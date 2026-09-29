from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc, func, text

from api_computers import ChangeBatch
from auth import get_current_user, require_editor
from db import get_db
from history_undo import SIMPLE, Ref, cancel_changes, find_object, object_title, revert_value, value_history
from models import Computer, History, Location

router = APIRouter(prefix="/api", tags=["history"])


HISTORY_PAGE_MAX = 5000


def valid_time_zone(session, tz):
    """Часовой пояс браузера (например, Asia/Irkutsk), если его знает база; иначе UTC."""
    if tz and session.execute(
        text("select 1 from pg_timezone_names where name = :tz"), {"tz": tz}
    ).first():
        return tz

    return "UTC"


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
    me=Depends(get_current_user),
    session=Depends(get_db),
):
    """Записи истории, новые сверху, порциями: limit (до 5000) начиная с offset.
    total — сколько записей всего, days — сколько записей в каждый день
    (день — по часовому поясу tz браузера): счётчики точные, даже если
    загружена только часть записей.
    Фильтры: user — кто менял, entity (+ entity_id / entity_key) — что менялось.
    Записи о пользователях системы видит только администратор.
    Отменённые целиком записи — только с cancelled=true (и в счётчиках тоже).
    users — все, кто что-либо менял (для фильтра)."""
    limit = min(max(limit, 1), HISTORY_PAGE_MAX)
    offset = max(offset, 0)

    filters = []

    if me["role"] != "admin":
        filters.append(History.entity != "users")

    if user:
        filters.append(History.user_name == user)

    if entity:
        filters.append(History.entity == entity)

        if entity_id is not None:
            filters.append(History.entity_id == entity_id)

        if entity_key is not None:
            filters.append(History.entity_key == entity_key)

    if not cancelled:
        filters.append(History.cancelled == False)

    total = session.query(func.count(History.id)).filter(*filters).scalar()

    items = (
        session.query(History)
        .filter(*filters)
        .order_by(desc(History.at), desc(History.id))
        .offset(offset)
        .limit(limit)
        .all()
    )

    day = func.date(func.timezone(valid_time_zone(session, tz), History.at))
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

    computer_ids = set()
    location_ids = set()

    for item in items:
        if item.entity == "computers":
            computer_ids.add(item.entity_id)
        elif item.entity == "locations":
            location_ids.add(item.entity_id)

    hostname_by_id = {}

    if computer_ids:
        computers = (
            session.query(Computer)
            .filter(Computer.id.in_(computer_ids))
            .all()
        )

        for computer in computers:
            hostname_by_id[computer.id] = computer.hostname

    location_name_by_id = {}

    if location_ids:
        locations = (
            session.query(Location)
            .filter(Location.id.in_(location_ids))
            .all()
        )

        for location in locations:
            location_name_by_id[location.id] = location.name

    # Справочники, поля, оформление, пользователи — название сейчас, а если
    # объекта уже нет (удалённое значение) — каким оно было при записи
    simple_titles = {}

    for item in items:
        ref = Ref(item.entity, item.entity_id, item.entity_key)

        if item.entity in SIMPLE and ref not in simple_titles:
            obj = find_object(session, ref, lock=False)
            simple_titles[ref] = object_title(session, obj, ref) if obj is not None else None

    result = []

    for item in items:
        title = None

        if item.entity == "computers":
            title = hostname_by_id.get(item.entity_id)
        elif item.entity == "locations":
            title = location_name_by_id.get(item.entity_id)
        elif item.entity in SIMPLE:
            title = simple_titles.get(Ref(item.entity, item.entity_id, item.entity_key)) or item.title

        result.append(
            {
                "id": item.id,
                "entity": item.entity,
                "entity_id": item.entity_id,
                "entity_key": item.entity_key,
                "user_name": item.user_name,
                "at": item.at,
                "title": title,
                "changes": item.changes,
                "cancelled": item.cancelled,
            }
        )

    return {
        "items": result,
        "total": total,
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
    """Все изменения одного поля объекта (и отменённые) — окно «История значения»."""
    if entity == "users" and me["role"] != "admin":
        raise HTTPException(status_code=403, detail="Это доступно только администратору.")

    return value_history(session, Ref(entity, entity_id, entity_key), field)


class CancelItem(BaseModel):
    id: int
    field: Optional[str] = None     # без поля — все поля записи


class CancelRequest(BaseModel):
    items: list[CancelItem]
    cancel: bool = True             # False — восстановить отменённые


@router.post("/history/cancel")
def cancel_history(payload: CancelRequest, user=Depends(require_editor), session=Depends(get_db)):
    """Отменить изменения (пометка «отменено», новой записи нет; значение
    пересчитывается по оставшимся) или восстановить отменённые."""
    if not payload.items:
        raise HTTPException(status_code=400, detail="Не выбраны изменения.")

    ids = {item.id for item in payload.items}
    records = {
        record.id: record
        for record in session.query(History).filter(History.id.in_(ids)).with_for_update().all()
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


class RevertRequest(BaseModel):
    id: int                         # запись истории
    field: str
    initial: bool = False           # True — исходное значение («было» первого изменения)


@router.post("/history/revert")
def revert_history(payload: RevertRequest, user=Depends(require_editor), session=Depends(get_db)):
    """Вернуть полю значение из истории; в Историю — запись «возврат значения»."""
    record = session.get(History, payload.id)

    if not record or payload.field not in (record.changes or {}):
        raise HTTPException(status_code=404, detail="Запись не найдена. Обнови историю.")

    batch = ChangeBatch(user["login"])
    revert_value(session, record, payload.field, payload.initial, user, batch)
    batch.finish(session)
    session.commit()

    return {"ok": True, "shifted": batch.changed_ids()}
