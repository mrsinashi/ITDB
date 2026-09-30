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

Смотреть (пометки в Таблице) — все; решения — editor и admin (как правка таблицы).
Этап 26б: «неточно» (unsure) — источники предлагают разное или VNC-серверов
несколько; «в таблице часть» (partial, «≈») — отдаётся для пометок, но не
расхождение (не в счётчике); у источника — как сопоставлен (state, by) и что
предлагает (value) — признаки, можно ли верить.
"""
import re
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
from auth import get_current_user, require_editor
from db import get_db
from history_log import log_change
from models import Computer, ScanMark, ScanRecord, ScanReject, ScanSource
from scan_values import COMPARE_FIELDS, NAME_FIELDS, key_of

router = APIRouter(prefix="/api/scan/diffs", tags=["scan"])

MAX_ITEMS = 5000


class DiffSource(BaseModel):
    source: str
    title: str
    source_id: int
    checked_at: Optional[datetime]
    state: str = "key"          # key — по признаку, link — вручную
    by: list[str] = []          # признаки: id, mac, serial
    value: str = ""             # что предлагает этот источник (в названиях таблицы)


class DiffOut(BaseModel):
    id: str
    computer_id: int
    hostname: Optional[str]
    place: Optional[str]
    field: str
    table: str            # как в таблице
    proposed: str         # как предлагает сканер (в названиях таблицы)
    raw: str              # как в источнике
    kind: str             # diff — отличается, fill — в таблице пусто, unsure — неточно
                          # (источники расходятся или VNC-серверов несколько),
                          # partial — в таблице записана часть («≈», не расхождение)
    unsure: str = ""      # почему неточно — для подсказки
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
    """(расхождения, число отклонённых, источники) по всем включённым источникам.
    Одно поле ПК — одна строка; если источники предлагают разное — «неточно»."""
    kinds = enabled_kinds(session)
    computers = scan_collect.active_values(session)
    names = scan_collect.load_names(session, computers)
    rejects = {}

    for r in session.query(ScanReject):
        rejects[(r.computer_id, r.field, r.value_key)] = r

    rows = {}   # (ПК, поле) → {row из compare, sources: [...]}

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

                entry = rows.setdefault((computer_id, row["field"]), {"rows": [], "sources": []})
                entry["rows"].append(row)
                entry["sources"].append({
                    "source": kind, "title": SOURCES[kind]["title"], "source_id": source_id,
                    "checked_at": record.checked_at, "state": item["state"], "by": item["by"],
                    "value": row["source"],
                })

    items = []
    rejected = 0

    for (computer_id, field), entry in rows.items():
        proposals = {key_of(r["source"]) for r in entry["rows"]}
        row = entry["rows"][0]
        marks = {r["mark"] for r in entry["rows"]}
        unsure = ""

        if len(proposals) > 1:
            unsure = "источники предлагают разное: " + "; ".join(f"{s['title']} — {s['value']}" for s in entry["sources"])
        elif field == "vnc" and len(row["source"].splitlines()) > 1:
            unsure = "установлено несколько VNC — какой из них сервер, по программам не понять"

        if "≠" in marks or (unsure and not row["itdb"]):
            diff_kind = "unsure" if unsure else "diff"
        elif not row["itdb"] and "" in marks:
            diff_kind = "unsure" if unsure else "fill"
        elif "≈" in marks:
            diff_kind = "partial"
        else:
            continue

        reject = rejects.get((computer_id, field, key_of(row["raw"])))

        if reject is not None and diff_kind != "partial":
            rejected += 1

            if not with_rejected:
                continue

        items.append({
            "id": f"{computer_id}:{field}", "computer_id": computer_id, "field": field,
            "table": row["itdb"] or "", "proposed": row["source"], "raw": row["raw"],
            "kind": diff_kind, "unsure": unsure, "name_field": field in NAME_FIELDS,
            "sources": entry["sources"],
            "rejected_by": reject.user_name if reject else None,
            "rejected_at": reject.at if reject else None,
        })

    # «Ещё у N ПК»: та же пара «в таблице — у сканера» в том же поле
    pairs = {}

    for entry in items:
        pair = (entry["field"], key_of(entry["table"]), key_of(entry["raw"]))
        pairs[pair] = pairs.get(pair, 0) + 1

    ids = {entry["computer_id"] for entry in items}
    hosts = {}

    if ids:
        locations = load_locations(session)

        for c in session.query(Computer.id, Computer.hostname, Computer.location_id).filter(Computer.id.in_(ids)):
            hosts[c.id] = (c.hostname, location_path(c.location_id, locations))

    order = {field: i for i, field in enumerate(COMPARE_FIELDS)}
    result = []

    for entry in items:
        pair = (entry["field"], key_of(entry["table"]), key_of(entry["raw"]))
        hostname, place = hosts.get(entry["computer_id"], (None, None))
        result.append(DiffOut(**entry, hostname=hostname, place=place, same_pair=pairs[pair] - 1))

    result.sort(key=lambda d: ((d.hostname or "").lower(), d.computer_id, order.get(d.field, 99)))
    return result[:MAX_ITEMS], rejected, kinds


@router.get("", response_model=DiffsOut)
def list_diffs(
    rejected: bool = Query(False),
    me=Depends(get_current_user),
    session=Depends(get_db),
):
    items, rejected_count, kinds = compute(session, with_rejected=rejected)
    return DiffsOut(
        items=items,
        computers=len({d.computer_id for d in items if not d.rejected_by and d.kind != "partial"}),
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


# ---------- Пометки в Таблице: вид и когда показывать (этап 26б) ----------

marks_router = APIRouter(prefix="/api/scan/marks", tags=["scan"])

MARK_LABELS = {
    "diff": "Отличается",
    "fill": "В таблице пусто",
    "unsure": "Неточно",
    "partial": "В таблице часть",
}
MARK_FIELDS = ("color", "bg_color", "bold", "italic", "strike", "frame", "enabled", "always")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class MarkOut(BaseModel):
    kind: str
    label: str
    color: Optional[str]
    bg_color: Optional[str]
    bold: bool
    italic: bool
    strike: bool
    frame: Optional[str]
    enabled: bool
    always: bool


class MarkUpdate(BaseModel):
    """None — не менять; у цветов "" — убрать."""
    color: Optional[str] = None
    bg_color: Optional[str] = None
    bold: Optional[bool] = None
    italic: Optional[bool] = None
    strike: Optional[bool] = None
    frame: Optional[str] = None
    enabled: Optional[bool] = None
    always: Optional[bool] = None


def mark_out(mark):
    return MarkOut(label=MARK_LABELS.get(mark.kind, mark.kind), **{
        "kind": mark.kind, **{field: getattr(mark, field) for field in MARK_FIELDS}
    })


@marks_router.get("", response_model=list[MarkOut])
def list_marks(me=Depends(get_current_user), session=Depends(get_db)):
    return [mark_out(m) for m in session.query(ScanMark).order_by(ScanMark.sort, ScanMark.kind)]


@marks_router.patch("/{kind}", response_model=MarkOut)
def update_mark(kind: str, payload: MarkUpdate, me=Depends(require_editor), session=Depends(get_db)):
    """Вид пометки — общий для всех, как оформление в Справочниках."""
    mark = session.get(ScanMark, kind)

    if mark is None:
        raise HTTPException(status_code=404, detail="Нет такой пометки.")

    data = payload.model_dump(exclude_none=True)
    changes = {}

    for field, value in data.items():
        if field in ("color", "bg_color", "frame"):
            value = (value or "").strip() or None

            if value is not None and not COLOR_RE.match(value):
                raise HTTPException(status_code=400, detail="Цвет — в виде #RRGGBB.")

        changes[field] = {"old": getattr(mark, field), "new": value}
        setattr(mark, field, value)

    log_change(session, "scan_marks", 0, me["login"], changes, title=MARK_LABELS.get(kind, kind), entity_key=kind)
    session.commit()
    return mark_out(mark)
