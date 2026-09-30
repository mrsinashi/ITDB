"""Режим «Расхождения» (этап 26): где данные сканера отличаются от таблицы.

Расхождение — поле ПК, сопоставленного с записью включённого источника по
признаку или вручную (state key / link), у которого значение сканера (в
названиях таблицы, scan_values) отличается («≠») или в таблице пусто, а у
сканера есть. «≈» (в таблице записана часть, например один MAC из двух) —
не расхождение. Считается на лету, ничего не хранится, кроме решений:

- «Принять» — значение пишется в ПК обычной правкой (История, пометка
  источника «scan»); если значение в таблице за это время изменилось — не
  пишется;
- «Отклонить» — этому ПК это значение не предлагать, пока источник отдаёт то же
  (scan_rejects); отклонённые можно показать и вернуть;
- «В таблице своё» — пара «значение источника — значение таблицы» не
  расхождение ни у одного ПК, но и не «одно и то же» (scan_aliases kind keep,
  через /api/scan/names).

Правка — editor и admin (как правка таблицы).
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import scan_collect
from api_columns import COLUMNS_BY_KEY
from api_computers import (
    ChangeBatch, apply_fields, load_locations, location_path, save_changes, user_field_keys_of,
)
from api_scan import SOURCES
from auth import require_editor
from db import get_db
from models import Computer, ScanRecord, ScanReject, ScanSource
from scan_values import COMPARE_FIELDS, NAME_FIELDS, key_of

router = APIRouter(prefix="/api/scan/diffs", tags=["scan"])

MAX_ITEMS = 5000


class DiffSource(BaseModel):
    source: str
    title: str
    source_id: int
    checked_at: Optional[datetime]


class DiffOut(BaseModel):
    id: str
    computer_id: int
    hostname: Optional[str]
    place: Optional[str]
    field: str
    table: str            # как в таблице
    proposed: str         # как предлагает сканер (в названиях таблицы)
    raw: str              # как в источнике
    kind: str             # diff — отличается, fill — в таблице пусто
    name_field: bool      # поле-название: можно «в таблице своё»
    sources: list[DiffSource]
    same_pair: int        # ещё у скольких ПК такая же пара «таблица — сканер»
    rejected_by: Optional[str] = None
    rejected_at: Optional[datetime] = None


class DiffsOut(BaseModel):
    items: list[DiffOut]
    computers: int
    rejected: int
    sources: list[str]    # включённые источники, из которых считались


def enabled_kinds(session):
    return [
        s.kind for s in session.query(ScanSource).filter(ScanSource.enabled == True)  # noqa: E712
        if s.kind in scan_collect.COLLECTORS
    ]


def compute(session, with_rejected=False):
    """(расхождения, число отклонённых) по всем включённым источникам."""
    kinds = enabled_kinds(session)
    computers = scan_collect.active_values(session)
    names = scan_collect.load_names(session, computers)
    rejects = {}

    for r in session.query(ScanReject):
        rejects[(r.computer_id, r.field, r.value_key)] = r

    items = {}
    rejected = 0

    for kind in kinds:
        matches, _ = scan_collect.match(session, kind)
        records = {r.source_id: r for r in session.query(ScanRecord).filter(ScanRecord.source == kind)}

        for source_id, item in matches.items():
            computer_id = item["computer_id"]

            if item["state"] not in ("key", "link") or computer_id not in computers:
                continue

            record = records[source_id]
            values = (record.data or {}).get("values") or {}

            for row in scan_collect.compare_record(names, values, computers[computer_id]):
                if not row["raw"]:
                    continue

                if row["mark"] == "≠":
                    diff_kind = "diff"
                elif row["mark"] == "" and not row["itdb"]:
                    diff_kind = "fill"
                else:
                    continue

                field = row["field"]
                reject = rejects.get((computer_id, field, key_of(row["raw"])))

                if reject is not None:
                    rejected += 1

                    if not with_rejected:
                        continue

                item_id = f"{computer_id}:{field}:{key_of(row['source'])}"
                entry = items.get(item_id)

                if entry is None:
                    entry = items[item_id] = {
                        "id": item_id, "computer_id": computer_id, "field": field,
                        "table": row["itdb"] or "", "proposed": row["source"], "raw": row["raw"],
                        "kind": diff_kind, "name_field": field in NAME_FIELDS, "sources": [],
                        "rejected_by": reject.user_name if reject else None,
                        "rejected_at": reject.at if reject else None,
                    }

                entry["sources"].append({
                    "source": kind, "title": SOURCES[kind]["title"], "source_id": source_id,
                    "checked_at": record.checked_at,
                })

    # «Ещё у N ПК»: та же пара «в таблице — у сканера» в том же поле
    pairs = {}

    for entry in items.values():
        pair = (entry["field"], key_of(entry["table"]), key_of(entry["raw"]))
        pairs[pair] = pairs.get(pair, 0) + 1

    ids = {entry["computer_id"] for entry in items.values()}
    hosts = {}

    if ids:
        locations = load_locations(session)

        for c in session.query(Computer.id, Computer.hostname, Computer.location_id).filter(Computer.id.in_(ids)):
            hosts[c.id] = (c.hostname, location_path(c.location_id, locations))

    order = {field: i for i, field in enumerate(COMPARE_FIELDS)}
    result = []

    for entry in items.values():
        pair = (entry["field"], key_of(entry["table"]), key_of(entry["raw"]))
        hostname, place = hosts.get(entry["computer_id"], (None, None))
        result.append(DiffOut(**entry, hostname=hostname, place=place, same_pair=pairs[pair] - 1))

    result.sort(key=lambda d: ((d.hostname or "").lower(), d.computer_id, order.get(d.field, 99)))
    return result[:MAX_ITEMS], rejected, kinds


@router.get("", response_model=DiffsOut)
def list_diffs(
    rejected: bool = Query(False),
    me=Depends(require_editor),
    session=Depends(get_db),
):
    items, rejected_count, kinds = compute(session, with_rejected=rejected)
    return DiffsOut(
        items=items,
        computers=len({d.computer_id for d in items if not d.rejected_by}),
        rejected=rejected_count,
        sources=kinds,
    )


# ---------- Решения ----------


class AcceptItem(BaseModel):
    computer_id: int
    field: str
    value: str            # что записать (как показано: в названиях таблицы)
    table: str = ""       # что было в таблице, когда смотрели
    source: str = ""      # «GLPI №12» — пометка в Истории


class AcceptIn(BaseModel):
    items: list[AcceptItem]


class RejectItem(BaseModel):
    computer_id: int
    field: str
    raw: str


class RejectIn(BaseModel):
    items: list[RejectItem]


def check_field(field):
    if field not in COMPARE_FIELDS:
        raise HTTPException(status_code=400, detail=f"Это поле из сканера не принимается: {field}")


@router.post("/accept")
def accept(payload: AcceptIn, me=Depends(require_editor), session=Depends(get_db)):
    """Записать значения сканера в ПК. Пропускаются ПК, у которых значение в
    таблице уже не то, что было при просмотре (кто-то успел поменять)."""
    user_field_keys = user_field_keys_of(session)
    batch = ChangeBatch(me["login"])
    accepted = 0
    skipped = []
    by_computer = {}

    for item in payload.items:
        check_field(item.field)
        by_computer.setdefault(item.computer_id, []).append(item)

    for computer_id, items in by_computer.items():
        computer = session.query(Computer).filter(Computer.id == computer_id).with_for_update().first()

        if computer is None or computer.archived:
            skipped.extend(f"ПК №{computer_id}" for _ in items)
            continue

        changes = {}

        for item in items:
            now_value = getattr(computer, item.field) or ""

            if key_of(now_value) != key_of(item.table):
                skipped.append(f"{computer.hostname or computer.id}: {COLUMNS_BY_KEY[item.field].short}")
                continue

            field_changes = apply_fields(session, computer, {item.field: item.value}, user_field_keys, batch)

            for field, change in field_changes.items():
                changes[field] = dict(change, scan=item.source or "сканер")

            if field_changes:
                accepted += 1

        save_changes(session, computer, changes, me["login"])

    batch.finish(session)
    session.commit()
    return {"accepted": accepted, "skipped": skipped}


@router.post("/reject")
def reject(payload: RejectIn, me=Depends(require_editor), session=Depends(get_db)):
    """Не предлагать это значение этому ПК, пока источник отдаёт то же."""
    added = 0

    for item in payload.items:
        check_field(item.field)
        key = key_of(item.raw)
        exists = (
            session.query(ScanReject)
            .filter(ScanReject.computer_id == item.computer_id, ScanReject.field == item.field, ScanReject.value_key == key)
            .first()
        )

        if exists or session.get(Computer, item.computer_id) is None:
            continue

        session.add(ScanReject(
            computer_id=item.computer_id, field=item.field, value=item.raw, value_key=key, user_name=me["login"],
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
                ScanReject.computer_id == item.computer_id, ScanReject.field == item.field,
                ScanReject.value_key == key_of(item.raw),
            )
            .delete()
        )

    session.commit()
    return {"returned": removed}
