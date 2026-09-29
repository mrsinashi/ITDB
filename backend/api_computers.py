from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal
import re

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func

from api_columns import COLUMNS, COLUMNS_BY_KEY, EDITABLE_KEYS, EXTRA_FIELDS, keys_of
from api_import import split_vacuum_logins
from auth import require_editor

from db import get_db
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

SINGLE_FIELDS = keys_of("text")

MULTILINE_FIELDS = keys_of("multiline")

DATE_FIELDS = keys_of("date")

# Поля-связи: хранятся не в computers, а в отдельных таблицах
LINK_FIELDS = keys_of("user", "vacuum")

# Ключи, которые уже заняты встроенными полями строки таблицы.
# Пользовательское поле с таким ключом затёрло бы встроенное значение.
RESERVED_FIELD_KEYS = set(COLUMNS_BY_KEY) | {
    "id",
    "location_id",
    "seat_sort",
    "extra",
    "version",
    "updated_at",
    "archived",
}

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


def parse_date(value):
    """Дата из ввода: «15.10.2026», «15.10.26», «15.10» (этот год),
    «2026-10-15». Пусто — None, не дата — 400."""
    text = normalize_single(value)

    if text is None:
        return None

    parts = None
    m = re.fullmatch(r"(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?", text)

    if m:
        year = int(m.group(3)) if m.group(3) else date.today().year
        parts = (year + 2000 if year < 100 else year, int(m.group(2)), int(m.group(1)))
    else:
        m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", text)

        if m:
            parts = (int(m.group(1)), int(m.group(2)), int(m.group(3)))

    try:
        if parts:
            return date(*parts)
    except ValueError:
        pass

    raise HTTPException(
        status_code=400,
        detail=f"«{text}» — не дата. Нужно ДД.ММ.ГГГГ, например 15.10.2026.",
    )


def format_date(value):
    """Дата для API и истории — только цифрами: «15.10.2026»."""
    return value.strftime("%d.%m.%Y") if value else None


LOCATION_PART_FIELDS = ("building", "department", "floor", "room_code", "room_name")


def load_locations(session):
    return {location.id: location for location in session.query(Location).all()}


def location_parts(location_id, locations_by_id):
    """Адрес / отделение / этаж / кабинет ПК — для строки таблицы."""
    parts = {field: None for field in LOCATION_PART_FIELDS}

    current = locations_by_id.get(location_id) if location_id is not None else None
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

            parts["room_code"] = code
            parts["room_name"] = None if code and name == code else name

        current = locations_by_id.get(current.parent_id)
        depth += 1

    return parts


def location_title(location):
    """Подпись узла как в дереве: «214 Процедурная», «2 этаж»."""
    name = location.name or ""
    code = ""

    if location.kind == "room" and location.code:
        code = location.code
        name = "" if not location.name or location.name == location.code else location.name

    if location.kind == "floor" and name.strip().isdigit():
        name = name + " этаж"

    return " ".join(part for part in (code, name) if part) or location.name or location.code or ""


def location_path(location_id, locations_by_id):
    """Полный путь узла для истории: «ул. Ленина, 1 / Терапия / 201 Ординаторская».
    Разделитель не «→»: в истории стрелкой уже показано «было → стало»."""
    titles = []
    current = locations_by_id.get(location_id) if location_id is not None else None
    depth = 0

    while current and depth < 20:
        titles.append(location_title(current))
        current = locations_by_id.get(current.parent_id)
        depth += 1

    return " / ".join(reversed(titles)) if titles else None


def get_active_location(session, value):
    """Узел дерева по id из запроса; архивный или несуществующий — ошибка."""
    if value is None or value == "":
        raise HTTPException(
            status_code=400,
            detail="Выбери расположение.",
        )

    try:
        location_id = int(value)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400,
            detail="location_id должен быть числом.",
        )

    location = session.get(Location, location_id)

    if not location or location.archived:
        raise HTTPException(
            status_code=400,
            detail="Расположение не найдено.",
        )

    return location


def seat_sort_in_location(session, location_id, seat_no, exclude_id=None):
    """Порядок строки ПК в узле: после соседей с номером места не больше
    его номера, без номера места — в конец узла."""
    query = session.query(Computer).filter(
        Computer.location_id == location_id,
        Computer.seat_sort.isnot(None),
    )

    if exclude_id is not None:
        query = query.filter(Computer.id != exclude_id)

    neighbours = query.order_by(Computer.seat_sort, Computer.id).all()

    if not neighbours:
        return Decimal(1)

    if seat_no is None:
        return neighbours[-1].seat_sort + 1

    before = [
        index
        for index, item in enumerate(neighbours)
        if item.seat_no is not None and item.seat_no <= seat_no
    ]

    if not before:
        return neighbours[0].seat_sort - 1

    index = before[-1]

    if index + 1 < len(neighbours):
        return (neighbours[index].seat_sort + neighbours[index + 1].seat_sort) / 2

    return neighbours[index].seat_sort + 1


class ChangeBatch:
    """Изменения нескольких ПК за одно действие: на каждый ПК — одна запись
    истории (поле: было → стало), версия +1. Повторная правка того же поля
    сливается: «было» — первое, «стало» — последнее."""

    def __init__(self, user_name):
        self.user_name = user_name
        self.changes = defaultdict(dict)
        self.computers = {}

    def record(self, computer, field, old, new, old_id=None, new_id=None):
        """old_id / new_id — id узлов у расположения (old / new — путь текстом)."""
        changes = self.changes[computer.id]
        self.computers[computer.id] = computer

        if field in changes:
            changes[field]["new"] = new

            if new_id is not None:
                changes[field]["new_id"] = new_id

            if changes[field]["old"] == new:
                del changes[field]

        elif old != new:
            changes[field] = {"old": old, "new": new}

            if old_id is not None or new_id is not None:
                changes[field]["old_id"] = old_id
                changes[field]["new_id"] = new_id

    def finish(self, session):
        now = datetime.now(timezone.utc)

        for computer_id, changes in self.changes.items():
            if not changes:
                continue

            computer = self.computers[computer_id]
            computer.version = (computer.version or 1) + 1
            computer.updated_at = now

            session.add(
                History(
                    entity="computers",
                    entity_id=computer_id,
                    user_name=self.user_name,
                    changes=changes,
                )
            )

    def changed_ids(self):
        return sorted(key for key, changes in self.changes.items() if changes)


def shift_seats(session, batch, location_id, seat_no, exclude_ids=()):
    """Номер места seat_no в узле занят — ПК с этим и следующими подряд
    номерами сдвигаются на +1 (3, 4, 5 → 4, 5, 6; после пропуска — не трогаются).
    ПК из архива места не занимают."""
    if location_id is None or seat_no is None:
        return

    query = session.query(Computer).filter(
        Computer.location_id == location_id,
        Computer.archived == False,
        Computer.seat_no.isnot(None),
    )

    if exclude_ids:
        query = query.filter(Computer.id.notin_(list(exclude_ids)))

    by_seat = defaultdict(list)

    for computer in query.with_for_update().all():
        by_seat[computer.seat_no].append(computer)

    number = seat_no
    shifted = []

    while number in by_seat:
        shifted.extend(by_seat[number])
        number += 1

    for computer in shifted:
        batch.record(computer, "seat_no", computer.seat_no, computer.seat_no + 1)
        computer.seat_no += 1

    session.flush()


def replace_people(session, batch, source, target):
    """Пользователи и VACUUM ПК source переходят к ПК target (у target прежние
    связи снимаются). source=None — у target просто всё снимается."""
    old_main, target_links = get_main_person_link(session, target.id)
    old_person = session.get(Person, old_main.person_id) if old_main else None
    old_logins = get_vacuum_logins(session, target.id)

    for link in target_links:
        session.delete(link)

    session.query(VacuumAccountComputer).filter(
        VacuumAccountComputer.computer_id == target.id
    ).delete(synchronize_session=False)
    session.flush()

    if source is not None:
        session.query(ComputerPerson).filter(
            ComputerPerson.computer_id == source.id
        ).update({"computer_id": target.id}, synchronize_session=False)
        session.query(VacuumAccountComputer).filter(
            VacuumAccountComputer.computer_id == source.id
        ).update({"computer_id": target.id}, synchronize_session=False)
        session.flush()

        batch.record(source, "user", main_person_name(session, target), None)
        batch.record(source, "vacuum", vacuum_text(get_vacuum_logins(session, target.id)), None)

    batch.record(
        target,
        "user",
        old_person.full_name if old_person else None,
        main_person_name(session, target),
    )
    batch.record(
        target,
        "vacuum",
        vacuum_text(old_logins),
        vacuum_text(get_vacuum_logins(session, target.id)),
    )


def main_person_name(session, computer_id_or_computer):
    computer_id = getattr(computer_id_or_computer, "id", computer_id_or_computer)
    link, _ = get_main_person_link(session, computer_id)
    person = session.get(Person, link.person_id) if link else None
    return person.full_name if person else None


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


def column_values(computer, parts, user_name, vacuum):
    """Значения встроенных столбцов ПК (по описанию в api_columns)."""
    extra = computer.extra or {}
    values = {}

    for column in COLUMNS:
        if column.kind == "location":
            values[column.key] = parts[column.key]
        elif column.kind == "extra":
            values[column.key] = extra.get(column.extra_key)
        elif column.kind == "user":
            values[column.key] = user_name
        elif column.kind == "vacuum":
            values[column.key] = vacuum
        elif column.kind == "date":
            values[column.key] = format_date(getattr(computer, column.key))
        else:
            values[column.key] = getattr(computer, column.key)

    return values


ARCHIVED_FILTERS = ("no", "yes", "all")


@router.get("/computers")
def list_computers(archived: str = "no", session=Depends(get_db)):
    """Строки таблицы. archived: no — рабочие ПК (по умолчанию),
    yes — только архив, all — все (у строки есть признак archived)."""
    if archived not in ARCHIVED_FILTERS:
        raise HTTPException(
            status_code=400,
            detail="archived: no, yes или all.",
        )

    return computer_rows(session, archived)


def computer_rows(session, archived="no"):
    """Строки таблицы (для списка и выгрузки): {"total", "rows"}."""
    query = session.query(Computer)

    if archived == "no":
        query = query.filter(Computer.archived == False)
    elif archived == "yes":
        query = query.filter(Computer.archived == True)

    computers = query.all()
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
        if location_id not in location_parts_cache:
            location_parts_cache[location_id] = location_parts(location_id, locations_by_id)

        return location_parts_cache[location_id]

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
            column_values(
                computer,
                parts,
                main_user_by_computer.get(computer.id),
                vacuum_text(vacuum_logins),
            )
        )
        row.update(
            {
                "id": computer.id,
                "location_id": computer.location_id,
                "_seat_sort": seat_sort,
                "archived": computer.archived,
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


@router.post("/computers")
def create_computer(
    payload: dict = Body(...),
    user=Depends(require_editor),
    session=Depends(get_db),
):
    """Новый ПК: расположение обязательно, № места, HOSTNAME, IP — по желанию.
    Остальное заполняется потом в таблице или карточке."""
    location = get_active_location(session, payload.get("location_id"))

    seat_no = parse_seat_no(payload.get("seat_no"))
    hostname = normalize_single(payload.get("hostname"))
    ip = normalize_ip(payload.get("ip"))

    # Место занято — ПК на нём и дальше подряд сдвигаются на +1
    batch = ChangeBatch(user["login"])
    shift_seats(session, batch, location.id, seat_no)
    batch.finish(session)

    computer = Computer(
        status="установлен",
        location_id=location.id,
        seat_no=seat_no,
        seat_sort=seat_sort_in_location(session, location.id, seat_no),
        hostname=hostname,
        ip=ip,
        extra={},
    )
    session.add(computer)
    session.flush()

    locations_by_id = load_locations(session)

    changes = {
        "created": {
            "old": None,
            "new": location_path(location.id, locations_by_id),
        }
    }

    for field, value in (("seat_no", seat_no), ("hostname", hostname), ("ip", ip)):
        if value is not None:
            changes[field] = {"old": None, "new": value}

    session.add(
        History(
            entity="computers",
            entity_id=computer.id,
            user_name=user["login"],
            changes=changes,
        )
    )

    session.commit()

    return {"ok": True, "id": computer.id, "shifted": batch.changed_ids()}


@router.post("/computers/archive")
def archive_computers(
    payload: dict = Body(...),
    user=Depends(require_editor),
    session=Depends(get_db),
):
    """В архив или обратно: {"ids": [...], "archived": true/false}.
    ПК уже в нужном состоянии пропускаются. История — запись на каждый ПК."""
    ids = payload.get("ids")
    archived = payload.get("archived")

    if not isinstance(ids, list) or not ids:
        raise HTTPException(
            status_code=400,
            detail="Не выбраны компьютеры.",
        )

    if not isinstance(archived, bool):
        raise HTTPException(
            status_code=400,
            detail="archived должен быть true или false.",
        )

    try:
        ids = {int(value) for value in ids}
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400,
            detail="ids должны быть числами.",
        )

    computers = (
        session.query(Computer)
        .filter(Computer.id.in_(ids))
        .with_for_update()
        .all()
    )

    if len(computers) != len(ids):
        raise HTTPException(
            status_code=404,
            detail="Часть компьютеров не найдена. Обнови таблицу.",
        )

    now = datetime.now(timezone.utc)
    changed = []

    for computer in computers:
        if computer.archived == archived:
            continue

        session.add(
            History(
                entity="computers",
                entity_id=computer.id,
                user_name=user["login"],
                changes={"archived": {"old": computer.archived, "new": archived}},
            )
        )

        computer.archived = archived
        computer.version = (computer.version or 1) + 1
        computer.updated_at = now
        changed.append(computer.id)

    session.commit()

    return {"ok": True, "changed": sorted(changed)}


def user_field_keys_of(session):
    """Ключи пользовательских полей (кроме совпадающих со встроенными)."""
    defs = session.query(FieldDef).filter(FieldDef.archived == False).all()
    return {fd.key for fd in defs if not is_reserved_field_key(fd.key)}


def apply_fields(session, computer, payload, user_field_keys, batch):
    """Правка полей одного ПК (как в PATCH). Возвращает изменения этого ПК;
    сдвинутые соседи по номеру места попадают в batch."""
    changes = {}

    extra = dict(computer.extra or {})
    extra_changed = False

    allowed_fields = EDITABLE_KEYS | {"location_id"} | user_field_keys

    locations_by_id = None
    placement_changed = False
    seat_given = False

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

        if field == "location_id":
            location = get_active_location(session, value)

            if location.id != computer.location_id:
                locations_by_id = locations_by_id or load_locations(session)

                changes["location_id"] = {
                    "old": location_path(computer.location_id, locations_by_id),
                    "new": location_path(location.id, locations_by_id),
                    # id узлов — чтобы откат из истории не зависел от названий
                    "old_id": computer.location_id,
                    "new_id": location.id,
                }

                computer.location_id = location.id
                placement_changed = True

            continue

        if field == "vacuum":
            result = set_vacuum_logins(session, computer, value)

            if result:
                changes["vacuum"] = {"old": result[0], "new": result[1]}

            continue

        if field == "seat_no":
            new_value = parse_seat_no(value)
            old_value = computer.seat_no

            if old_value != new_value:
                seat_given = True
                placement_changed = True

        elif field == "ip":
            new_value = normalize_ip(value)
            old_value = computer.ip

        elif field == "mac":
            new_value = normalize_mac(value)
            old_value = computer.mac

        elif field in MULTILINE_FIELDS:
            new_value = normalize_multiline(value)
            old_value = getattr(computer, field)

        elif field in DATE_FIELDS:
            new_value = parse_date(value)
            old_value = getattr(computer, field)

            if old_value != new_value:
                # В историю — как видно в таблице: «15.10.2026»
                changes[field] = {"old": format_date(old_value), "new": format_date(new_value)}
                setattr(computer, field, new_value)

            continue

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

    if extra_changed:
        computer.extra = extra

    # Новый номер места занят — соседи сдвигаются; строка встаёт в узле по номеру
    if seat_given:
        shift_seats(session, batch, computer.location_id, computer.seat_no, {computer.id})

    if placement_changed:
        session.flush()
        computer.seat_sort = seat_sort_in_location(
            session,
            computer.location_id,
            computer.seat_no,
            exclude_id=computer.id,
        )

    return changes


def save_changes(session, computer, changes, user_name):
    if not changes:
        return

    computer.version = (computer.version or 1) + 1
    computer.updated_at = datetime.now(timezone.utc)

    session.add(
        History(
            entity="computers",
            entity_id=computer.id,
            user_name=user_name,
            changes=changes,
        )
    )


@router.patch("/computers/{computer_id}")
def update_computer(
    computer_id: int,
    payload: dict = Body(...),
    user=Depends(require_editor),
    session=Depends(get_db),
):
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

    user_field_keys = user_field_keys_of(session)
    batch = ChangeBatch(user["login"])

    changes = apply_fields(session, computer, payload, user_field_keys, batch)

    if changes:
        save_changes(session, computer, changes, user["login"])
        batch.finish(session)
        session.commit()

    extra = computer.extra or {}

    updated = column_values(
        computer,
        location_parts(computer.location_id, load_locations(session)),
        main_person_name(session, computer),
        vacuum_text(get_vacuum_logins(session, computer.id)),
    )

    for key in user_field_keys:
        updated[key] = extra.get(key)

    updated["location_id"] = computer.location_id
    updated["version"] = computer.version
    updated["updated_at"] = computer.updated_at

    # Снимаем блокировку строки, если правок не было
    session.rollback()

    return {
        "ok": True,
        "id": computer_id,
        "changes": changes,
        "updated": updated,
        # Соседи, которым сдвинули № места: таблицу надо перечитать
        "shifted": batch.changed_ids(),
    }

@router.get("/computers/{computer_id}")
def get_computer(computer_id: int, session=Depends(get_db)):
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
        .all()
    )

    history = [
        {
            "id": item.id,
            "at": item.at,
            "user_name": item.user_name,
            "changes": item.changes or {},
            "cancelled": item.cancelled,
        }
        for item in items
    ]

    return {
        "people": people,
        "vacuum": vacuum,
        "history": history,
    }
