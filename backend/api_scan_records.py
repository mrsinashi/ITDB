"""Сбор из GLPI / GSIT и сопоставление с ПК (этап 25). Только администратор.

- POST /api/scan/sources/{kind}/collect — начать сбор (в фоне); ответ — запуск;
- GET  /api/scan/runs/{id} — запуск (пока идёт — «сделано из»);
- GET  /api/scan/runs?source=… — журнал запусков;
- GET  /api/scan/records?source=… — записи последнего сбора и их сопоставление
  с ПК ITDB (считается сейчас, по текущим данным таблицы);
- POST /api/scan/records/{kind}/{source_id}/link {computer_id} — «это этот ПК»;
- POST /api/scan/records/{kind}/{source_id}/reject {computer_id} — «не этот ПК»;
- DELETE /api/scan/records/{kind}/{source_id}/decisions — забыть решения.

Решения пишутся в Историю (видит администратор, отмены нет).
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import scan_collect
from api_computers import load_locations, location_path
from api_scan import SOURCES, RunOut, load_source, run_out
from auth import require_admin
from db import get_db
from history_log import log_change
from models import Computer, ScanLink, ScanRecord, ScanRun
from scan_glpi import api_base

router = APIRouter(prefix="/api/scan", tags=["scan"])

# Поля записи, которые сравниваются с ПК (как в таблице ITDB)
VALUE_FIELDS = ["hostname", "ip", "mac", "serial", "model", "os", "cpu", "ram", "drive", "gpu", "vnc"]
RUNS_LIMIT = 50


def check_collect_kind(kind):
    if kind not in scan_collect.COLLECTORS:
        raise HTTPException(status_code=404, detail="Нет такого источника.")


# ---------- Запуски ----------


@router.post("/sources/{kind}/collect", response_model=RunOut)
def collect(kind: str, me=Depends(require_admin), session=Depends(get_db)):
    check_collect_kind(kind)

    try:
        run = scan_collect.start(session, kind, me["login"])
    except scan_collect.CollectRefused as err:
        raise HTTPException(status_code=err.code, detail=str(err))

    return run_out(run)


@router.get("/runs", response_model=list[RunOut])
def list_runs(
    source: Optional[str] = None,
    limit: int = Query(10, ge=1, le=RUNS_LIMIT),
    me=Depends(require_admin),
    session=Depends(get_db),
):
    query = session.query(ScanRun)

    if source:
        query = query.filter(ScanRun.source == source)

    return [run_out(run) for run in query.order_by(ScanRun.id.desc()).limit(limit)]


@router.get("/runs/{run_id}", response_model=RunOut)
def get_run(run_id: int, me=Depends(require_admin), session=Depends(get_db)):
    run = session.get(ScanRun, run_id)

    if run is None:
        raise HTTPException(status_code=404, detail="Запуск не найден.")

    return run_out(run)


# ---------- Записи и сопоставление ----------


class Decision(BaseModel):
    action: str
    computer_id: int
    hostname: Optional[str]
    user_name: Optional[str]
    at: datetime


class RecordOut(BaseModel):
    source_id: int
    name: Optional[str]
    checked_at: Optional[datetime]
    values: dict
    antivirus: list
    full: dict
    state: str
    computer_id: Optional[int]
    candidates: list[int]
    by: list[str]
    note: Optional[str]
    dup_of: Optional[int]
    decisions: list[Decision]


class ComputerBrief(BaseModel):
    id: int
    hostname: Optional[str]
    archived: bool
    place: Optional[str]
    values: dict


class RecordsOut(BaseModel):
    source: str
    title: str
    web_url: Optional[str]
    records: list[RecordOut]
    computers: dict[int, ComputerBrief]
    counts: dict[str, int]


def web_url_of(source):
    """Адрес веб-интерфейса GLPI для ссылок на записи (…/front/computer.form.php?id=N)."""
    if source is None or not source.url:
        return None

    try:
        return api_base(source.url)[: -len("/apirest.php")]
    except Exception:  # noqa: BLE001 — неверный адрес: просто без ссылок
        return None


def computer_brief(computer, locations):
    values = {field: getattr(computer, field) for field in VALUE_FIELDS}
    values["glpi_id"] = computer.glpi_id
    return ComputerBrief(
        id=computer.id,
        hostname=computer.hostname,
        archived=computer.archived,
        place=location_path(computer.location_id, locations),
        values=values,
    )


@router.get("/records", response_model=RecordsOut)
def list_records(source: str, me=Depends(require_admin), session=Depends(get_db)):
    check_collect_kind(source)
    records = session.query(ScanRecord).filter(ScanRecord.source == source).order_by(ScanRecord.name, ScanRecord.source_id).all()
    matches, _ = scan_collect.match(session, source)
    decisions = {}
    referenced = set()

    for link in scan_collect.links_of(session, source):
        decisions.setdefault(link.source_id, []).append(link)
        referenced.add(link.computer_id)

    counts = {state: 0 for state in scan_collect.STATES}

    for item in matches.values():
        counts[item["state"]] += 1
        referenced.update(item["candidates"])

        if item["computer_id"]:
            referenced.add(item["computer_id"])

    computers = {}

    if referenced:
        locations = load_locations(session)

        for computer in session.query(Computer).filter(Computer.id.in_(referenced)):
            computers[computer.id] = computer_brief(computer, locations)

    def decisions_of(source_id):
        return [
            Decision(
                action=link.action, computer_id=link.computer_id,
                hostname=computers[link.computer_id].hostname if link.computer_id in computers else None,
                user_name=link.user_name, at=link.at,
            )
            for link in sorted(decisions.get(source_id, []), key=lambda l: l.at)
        ]

    result = []

    for record in records:
        item = matches.get(record.source_id) or {"state": "none", "computer_id": None, "candidates": [], "by": [], "note": None}
        data = record.data or {}
        result.append(RecordOut(
            source_id=record.source_id,
            name=record.name,
            checked_at=record.checked_at,
            values=data.get("values") or {},
            antivirus=data.get("antivirus") or [],
            full=data.get("full") or {},
            state=item["state"],
            computer_id=item["computer_id"],
            candidates=item["candidates"],
            by=item["by"],
            note=item["note"],
            dup_of=record.dup_of,
            decisions=decisions_of(record.source_id),
        ))

    return RecordsOut(
        source=source,
        title=SOURCES[source]["title"],
        web_url=web_url_of(load_source(session, source)),
        records=result,
        computers=computers,
        counts=counts,
    )


# ---------- Решения администратора ----------


class DecisionIn(BaseModel):
    computer_id: int


def load_record(session, kind, source_id):
    check_collect_kind(kind)
    record = session.query(ScanRecord).filter(ScanRecord.source == kind, ScanRecord.source_id == source_id).first()

    if record is None:
        raise HTTPException(status_code=404, detail="Запись не найдена: соберите данные заново.")

    return record


def load_computer(session, computer_id):
    computer = session.get(Computer, computer_id)

    if computer is None:
        raise HTTPException(status_code=404, detail="ПК не найден.")

    return computer


def host_of(computer):
    return computer.hostname or f"ПК №{computer.id}"


def record_title(kind, record):
    return f"{SOURCES[kind]['title']} №{record.source_id}" + (f" {record.name}" if record.name else "")


def log_decision(session, kind, record, me, changes):
    log_change(
        session, "scan_records", 0, me["login"], changes,
        title=record_title(kind, record), entity_key=f"{kind}:{record.source_id}",
    )


def links_for(session, kind, source_id):
    return session.query(ScanLink).filter(ScanLink.source == kind, ScanLink.source_id == source_id).all()


@router.post("/records/{kind}/{source_id}/link")
def link_record(kind: str, source_id: int, payload: DecisionIn, me=Depends(require_admin), session=Depends(get_db)):
    """«Это этот ПК»: запись сопоставляется с ним, что бы ни говорили признаки."""
    record = load_record(session, kind, source_id)
    computer = load_computer(session, payload.computer_id)

    if computer.archived:
        raise HTTPException(status_code=400, detail=f"{host_of(computer)} в архиве: сначала верни его из архива.")

    old = None

    for link in links_for(session, kind, source_id):
        if link.action == "link" and link.computer_id != computer.id:
            prev = session.get(Computer, link.computer_id)
            old = host_of(prev) if prev else None
            session.delete(link)
        elif link.computer_id == computer.id:
            session.delete(link)

    session.flush()
    session.add(ScanLink(
        source=kind, source_id=source_id, computer_id=computer.id, action="link",
        title=record.name, user_name=me["login"],
    ))
    log_decision(session, kind, record, me, {"link": {"old": old, "new": host_of(computer)}})
    session.commit()
    return {"ok": True}


@router.post("/records/{kind}/{source_id}/reject")
def reject_record(kind: str, source_id: int, payload: DecisionIn, me=Depends(require_admin), session=Depends(get_db)):
    """«Это не этот ПК»: его больше не предлагать для этой записи."""
    record = load_record(session, kind, source_id)
    computer = load_computer(session, payload.computer_id)

    for link in links_for(session, kind, source_id):
        if link.computer_id == computer.id:
            session.delete(link)

    session.flush()
    session.add(ScanLink(
        source=kind, source_id=source_id, computer_id=computer.id, action="reject",
        title=record.name, user_name=me["login"],
    ))
    log_decision(session, kind, record, me, {"reject": {"old": None, "new": host_of(computer)}})
    session.commit()
    return {"ok": True}


@router.delete("/records/{kind}/{source_id}/decisions")
def reset_record(kind: str, source_id: int, me=Depends(require_admin), session=Depends(get_db)):
    """Забыть решения по записи: снова сопоставлять по признакам."""
    record = load_record(session, kind, source_id)
    links = links_for(session, kind, source_id)

    if not links:
        return {"ok": True}

    described = []

    for link in links:
        computer = session.get(Computer, link.computer_id)
        host = host_of(computer) if computer else f"ПК №{link.computer_id}"
        described.append(("это " if link.action == "link" else "не ") + host)
        session.delete(link)

    log_decision(session, kind, record, me, {"reset": {"old": ", ".join(described), "new": None}})
    session.commit()
    return {"ok": True}
