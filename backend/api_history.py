from fastapi import APIRouter, Depends
from sqlalchemy import desc, func, text

from db import get_db
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
def history(limit: int = 200, offset: int = 0, tz: str = "UTC", session=Depends(get_db)):
    """Записи истории, новые сверху, порциями: limit (до 5000) начиная с offset.
    total — сколько записей всего, days — сколько записей в каждый день
    (день — по часовому поясу tz браузера): счётчики точные, даже если
    загружена только часть записей."""
    limit = min(max(limit, 1), HISTORY_PAGE_MAX)
    offset = max(offset, 0)

    total = session.query(func.count(History.id)).scalar()

    items = (
        session.query(History)
        .order_by(desc(History.at), desc(History.id))
        .offset(offset)
        .limit(limit)
        .all()
    )

    day = func.date(func.timezone(valid_time_zone(session, tz), History.at))
    days = {
        value.strftime("%d.%m.%Y"): count
        for value, count in session.query(day, func.count(History.id)).group_by(day).all()
    }

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

    result = []

    for item in items:
        title = None

        if item.entity == "computers":
            title = hostname_by_id.get(item.entity_id)
        elif item.entity == "locations":
            title = location_name_by_id.get(item.entity_id)

        result.append(
            {
                "id": item.id,
                "entity": item.entity,
                "entity_id": item.entity_id,
                "user_name": item.user_name,
                "at": item.at,
                "title": title,
                "changes": item.changes,
            }
        )

    return {
        "items": result,
        "total": total,
        "days": days,
    }
