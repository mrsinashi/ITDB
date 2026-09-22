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


def node_title(location):
    if (
        location.kind == "room"
        and location.code
        and location.name
        and location.code != location.name
    ):
        return f"{location.code} {location.name}"

    return location.name


@router.get("/computers")
def list_computers():
    session = SessionLocal()

    try:
        computers = session.query(Computer).all()
        locations = session.query(Location).all()

        locations_by_id = {location.id: location for location in locations}

        location_paths = {}

        for location in locations:
            parts = []
            current = location
            depth = 0

            while current and depth < 20:
                parts.append(node_title(current))
                current = locations_by_id.get(current.parent_id)
                depth += 1

            location_paths[location.id] = " / ".join(reversed(parts))

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

            vacuum_logins = vacuum_by_computer.get(computer.id, [])
            vacuum_text = "\n".join(sorted(vacuum_logins, key=str.lower)) if vacuum_logins else None

            rows.append(
                {
                    "id": computer.id,
                    "status": computer.status,
                    "location_id": computer.location_id,
                    "location_path": location_paths.get(computer.location_id, ""),
                    "seat_no": computer.seat_no,
                    "hostname": computer.hostname,
                    "ip": computer.ip,
                    "mac": computer.mac,
                    "inv_no": computer.inv_no,
                    "serial": computer.serial,
                    "type": computer.type,
                    "model": computer.model,
                    "os": computer.os,
                    "cpu": computer.cpu,
                    "ram": computer.ram,
                    "drive": computer.drive,
                    "gpu": computer.gpu,
                    "vnc": computer.vnc,
                    "user": main_user_by_computer.get(computer.id),
                    "vacuum": vacuum_text,
                    "gsit": extra.get("GSIT"),
                    "state": extra.get("Сост."),
                    "label": extra.get("Метка"),
                    "note": computer.note,
                    "updated_at": computer.updated_at,
                }
            )

        rows.sort(
            key=lambda row: (
                (row["location_path"] or "").lower(),
                row["seat_no"] is None,
                row["seat_no"] or 0,
                (row["hostname"] or "").lower(),
            )
        )

        return {
            "total": len(rows),
            "rows": rows,
        }

    finally:
        session.close()