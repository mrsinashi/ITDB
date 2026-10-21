from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import func

from auth import require_page
from db import get_db
from models import (
    Choice,
    Computer,
    ComputerPerson,
    Location,
    Person,
    VacuumAccount,
    VacuumAccountComputer,
    VacuumAccountPerson,
)

from api_import import (
    CHOICE_FIELDS,
    EXTRA_FIELDS,
    Anomalies,
    cell_to_text,
    check_file_name,
    clean_multiline,
    clean_text,
    parse_drive_text,
    parse_int,
    parse_ips,
    parse_macs,
    place_of,
    read_sheet,
    row_label_of,
    sheet_records,
    split_vacuum_logins,
)

router = APIRouter(prefix="/api/import", tags=["import"])

BASE_STATUSES = ["установлен", "склад", "ремонт", "списан"]


def get_or_create_location(session, parent_id, kind, name, code=None):
    if name is None and code is None:
        return None

    if name is None:
        name = code

    base_filters = [Location.kind == kind]

    if parent_id is None:
        base_filters.append(Location.parent_id.is_(None))
    else:
        base_filters.append(Location.parent_id == parent_id)

    find_filters = base_filters.copy()

    if code is not None:
        find_filters.append(Location.code == code)
    else:
        find_filters.append(Location.name == name)

    location = session.query(Location).filter(*find_filters).first()

    if location:
        return location

    max_sort = session.query(func.max(Location.sort)).filter(*base_filters).scalar() or 0

    location = Location(
        parent_id=parent_id,
        kind=kind,
        name=name,
        code=code,
        sort=max_sort + 1,
    )

    session.add(location)
    session.flush()

    return location


def get_or_create_person(session, full_name):
    person = (
        session.query(Person)
        .filter(func.lower(Person.full_name) == full_name.lower())
        .first()
    )

    if person:
        return person

    person = Person(full_name=full_name)

    session.add(person)
    session.flush()

    return person


def get_or_create_vacuum_account(session, login):
    account = (
        session.query(VacuumAccount)
        .filter(VacuumAccount.login == login)
        .first()
    )

    if account:
        return account

    account = VacuumAccount(login=login)

    session.add(account)
    session.flush()

    return account


def ensure_choice(session, field, value):
    value = clean_text(value)

    if not value:
        return

    exists = (
        session.query(Choice)
        .filter(Choice.field == field, Choice.value == value)
        .first()
    )

    if exists:
        return

    max_sort = session.query(func.max(Choice.sort)).filter(Choice.field == field).scalar() or 0

    session.add(
        Choice(
            field=field,
            value=value,
            sort=max_sort + 1,
        )
    )

    session.flush()


def seed_base_statuses(session):
    for index, value in enumerate(BASE_STATUSES):
        exists = (
            session.query(Choice)
            .filter(Choice.field == "status", Choice.value == value)
            .first()
        )

        if exists:
            continue

        session.add(
            Choice(
                field="status",
                value=value,
                sort=index,
            )
        )

    session.flush()


def import_location(session, rec, row_label, anomalies):
    """Узлы дерева из строки: адрес → отделение → этаж → кабинет (недостающие
    создаются). Ответ – id самого глубокого, без адреса – None."""
    address, department, floor, room_code, room_name = place_of(rec)

    if not address:
        anomalies.add(row_label, "Адрес", address, "Пустой адрес")
        return None

    building = get_or_create_location(session, None, "building", address, None)
    location_id = building.id

    if not department:
        anomalies.add(row_label, "Отделение", department, "Пустое отделение")
        return location_id

    department_location = get_or_create_location(
        session,
        building.id,
        "department",
        department,
        None,
    )

    location_id = department_location.id
    parent_for_room = department_location.id

    if floor:
        floor_location = get_or_create_location(
            session,
            department_location.id,
            "floor",
            floor,
            None,
        )

        location_id = floor_location.id
        parent_for_room = floor_location.id

    if room_code or room_name:
        room_location = get_or_create_location(
            session,
            parent_for_room,
            "room",
            room_name,
            room_code,
        )

        location_id = room_location.id

    return location_id


def link_people(session, computer, person, vacuum):
    """Пользователь ПК (главный) и логины VACUUM: у ПК и, если есть, у человека."""
    if person:
        link = (
            session.query(ComputerPerson)
            .filter(
                ComputerPerson.computer_id == computer.id,
                ComputerPerson.person_id == person.id,
            )
            .first()
        )

        if not link:
            session.add(
                ComputerPerson(
                    computer_id=computer.id,
                    person_id=person.id,
                    is_main=True,
                    sort=0,
                )
            )
            session.flush()

    for login in split_vacuum_logins(vacuum):
        account = get_or_create_vacuum_account(session, login)

        computer_link = (
            session.query(VacuumAccountComputer)
            .filter(
                VacuumAccountComputer.account_id == account.id,
                VacuumAccountComputer.computer_id == computer.id,
            )
            .first()
        )

        if not computer_link:
            session.add(
                VacuumAccountComputer(
                    account_id=account.id,
                    computer_id=computer.id,
                )
            )
            session.flush()

        if person:
            person_link = (
                session.query(VacuumAccountPerson)
                .filter(
                    VacuumAccountPerson.account_id == account.id,
                    VacuumAccountPerson.person_id == person.id,
                )
                .first()
            )

            if not person_link:
                session.add(
                    VacuumAccountPerson(
                        account_id=account.id,
                        person_id=person.id,
                    )
                )
                session.flush()


def import_row(session, rec, excel_row, anomalies):
    """Одна строка файла → ПК с расположением, пользователем, VACUUM и значениями
    справочников; что не так – в anomalies."""
    row_label = row_label_of(rec, excel_row)
    location_id = import_location(session, rec, row_label, anomalies)

    person = None
    person_name = clean_text(rec.get("person"))

    if person_name:
        person = get_or_create_person(session, person_name)

    seat_no, seat_ok = parse_int(rec.get("seat_no"))

    if not seat_ok:
        anomalies.add(
            row_label,
            "№",
            cell_to_text(rec.get("seat_no")),
            "Номер места не является целым числом",
        )
        seat_no = None

    row_num_int, row_num_ok = parse_int(rec.get("row_num"))

    if row_num_ok and row_num_int is not None:
        seat_sort = float(row_num_int)
    else:
        seat_sort = float(excel_row)

    ips, ip_issues = parse_ips(rec.get("ip"))

    for bad_ip, message in ip_issues:
        anomalies.add(row_label, "IP", bad_ip, message)

    macs, mac_issues = parse_macs(rec.get("mac"))

    for bad_mac, message in mac_issues:
        anomalies.add(row_label, "MAC", bad_mac, message)

    drive_values, drive_issues = parse_drive_text(rec.get("drive"))

    for message in drive_issues:
        anomalies.add(
            row_label,
            "DRIVE",
            clean_text(rec.get("drive")),
            message,
        )

    note = clean_multiline(rec.get("note"))

    printer = clean_text(rec.get("printer_skip"))

    if printer:
        anomalies.add(
            row_label,
            "Принтер",
            printer,
            "Значение из столбца Принтер пока не импортируется как принтер",
        )

        if note:
            note = f"{note}\nПринтер: {printer}"
        else:
            note = f"Принтер: {printer}"

    extra = {}

    for extra_key, source_key in EXTRA_FIELDS:
        value = clean_text(rec.get(source_key))

        if value:
            extra[extra_key] = value

    computer = Computer(
        status="установлен",
        location_id=location_id,
        seat_no=seat_no,
        seat_sort=seat_sort,
        hostname=clean_text(rec.get("hostname")),
        ip="\n".join(ips) if ips else None,
        mac="\n".join(macs) if macs else None,
        inv_no=clean_text(rec.get("inv_no")),
        serial=None,
        type=clean_text(rec.get("type")),
        model=clean_text(rec.get("model")),
        os=clean_text(rec.get("os")),
        cpu=clean_text(rec.get("cpu")),
        ram=clean_text(rec.get("ram")),
        drive="\n".join(drive_values) if drive_values else None,
        gpu=clean_text(rec.get("gpu")),
        vnc=None,
        glpi_id=None,
        extra=extra,
        note=note,
        version=1,
    )

    session.add(computer)
    session.flush()

    for field in CHOICE_FIELDS:
        ensure_choice(session, field, getattr(computer, field))

    for drive_value in drive_values:
        ensure_choice(session, "drive", drive_value)

    for extra_key, field_name in EXTRA_FIELDS:
        if extra_key in extra:
            ensure_choice(session, field_name, extra[extra_key])

    link_people(session, computer, person, rec.get("vacuum"))


@router.post("/apply")
async def apply_import(
    file: UploadFile = File(...),
    confirm: bool = Form(False),
    user=Depends(require_page("table", "edit", admin=True)),  # этап 70: и правка «Компьютеров»
    session=Depends(get_db),
):
    check_file_name(file)
    rows, header_index, col_map, unknown_columns, sheet_title = read_sheet(await file.read())

    if unknown_columns:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "В файле есть неизвестные столбцы. Импорт без решения по ним не выполняется.",
                "unknown_columns": unknown_columns,
            },
        )

    if not confirm:
        return {
            "message": "Для записи в базу отправьте запрос ещё раз с confirm=true.",
            "sheet": sheet_title,
        }

    existing_computers = session.query(func.count(Computer.id)).scalar()

    if existing_computers:
        raise HTTPException(
            status_code=409,
            detail="В базе уже есть компьютеры. Повторный импорт пока не поддерживается.",
        )

    seed_base_statuses(session)

    stats = {
        "rows": 0,
        "computers": 0,
        "anomalies": 0,
    }

    anomalies = Anomalies(limit=100)

    for excel_row, rec in sheet_records(rows, header_index, col_map):
        if rec is None:
            continue

        stats["rows"] += 1
        import_row(session, rec, excel_row, anomalies)
        stats["computers"] += 1

    stats["anomalies"] = anomalies.count
    session.commit()

    return {
        "ok": True,
        "sheet": sheet_title,
        "stats": stats,
        "anomalies": anomalies.items,
    }
