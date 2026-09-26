from collections import defaultdict
from datetime import datetime, timezone
import re

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func

from api_import import split_vacuum_logins
from auth import require_editor

from db import SessionLocal
from models import (
    Computer,
    ComputerPerson,
    FieldDef,
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

# Поля-связи: хранятся не в computers, а в отдельных таблицах
LINK_FIELDS = {"user", "vacuum"}

# Ключи, которые уже заняты встроенными полями строки таблицы.
# Пользовательское поле с таким ключом затёрло бы встроенное значение.
RESERVED_FIELD_KEYS = (
    SINGLE_FIELDS
    | MULTILINE_FIELDS
    | EXTRA_FIELDS.keys()
    | LINK_FIELDS
    | {
        "id",
        "location_id",
        "building",
        "department",
        "floor",
        "room_code",
        "room_name",
        "seat_no",
        "seat_sort",
        "ip",
        "mac",
        "glpi_id",
        "temp_note",
        "extra",
        "version",
        "updated_at",
    }
)

# Ключи в computers.extra, под которыми лежат встроенные GSIT / Сост. / Метка.
# Пользовательское поле с таким ключом (старые поля, созданные до проверки
# ключа) показывало бы те же значения второй раз.
EXTRA_STORAGE_KEYS = {value.lower() for value in EXTRA_FIELDS.values()}


def is_reserved_field_key(key):
    """Ключ пользовательского поля совпадает со встроенным (без учёта регистра)."""
    lowered = (key or "").strip().lower()
    return lowered in RESERVED_FIELD_KEYS or lowered in EXTRA_STORAGE_KEYS


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


def normalize_person_name(value):
    if value is None:
        return None

    text = " ".join(str(value).split())

    return text if text else None


def get_main_person_link(session, computer_id):
    """Связь ПК с «главным» человеком — тот, кого показывает таблица."""
    links = (
        session.query(ComputerPerson)
        .filter(ComputerPerson.computer_id == computer_id)
        .all()
    )

    if not links:
        return None, links

    links.sort(key=lambda item: (not item.is_main, item.sort, item.id))

    return links[0], links


def set_main_person(session, computer, value):
    """Меняет главного пользователя ПК. Возвращает (old, new) или None."""
    new_name = normalize_person_name(value)

    main_link, links = get_main_person_link(session, computer.id)

    old_person = session.get(Person, main_link.person_id) if main_link else None
    old_name = old_person.full_name if old_person else None

    if old_name == new_name:
        return None

    # Тот же человек, поменялся только регистр букв — правим само ФИО
    if old_person and new_name and old_name.lower() == new_name.lower():
        old_person.full_name = new_name
        return old_name, new_name

    if main_link:
        session.delete(main_link)
        session.flush()

    if new_name:
        person = (
            session.query(Person)
            .filter(func.lower(Person.full_name) == new_name.lower())
            .first()
        )

        if not person:
            person = Person(full_name=new_name)
            session.add(person)
            session.flush()

        existing = None

        for link in links:
            if link is not main_link and link.person_id == person.id:
                existing = link
                break

        if existing:
            existing.is_main = True
            existing.sort = 0
        else:
            session.add(
                ComputerPerson(
                    computer_id=computer.id,
                    person_id=person.id,
                    is_main=True,
                    sort=0,
                )
            )

        new_name = person.full_name

    return old_name, new_name


def get_vacuum_logins(session, computer_id):
    rows = (
        session.query(VacuumAccount.login)
        .join(
            VacuumAccountComputer,
            VacuumAccountComputer.account_id == VacuumAccount.id,
        )
        .filter(VacuumAccountComputer.computer_id == computer_id)
        .all()
    )

    return sorted([row[0] for row in rows], key=str.lower)


def vacuum_text(logins):
    return "\n".join(sorted(logins, key=str.lower)) if logins else None


def set_vacuum_logins(session, computer, value):
    """Заменяет набор логинов VACUUM у ПК. Возвращает (old, new) или None."""
    new_logins = split_vacuum_logins(value)

    links = (
        session.query(VacuumAccountComputer, VacuumAccount)
        .join(VacuumAccount, VacuumAccountComputer.account_id == VacuumAccount.id)
        .filter(VacuumAccountComputer.computer_id == computer.id)
        .all()
    )

    old_logins = [account.login for _, account in links]

    if set(old_logins) == set(new_logins):
        return None

    for link, account in links:
        if account.login not in new_logins:
            session.delete(link)

    for login in new_logins:
        if login in old_logins:
            continue

        account = (
            session.query(VacuumAccount)
            .filter(VacuumAccount.login == login)
            .first()
        )

        if not account:
            account = VacuumAccount(login=login)
            session.add(account)
            session.flush()

        session.add(
            VacuumAccountComputer(
                account_id=account.id,
                computer_id=computer.id,
            )
        )

    return vacuum_text(old_logins), vacuum_text(new_logins)


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

        field_defs = (
            session.query(FieldDef)
            .filter(FieldDef.archived == False)
            .order_by(FieldDef.sort, FieldDef.id)
            .all()
        )
        field_defs = [fd for fd in field_defs if not is_reserved_field_key(fd.key)]

        vacuum_by_computer = defaultdict(list)

        for computer_id, login in vacuum_rows:
            vacuum_by_computer[computer_id].append(login)

        rows = []

        for computer in computers:
            extra = computer.extra or {}
            parts = get_location_parts(computer.location_id)

            vacuum_logins = vacuum_by_computer.get(computer.id, [])

            seat_sort = computer.seat_sort
            if seat_sort is not None:
                seat_sort = float(seat_sort)

            # Пользовательские поля идут первыми: при совпадении ключа
            # встроенное значение ниже их перекроет, а не наоборот.
            row = {fd.key: extra.get(fd.key) for fd in field_defs}

            row.update(
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
                    "vacuum": vacuum_text(vacuum_logins),
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
                    "version": computer.version,
                    "updated_at": computer.updated_at,
                }
            )

            rows.append(row)

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
    user=Depends(require_editor),
):
    session = SessionLocal()

    try:
        payload = dict(payload)

        # Версия записи, которую видел пользователь. Если за это время ПК
        # кто-то изменил — не затираем чужую правку, а просим обновить.
        expected_version = payload.pop("_version", None)

        computer = (
            session.query(Computer)
            .filter(Computer.id == computer_id)
            .with_for_update()
            .first()
        )

        if not computer:
            raise HTTPException(
                status_code=404,
                detail="Компьютер не найден.",
            )

        if expected_version is not None:
            try:
                expected_version = int(expected_version)
            except (TypeError, ValueError):
                raise HTTPException(
                    status_code=400,
                    detail="_version должен быть числом.",
                )

            if expected_version != computer.version:
                raise HTTPException(
                    status_code=409,
                    detail="Этот компьютер уже изменил другой пользователь. "
                    "Таблица будет обновлена — проверь значение и повтори правку.",
                )

        changes = {}

        extra = dict(computer.extra or {})
        extra_changed = False

        user_field_defs = (
            session.query(FieldDef)
            .filter(FieldDef.archived == False)
            .all()
        )
        # Ключи, совпадающие со встроенными полями, как пользовательские не принимаем
        user_field_keys = {
            fd.key for fd in user_field_defs if not is_reserved_field_key(fd.key)
        }
        allowed_fields = (
            SINGLE_FIELDS
            | MULTILINE_FIELDS
            | EXTRA_FIELDS.keys()
            | LINK_FIELDS
            | {"ip", "mac", "seat_no"}
            | user_field_keys
        )

        for field, value in payload.items():
            if field not in allowed_fields:
                raise HTTPException(
                    status_code=400,
                    detail=f"Неизвестное поле: {field}",
                )

            if field == "user":
                result = set_main_person(session, computer, value)

                if result:
                    changes["user"] = {"old": result[0], "new": result[1]}

                continue

            if field == "vacuum":
                result = set_vacuum_logins(session, computer, value)

                if result:
                    changes["vacuum"] = {"old": result[0], "new": result[1]}

                continue

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

            elif field in EXTRA_FIELDS or field in user_field_keys:
                extra_key = EXTRA_FIELDS.get(field, field)
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
                    user_name=user["login"],
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
            "version": computer.version,
            "updated_at": computer.updated_at,
        }

        for field in SINGLE_FIELDS:
            updated[field] = getattr(computer, field)

        for frontend_key, extra_key in EXTRA_FIELDS.items():
            updated[frontend_key] = extra.get(extra_key)

        for key in user_field_keys:
            updated[key] = extra.get(key)

        main_link, _ = get_main_person_link(session, computer.id)
        main_person = session.get(Person, main_link.person_id) if main_link else None
        updated["user"] = main_person.full_name if main_person else None

        updated["vacuum"] = vacuum_text(get_vacuum_logins(session, computer.id))

        # Снимаем блокировку строки, если правок не было
        session.rollback()

        return {
            "ok": True,
            "id": computer_id,
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

@router.get("/computers/{computer_id}")
def get_computer(computer_id: int):
    session = SessionLocal()

    try:
        computer = session.get(Computer, computer_id)

        if not computer:
            raise HTTPException(
                status_code=404,
                detail="Компьютер не найден.",
            )

        links = (
            session.query(ComputerPerson, Person)
            .join(Person, ComputerPerson.person_id == Person.id)
            .filter(ComputerPerson.computer_id == computer_id)
            .all()
        )

        people = [
            {
                "person_id": person.id,
                "full_name": person.full_name,
                "position": person.position,
                "is_main": link.is_main,
                "sort": link.sort or 0,
            }
            for link, person in links
        ]

        people.sort(
            key=lambda item: (not item["is_main"], item["sort"], item["person_id"])
        )

        vacuum_rows = (
            session.query(VacuumAccount.login)
            .join(
                VacuumAccountComputer,
                VacuumAccountComputer.account_id == VacuumAccount.id,
            )
            .filter(VacuumAccountComputer.computer_id == computer_id)
            .all()
        )

        vacuum = sorted([row[0] for row in vacuum_rows], key=str.lower)

        items = (
            session.query(History)
            .filter(
                History.entity == "computers",
                History.entity_id == computer_id,
            )
            .order_by(History.at.desc(), History.id.desc())
            .limit(20)
            .all()
        )

        history = [
            {
                "id": item.id,
                "at": item.at,
                "user_name": item.user_name,
                "changes": item.changes or {},
            }
            for item in items
        ]

        return {
            "people": people,
            "vacuum": vacuum,
            "history": history,
        }

    finally:
        session.close()