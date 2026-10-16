"""Журналы (этап 66): «Движение» – получение и установка техники и компонентов.

- Тип записи – из справочника item_types: техника (tech) или компонент (part). Вид полей
  типа (form) решает, из чего складывается «Понятное название» (move_title): «Своё
  название» (поле model, у любого типа) и в скобках – поля типа через «; »; у принтеров и
  МФУ в скобках – модель из справочника моделей принтеров. Новый тип из окна записи – с
  одним полем «Информация». Сменили тип – поля, которых у нового нет, очищаются. У
  компьютера ещё «Комплект» (мышь, клавиатура…) – своим столбцом, не в названии; у
  компьютера, принтера и МФУ – IP (этап 67), тоже своим столбцом.
- Строки – новые сверху (правки этапа 66); одинаковый инвентарный рядом – это делает фронт.
- Даты – день и месяц можно не знать: в базе «ГГГГ», «ГГГГ-ММ», «ГГГГ-ММ-ДД» (так они и
  сортируются), в API и Истории – «ДД.ММ.ГГГГ», «ММ.ГГГГ», «ГГГГ».
- Куда – узел дерева (любой: адрес, отделение, этаж, кабинет) или ПК; в ПК ставят только
  компоненты. В API – «l:ID» (узел) или «c:ID» (ПК). Установил – пользователь программы
  («Фамилия И.О.», без ФИО – логин) или вписанное имя.
- История – entity "moves" (правки отменяются, как у принтеров: history_undo.py), типы –
  "item_types" (только «Создан»).
- «Установить» (этап 67, install_move): куда, дата, кто, статус «Установлен» одним действием
  (с несохранёнными правками окна записи); заменённый ПК или принтер – в архив, запись – по
  галочке тоже. Всё одной транзакцией: у записей Истории одно время – Ctrl+Z отменяет разом.
"""
import calendar
import re
from datetime import date
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from api_columns import MOVE_COLUMNS, MOVE_COLUMNS_BY_KEY, MOVE_SPEC_LABELS
from api_computer_actions import parse_ids
from api_computers import load_locations, location_chain, location_path, location_title, lock_rows, normalize_ip, normalize_multiline, normalize_single, save_changes
from api_printers import model_title
from auth import require_editor
from db import get_db
from history_log import log_change
from models import Computer, History, ItemType, Location, Move, Printer, PrinterModel, User

router = APIRouter(prefix="/api", tags=["moves"])

KINDS = {"tech": "техника", "part": "компонент"}

# Поля каждого вида типа («Своё название» – у всех, у принтеров ещё модель из справочника).
# В «Понятное название» идут все, кроме комплекта компьютера и IP (KIT, IP – свои столбцы)
FORM_FIELDS = {
    "computer": ("pc_kind", "cpu", "ram", "disk_kind", "disk_size", "gpu", "kit", "move_ip"),
    "monitor": ("diagonal", "resolution"),
    "disk": ("disk_kind", "interface", "size"),
    "ram": ("ram_kind", "freq", "size"),
    "printer": ("move_ip",),
    "info": ("info",),
}
SPEC_FIELDS = set(MOVE_SPEC_LABELS)
DATE_FIELDS = ("made", "bought", "received", "installed")
TEXT_FIELDS = ("name_1c", "model", "inv_no", "serial", "country", "supplier", "source", "move_status", "note")
# Ключ в API и Истории → столбец moves (статус – свой ключ, чтобы не смешаться со статусом ПК)
COLUMN_OF = {"move_status": "status"}

# Что принимает правка записи. Тип, модель принтера, «Куда», «Установил» в Истории – полями
# item_type, printer_model, dest, installer (с номерами old_id / new_id)
EDITABLE_KEYS = set(TEXT_FIELDS) | set(DATE_FIELDS) | SPEC_FIELDS | {
    "type_id", "printer_model_id", "dest", "installer", "installer_user_id",
}
BULK_KEYS = {column.key for column in MOVE_COLUMNS if column.bulk}

ARCHIVED_FILTERS = ("no", "yes", "all")
MOVES_MISSING = "Часть записей не найдена. Обнови таблицу."

YEAR_MIN = 1990
YEAR_MAX = 2100

KIT = "kit"
KIT_SPLIT = re.compile(r"[,;\n]")
# IP в журнале – свой ключ (у ПК и принтеров «ip» – с оформлением подсетей)
IP = "move_ip"

NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
ISO_DATE = re.compile(r"([0-9]{4})(?:-([0-9]{1,2})(?:-([0-9]{1,2}))?)?")
DEST_REF = re.compile(r"([lc]):(\d+)")
USER_REF = re.compile(r"u:(\d+)")


# ---------- Значения ----------


def label_of(field):
    column = MOVE_COLUMNS_BY_KEY.get(field)
    return column.title if column is not None else MOVE_SPEC_LABELS.get(field, field)


def parse_pdate(value, label):
    """«02.08.2026», «08.2026», «2026» (и «2026-08-02») → «2026-08-02», «2026-08», «2026»;
    пусто – None."""
    text = normalize_single(value)

    if text is None:
        return None

    error = HTTPException(status_code=400, detail=f"{label}: нужно ДД.ММ.ГГГГ, ММ.ГГГГ или ГГГГ.")
    iso = ISO_DATE.fullmatch(text)

    if iso:
        year, month, day = iso.group(1), iso.group(2), iso.group(3)
    else:
        parts = text.split(".")

        if len(parts) > 3 or not all(part.isascii() and part.isdigit() for part in parts) or len(parts[-1]) != 4:
            raise error

        year = parts[-1]
        month = parts[-2] if len(parts) > 1 else None
        day = parts[0] if len(parts) == 3 else None

    year = int(year)

    if not YEAR_MIN <= year <= YEAR_MAX:
        raise HTTPException(status_code=400, detail=f"{label}: год – с {YEAR_MIN}.")

    if month is None:
        return f"{year:04d}"

    month = int(month)

    if not 1 <= month <= 12:
        raise error

    if day is None:
        return f"{year:04d}-{month:02d}"

    day = int(day)

    if not 1 <= day <= calendar.monthrange(year, month)[1]:
        raise HTTPException(status_code=400, detail=f"{label}: такого дня нет.")

    return f"{year:04d}-{month:02d}-{day:02d}"


def show_pdate(stored):
    """«2026-08-02» → «02.08.2026», «2026-08» → «08.2026», «2026» – как есть."""
    if not stored:
        return None

    return ".".join(reversed(stored.split("-")))


def with_unit(value, unit, space=True):
    """Число – с единицей («8» → «8 Гб»); вписали своё («1TB») – как есть."""
    if not value:
        return None

    if not NUMBER.fullmatch(value):
        return value

    return value + (" " if space else "") + unit


def kit_text(value):
    """Комплект: «мышь,  Клавиатура; мышь» → «мышь, Клавиатура» (повтор – один раз); пусто – None."""
    items = []
    seen = set()

    for part in KIT_SPLIT.split(str(value or "")):
        part = " ".join(part.split())

        if part and part.lower() not in seen:
            seen.add(part.lower())
            items.append(part)

    return ", ".join(items) or None


def move_title(form, model, specs, printer_model=None):
    """«Понятное название», как в журнале пользователя: «Своё название» и в скобках поля
    типа через «; »: компьютер – «DEXP (ПК; Intel i3-10100; 8 Гб; SSD 240; GT 1030)»,
    монитор – «Asus VA249HG (23.8"; 1920x1080)», диск – «ADATA SU650 (SSD; SATA; 480 Гб)»,
    ОЗУ – «Kingston FURY (DDR4; 3200 Мгц; 16 Гб)», прочее – «название (информация)»,
    принтер и МФУ – «название (модель из справочника)». Пустые части пропускаются; без
    своего названия – одни поля без скобок."""
    def get(key):
        return (specs or {}).get(key) or None

    if form == "printer":
        parts = [model_title(printer_model)]
    elif form == "computer":
        disk = " ".join(part for part in (get("disk_kind"), get("disk_size")) if part)
        parts = [get("pc_kind"), get("cpu"), with_unit(get("ram"), "Гб"), disk, get("gpu")]
    elif form == "monitor":
        parts = [with_unit(get("diagonal"), '"', space=False), get("resolution")]
    elif form == "disk":
        parts = [get("disk_kind"), get("interface"), with_unit(get("size"), "Гб")]
    elif form == "ram":
        parts = [get("ram_kind"), with_unit(get("freq"), "Мгц"), with_unit(get("size"), "Гб")]
    else:
        parts = [get("info")]

    inner = "; ".join(part for part in parts if part)

    if model and inner:
        return f"{model} ({inner})"

    return model or inner or None


def short_name(full_name, login):
    """«Иванов Иван Иванович» → «Иванов И.И.»; без ФИО – логин (как shortName в util.js)."""
    words = (full_name or "").split()

    if not words:
        return login or ""

    initials = "".join(word[0].upper() + "." for word in words[1:3])
    return f"{words[0]} {initials}" if initials else words[0]


def get_type(session, value):
    try:
        type_id = int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Выбери тип.")

    item_type = session.get(ItemType, type_id)

    if item_type is None:
        raise HTTPException(status_code=400, detail="Этого типа больше нет. Обнови страницу.")

    return item_type


def dest_ref(location_id, computer_id):
    if computer_id is not None:
        return f"c:{computer_id}"

    return f"l:{location_id}" if location_id is not None else None


def parse_dest(session, value):
    """«l:ID» – узел дерева, «c:ID» – ПК; пусто – (None, None)."""
    text = normalize_single(value)

    if text is None:
        return None, None

    match = DEST_REF.fullmatch(text)

    if not match:
        raise HTTPException(status_code=400, detail="Куда: узел структуры или ПК.")

    item_id = int(match.group(2))

    if match.group(1) == "l":
        location = session.get(Location, item_id)

        if location is None or location.archived:
            raise HTTPException(status_code=400, detail="Куда: узел не найден или в архиве.")

        return location.id, None

    computer = session.get(Computer, item_id)

    if computer is None or computer.archived:
        raise HTTPException(status_code=400, detail="Куда: ПК не найден или в архиве.")

    return None, computer.id


def computer_name(computer):
    return computer.hostname or f"ПК #{computer.id}"


def dest_lines(location_id, computer, locations_by_id):
    """«Куда» в ячейке – строками, как в журнале пользователя: отделение (нет – адрес),
    этаж (если выбран этаж), «[326] Ординаторская», имя ПК."""
    node_id = computer.location_id if computer is not None else location_id
    chain = list(location_chain(node_id, locations_by_id))
    first = {}

    for node in chain:
        first.setdefault(node.kind, node)

    lines = []
    top = first.get("department") or first.get("building")

    if top is not None:
        lines.append(top.name)

    node = chain[0] if chain else None

    if node is not None and node.kind == "floor":
        lines.append(location_title(node))

    room = first.get("room")

    if room is not None:
        name = room.name if room.name and room.name != room.code else None
        lines.append(f"[{room.code}] {name}" if room.code and name else (room.code or name or ""))

    if computer is not None:
        lines.append(computer_name(computer))

    return "\n".join(line for line in lines if line) or None


def dest_path(session, location_id, computer_id, locations_by_id):
    """«Куда» для Истории – полным путём: «ул. Ленина, 1 / Терапия / 326 Ординаторская / ter-1»."""
    if computer_id is not None:
        computer = session.get(Computer, computer_id)

        if computer is None:
            return f"ПК #{computer_id}"

        path = location_path(computer.location_id, locations_by_id)
        return " / ".join(part for part in (path, computer_name(computer)) if part)

    return location_path(location_id, locations_by_id) if location_id is not None else None


def parse_installer(session, user_id, text, current=None):
    """Пользователь программы (id) или вписанное имя → (id, имя). Отключённого можно только
    оставить (current – «Установил» записи сейчас: «Установить» шлёт его же, этап 67)."""
    if user_id not in (None, ""):
        try:
            user = session.get(User, int(user_id))
        except (TypeError, ValueError):
            user = None

        if user is None or (user.archived and user.id != current):
            raise HTTPException(status_code=400, detail="Установил: пользователь не найден или отключён.")

        return user.id, None

    return None, normalize_single(text)


def installer_name(session, user_id, text):
    if user_id is not None:
        user = session.get(User, user_id)
        return short_name(user.full_name, user.login) if user else f"#{user_id}"

    return text


def record(changes, field, old, new, **ids):
    """Изменение в Историю; то же поле ещё раз (тип сменили – поле очистилось) – сливается:
    «было» – первое, «стало» – последнее. С номерами (old_id / new_id) сравниваются номера:
    у двух ПК может быть одно имя и место, у пользователя без ФИО и вписанного имени – одна
    подпись."""
    if field in changes:
        change = changes[field]
        change["new"] = new
        change.update({key: value for key, value in ids.items() if key.startswith("new")})
        same = change.get("old_id") == change.get("new_id") if "old_id" in change else change["old"] == new

        if same:
            del changes[field]

    elif (ids.get("old_id") != ids.get("new_id")) if ids else (old != new):
        changes[field] = dict({"old": old, "new": new}, **ids)


def ref_note(ref):
    """«c:12» → «ПК №12», «l:5» → «узел №5» – чтобы одинаковые подписи в Истории различались."""
    kind, _, number = str(ref).partition(":")
    return f"ПК №{number}" if kind == "c" else f"узел №{number}"


def distinct(old, new, old_note, new_note):
    """Одинаковые подписи «было» и «стало» – с пояснением (как «buh-3 (ПК №12)», этап 53)."""
    if old == new and old is not None:
        return f"{old} ({old_note})", f"{new} ({new_note})"

    return old, new


# ---------- Правка ----------


def apply_move_fields(session, move, payload, tidy=True):
    """Правка полей записи (создание, PATCH, массовая правка, отмена из Истории). Возвращает
    изменения для Истории. Тип – первым: от него зависит, какие поля у записи есть; сменили
    тип – поля, которых у нового нет, очищаются. tidy=False – отмена и возврат из Истории:
    поля по виду типа не чистятся и не проверяются (каждое поле той же записи Истории
    вернётся своей отменой, тип – первым; иначе отмена смены типа упрётся в «менялось не
    через историю»), техника в ПК – тоже (прежнее состояние уже было допустимым)."""
    changes = {}
    specs = dict(move.specs or {})
    keys = sorted(payload, key=lambda key: key != "type_id")
    type_changed = False

    for field in keys:
        if field not in EDITABLE_KEYS:
            raise HTTPException(status_code=400, detail=f"Неизвестное поле: {field}")

    old_type = session.get(ItemType, move.type_id) if move.type_id is not None else None
    item_type = old_type

    if "type_id" in payload:
        item_type = get_type(session, payload["type_id"])

        if old_type is None or item_type.id != old_type.id:
            record(changes, "item_type", old_type.name if old_type else None, item_type.name,
                   old_id=move.type_id, new_id=item_type.id)
            move.type_id = item_type.id
            type_changed = True

    if item_type is None:
        raise HTTPException(status_code=400, detail="Выбери тип.")

    form = item_type.form if item_type.form in FORM_FIELDS else "info"
    locations_by_id = None

    for field in keys:
        value = payload[field]

        if field in ("type_id", "installer", "installer_user_id"):
            continue

        if field == "printer_model_id":
            model = None

            if value not in (None, ""):
                try:
                    model = session.get(PrinterModel, int(value))
                except (TypeError, ValueError):
                    model = None

                if model is None:
                    raise HTTPException(status_code=400, detail="Этой модели больше нет в справочнике.")

                if tidy and form != "printer":
                    raise HTTPException(status_code=400, detail=f"У типа «{item_type.name}» модель вписывается, а не выбирается.")

            new_id = model.id if model else None

            if new_id != move.printer_model_id:
                old_model = session.get(PrinterModel, move.printer_model_id) if move.printer_model_id else None
                record(changes, "printer_model", model_title(old_model), model_title(model),
                       old_id=move.printer_model_id, new_id=new_id)
                move.printer_model_id = new_id

            continue

        if field == "dest":
            location_id, computer_id = parse_dest(session, value)
            old_ref = dest_ref(move.dest_location_id, move.dest_computer_id)
            new_ref = dest_ref(location_id, computer_id)

            if old_ref != new_ref:
                locations_by_id = locations_by_id or load_locations(session)
                old_text, new_text = distinct(
                    dest_path(session, move.dest_location_id, move.dest_computer_id, locations_by_id),
                    dest_path(session, location_id, computer_id, locations_by_id),
                    ref_note(old_ref), ref_note(new_ref),
                )
                record(changes, "dest", old_text, new_text, old_id=old_ref, new_id=new_ref)
                move.dest_location_id = location_id
                move.dest_computer_id = computer_id

            continue

        if field in SPEC_FIELDS:
            if field == KIT:
                new_value = kit_text(value)
            elif field == IP:
                new_value = normalize_ip(value)
            else:
                new_value = normalize_single(value)

            if tidy and new_value is not None and field not in FORM_FIELDS[form]:
                raise HTTPException(status_code=400, detail=f"У типа «{item_type.name}» нет поля «{label_of(field)}».")

            record(changes, field, specs.get(field), new_value)

            if new_value is None:
                specs.pop(field, None)
            else:
                specs[field] = new_value

            continue

        if field in DATE_FIELDS:
            new_value = parse_pdate(value, label_of(field))
            old_value = getattr(move, field)

            if old_value != new_value:
                record(changes, field, show_pdate(old_value), show_pdate(new_value))
                setattr(move, field, new_value)

            continue

        new_value = normalize_multiline(value) if field == "note" else normalize_single(value)
        column = COLUMN_OF.get(field, field)
        old_value = getattr(move, column)

        if old_value != new_value:
            record(changes, field, old_value, new_value)
            setattr(move, column, new_value)

    if "installer" in payload or "installer_user_id" in payload:
        user_id, text = parse_installer(session, payload.get("installer_user_id"), payload.get("installer"), move.installer_user_id)

        if (user_id, text) != (move.installer_user_id, move.installer):
            # Номер – пользователь или вписанное имя; одно на двоих имя различает пометка
            old_text, new_text = distinct(
                installer_name(session, move.installer_user_id, move.installer),
                installer_name(session, user_id, text),
                "пользователь" if move.installer_user_id is not None else "вписано",
                "пользователь" if user_id is not None else "вписано",
            )
            changes.pop("installer", None)
            changes["installer"] = {"old": old_text, "new": new_text, "old_id": move.installer_user_id, "new_id": user_id}
            move.installer_user_id = user_id
            move.installer = text

    # Сменили тип – полей, которых у нового нет, больше нет
    if tidy and type_changed:
        for key in [key for key in specs if key not in FORM_FIELDS[form]]:
            record(changes, key, specs.pop(key), None)

        if form != "printer" and move.printer_model_id is not None:
            old_model = session.get(PrinterModel, move.printer_model_id)
            record(changes, "printer_model", model_title(old_model), None, old_id=move.printer_model_id, new_id=None)
            move.printer_model_id = None

    if specs != (move.specs or {}):
        move.specs = specs  # новый dict – иначе JSONB не заметит изменения

    if tidy and item_type.kind == "tech" and move.dest_computer_id is not None:
        raise HTTPException(status_code=400, detail="Технику ставят в узел структуры, а не в ПК.")

    return changes


def move_value(session, move, field):
    """Значение поля записи, как его пишет История (для отмены и возврата)."""
    if field == "item_type":
        return move.type_id

    if field == "printer_model":
        return move.printer_model_id

    if field == "dest":
        return dest_ref(move.dest_location_id, move.dest_computer_id)

    if field == "installer":
        return f"u:{move.installer_user_id}" if move.installer_user_id is not None else move.installer

    if field in SPEC_FIELDS:
        return (move.specs or {}).get(field)

    if field in DATE_FIELDS:
        return show_pdate(getattr(move, field))

    return getattr(move, COLUMN_OF.get(field, field), None)


def move_change_value(field, change, side):
    """Значение из записи Истории в том же виде, что move_value."""
    if field in ("item_type", "printer_model", "dest"):
        return change.get(side + "_id")

    if field == "installer" and change.get(side + "_id") is not None:
        return f"u:{change[side + '_id']}"

    return change.get(side)


def move_display(session, field, value):
    """Значение для сообщения об ошибке отмены («сейчас: …»)."""
    if value is None:
        return None

    if field == "item_type":
        item_type = session.get(ItemType, value)
        return item_type.name if item_type else None

    if field == "printer_model":
        return model_title(session.get(PrinterModel, value))

    if field == "dest":
        match = DEST_REF.fullmatch(str(value))

        if not match:
            return value

        item_id = int(match.group(2))
        location_id, computer_id = (item_id, None) if match.group(1) == "l" else (None, item_id)
        return dest_path(session, location_id, computer_id, load_locations(session))

    if field == "installer":
        match = USER_REF.fullmatch(str(value))
        return installer_name(session, int(match.group(1)), None) if match else value

    return value


def set_move_value(session, move, field, value):
    """Поле записи – значением из Истории, как правкой в окне."""
    if field == "archived":
        value = bool(value)

        if move.archived == value:
            return {}

        old = move.archived
        move.archived = value
        return {"archived": {"old": old, "new": value}}

    if field == "item_type":
        payload = {"type_id": value}
    elif field == "printer_model":
        payload = {"printer_model_id": value}
    elif field == "installer":
        match = USER_REF.fullmatch(str(value or ""))
        payload = {"installer_user_id": int(match.group(1))} if match else {"installer_user_id": None, "installer": value}
    else:
        payload = {field: value}

    return apply_move_fields(session, move, payload, tidy=False)


def lock_move(session, move_id):
    move = session.query(Move).filter(Move.id == move_id).with_for_update().first()

    if move is None:
        raise HTTPException(status_code=404, detail="Запись не найдена. Обнови таблицу.")

    return move


# ---------- Строки таблицы ----------


def move_name(move, item_type, printer_model):
    """Название записи в Истории: «Понятное название», без него – тип."""
    title = move_title(item_type.form if item_type else "info", move.model, move.specs, printer_model)
    return title or (item_type.name if item_type else None) or f"#{move.id}"


def move_names(session, ids):
    """id записи → название (для Истории)."""
    if not ids:
        return {}

    moves = session.query(Move).filter(Move.id.in_(list(ids))).all()
    types = {item.id: item for item in session.query(ItemType).all()}
    models = {model.id: model for model in session.query(PrinterModel).all()}
    return {move.id: move_name(move, types.get(move.type_id), models.get(move.printer_model_id)) for move in moves}


def move_rows(session, archived="no", ids=None):
    """Строки журнала: новые сверху (правки этапа 66, просьба пользователя)."""
    query = session.query(Move)

    if archived == "no":
        query = query.filter(Move.archived == False)  # noqa: E712
    elif archived == "yes":
        query = query.filter(Move.archived == True)  # noqa: E712

    if ids is not None:
        query = query.filter(Move.id.in_(list(ids) or [0]))

    moves = query.order_by(Move.id.desc()).all()
    types = {item.id: item for item in session.query(ItemType).all()}
    models = {model.id: model for model in session.query(PrinterModel).all()}
    locations_by_id = load_locations(session)
    computer_ids = {move.dest_computer_id for move in moves if move.dest_computer_id is not None}
    computers = {pc.id: pc for pc in session.query(Computer).filter(Computer.id.in_(computer_ids)).all()} if computer_ids else {}
    user_ids = {move.installer_user_id for move in moves if move.installer_user_id is not None}
    users = {user.id: user for user in session.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    rows = []

    for move in moves:
        item_type = types.get(move.type_id)
        computer = computers.get(move.dest_computer_id)
        user = users.get(move.installer_user_id)
        form = item_type.form if item_type else "info"
        rows.append({
            "id": move.id,
            "type_id": move.type_id,
            "item_type": item_type.name if item_type else None,
            "type_kind": item_type.kind if item_type else None,
            "form": form,
            "name_1c": move.name_1c,
            "title": move_title(form, move.model, move.specs, models.get(move.printer_model_id)),
            "model": move.model,
            "printer_model_id": move.printer_model_id,
            "specs": dict(move.specs or {}),
            "kit": (move.specs or {}).get(KIT),
            IP: (move.specs or {}).get(IP),
            "inv_no": move.inv_no,
            "serial": move.serial,
            "country": move.country,
            "made": show_pdate(move.made),
            "bought": show_pdate(move.bought),
            "supplier": move.supplier,
            "source": move.source,
            "received": show_pdate(move.received),
            "dest": dest_lines(move.dest_location_id, computer, locations_by_id)
            if (move.dest_location_id is not None or computer is not None) else None,
            "dest_ref": dest_ref(move.dest_location_id, move.dest_computer_id),
            "installed": show_pdate(move.installed),
            "installer": short_name(user.full_name, user.login) if user else move.installer,
            "installer_user_id": move.installer_user_id,
            "move_status": move.status,
            "note": move.note,
            "archived": move.archived,
            "version": move.version,
        })

    return rows


def one_row(session, move_id):
    rows = move_rows(session, "all", [move_id])
    return rows[0] if rows else None


@router.get("/moves")
def list_moves(archived: str = "no", session=Depends(get_db)):
    """archived: no – рабочие (по умолчанию), yes – архив, all – все (признак archived)."""
    if archived not in ARCHIVED_FILTERS:
        raise HTTPException(status_code=400, detail="archived: no, yes или all.")

    return {"rows": move_rows(session, archived)}


@router.post("/moves")
def create_move(payload: dict = Body(...), user=Depends(require_editor), session=Depends(get_db)):
    """Новая запись: тип обязателен, остальное – по желанию."""
    payload = dict(payload)

    if payload.get("type_id") in (None, ""):
        raise HTTPException(status_code=400, detail="Выбери тип.")

    move = Move(specs={})
    changes = apply_move_fields(session, move, payload)
    session.add(move)
    session.flush()

    item_type = session.get(ItemType, move.type_id)
    model = session.get(PrinterModel, move.printer_model_id) if move.printer_model_id else None
    created = {"created": {"old": None, "new": move_name(move, item_type, model)}}
    session.add(History(entity="moves", entity_id=move.id, user_name=user["login"], changes=dict(created, **changes)))
    session.commit()

    return {"ok": True, "id": move.id, "row": one_row(session, move.id)}


def check_version(move, expected_version):
    """Окно записи открыто давно, а запись успели поменять – 409 (правку другого не затереть)."""
    if expected_version is None:
        return

    try:
        expected_version = int(expected_version)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="_version должен быть числом.")

    if expected_version != move.version:
        raise HTTPException(
            status_code=409,
            detail="Эту запись уже изменил другой пользователь. Таблица будет обновлена – проверь значение и повтори правку.",
        )


@router.patch("/moves/{move_id}")
def update_move(move_id: int, payload: dict = Body(...), user=Depends(require_editor), session=Depends(get_db)):
    payload = dict(payload)
    expected_version = payload.pop("_version", None)
    move = lock_move(session, move_id)
    check_version(move, expected_version)
    changes = apply_move_fields(session, move, payload)

    if changes:
        save_changes(session, move, changes, user["login"])
        session.commit()
    else:
        session.rollback()

    return {"ok": True, "id": move_id, "changes": changes, "updated": one_row(session, move_id)}


@router.post("/moves/archive")
def archive_moves(payload: dict = Body(...), user=Depends(require_editor), session=Depends(get_db)):
    """{"ids": [...], "archived": true/false}: в архив или обратно, запись Истории у каждой."""
    ids = parse_ids(payload.get("ids"))
    archived = payload.get("archived")

    if not isinstance(archived, bool):
        raise HTTPException(status_code=400, detail="archived должен быть true или false.")

    changed = []

    for move in lock_rows(session, Move, ids, MOVES_MISSING):
        if move.archived == archived:
            continue

        save_changes(session, move, {"archived": {"old": move.archived, "new": archived}}, user["login"])
        move.archived = archived
        changed.append(move.id)

    session.commit()
    return {"ok": True, "changed": sorted(changed)}


@router.post("/moves/bulk-update")
def bulk_update_moves(payload: dict = Body(...), user=Depends(require_editor), session=Depends(get_db)):
    """{ids, field, value} – одно поле у всех выбранных записей (пустое – очистить)."""
    ids = parse_ids(payload.get("ids"))
    field = payload.get("field")

    if not isinstance(field, str) or field not in BULK_KEYS:
        raise HTTPException(status_code=400, detail="Это поле нельзя менять сразу у нескольких записей.")

    changed = []

    for move in lock_rows(session, Move, ids, MOVES_MISSING):
        changes = apply_move_fields(session, move, {field: payload.get("value")})

        if changes:
            save_changes(session, move, changes, user["login"])
            changed.append(move.id)

    session.commit()
    return {"ok": True, "ids": ids, "changed": changed}


# ---------- Установить (этап 67) ----------


INSTALLED = "Установлен"


class InstallIn(BaseModel):
    version: Optional[int] = None
    # Несохранённые правки окна записи – сохраняются вместе с установкой
    edits: dict = {}
    dest: Optional[str] = None
    installed: Optional[str] = None
    installer_user_id: Optional[int] = None
    installer: Optional[str] = None
    # «Заменить»: этот ПК (у компьютера) или принтер (у принтера и МФУ) уходит в архив
    replace_pc: Optional[int] = None
    replace_printer: Optional[int] = None
    # «В архив»: запись журнала – тоже
    archive: bool = False


def archive_replaced(session, model, item_id, what, node_id, login):
    """Заменённый ПК или принтер (в узле «Куда» или под ним) – в архив, с Историей у него."""
    item = session.query(model).filter(model.id == item_id).with_for_update().first()

    if item is None or item.archived:
        raise HTTPException(status_code=400, detail=f"{what} уже нет среди рабочих. Обнови таблицу.")

    if node_id not in {location.id for location in location_chain(item.location_id, load_locations(session))}:
        raise HTTPException(status_code=400, detail=f"{what} нет в выбранном кабинете. Обнови таблицу.")

    save_changes(session, item, {"archived": {"old": False, "new": True}}, login)
    item.archived = True


@router.post("/moves/{move_id}/install")
def install_move(move_id: int, payload: InstallIn, user=Depends(require_editor), session=Depends(get_db)):
    """«Установить»: куда (узел; компоненту – и ПК), дата установки, кто установил и статус
    «Установлен» – вместе с несохранёнными правками окна записи. Заменить – выбранный ПК или
    принтер в архив; archive – запись тоже."""
    move = lock_move(session, move_id)
    check_version(move, payload.version)

    if move.archived:
        raise HTTPException(status_code=400, detail="Запись в архиве.")

    if normalize_single(payload.dest) is None:
        raise HTTPException(status_code=400, detail="Выбери кабинет.")

    fields = dict(payload.edits or {})
    fields.update({
        "dest": payload.dest,
        # Дата не указана – сегодня (как в окошке)
        "installed": normalize_single(payload.installed) or date.today().strftime("%d.%m.%Y"),
        "installer_user_id": payload.installer_user_id,
        "installer": payload.installer,
        "move_status": INSTALLED,
    })
    changes = apply_move_fields(session, move, fields)
    item_type = session.get(ItemType, move.type_id)
    form = item_type.form if item_type else "info"

    if payload.replace_pc is not None:
        if form != "computer":
            raise HTTPException(status_code=400, detail="Заменить ПК можно только компьютером.")

        archive_replaced(session, Computer, payload.replace_pc, "Этого ПК", move.dest_location_id, user["login"])

    if payload.replace_printer is not None:
        if form != "printer":
            raise HTTPException(status_code=400, detail="Заменить принтер можно только принтером или МФУ.")

        archive_replaced(session, Printer, payload.replace_printer, "Этого принтера", move.dest_location_id, user["login"])

    if payload.archive:
        changes["archived"] = {"old": False, "new": True}
        move.archived = True

    save_changes(session, move, changes, user["login"])
    session.commit()

    return {"ok": True, "id": move_id, "changes": changes, "updated": one_row(session, move_id)}


@router.get("/moves/installers")
def list_installers(user=Depends(require_editor), session=Depends(get_db)):
    """Кого можно выбрать в «Установил»: рабочие пользователи программы."""
    users = session.query(User).filter(User.archived == False).all()  # noqa: E712
    items = [
        {"id": item.id, "name": short_name(item.full_name, item.login), "full_name": item.full_name, "login": item.login}
        for item in users
    ]
    items.sort(key=lambda item: item["name"].lower())
    return {"items": items}


# ---------- Типы ----------


class TypeIn(BaseModel):
    name: str
    kind: str


def type_out(item_type, count=0):
    return {"id": item_type.id, "name": item_type.name, "kind": item_type.kind, "form": item_type.form, "moves": count}


@router.get("/item-types")
def list_types(session=Depends(get_db)):
    """Типы: сначала техника, потом компоненты, в своём порядке; число – записи журнала."""
    counts = dict(session.query(Move.type_id, func.count(Move.id)).group_by(Move.type_id).all())
    types = session.query(ItemType).all()
    types.sort(key=lambda item: (item.kind != "tech", item.sort, item.name.lower()))
    return {"items": [type_out(item, counts.get(item.id, 0)) for item in types]}


@router.post("/item-types")
def create_type(payload: TypeIn, user=Depends(require_editor), session=Depends(get_db)):
    """Новый тип из окна записи – с одним полем «Информация»."""
    name = normalize_single(payload.name)

    if name is None:
        raise HTTPException(status_code=400, detail="Нужно название типа.")

    if payload.kind not in KINDS:
        raise HTTPException(status_code=400, detail="Тип – техника или компонент.")

    same = session.query(ItemType).filter(func.lower(ItemType.name) == name.lower()).first()

    if same is not None:
        raise HTTPException(status_code=400, detail=f"Тип «{same.name}» уже есть ({KINDS.get(same.kind, same.kind)}).")

    last = session.query(func.max(ItemType.sort)).filter(ItemType.kind == payload.kind).scalar() or 0
    item_type = ItemType(name=name, kind=payload.kind, form="info", sort=last + 1)
    session.add(item_type)

    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        raise HTTPException(status_code=400, detail=f"Тип «{name}» уже есть.")

    log_change(session, "item_types", item_type.id, user["login"], {"created": {"old": None, "new": name}}, title=name)
    session.commit()
    return type_out(item_type)
