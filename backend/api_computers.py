from collections import defaultdict

from fastapi import APIRouter

from db import SessionLocal
from models import (
    Computer,
    ComputerPerson,
    Location,
    Person,
    VacuumAccount,
    VacuumAccountComputer,
)

router = APIRouter(prefix="/api", tags=["computers"])


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