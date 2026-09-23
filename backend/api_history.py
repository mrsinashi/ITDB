from fastapi import APIRouter
from sqlalchemy import desc

from db import SessionLocal
from models import Computer, History, Location

router = APIRouter(prefix="/api", tags=["history"])


@router.get("/history")
def history(limit: int = 200):
    if limit < 1:
        limit = 1

    if limit > 500:
        limit = 500

    session = SessionLocal()

    try:
        items = (
            session.query(History)
            .order_by(desc(History.at), desc(History.id))
            .limit(limit)
            .all()
        )

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
        }

    finally:
        session.close()