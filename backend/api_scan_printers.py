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
from api_computers import ChangeBatch, save_changes
from api_printers import apply_printer_fields
from api_scan_diffs import DiffItems, DiffSource, add_scan_changes, drop_rejects, host_observations, save_rejects
from auth import get_current_user, require_editor
from db import get_db
from models import Printer
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
    items = DiffItems(session, with_rejected, "printer_id")

    for proposal in printer_rows(printers, scan_collect.active_values(session), hosts):
        printer_id, field, value = proposal["printer_id"], proposal["field"], proposal["value"]
        table = printers[printer_id].get(field) or ""
        reject, shown = items.reject_of(printer_id, field, value)

        if not shown:
            continue

        written = lines_of(table)
        items.items.append(PrinterDiffOut(
            id=f"p{printer_id}:{field}", printer_id=printer_id, name=printers[printer_id]["name"], field=field,
            table=table, proposed="\n".join(written + [value]), raw=value, kind="diff" if written else "fill",
            unsure=proposal["unsure"], sources=[DiffSource(**dict(proposal["source"], value=value))],
            rejected_by=reject.user_name if reject else None, rejected_at=reject.at if reject else None,
        ))

    return items.items, items.rejected


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
    """Записать значения сканера в принтеры. Пропускаются пропавшие и те, у кого значение
    в таблице уже не то, что было при просмотре (как у ПК – api_scan_diffs.accept)."""
    batch = ChangeBatch(me["login"])
    accepted = 0
    skipped = []
    by_printer = {}

    for item in payload.items:
        check_field(item.field)
        by_printer.setdefault(item.printer_id, []).append(item)

    # Принтеры блокируются по возрастанию id – два «Записать» с одними принтерами не ждут друг друга вечно
    for printer_id, items in sorted(by_printer.items()):
        printer = session.query(Printer).filter(Printer.id == printer_id).with_for_update().first()

        if printer is None:
            skipped.extend(f"#{printer_id}" for _ in items)
            continue

        changes = {}

        for item in items:
            if printer.archived or key_of(getattr(printer, item.field) or "") != key_of(item.table):
                skipped.append(printer.name or f"#{printer.id}")
                continue

            field_changes = apply_printer_fields(session, printer, {item.field: item.value}, batch)
            add_scan_changes(changes, field_changes, item.source)

            if field_changes:
                accepted += 1

        save_changes(session, printer, changes, me["login"])

    batch.finish(session)
    session.commit()
    return {"accepted": accepted, "skipped": skipped}


@router.post("/reject")
def reject(payload: RejectIn, me=Depends(require_editor), session=Depends(get_db)):
    """Не предлагать этот MAC этому принтеру, пока сеть видит тот же."""
    added = save_rejects(session, Printer, "printer_id", payload.items, check_field, me["login"])
    session.commit()
    return {"rejected": added}


@router.post("/unreject")
def unreject(payload: RejectIn, me=Depends(require_editor), session=Depends(get_db)):
    """Вернуть отклонённое: снова предлагать."""
    removed = drop_rejects(session, "printer_id", payload.items)
    session.commit()
    return {"returned": removed}
