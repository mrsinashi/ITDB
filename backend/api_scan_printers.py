"""Значения сканера у принтеров (этап 47): MAC из сети по IP принтера.

Наблюдения DHCP и прохода подсетей (scan_hosts) – как у ПК (api_scan_diffs), правило –
scan_hostmatch.printer_rows. Ничего не пишется само: на странице «Принтеры» – блочок в
ячейке MAC (кнопка «Значения сканера»), «Взять» – обычная правка принтера (История, пометка
«из Сети»), «Оставить как есть» – этому принтеру этот MAC больше не предлагать
(scan_rejects.printer_id), пока сеть видит тот же. MAC в таблице уже есть – новый
дописывается к нему (как у ПК: MAC таблицы сканер не убирает).
Смотреть – все; решать – редактор и администратор.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import scan_collect
from api_computers import ChangeBatch
from api_printers import apply_printer_fields, lock_printer, save_printer_changes
from api_scan_diffs import DiffSource, host_observations
from auth import get_current_user, require_editor
from db import get_db
from models import Printer, ScanReject
from scan_hostmatch import printer_rows
from scan_values import key_of, lines_of

router = APIRouter(prefix="/api/scan/printer-diffs", tags=["scan"])

FIELDS = ("mac",)


class PrinterDiffOut(BaseModel):
    id: str               # «p12:mac»
    printer_id: int
    name: Optional[str]
    field: str
    table: str            # как в таблице
    proposed: str         # что будет в ячейке
    raw: str              # MAC из сети (ключ отклонения)
    kind: str             # fill – в таблице пусто, diff – дописать к записанным
    unsure: str = ""
    note: str = ""
    name_field: bool = False
    can_take: bool = True
    sources: list[DiffSource]
    same_pair: int = 0
    rejected_by: Optional[str] = None
    rejected_at: Optional[datetime] = None
    compare: list[dict] = []


class PrinterDiffsOut(BaseModel):
    items: list[PrinterDiffOut]
    rejected: int


def compute(session, with_rejected=False):
    """(предложения, число отклонённых) по включённым источникам сети."""
    hosts, _ = host_observations(session)

    if not hosts:
        return [], 0

    printers = {
        p.id: {"ip": p.ip, "mac": p.mac, "name": p.name}
        for p in session.query(Printer).filter(Printer.archived == False)  # noqa: E712
    }
    rejects = {
        (r.printer_id, r.field, r.value_key): r
        for r in session.query(ScanReject).filter(ScanReject.printer_id.isnot(None))
    }
    items = []
    rejected = 0

    for proposal in printer_rows(printers, scan_collect.active_values(session), hosts):
        printer_id, field, value = proposal["printer_id"], proposal["field"], proposal["value"]
        table = printers[printer_id].get(field) or ""
        reject = rejects.get((printer_id, field, key_of(value)))

        if reject is not None:
            rejected += 1

            if not with_rejected:
                continue

        written = lines_of(table)
        items.append(PrinterDiffOut(
            id=f"p{printer_id}:{field}", printer_id=printer_id, name=printers[printer_id]["name"], field=field,
            table=table, proposed="\n".join(written + [value]), raw=value, kind="diff" if written else "fill",
            unsure=proposal["unsure"], sources=[DiffSource(**dict(proposal["source"], value=value))],
            rejected_by=reject.user_name if reject else None, rejected_at=reject.at if reject else None,
        ))

    return items, rejected


@router.get("", response_model=PrinterDiffsOut)
def list_printer_diffs(rejected: bool = Query(False), me=Depends(get_current_user), session=Depends(get_db)):
    items, rejected_count = compute(session, with_rejected=rejected)
    return PrinterDiffsOut(items=items, rejected=rejected_count)


class AcceptItem(BaseModel):
    printer_id: int
    field: str
    value: str            # что записать
    table: str = ""       # что было в таблице, когда смотрели
    source: str = ""      # «Сеть» – пометка в Истории


class AcceptIn(BaseModel):
    items: list[AcceptItem]


class RejectItem(BaseModel):
    printer_id: int
    field: str
    raw: str


class RejectIn(BaseModel):
    items: list[RejectItem]


def check_field(field):
    if field not in FIELDS:
        raise HTTPException(status_code=400, detail=f"Это поле из сканера не принимается: {field}")


@router.post("/accept")
def accept(payload: AcceptIn, me=Depends(require_editor), session=Depends(get_db)):
    """Записать значения сканера в принтеры. Пропускаются те, у кого значение в таблице
    уже не то, что было при просмотре."""
    batch = ChangeBatch(me["login"])
    accepted = 0
    skipped = []

    for item in payload.items:
        check_field(item.field)
        printer = lock_printer(session, item.printer_id)

        if printer.archived or key_of(getattr(printer, item.field) or "") != key_of(item.table):
            skipped.append(printer.name or f"#{printer.id}")
            continue

        changes = apply_printer_fields(session, printer, {item.field: item.value}, batch)

        for change in changes.values():
            change["scan"] = item.source or "сканер"

        if changes:
            save_printer_changes(session, printer, changes, me["login"])
            accepted += 1

    batch.finish(session)
    session.commit()
    return {"accepted": accepted, "skipped": skipped}


@router.post("/reject")
def reject(payload: RejectIn, me=Depends(require_editor), session=Depends(get_db)):
    """Не предлагать этот MAC этому принтеру, пока сеть видит тот же."""
    added = 0

    for item in payload.items:
        check_field(item.field)
        key = key_of(item.raw)
        exists = (
            session.query(ScanReject)
            .filter(ScanReject.printer_id == item.printer_id, ScanReject.field == item.field, ScanReject.value_key == key)
            .first()
        )

        if exists or session.get(Printer, item.printer_id) is None:
            continue

        session.add(ScanReject(
            printer_id=item.printer_id, field=item.field, value=item.raw, value_key=key, user_name=me["login"],
        ))
        session.flush()
        added += 1

    session.commit()
    return {"rejected": added}


@router.post("/unreject")
def unreject(payload: RejectIn, me=Depends(require_editor), session=Depends(get_db)):
    """Вернуть отклонённое: снова предлагать."""
    removed = 0

    for item in payload.items:
        removed += (
            session.query(ScanReject)
            .filter(
                ScanReject.printer_id == item.printer_id, ScanReject.field == item.field,
                ScanReject.value_key == key_of(item.raw),
            )
            .delete()
        )

    session.commit()
    return {"returned": removed}
