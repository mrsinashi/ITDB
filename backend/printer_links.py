"""Подключение принтеров к ПК (этап 44): связь printer_computers – по USB или по сети.

В таблице ПК – столбец «Принтеры», в таблице принтеров – «Компьютеры»: строками
имя или «имя [usb]» (по сети – без пометки). Правка ячейки – тот же текст: имена
ищутся среди рабочих ПК / принтеров без учёта регистра; без имени объект пишется
как «#12» (номер записи). История – у того, чью ячейку правили: текстом и номерами
записей (old_ids / new_ids – [[id, usb]]), отмена ставит связи по номерам."""
import re

from fastapi import HTTPException
from sqlalchemy import func

from models import Computer, Printer, PrinterComputer

USB_MARK = " [usb]"
USB_RE = re.compile(r"\s*[\[(]\s*usb\s*[\])]\s*$", re.IGNORECASE)
ID_RE = re.compile(r"#(\d+)")


def computer_title(computer):
    return computer.hostname or f"#{computer.id}"


def printer_title(printer):
    return printer.name or f"#{printer.id}"


def link_text(title, usb):
    return title + (USB_MARK if usb else "")


def sort_key(title):
    return (title.startswith("#"), title.lower())


def computers_by_printer(session, printer_ids=None):
    """id принтера → [(ПК, usb)] по имени ПК (ПК из архива – тоже: связь остаётся)."""
    query = session.query(PrinterComputer, Computer).join(Computer, PrinterComputer.computer_id == Computer.id)

    if printer_ids is not None:
        query = query.filter(PrinterComputer.printer_id.in_(list(printer_ids) or [0]))

    result = {}

    for link, computer in query.all():
        result.setdefault(link.printer_id, []).append((computer, link.usb))

    for items in result.values():
        items.sort(key=lambda item: sort_key(computer_title(item[0])))

    return result


def printers_by_computer(session, computer_ids=None):
    """id ПК → [(принтер, usb)] по имени принтера."""
    query = session.query(PrinterComputer, Printer).join(Printer, PrinterComputer.printer_id == Printer.id)

    if computer_ids is not None:
        query = query.filter(PrinterComputer.computer_id.in_(list(computer_ids) or [0]))

    result = {}

    for link, printer in query.all():
        result.setdefault(link.computer_id, []).append((printer, link.usb))

    for items in result.values():
        items.sort(key=lambda item: sort_key(printer_title(item[0])))

    return result


def links_text(items, title):
    """Текст ячейки: [(объект, usb)] → «pc-1\\npc-2 [usb]»; пусто – None."""
    return "\n".join(link_text(title(obj), usb) for obj, usb in items) or None


def links_refs(items, title):
    """Для ссылок в ячейке: [{id, title, usb}] в том же порядке, что строки текста."""
    return [{"id": obj.id, "title": title(obj), "usb": bool(usb)} for obj, usb in items]


def parse_lines(value):
    """Текст ячейки → [(имя, usb)]; пустые строки пропускаются, повтор имени – одна связь."""
    result = []
    seen = set()

    for line in str(value or "").splitlines():
        line = line.strip()

        if not line:
            continue

        usb = bool(USB_RE.search(line))
        name = USB_RE.sub("", line).strip()

        if name and name.lower() not in seen:
            seen.add(name.lower())
            result.append((name, usb))

    return result


def find_by_name(session, model, name_column, name, what):
    """Рабочий ПК / принтер по имени (без учёта регистра) или по «#12»."""
    m = ID_RE.fullmatch(name)

    if m:
        obj = session.get(model, int(m.group(1)))

        if obj is None:
            raise HTTPException(status_code=400, detail=f"{what} {name} не найден.")

        return obj

    found = (
        session.query(model)
        .filter(func.lower(name_column) == name.lower(), model.archived == False)  # noqa: E712
        .order_by(model.id)
        .all()
    )

    if not found:
        raise HTTPException(status_code=400, detail=f"{what} «{name}» не найден.")

    if len(found) > 1:
        raise HTTPException(status_code=400, detail=f"Имя «{name}» – у нескольких: {what.lower()} не понять.")

    return found[0]


def links_ids(items):
    """Связи номерами записей: [[id, usb]] по id – для Истории и отмены."""
    return sorted([obj.id, bool(usb)] for obj, usb in items)


def wanted_links(session, value, model, name_column, what):
    """{id: usb} по тексту ячейки или по номерам [[id, usb]] (отмена из Истории)."""
    if isinstance(value, list):
        wanted = {}

        for item in value:
            obj = session.get(model, int(item[0]))

            if obj is None:
                raise HTTPException(status_code=400, detail=f"{what} #{item[0]} больше нет.")

            wanted[obj.id] = bool(item[1])

        return wanted

    return {
        find_by_name(session, model, name_column, name, what).id: usb
        for name, usb in parse_lines(value)
    }


def set_printer_computers(session, printer, value):
    """ПК, к которым подключён принтер, – по тексту ячейки «Компьютеры» (или
    номерам). Возвращает изменение для Истории или None."""
    wanted = wanted_links(session, value, Computer, Computer.hostname, "Компьютер")
    return replace_links(session, PrinterComputer.printer_id == printer.id, "computer_id", wanted,
                         lambda: computers_by_printer(session, [printer.id]).get(printer.id, []),
                         computer_title, dict(printer_id=printer.id))


def set_computer_printers(session, computer, value):
    """Принтеры ПК – по тексту ячейки «Принтеры» (или номерам). Изменение или None."""
    wanted = wanted_links(session, value, Printer, Printer.name, "Принтер")
    return replace_links(session, PrinterComputer.computer_id == computer.id, "printer_id", wanted,
                         lambda: printers_by_computer(session, [computer.id]).get(computer.id, []),
                         printer_title, dict(computer_id=computer.id))


def replace_links(session, own_filter, other_key, wanted, current, title, own):
    """Связи одного объекта: other_key – поле другой стороны, wanted – {id: usb}.
    Изменение для Истории: {old, new – текстом, old_ids, new_ids} или None."""
    items = current()
    before = links_text(items, title)
    before_ids = links_ids(items)
    links = {getattr(link, other_key): link for link in session.query(PrinterComputer).filter(own_filter).all()}

    for other_id, link in links.items():
        if other_id not in wanted:
            session.delete(link)
        elif link.usb != wanted[other_id]:
            link.usb = wanted[other_id]

    for other_id, usb in wanted.items():
        if other_id not in links:
            session.add(PrinterComputer(usb=usb, **own, **{other_key: other_id}))

    session.flush()
    items = current()
    after_ids = links_ids(items)

    if before_ids == after_ids:
        return None

    return {"old": before, "new": links_text(items, title), "old_ids": before_ids, "new_ids": after_ids}
