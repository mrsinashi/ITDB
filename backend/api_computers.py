from collections import defaultdict
from datetime import datetime, timezone
import re

from fastapi import APIRouter, Body, HTTPException

from db import SessionLocal
from models import (
    Computer,
    ComputerPerson,
    History,
    Location,
    Person,
    VacuumAccount,
    VacuumAccountComputer,
)

router = APIRouter(prefix="/api", tags=["computers"])

SINGLE_FIELDS = {
    "status",
    "hostname",
    "inv_no",
    "serial",
    "type",
    "model",
    "os",
    "cpu",
    "ram",
    "gpu",
    "vnc",
}

MULTILINE_FIELDS = {
    "drive",
    "note",
}

EXTRA_FIELDS = {
    "gsit": "GSIT",
    "state": "Сост.",
    "label": "Метка",
}


def normalize_single(value):
    if value is None:
        return None

    text = str(value).strip()

    return text if text else None


def normalize_multiline(value):
    if value is None:
        return None

    text = str(value)

    lines = []

    for line in text.splitlines():
        line = line.strip()

        if line:
            lines.append(line)

    if not lines:
        return None

    return "\n".join(lines)


def normalize_ip(value):
    if value is None:
        return None

    text = str(value).strip()

    if not text:
        return None

    parts = []

    for part in re.split(r"[\s,;]+", text):
        part = part.strip()

        if part:
            parts.append(part)

    if not parts:
        return None

    return "\n".join(parts)


def normalize_mac(value):
    if value is None:
        return None

    text = str(value).strip()

    if not text:
        return None

    parts = []

    for part in re.split(r"[\s,;]+", text):
        part = part.strip().upper()

        if part:
            parts.append(part)

    if not parts:
        return None

    return "\n".join(parts)


def parse_seat_no(value):
    text = normalize_single(value)

    if text is None:
        return None

    try:
        number = float(text.replace(",", "."))
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Номер места должен быть целым числом.",
        )

    if not number.is_integer():
        raise HTTPException(
            status_code=400,
            detail="Номер места должен быть целым числом.",
        )

    return int(number)


@router.get("/computers")
def list_computers():
    session = SessionLocal()

    try:
        computers = session.query(Computer).all()
        locations = session.query(Location).all()

        locations_by_id = {location.id: location for location in locations}

        location_sort_keys = {}

        for location in locations:
            sort_parts = []
            current = location
            depth = 0

            while current and depth < 20:
                sort_parts.append(current.sort or 0)
                current = locations_by_id.get(current.parent_id)
                depth += 1

            location_sort_keys[location.id] = tuple(reversed(sort_parts))

        location_parts_cache = {}

        def get_location_parts(location_id):
            if location_id is None:
                return {
                    "building": None,
                    "department": None,
                    "floor": None,
                    "room_code": None,
                    "room_name": None,
                }

            if location_id in location_parts_cache:
                return location_parts_cache[location_id]

            parts = {
                "building": None,
                "department": None,
                "floor": None,
                "room_code": None,
                "room_name": None,
            }

            current = locations_by_id.get(location_id)
            depth = 0

            while current and depth < 20:
                if current.kind == "building" and parts["building"] is None:
                    parts["building"] = current.name

                elif current.kind == "department" and parts["department"] is None:
                    parts["department"] = current.name

                elif current.kind == "floor" and parts["floor"] is None:
                    parts["floor"] = current.name

                elif current.kind == "room" and parts["room_code"] is None and parts["room_name"] is None:
                    code = current.code
                    name = current.name

                    if code and name == code:
                        parts["room_code"] = code
                        parts["room_name"] = None
                    else:
                        parts["room_code"] = code
                        parts["room_name"] = name

                current = locations_by_id.get(current.parent_id)
                depth += 1

            location_parts_cache[location_id] = parts

            return parts

        people = session.query(Person).all()
        people_by_id = {person.id: person for person in people}

        computer_people = session.query(ComputerPerson).all()
        people_links_by_computer = defaultdict(list)

        for link in computer_people:
            people_links_by_computer[link.computer_id].append(link)

        main_user_by_computer = {}

        for computer_id, links in people_links_by_computer.items():
            links.sort(key=lambda item: (not item.is_main, item.sort, item.id))

            person = people_by_id.get(links[0].person_id)

            if person:
                main_user_by_computer[computer_id] = person.full_name

        vacuum_rows = (
            session.query(VacuumAccountComputer.computer_id, VacuumAccount.login)
            .join(
                VacuumAccount,
                VacuumAccountComputer.account_id == VacuumAccount.id,
            )
            .all()
        )

        vacuum_by_computer = defaultdict(list)

        for computer_id, login in vacuum_rows:
            vacuum_by_computer[computer_id].append(login)

        rows = []

        for computer in computers:
            extra = computer.extra or {}
            parts = get_location_parts(computer.location_id)

            vacuum_logins = vacuum_by_computer.get(computer.id, [])
            vacuum_text = "\n".join(sorted(vacuum_logins, key=str.lower)) if vacuum_logins else None

            seat_sort = computer.seat_sort
            if seat_sort is not None:
                seat_sort = float(seat_sort)

            rows.append(
                {
                    "id": computer.id,
                    "location_id": computer.location_id,
                    "user": main_user_by_computer.get(computer.id),
                    "building": parts["building"],
                    "department": parts["department"],
                    "floor": parts["floor"],
                    "room_code": parts["room_code"],
                    "room_name": parts["room_name"],
                    "seat_no": computer.seat_no,
                    "_seat_sort": seat_sort,
                    "ip": computer.ip,
                    "hostname": computer.hostname,
                    "vacuum": vacuum_text,
                    "os": computer.os,
                    "type": computer.type,
                    "model": computer.model,
                    "cpu": computer.cpu,
                    "ram": computer.ram,
                    "drive": computer.drive,
                    "gpu": computer.gpu,
                    "mac": computer.mac,
                    "inv_no": computer.inv_no,
                    "serial": computer.serial,
                    "gsit": extra.get("GSIT"),
                    "state": extra.get("Сост."),
                    "label": extra.get("Метка"),
                    "status": computer.status,
                    "note": computer.note,
                    "updated_at": computer.updated_at,
                }
            )

        def sort_key(row):
            location_key = location_sort_keys.get(row["location_id"])

            if location_key is None:
                location_key = (999999,)

            seat_sort = row["_seat_sort"]

            return (
                location_key,
                seat_sort is None,
                seat_sort if seat_sort is not None else 0,
                (row["hostname"] or "").lower(),
                row["id"],
            )

        rows.sort(key=sort_key)

        for row in rows:
            row.pop("_seat_sort", None)

        return {
            "total": len(rows),
            "rows": rows,
        }

    finally:
        session.close()


@router.patch("/computers/{computer_id}")
def update_computer(
    computer_id: int,
    payload: dict = Body(...),
):
    session = SessionLocal()

    try:
        computer = session.get(Computer, computer_id)

        if not computer:
            raise HTTPException(
                status_code=404,
                detail="Компьютер не найден.",
            )

        changes = {}

        extra = dict(computer.extra or {})
        extra_changed = False

        allowed_fields = (
            SINGLE_FIELDS
            | MULTILINE_FIELDS
            | EXTRA_FIELDS.keys()
            | {"ip", "mac", "seat_no"}
        )

        for field, value in payload.items():
            if field not in allowed_fields:
                raise HTTPException(
                    status_code=400,
                    detail=f"Неизвестное поле: {field}",
                )

            if field == "seat_no":
                new_value = parse_seat_no(value)
                old_value = computer.seat_no

            elif field == "ip":
                new_value = normalize_ip(value)
                old_value = computer.ip

            elif field == "mac":
                new_value = normalize_mac(value)
                old_value = computer.mac

            elif field in MULTILINE_FIELDS:
                new_value = normalize_multiline(value)
                old_value = getattr(computer, field)

            elif field in SINGLE_FIELDS:
                new_value = normalize_single(value)
                old_value = getattr(computer, field)

                if field == "status" and new_value is None:
                    new_value = "установлен"

            elif field in EXTRA_FIELDS:
                extra_key = EXTRA_FIELDS[field]
                new_value = normalize_single(value)
                old_value = extra.get(extra_key)

                if old_value != new_value:
                    changes[f"extra.{extra_key}"] = {
                        "old": old_value,
                        "new": new_value,
                    }

                    if new_value is None:
                        extra.pop(extra_key, None)
                    else:
                        extra[extra_key] = new_value

                    extra_changed = True

                continue

            else:
                continue

            if old_value != new_value:
                changes[field] = {
                    "old": old_value,
                    "new": new_value,
                }

                setattr(computer, field, new_value)

        if changes:
            if extra_changed:
                computer.extra = extra

            computer.version = (computer.version or 1) + 1
            computer.updated_at = datetime.now(timezone.utc)

            session.add(
                History(
                    entity="computers",
                    entity_id=computer.id,
                    user_name=None,
                    changes=changes,
                )
            )

            session.commit()

        updated = {
            "seat_no": computer.seat_no,
            "ip": computer.ip,
            "mac": computer.mac,
            "drive": computer.drive,
            "note": computer.note,
        }

        for field in SINGLE_FIELDS:
            updated[field] = getattr(computer, field)

        for frontend_key, extra_key in EXTRA_FIELDS.items():
            updated[frontend_key] = extra.get(extra_key)

        return {
            "ok": True,
            "id": computer.id,
            "changes": changes,
            "updated": updated,
        }

    except HTTPException:
        session.rollback()
        raise

    except Exception as e:
        session.rollback()
        raise HTTPException(
            status_code=400,
            detail=f"Не удалось сохранить изменения: {e}",
        )

    finally:
        session.close()