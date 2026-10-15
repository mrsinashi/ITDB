from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc, func, text

from api_computers import ChangeBatch
from api_moves import move_names
from auth import get_current_user, require_editor
from db import get_db
from history_search import search, search_words
from history_undo import (
    ENTITIES, SIMPLE, Ref, cancel_changes, field_kind, field_label, find_object, moved_room, object_title, ref_of,
    revert_value, value_history,
)
from models import Computer, History, Location, Printer
from scan_decisions import DECISION_ENTITIES

router = APIRouter(prefix="/api", tags=["history"])

# Записи только для администратора: пользователи системы, настройки сканирования
ADMIN_ENTITIES = ("users", "scan_sources", "scan_subnets", "scan_records", "scan_aliases", "scan_schedule")


HISTORY_PAGE_MAX = 5000

# Поля записи в ответе (и для поиска – строками, без объектов ORM)
ROW_COLUMNS = (
    History.id, History.entity, History.entity_id, History.entity_key, History.user_name, History.at,
    History.title, History.changes, History.cancelled,
)


def valid_time_zone(session, tz):
    """Часовой пояс браузера (например, Asia/Irkutsk), если его знает база; иначе UTC."""
    if tz and session.execute(
        text("select 1 from pg_timezone_names where name = :tz"), {"tz": tz}
    ).first():
        return tz

    return "UTC"


def history_filters(me, user, entity, entity_id, entity_key, cancelled):
    """Условия отбора записей Истории (см. history)."""
    filters = []

    if me["role"] != "admin":
        filters.append(History.entity.notin_(ADMIN_ENTITIES))

    if user:
        filters.append(History.user_name == user)

    if entity:
        filters.append(History.entity == entity)

        if entity_id is not None:
            filters.append(History.entity_id == entity_id)

        if entity_key is not None:
            filters.append(History.entity_key == entity_key)

    if not cancelled:
        filters.append(History.cancelled == False)  # noqa: E712

    return filters


# Объекты, у которых в Истории – имя сейчас: таблица → (столбец имени, имя). Принтер без
# имени (этап 44) – «#N» (вид объекта «Принтер» пишет фронт)
NAMED_ENTITIES = {
    "computers": (Computer.hostname, lambda computer: computer.hostname),
    "locations": (Location.name, lambda location: location.name),
    "printers": (Printer.name, lambda printer: printer.name or f"#{printer.id}"),
}


def entry_titles(session, items):
    """Название объекта у записей Истории → функция «запись → название». ПК, узлы,
    принтеры – имя сейчас; справочники, поля, оформление, пользователи – название
    сейчас, а если объекта уже нет (удалённое значение) – каким оно было при записи;
    настройки сканирования – на момент записи."""
    names = {}

    # Только номер и имя (при поиске записей – тысячи, целые строки ПК не нужны)
    for entity, (column, name_of) in NAMED_ENTITIES.items():
        ids = {item.entity_id for item in items if item.entity == entity}
        model = column.class_
        names[entity] = {
            row.id: name_of(row) for row in (session.query(model.id, column).filter(model.id.in_(ids)).all() if ids else [])
        }

    # Запись журнала «Движение» (этап 66) – «Понятное название» сейчас (из нескольких полей)
    names["moves"] = move_names(session, {item.entity_id for item in items if item.entity == "moves"})

    simple_titles = {}
    simple_refs = {Ref(item.entity, item.entity_id, item.entity_key) for item in items if item.entity in SIMPLE}

    for ref in simple_refs:
        obj = find_object(session, ref, lock=False)
        simple_titles[ref] = object_title(session, obj, ref) if obj is not None else None

    def title_of(item):
        if item.entity in names:
            return names[item.entity].get(item.entity_id)

        if item.entity in SIMPLE:
            return simple_titles.get(Ref(item.entity, item.entity_id, item.entity_key)) or item.title

        return item.title

    return title_of


@router.get("/history")
def history(
    limit: int = 200,
    offset: int = 0,
    tz: str = "UTC",
    user: Optional[str] = None,
    entity: Optional[str] = None,
    entity_id: Optional[int] = None,
    entity_key: Optional[str] = None,
    cancelled: bool = False,
    q: str = "",
    me=Depends(get_current_user),
    session=Depends(get_db),
):
    """Записи истории, новые сверху, порциями: limit (до 5000) начиная с offset.
    total – сколько записей всего, days – сколько записей в каждый день
    (день – по часовому поясу tz браузера): счётчики точные, даже если
    загружена только часть записей.
    Фильтры: user – кто менял, entity (+ entity_id / entity_key) – что менялось.
    Записи о пользователях системы видит только администратор.
    Отменённые целиком записи – только с cancelled=true (и в счётчиках тоже).
    q – поиск по словам (history_search.py, этап 53): total и days – по найденным,
    total_all – сколько записей без поиска.
    users – все, кто что-либо менял (для фильтра)."""
    limit = min(max(limit, 1), HISTORY_PAGE_MAX)
    offset = max(offset, 0)
    filters = history_filters(me, user, entity, entity_id, entity_key, cancelled)
    zone = valid_time_zone(session, tz)

    total = session.query(func.count(History.id)).filter(*filters).scalar()
    total_all = total
    order = (desc(History.at), desc(History.id))

    if search_words(q):
        # Поиск – по всем записям фильтра (время – как на странице); строки – без объектов ORM
        local = func.to_char(func.timezone(zone, History.at), "DD.MM.YYYY HH24:MI:SS").label("local")
        rows = session.query(*ROW_COLUMNS, local).filter(*filters).order_by(*order).all()
        found = search(session, rows, q, entry_titles(session, rows))
        total = len(found)
        days = dict(Counter(row.local[:10] for row in found))
        items = found[offset:offset + limit]
    else:
        items = session.query(History).filter(*filters).order_by(*order).offset(offset).limit(limit).all()
        day = func.date(func.timezone(zone, History.at))
        days = {
            value.strftime("%d.%m.%Y"): count
            for value, count in session.query(day, func.count(History.id))
            .filter(*filters)
            .group_by(day)
            .all()
        }

    users = [
        name
        for (name,) in session.query(History.user_name)
        .filter(History.user_name.isnot(None))
        .distinct()
        .order_by(History.user_name)
        .all()
    ]

    title_of = entry_titles(session, items)
    result = [
        {
            "id": item.id,
            "entity": item.entity,
            "entity_id": item.entity_id,
            "entity_key": item.entity_key,
            "user_name": item.user_name,
            "at": item.at,
            "title": title_of(item),
            "changes": item.changes,
            "cancelled": item.cancelled,
        }
        for item in items
    ]

    return {
        "items": result,
        "total": total,
        "total_all": total_all,
        "days": days,
        "users": users,
    }


@router.get("/history/value")
def history_of_value(
    entity: str,
    entity_id: int,
    field: str,
    entity_key: Optional[str] = None,
    me=Depends(get_current_user),
    session=Depends(get_db),
):
    """Все изменения одного поля объекта (и отменённые) – окно «История значения»."""
    if entity in ADMIN_ENTITIES and me["role"] != "admin":
        raise HTTPException(status_code=403, detail="Это доступно только администратору.")

    return value_history(session, Ref(entity, entity_id, entity_key), field)


class CancelItem(BaseModel):
    id: int
    field: Optional[str] = None     # без поля – все поля записи


class CancelRequest(BaseModel):
    items: list[CancelItem]
    cancel: bool = True             # False – восстановить отменённые


@router.post("/history/cancel")
def cancel_history(payload: CancelRequest, user=Depends(require_editor), session=Depends(get_db)):
    """Отменить изменения (пометка «отменено», новой записи нет; значение
    пересчитывается по оставшимся) или восстановить отменённые."""
    if not payload.items:
        raise HTTPException(status_code=400, detail="Не выбраны изменения.")

    ids = {item.id for item in payload.items}
    records = {
        record.id: record
        for record in session.query(History).filter(History.id.in_(ids)).order_by(History.id).with_for_update().all()
    }

    if len(records) != len(ids):
        raise HTTPException(status_code=404, detail="Часть записей не найдена. Обнови историю.")

    pairs = []

    for item in sorted(payload.items, key=lambda value: value.id):
        record = records[item.id]
        fields = [item.field] if item.field else list(record.changes or {})

        for field in fields:
            if field not in (record.changes or {}):
                raise HTTPException(status_code=400, detail=f"В записи нет поля {field}.")

            pairs.append((record, field))

    batch = ChangeBatch(user["login"])
    count = cancel_changes(session, pairs, payload.cancel, user, batch)
    batch.finish(session)
    session.commit()

    return {"ok": True, "count": count, "shifted": batch.changed_ids()}


# Ctrl+Z (этап 28б): отменяется последнее своё действие не старше этого срока (этап 47 –
# 5 минут, просьба пользователя); старше UNDO_CONFIRM – только после подтверждения
UNDO_WINDOW = timedelta(minutes=5)
UNDO_CONFIRM = timedelta(minutes=1)


class UndoLastIn(BaseModel):
    confirm_id: Optional[int] = None   # действие старше минуты: его запись, отмену подтвердили


def action_text(session, pairs):
    """Что отменяет Ctrl+Z – словами: «pc-1 – Оперативная память». Решение сканера вместе
    с правкой одного ПК («Привязать»: «Это ПК» + номер в столбец) – подписью этого ПК;
    несколько объектов – числом. Кабинет, созданный переносом (этап 58), – часть переноса:
    подпись – по перенесённому ПК или кабинету."""
    objects = {ref_of(record) for record, _ in pairs}
    copies = {ref_of(record) for record, field in pairs if moved_room(record, field)}
    main = {ref for ref in objects if ref.entity not in DECISION_ENTITIES and ref not in copies} or objects
    pairs = [pair for pair in pairs if not moved_room(*pair)] or pairs

    if len(main) != 1:
        return f"изменений: {len(pairs)}, объектов: {len(objects)}"

    ref = next(iter(main))
    stored = next(record.title for record, _ in pairs if ref_of(record) == ref)
    obj = find_object(session, ref, lock=False) if ref.entity not in DECISION_ENTITIES else None
    title = (object_title(session, obj, ref) if obj is not None else None) or stored or ""
    labels = []

    # Сначала поля самого объекта, потом решения
    for record, field in sorted(pairs, key=lambda pair: ref_of(pair[0]) != ref):
        label = field_label(session, record.entity, field)

        if label not in labels:
            labels.append(label)

    return f"{title} – {', '.join(labels)}" if title else ", ".join(labels)


@router.post("/history/undo-last")
def undo_last(payload: Optional[UndoLastIn] = None, user=Depends(require_editor), session=Depends(get_db)):
    """Отменить своё последнее действие (Ctrl+Z): все его записи истории – одной
    отменой, как «Отменить изменения» в Истории. Действие – записи одного
    сохранения (у них одно время). items – что отменено (для возврата Ctrl+Y).
    Действие старше минуты не отменяется сразу: ответ confirm (что, сколько секунд
    назад, last_id) – отменить его можно, прислав confirm_id = last_id."""
    # Решения сканера – и редактору: здесь только свои («Привязать» в Таблице, этап 53)
    allowed = [
        entity for entity in ENTITIES
        if user["role"] == "admin" or not SIMPLE.get(entity, {}).get("admin")
    ] + list(DECISION_ENTITIES)
    mine = [
        History.user_name == user["login"],
        History.cancelled == False,  # noqa: E712
    ]
    last = session.query(History).filter(*mine).order_by(desc(History.id)).first()

    if last is None:
        raise HTTPException(status_code=404, detail="Отменять нечего.")

    age = datetime.now(timezone.utc) - last.at

    if age > UNDO_WINDOW:
        raise HTTPException(status_code=404, detail="Ctrl+Z отменяет только за 5 минут – остальное в Истории.")

    records = session.query(History).filter(*mine, History.at == last.at).order_by(History.id).with_for_update().all()

    # Последним могло быть то, что не отменяется: настройка (вид выделений, сканер),
    # создание, удаление, смена пароля – тогда не отменяется ничего (а не то, что было раньше)
    # Только создание или удаление объекта без отмены (новый тип техники, этап 66) – не «настройка»
    if any(record.entity not in allowed and not set(record.changes or {}) <= {"created", "deleted"} for record in records):
        raise HTTPException(status_code=400, detail="Последнее действие – настройка: она не отменяется.")

    if any(
        field_kind(record.entity, field) == "fixed" and not moved_room(record, field)
        for record in records for field in record.changes or {}
    ):
        raise HTTPException(status_code=400, detail="Последнее действие – создание или удаление: оно не отменяется.")

    pairs = [
        (record, field)
        for record in records
        for field, change in (record.changes or {}).items()
        if not change.get("cancelled")
    ]

    # Что отменяется – словами, пока значения ещё прежние
    text = action_text(session, pairs)

    # Сделано больше минуты назад – сначала спросить (этап 47)
    if age > UNDO_CONFIRM and (payload is None or payload.confirm_id != last.id):
        session.rollback()
        return {"ok": False, "confirm": True, "text": text, "age": int(age.total_seconds()), "last_id": last.id}

    batch = ChangeBatch(user["login"])
    count = cancel_changes(session, pairs, True, user, batch)
    batch.finish(session)
    session.commit()

    return {
        "ok": True, "count": count, "text": text,
        "items": [{"id": record.id, "field": field} for record, field in pairs],
        "entities": sorted({record.entity for record, _ in pairs}),
    }


class RevertRequest(BaseModel):
    id: int                         # запись истории
    field: str
    initial: bool = False           # True – исходное значение («было» первого изменения)


@router.post("/history/revert")
def revert_history(payload: RevertRequest, user=Depends(require_editor), session=Depends(get_db)):
    """Вернуть полю значение из истории; в Историю – запись «возврат значения»."""
    record = session.get(History, payload.id)

    if not record or payload.field not in (record.changes or {}):
        raise HTTPException(status_code=404, detail="Запись не найдена. Обнови историю.")

    batch = ChangeBatch(user["login"])
    revert_value(session, record, payload.field, payload.initial, user, batch)
    batch.finish(session)
    session.commit()

    return {"ok": True, "shifted": batch.changed_ids()}
