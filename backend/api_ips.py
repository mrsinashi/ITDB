"""Журналы (этап 71): «IP» – занятые и свободные адреса.

- Строка – адрес (ответ пользователя: «один IP и все источники в строку»). Что о нём знают:
  Компьютеры и Принтеры (IP в таблице), Движение (IP записи), сам журнал (запись «IP»),
  сканер – проход подсетей, аренды и привязки DHCP, записи GLPI / GSIT, пользователи Jabber
  (Vacuum). Источники – короткими названиями («Принтеры», «DHCP Leases»), полное – в подсказке.
  Источник страницы, закрытой пользователю правами (этап 69), в журнал не попадает.
- Тип и имя – значения источников строками (одинаковые – одной строкой, откуда – в
  подсказке); имя ПК, принтера и записи Движения – ссылкой на карточку. «Актуальность» –
  последняя дата, когда значение проверяли (сканер видел адрес) или меняли (История ПК,
  принтера, записи; запись журнала – checked_at). «Добавил» – у записи журнала (пользователь
  программы или вписанное имя; по умолчанию – кто добавил), у Движения – «Установил».
- Своё: записи журнала (ip_entries) – тип, IP, имя, «Добавил» правятся в ячейке; описание
  (ip_notes) – одно на адрес, у любого адреса, остаётся у адреса при архиве и переносе записи.
  Свободные адреса (подсети из «Подключений») строки собирает фронт; правка такой строки
  создаёт запись.
- Сканер в таблицы не пишет и здесь ничего не меняет: только читается.
- История – entity "ip_entries" (записи) и "ip_notes" (описания; первое описание – обычная
  правка «– → текст», отменяется), отмена – history_undo.py; поля – ключи столбцов.
"""
import ipaddress
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import array
from sqlalchemy.exc import IntegrityError

import scan_collect
from api_columns import IP_COLUMNS
from api_computer_actions import parse_ids
from api_computers import lock_rows, normalize_multiline, normalize_single, save_changes
from api_moves import IP as MOVE_IP, USER_REF, distinct, move_title, record, short_name
from api_printers import KINDS as PRINTER_KINDS
from api_scan import fresh_days_of, load_source
from api_scan_net import same_host
from auth import can, require_page
from db import get_db
from models import (
    Computer, History, IpEntry, IpNote, ItemType, Move, Printer, PrinterModel, ScanHost, ScanJabberUser, ScanRecord,
    ScanSubnet, User,
)
from scan_dhcp import CONF_SOURCE
from scan_hostmatch import lines
from scan_normalize import usable_ipv4

router = APIRouter(prefix="/api", tags=["ips"])

# Источники строки: ключ → (коротко – в ячейке, полностью – в подсказке); порядок – как в ячейке
SOURCES = {
    "pc": ("Компьютеры", "Таблица – Компьютеры"),
    "printer": ("Принтеры", "Таблица – Принтеры"),
    "move": ("Движение", "Журнал – Движение"),
    "own": ("IP", "Журнал – IP"),
    "net": ("Сканер", "Сканер – проход подсетей"),
    "dhcp": ("DHCP Leases", "Сканер – DHCP Leases"),
    "conf": ("DHCP Config", "Сканер – DHCP Config"),
    "rec": ("GSIT / GLPI", "Сканер – GSIT / GLPI"),
    "jabber": ("Vacuum", "Vacuum"),
}

# Чья страница показывает источник (права этапа 69): нет к ней доступа – нет и его данных в
# журнале (ревью этапа 71: читатель видел логины Vacuum и имена из DHCP). Компьютеры и принтеры
# читает любой вошедший (общие списки), записи и описания журнала – страница «IP» сама
SOURCE_PAGES = {
    "move": "journals/moves", "net": "scan/net", "dhcp": "scan/net", "conf": "scan/net",
    "rec": "scan/check", "jabber": "vacuum",
}

# Что считается правкой значения для «Актуальности» (История): у ПК, принтера, записи Движения
CHANGE_FIELDS = {
    "computers": ("created", "ip", "hostname", "type"),
    "printers": ("created", "ip", "name", "model"),
    "moves": ("created", MOVE_IP, "item_type", "model", "printer_model", "installer"),
}

# Поля записи журнала: столбец (ключ в API и Истории) → поле ip_entries; описание – у адреса
ENTRY_FIELDS = {"ip_addr": "ip", "ip_type": "ip_type", "ip_name": "name", "ip_added": "added"}
NOTE = "ip_note"
BULK_KEYS = {column.key for column in IP_COLUMNS if column.bulk}

ARCHIVED_FILTERS = ("no", "yes", "all")
IPS_MISSING = "Часть записей не найдена. Обнови таблицу."
CHANGED_BY_OTHER = "Эту строку уже изменил другой пользователь. Таблица будет обновлена – проверь значение и повтори правку."


def visible_sources(user):
    return {key for key in SOURCES if key not in SOURCE_PAGES or can(user, SOURCE_PAGES[key])}


# ---------- Значения ----------


def parse_ip(value):
    """Один адрес IPv4 («192.168.0.10»); пусто или не адрес – ошибка."""
    text = normalize_single(value)
    ip = usable_ipv4(text) if text else None

    if ip is None:
        raise HTTPException(status_code=400, detail="IP: один адрес вида 192.168.0.10.")

    return ip


def ip_number(ip):
    try:
        return int(ipaddress.IPv4Address(ip))
    except ValueError:
        return 0


def user_name(user):
    return short_name(user.full_name, user.login)


def parse_added(session, value, current=None):
    """«Добавил» → (id пользователя, вписанное имя). «u:ID» – пользователь (отключённого можно
    только оставить – current); имя пользователя программы («Иванов И.И.», ФИО, логин) –
    он сам; другое – вписанное имя."""
    text = normalize_single(value)

    if text is None:
        return None, None

    match = USER_REF.fullmatch(text)

    if match:
        user = session.get(User, int(match.group(1)))

        if user is None or (user.archived and user.id != current):
            raise HTTPException(status_code=400, detail="Добавил: пользователь не найден или отключён.")

        return user.id, None

    key = text.lower()
    found = [
        user for user in session.query(User).filter(User.archived == False).all()  # noqa: E712
        if key in {user_name(user).lower(), user.login.lower(), (user.full_name or "").strip().lower()}
    ]
    return (found[0].id, None) if len(found) == 1 else (None, text)


def added_name(session, user_id, text):
    if user_id is not None:
        user = session.get(User, user_id)
        return user_name(user) if user else f"#{user_id}"

    return text


def entry_value(session, entry, field):
    """Значение поля записи, как его пишет История (для отмены и возврата)."""
    if field == "ip_added":
        return f"u:{entry.added_user_id}" if entry.added_user_id is not None else entry.added_by

    return getattr(entry, ENTRY_FIELDS.get(field, field), None)


def entry_change_value(field, change, side):
    """Значение из записи Истории в том же виде, что entry_value."""
    if field == "ip_added" and change.get(side + "_id") is not None:
        return f"u:{change[side + '_id']}"

    return change.get(side)


def entry_display(session, field, value):
    if field == "ip_added" and value is not None:
        match = USER_REF.fullmatch(str(value))
        return added_name(session, int(match.group(1)), None) if match else value

    return value


def flush_unique(session):
    """Двое одновременно добавили один адрес (или вернули из архива) – понятная ошибка, а не 500."""
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        raise HTTPException(status_code=409, detail="У этого адреса уже есть запись журнала. Обнови таблицу.")


def check_free(session, ip, entry_id=None):
    """У рабочего адреса – одна запись журнала (описание адреса не в счёт: оно у адреса)."""
    query = session.query(IpEntry.id).filter(IpEntry.ip == ip, IpEntry.archived == False)  # noqa: E712

    if entry_id is not None:
        query = query.filter(IpEntry.id != entry_id)

    if query.first():
        raise HTTPException(status_code=400, detail=f"У {ip} уже есть запись журнала IP.")


def apply_entry_fields(session, entry, payload):
    """Правка записи (создание, ячейка, массовая правка, отмена из Истории). Возвращает
    изменения для Истории; «Актуальность» записи – сейчас, если что-то изменилось."""
    changes = {}

    for field in payload:
        if field not in ENTRY_FIELDS:
            raise HTTPException(status_code=400, detail=f"Неизвестное поле: {field}")

    for field, value in payload.items():
        if field == "ip_added":
            user_id, text = parse_added(session, value, entry.added_user_id)

            if (user_id, text) != (entry.added_user_id, entry.added_by):
                old_text, new_text = distinct(
                    added_name(session, entry.added_user_id, entry.added_by), added_name(session, user_id, text),
                    "пользователь" if entry.added_user_id is not None else "вписано",
                    "пользователь" if user_id is not None else "вписано",
                )
                changes[field] = {"old": old_text, "new": new_text, "old_id": entry.added_user_id, "new_id": user_id}
                entry.added_user_id = user_id
                entry.added_by = text

            continue

        if field == "ip_addr":
            new_value = parse_ip(value)

            if new_value != entry.ip and not entry.archived:
                check_free(session, new_value, entry.id)
        else:
            new_value = normalize_single(value)

        column = ENTRY_FIELDS[field]
        old_value = getattr(entry, column)

        if old_value != new_value:
            record(changes, field, old_value, new_value)
            setattr(entry, column, new_value)

    if changes:
        entry.checked_at = datetime.now(timezone.utc)

    return changes


def set_entry_value(session, entry, field, value):
    """Поле записи – значением из Истории, как правкой в ячейке."""
    if field == "archived":
        value = bool(value)

        if entry.archived == value:
            return {}

        if not value:
            check_free(session, entry.ip, entry.id)

        old = entry.archived
        entry.archived = value
        return {field: {"old": old, "new": value}}

    # Вписанное имя, совпавшее с именем пользователя, осталось бы вписанным, а не им
    if field == "ip_added" and not USER_REF.fullmatch(str(value or "")):
        text = normalize_single(value)

        if (None, text) == (entry.added_user_id, entry.added_by):
            return {}

        changes = {field: {
            "old": added_name(session, entry.added_user_id, entry.added_by), "new": text,
            "old_id": entry.added_user_id, "new_id": None,
        }}
        entry.added_user_id = None
        entry.added_by = text
        entry.checked_at = datetime.now(timezone.utc)
        return changes

    return apply_entry_fields(session, entry, {field: value})


def set_note_value(session, note, field, value):
    """Описание адреса – значением из Истории (и правкой: write_note)."""
    if field != NOTE:
        raise HTTPException(status_code=400, detail=f"Неизвестное поле: {field}")

    new_value = normalize_multiline(value)

    if note.note == new_value:
        return {}

    old = note.note
    note.note = new_value
    return {NOTE: {"old": old, "new": new_value}}


def write_note(session, ip, value, login, version=None):
    """Описание адреса: строки нет – появится (в Историю – «Описание: – → текст», не «Создан»:
    первое описание отменяется, как любая правка). version – какое видел пользователь (нет
    описания – 0): с тех пор поменяли – 409. Ответ – изменилось ли."""
    note = session.query(IpNote).filter(IpNote.ip == ip).with_for_update().first()

    if version is not None and version != (note.version if note else 0):
        raise HTTPException(status_code=409, detail=CHANGED_BY_OTHER)

    if note is None:
        if normalize_multiline(value) is None:
            return False

        note = IpNote(ip=ip, version=1)
        session.add(note)

        try:
            session.flush()
        except IntegrityError:
            session.rollback()
            raise HTTPException(status_code=409, detail=CHANGED_BY_OTHER)

    changes = set_note_value(session, note, NOTE, value)
    save_changes(session, note, changes, login)
    return bool(changes)


# ---------- Строки ----------


class Row:
    """Что известно об адресе, пока строка собирается."""

    def __init__(self, ip):
        self.ip = ip
        self.sources = {}    # ключ источника → {"at", "stale", "details"}
        self.types = []      # [{"value", "from"}]
        self.names = []      # [{"value", "from", "obj", "stale"}]
        self.added = []
        self.entry = None    # запись журнала
        self.note = None     # описание адреса

    def seen(self, key, at, stale=False, detail=None):
        source = self.sources.setdefault(key, {"at": None, "stale": True, "details": []})

        if at is not None and (source["at"] is None or at > source["at"]):
            source["at"] = at

        source["stale"] = source["stale"] and stale

        if detail and detail not in source["details"]:
            source["details"].append(detail)

    def value(self, items, value, key, obj=None, stale=False, same=None):
        """Значение источника key: одинаковое – одной строкой (откуда – ключами источников)."""
        value = normalize_single(value)

        if value is None:
            return

        same = same or (lambda a, b: a.lower() == b.lower())

        for item in items:
            # Одинаковые имена разных ПК (принтеров, записей) – разными строками
            if same(item["value"], value) and not (obj and item.get("obj") and item["obj"] != obj):
                if key not in item["from"]:
                    item["from"].append(key)

                item["obj"] = item.get("obj") or obj
                item["stale"] = item.get("stale", True) and stale
                return

        items.append({"value": value, "from": [key], "obj": obj, "stale": stale})


def last_changes(session, entity):
    """id объекта → когда последний раз меняли его адрес, имя или тип (История, без отменённых).
    Нет таких записей (импорт) – даты нет: время последней правки строки сменило бы и
    примечание («Актуальность» – кроме описания, ревью этапа 71)."""
    rows = (
        session.query(History.entity_id, func.max(History.at))
        .filter(
            History.entity == entity,
            History.cancelled == False,  # noqa: E712
            History.changes.has_any(array(list(CHANGE_FIELDS[entity]))),
        )
        .group_by(History.entity_id)
        .all()
    )
    return dict(rows)


def ips_of(text):
    return [ip for ip in (usable_ipv4(line) for line in lines(text)) if ip]


def collect_rows(session, allowed):
    """Рабочие адреса: ip → Row (из источников allowed – тех, что пользователю можно видеть)."""
    rows = {}
    now = datetime.now(timezone.utc)
    users = {user.id: user for user in session.query(User).all()}

    def row_of(ip):
        return rows.setdefault(ip, Row(ip))

    # Компьютеры
    changed = last_changes(session, "computers")

    for pc in session.query(Computer.id, Computer.hostname, Computer.ip, Computer.type).filter(
        Computer.archived == False,  # noqa: E712
    ):
        for ip in ips_of(pc.ip):
            row = row_of(ip)
            row.seen("pc", changed.get(pc.id))
            row.value(row.types, pc.type, "pc")
            row.value(row.names, pc.hostname or f"ПК #{pc.id}", "pc", {"kind": "pc", "id": pc.id}, same=same_host)

    # Принтеры: тип – у модели (МФУ, принтер); без имени – «–», как в журнале пользователя
    changed = last_changes(session, "printers")
    models = {model.id: model for model in session.query(PrinterModel).all()}

    for printer in session.query(Printer.id, Printer.name, Printer.ip, Printer.model_id).filter(
        Printer.archived == False,  # noqa: E712
    ):
        model = models.get(printer.model_id)

        for ip in ips_of(printer.ip):
            row = row_of(ip)
            row.seen("printer", changed.get(printer.id))
            row.value(row.types, PRINTER_KINDS.get(model.kind) if model else None, "printer")
            row.value(row.names, printer.name or "–", "printer", {"kind": "printer", "id": printer.id}, same=same_host)

    # Движение: тип записи, «Своё название», «Установил»
    if "move" in allowed:
        changed = last_changes(session, "moves")
        types = {item.id: item for item in session.query(ItemType).all()}

        for move in session.query(Move).filter(Move.archived == False, Move.specs.has_key(MOVE_IP)):  # noqa: E712
            item_type = types.get(move.type_id)
            form = item_type.form if item_type else "info"
            title = move_title(form, move.model, move.specs, models.get(move.printer_model_id))
            user = users.get(move.installer_user_id)

            for ip in ips_of((move.specs or {}).get(MOVE_IP)):
                row = row_of(ip)
                row.seen("move", changed.get(move.id))
                row.value(row.types, item_type.name if item_type else None, "move")
                row.value(row.names, title or (item_type.name if item_type else f"#{move.id}"), "move", {"kind": "move", "id": move.id})
                row.value(row.added, user_name(user) if user else move.installer, "move")

    # Записи журнала (источник «IP»)
    for entry in session.query(IpEntry).filter(IpEntry.archived == False):  # noqa: E712
        row = row_of(entry.ip)
        user = users.get(entry.added_user_id)
        row.entry = entry
        row.seen("own", entry.checked_at)
        row.value(row.types, entry.ip_type, "own")
        row.value(row.names, entry.name, "own", same=same_host)
        row.value(row.added, user_name(user) if user else entry.added_by, "own")

    # Сканер: проход подсетей, аренды и привязки DHCP (давнее – старше срока «Актуальны»)
    if "net" in allowed:
        since = {
            kind: now - timedelta(days=fresh_days_of(load_source(session, kind), kind))
            for kind in scan_collect.HOST_KINDS
        }
        host_kinds = [kind for group in scan_collect.HOST_SOURCES.values() for kind in group]

        for host in session.query(ScanHost).filter(ScanHost.source.in_(host_kinds)):
            ip = usable_ipv4(host.ip)

            if ip is None:
                continue

            data = host.data or {}
            row = row_of(ip)

            if host.source == CONF_SOURCE or data.get("fixed"):
                # Привязка – настройка, а не наблюдение: давней не бывает
                row.seen("conf", host.seen_at, detail="host " + str(data["host"]) if data.get("host") else None)
                row.value(row.names, data.get("host"), "conf", same=same_host)
                continue

            key = "dhcp" if host.source == "dhcp" else "net"
            stale = host.seen_at < since[host.source]
            detail = None

            if key == "dhcp":
                detail = "аренда" if data.get("active") else "аренда кончилась"

            row.seen(key, host.seen_at, stale, detail)
            row.value(row.names, host.name, key, stale=stale, same=same_host)

    # Записи GLPI / GSIT: адреса из инвентаризации; давние – не в сроке «Актуальны» от сбора
    if "rec" in allowed:
        for kind in scan_collect.RECORD_KINDS:
            active_since = scan_collect.active_since(session, kind)

            for item in session.query(ScanRecord).filter(ScanRecord.source == kind):
                values = (item.data or {}).get("values") or {}
                stale = not scan_collect.is_active(item, active_since)
                at = item.checked_at or item.seen_at

                for ip in ips_of(values.get("ip")):
                    row = row_of(ip)
                    row.seen("rec", at, stale, f"{kind.upper()} №{item.source_id}")
                    row.value(row.names, item.name, "rec", stale=stale, same=same_host)

    # Vacuum: последний адрес пользователя Jabber и адреса, с которых он сейчас в сети
    if "jabber" in allowed:
        jabber_since = now - timedelta(days=fresh_days_of(load_source(session, "jabber"), "jabber"))

        for item in session.query(ScanJabberUser):
            addresses = {item.last_ip} | {
                res.get("ip") for res in (item.resources or []) if isinstance(res, dict) and item.online
            }
            at = item.last_seen_at or item.updated_at
            stale = not item.online and (at is None or at < jabber_since)

            for ip in {usable_ipv4(address) for address in addresses if address} - {None}:
                row = row_of(ip)
                row.seen("jabber", at, stale, "в сети" if item.online else None)
                row.value(row.names, item.login, "jabber", stale=stale)

    # Описания адресов: непустое – и у адреса без источников; пустое – только у строки, которая
    # уже есть (версия описания нужна правке: иначе 409)
    for note in session.query(IpNote):
        if note.note is not None or note.ip in rows:
            row_of(note.ip).note = note

    return rows


def iso(value):
    return value.isoformat() if value else None


def entry_out(session, entry):
    """Запись журнала – и её значения отдельно: в ячейке они могут слиться с чужими (тип ПК,
    имя из сети), а правка ячейки меняет своё (ревью этапа 71)."""
    if entry is None:
        return None

    return {
        "id": entry.id, "version": entry.version, "archived": entry.archived,
        "ip_type": entry.ip_type, "name": entry.name, "added_user_id": entry.added_user_id, "added_by": entry.added_by,
        "added": added_name(session, entry.added_user_id, entry.added_by),
    }


def text_of(items):
    return "\n".join(item["value"] for item in items) or None


def items_out(items):
    """Значения ячейки – короче (ответ на тысячи адресов): ссылка и «давно» – только если есть."""
    result = []

    for item in items:
        out = {"value": item["value"], "from": item["from"]}

        if item.get("obj"):
            out["obj"] = item["obj"]

        if item.get("stale"):
            out["stale"] = True

        result.append(out)

    return result


def row_out(session, row):
    """Строка адреса. Названия источников – у фронта (SOURCES в mixins/ips.js), здесь – ключи."""
    sources = []

    for key in SOURCES:
        if key in row.sources:
            source = row.sources[key]
            out = {"key": key, "at": iso(source["at"])}

            if source["stale"]:
                out["stale"] = True

            if source["details"]:
                out["details"] = source["details"]

            sources.append(out)

    dates = [row.sources[key]["at"] for key in row.sources if row.sources[key]["at"] is not None]
    return {
        "id": ip_number(row.ip),
        "ip_addr": row.ip,
        "ip_sources": "\n".join(SOURCES[source["key"]][0] for source in sources) or None,
        "sources": sources,
        "ip_type": text_of(row.types),
        "types": items_out(row.types),
        "ip_name": text_of(row.names),
        "names": items_out(row.names),
        "ip_note": row.note.note if row.note else None,
        "note_version": row.note.version if row.note else 0,
        "checked_at": iso(max(dates)) if dates else None,
        "ip_added": text_of(row.added),
        "added": items_out(row.added),
        "entry": entry_out(session, row.entry),
        "archived": False,
    }


def archived_out(session, entry):
    """Запись журнала из архива – своей строкой (номер строки – минус номер записи)."""
    added = added_name(session, entry.added_user_id, entry.added_by)
    row = {
        "id": -entry.id,
        "ip_addr": entry.ip,
        "ip_sources": SOURCES["own"][0],
        "sources": [{"key": "own", "at": iso(entry.checked_at)}],
        "ip_note": None,
        "note_version": 0,
        "checked_at": iso(entry.checked_at),
        "entry": entry_out(session, entry),
        "archived": True,
    }

    for field, items, value in (("ip_type", "types", entry.ip_type), ("ip_name", "names", entry.name), ("ip_added", "added", added)):
        row[field] = value
        row[items] = [{"value": value, "from": ["own"]}] if value else []

    return row


def ip_rows(session, user, archived="no", only=None):
    """Строки журнала по порядку адресов; only – только эти адреса (ответ на правку)."""
    rows = []

    if archived in ("no", "all"):
        found = collect_rows(session, visible_sources(user))
        rows = [row_out(session, found[ip]) for ip in sorted(found, key=ip_number) if only is None or ip in only]

    if archived in ("yes", "all") and only is None:
        entries = session.query(IpEntry).filter(IpEntry.archived == True).all()  # noqa: E712
        rows += [archived_out(session, entry) for entry in sorted(entries, key=lambda item: (ip_number(item.ip), item.id))]

    return rows


def subnets_out(session, user):
    """Подсети из «Подключений» – для «Свободных» и «Сканировать»: по порядку адресов. Примечание
    подсети – тем, кому видны подсети в Сканере (как /api/scan/subnets)."""
    notes = can(user, "scan/settings") or can(user, "scan/net", "run")
    subnets = []

    for subnet in session.query(ScanSubnet).all():
        try:
            network = ipaddress.ip_network(subnet.cidr, strict=False)
        except ValueError:
            continue

        subnets.append((network, {
            "cidr": subnet.cidr, "scan": subnet.scan, "note": subnet.note if notes else None, "size": network.num_addresses,
        }))

    subnets.sort(key=lambda item: (item[0].network_address, item[0].prefixlen))
    return [item for _, item in subnets]


@router.get("/ips")
def list_ips(archived: str = "no", user=Depends(require_page("journals/ips")), session=Depends(get_db)):
    """archived: no – рабочие адреса (по умолчанию), yes – записи журнала из архива, all – всё."""
    if archived not in ARCHIVED_FILTERS:
        raise HTTPException(status_code=400, detail="archived: no, yes или all.")

    return {"rows": ip_rows(session, user, archived), "subnets": subnets_out(session, user)}


# ---------- Правка ----------


class EntryIn(BaseModel):
    """Новая запись журнала: адрес обязателен; ip_note – описание адреса вместе с ней (правка
    свободного адреса). Правка записи – те же поля без описания; передаются только изменённые."""
    model_config = ConfigDict(populate_by_name=True)

    ip_addr: Optional[str] = None
    ip_type: Optional[str] = None
    ip_name: Optional[str] = None
    ip_note: Optional[str] = None
    ip_added: Optional[str] = None
    version: Optional[int] = Field(None, alias="_version")


def fresh_rows(session, user, *ips):
    return ip_rows(session, user, "no", {ip for ip in ips if ip})


def new_entry(session, ip, fields, user):
    """Запись журнала на свободном от записей адресе: «Добавил» по умолчанию – кто добавил.
    В Историю – «Создан» и значения."""
    check_free(session, ip)
    entry = IpEntry(ip=ip, version=1)
    session.add(entry)
    flush_unique(session)
    fields = dict(fields)
    fields.setdefault("ip_added", f"u:{user['id']}")
    changes = {"created": {"old": None, "new": ip}}
    changes.update(apply_entry_fields(session, entry, fields))
    session.add(History(entity="ip_entries", entity_id=entry.id, user_name=user["login"], changes=changes))
    return entry


@router.post("/ips")
def create_entry(payload: EntryIn, user=Depends(require_page("journals/ips", "edit")), session=Depends(get_db)):
    """Запись журнала (строка «Добавить», правка свободного адреса); с описанием – и оно."""
    fields = payload.model_dump(exclude_unset=True, exclude={"version"})
    ip = parse_ip(fields.pop("ip_addr", None))
    has_note = NOTE in fields
    note = fields.pop(NOTE, None)
    new_entry(session, ip, fields, user)

    if has_note:
        write_note(session, ip, note, user["login"])

    session.commit()
    return {"ok": True, "rows": fresh_rows(session, user, ip)}


def lock_entry(session, entry_id):
    entry = session.query(IpEntry).filter(IpEntry.id == entry_id).with_for_update().first()

    if entry is None:
        raise HTTPException(status_code=404, detail="Запись не найдена. Обнови таблицу.")

    return entry


@router.patch("/ips/{entry_id}")
def update_entry(entry_id: int, payload: EntryIn, user=Depends(require_page("journals/ips", "edit")), session=Depends(get_db)):
    """Правка записи журнала: тип, адрес, имя, «Добавил» (описание – PUT /api/ips/note)."""
    entry = lock_entry(session, entry_id)

    if payload.version is not None and payload.version != entry.version:
        raise HTTPException(status_code=409, detail=CHANGED_BY_OTHER)

    old_ip = entry.ip
    changes = apply_entry_fields(session, entry, payload.model_dump(exclude_unset=True, exclude={"version", NOTE}))

    if changes:
        save_changes(session, entry, changes, user["login"])
        flush_unique(session)
        session.commit()
    else:
        session.rollback()

    return {"ok": True, "changes": changes, "rows": fresh_rows(session, user, old_ip, entry.ip)}


class NoteIn(BaseModel):
    """Описание адреса; version – какое видел пользователь (описания не было – 0)."""
    model_config = ConfigDict(populate_by_name=True)

    ip: str
    ip_note: Optional[str] = None
    version: Optional[int] = Field(None, alias="_version")


@router.put("/ips/note")
def put_note(payload: NoteIn, user=Depends(require_page("journals/ips", "edit")), session=Depends(get_db)):
    """Описание любого адреса (записи журнала, адреса из других источников): без записи журнала."""
    ip = parse_ip(payload.ip)
    write_note(session, ip, payload.ip_note, user["login"], payload.version)
    session.commit()
    return {"ok": True, "rows": fresh_rows(session, user, ip)}


class ArchiveIn(BaseModel):
    ids: list[int]
    archived: bool


@router.post("/ips/archive")
def archive_entries(payload: ArchiveIn, user=Depends(require_page("journals/ips", "edit")), session=Depends(get_db)):
    """Записи журнала в архив и обратно (ids – номера записей); описание остаётся у адреса."""
    ids = parse_ids(payload.ids)
    changed = []

    for entry in lock_rows(session, IpEntry, ids, IPS_MISSING):
        if entry.archived == payload.archived:
            continue

        if not payload.archived:
            check_free(session, entry.ip, entry.id)

        save_changes(session, entry, {"archived": {"old": entry.archived, "new": payload.archived}}, user["login"])
        entry.archived = payload.archived
        flush_unique(session)
        changed.append(entry.id)

    session.commit()
    return {"ok": True, "changed": sorted(changed)}


class BulkIn(BaseModel):
    """own – выбраны свободные адреса («Свободные»): у адреса без записи она появится."""
    ips: list[str]
    field: str
    value: Optional[str] = None
    own: bool = False


@router.post("/ips/bulk-update")
def bulk_update(payload: BulkIn, user=Depends(require_page("journals/ips", "edit")), session=Depends(get_db)):
    """Одно значение у выбранных адресов: описание – у любых, тип – у записей журнала (остальные
    пропускаются); у свободных (own) – сначала записи. Замки – по возрастанию номеров."""
    if payload.field not in BULK_KEYS:
        raise HTTPException(status_code=400, detail="Это поле нельзя менять сразу у нескольких строк.")

    ips = sorted({parse_ip(ip) for ip in payload.ips}, key=ip_number)
    login = user["login"]
    entries = {
        entry.ip: entry for entry in session.query(IpEntry).filter(
            IpEntry.ip.in_(ips or [""]), IpEntry.archived == False,  # noqa: E712
        ).order_by(IpEntry.id).with_for_update().all()
    }
    changed = set()
    note = payload.field == NOTE
    created = set()

    if payload.own:
        for ip in ips:
            if ip not in entries:
                fields = {} if note else {payload.field: payload.value}
                entries[ip] = new_entry(session, ip, fields, user)
                created.add(ip)
                changed.add(ip)

    if note:
        notes = {
            item.ip: item for item in session.query(IpNote).filter(IpNote.ip.in_(ips or [""])).order_by(IpNote.id).with_for_update().all()
        }

        for item in sorted(notes.values(), key=lambda item: item.id):
            changes = set_note_value(session, item, NOTE, payload.value)

            if changes:
                save_changes(session, item, changes, login)
                changed.add(item.ip)

        for ip in ips:
            if ip not in notes and write_note(session, ip, payload.value, login):
                changed.add(ip)
    else:
        for entry in sorted(entries.values(), key=lambda item: item.id):
            if entry.ip in created:
                continue

            changes = apply_entry_fields(session, entry, {payload.field: payload.value})

            if changes:
                save_changes(session, entry, changes, login)
                changed.add(entry.ip)

    session.commit()
    skipped = 0 if note else len([ip for ip in ips if ip not in entries])
    return {"ok": True, "changed": sorted(changed, key=ip_number), "skipped": skipped}
