import re
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func

from api_computers import ChangeBatch, apply_fields, load_locations, location_path, save_changes, user_field_keys_of
from api_printers import apply_printer_fields
from auth import require_editor
from db import get_db
from models import Computer, History, Location, Printer

router = APIRouter(prefix="/api", tags=["locations"])

LOCATION_KINDS = ("building", "department", "floor", "room")

ALLOWED_CHILDREN = {
    "building": ("department",),
    "department": ("floor", "room"),
    "floor": ("room",),
}

# Куда можно перенести кабинет (этап 58)
ROOM_PARENTS = ("department", "floor")


def clean(value):
    if value is None:
        return None

    text = str(value).strip()

    return text if text else None


def validate_name_code(kind, name, code):
    if kind == "room":
        if not name and not code:
            raise HTTPException(
                status_code=400,
                detail="Для кабинета нужен код или название.",
            )
    elif not name:
        raise HTTPException(
            status_code=400,
            detail="Нужно название узла.",
        )


def check_duplicate(session, kind, parent_id, name, code, exclude_id=None, detail="Такой узел здесь уже есть."):
    filters = [
        Location.kind == kind,
        Location.archived == False,
    ]

    if parent_id is None:
        filters.append(Location.parent_id.is_(None))
    else:
        filters.append(Location.parent_id == parent_id)

    if kind == "room" and code:
        filters.append(Location.code == code)
    else:
        filters.append(Location.name == name)

    if exclude_id is not None:
        filters.append(Location.id != exclude_id)

    if session.query(Location).filter(*filters).first():
        raise HTTPException(
            status_code=400,
            detail=detail,
        )


def children_filter(parent_id):
    return Location.parent_id.is_(None) if parent_id is None else Location.parent_id == parent_id


def next_sort(session, parent_id):
    max_sort = (
        session.query(func.max(Location.sort)).filter(children_filter(parent_id)).scalar()
    ) or 0

    return max_sort + 1


def free_sort(session, parent_id, sort):
    """Место sort среди детей parent_id: узлы с ним и дальше сдвигаются на +1."""
    session.query(Location).filter(
        children_filter(parent_id),
        Location.sort >= sort,
    ).update({Location.sort: Location.sort + 1}, synchronize_session=False)


def natural_key(text):
    """Номер кабинета для сравнения, как на фронте (localeCompare numeric): 9 < 10 < 10а."""
    return [
        (0, int(part), "") if part.isdigit() else (1, 0, part.lower())
        for part in re.split(r"(\d+)", text or "")
        if part
    ]


def room_sort(session, parent_id, code):
    """Место кабинета среди соседей – по номеру, как у нового кабинета (этап 36): перед первым
    кабинетом с большим номером (соседи с ним и дальше сдвигаются); без номера – в конец."""
    siblings = (
        session.query(Location)
        .filter(children_filter(parent_id), Location.archived == False)
        .order_by(Location.sort, func.lower(Location.name))
        .all()
    )
    key = natural_key(code)
    before = next(
        (item for item in siblings if code and item.kind == "room" and item.code and natural_key(item.code) > key),
        None,
    )

    if before is None:
        return next_sort(session, parent_id)

    free_sort(session, parent_id, before.sort)
    return before.sort


@router.get("/locations/tree")
def locations_tree(session=Depends(get_db)):
    locations = (
        session.query(Location)
        .filter(Location.archived == False)
        .all()
    )

    computer_counts = (
        session.query(Computer.location_id, func.count(Computer.id))
        .filter(Computer.archived == False)
        .group_by(Computer.location_id)
        .all()
    )

    direct_counts = {}

    for location_id, count in computer_counts:
        if location_id is not None:
            direct_counts[location_id] = count

    unlocated = (
        session.query(func.count(Computer.id))
        .filter(Computer.location_id.is_(None), Computer.archived == False)
        .scalar()
    ) or 0

    nodes = {}

    for location in locations:
        nodes[location.id] = {
            "id": location.id,
            "parent_id": location.parent_id,
            "kind": location.kind,
            "name": location.name,
            "code": location.code,
            "name_part": location.name_part,
            "name_own": location.name_own,
            "name_single": location.name_single,
            "sort": location.sort or 0,
            "direct_count": direct_counts.get(location.id, 0),
            "total_count": 0,
            "children": [],
        }

    for node in nodes.values():
        parent_id = node["parent_id"]

        if parent_id and parent_id in nodes:
            nodes[parent_id]["children"].append(node)

    roots = [node for node in nodes.values() if node["parent_id"] is None or node["parent_id"] not in nodes]

    def sort_nodes(node):
        node["children"].sort(
            key=lambda item: (
                item["sort"],
                (item["name"] or "").lower(),
            )
        )

        for child in node["children"]:
            sort_nodes(child)

    def calculate_totals(node):
        total = node["direct_count"]

        for child in node["children"]:
            total += calculate_totals(child)

        node["total_count"] = total

        return total

    roots.sort(
        key=lambda item: (
            item["sort"],
            (item["name"] or "").lower(),
        )
    )

    for root in roots:
        sort_nodes(root)
        calculate_totals(root)

    return {
        "roots": roots,
        "unlocated": unlocated,
    }


@router.post("/locations")
def create_location(
    payload: dict = Body(...),
    user=Depends(require_editor),
    session=Depends(get_db),
):
    kind = payload.get("kind")
    parent_id = payload.get("parent_id")
    name = clean(payload.get("name"))
    code = clean(payload.get("code"))

    if kind not in LOCATION_KINDS:
        raise HTTPException(
            status_code=400,
            detail="Неизвестный тип узла.",
        )

    if parent_id is not None:
        parent = session.get(Location, parent_id)

        if not parent or parent.archived:
            raise HTTPException(
                status_code=400,
                detail="Родительский узел не найден.",
            )

        if kind not in ALLOWED_CHILDREN.get(parent.kind, ()):
            raise HTTPException(
                status_code=400,
                detail="Сюда нельзя добавить такой тип узла.",
            )
    elif kind != "building":
        raise HTTPException(
            status_code=400,
            detail="Без родителя можно создать только адрес.",
        )

    validate_name_code(kind, name, code)
    check_duplicate(session, kind, parent_id, name, code)

    sort = next_sort(session, parent_id)
    before_id = payload.get("before_id")

    # Новый кабинет при добавлении ПК (этап 36) – перед узлом before_id (по номеру
    # кабинета), узлы с ним и дальше сдвигаются; без before_id – в конец
    if before_id is not None:
        try:
            before = session.get(Location, int(before_id))
        except (TypeError, ValueError):
            before = None

        if not before or before.archived or before.parent_id != parent_id:
            raise HTTPException(
                status_code=400,
                detail="Узел, перед которым добавить, не найден.",
            )

        sort = before.sort
        free_sort(session, parent_id, sort)

    location = Location(
        parent_id=parent_id,
        kind=kind,
        name=name or code,
        code=code,
        sort=sort,
    )
    session.add(location)
    session.flush()

    session.add(
        History(
            entity="locations",
            entity_id=location.id,
            user_name=user["login"],
            changes={"created": {"old": None, "new": location.name}},
        )
    )

    session.commit()

    return {"ok": True, "id": location.id}


@router.patch("/locations/{location_id}")
def update_location(
    location_id: int,
    payload: dict = Body(...),
    user=Depends(require_editor),
    session=Depends(get_db),
):
    location = session.get(Location, location_id)

    if not location or location.archived:
        raise HTTPException(
            status_code=404,
            detail="Узел не найден.",
        )

    changes = {}

    # Кабинет – в другое отделение или на этаж (этап 58, форма «Изменить кабинет» в Структуре)
    parent = None

    if payload.get("parent_id") not in (None, location.parent_id):
        parent = room_parent(session, payload["parent_id"])
        parent = parent if parent.id != location.parent_id else None

    if "name" in payload or "code" in payload:
        new_name = clean(payload.get("name", location.name))
        new_code = clean(payload.get("code", location.code))

        validate_name_code(location.kind, new_name, new_code)

        # С переносом повтор ищется на новом месте (move_room)
        if parent is None:
            check_duplicate(
                session,
                location.kind,
                location.parent_id,
                new_name,
                new_code,
                exclude_id=location.id,
            )

        effective_name = new_name or new_code

        if effective_name != location.name:
            changes["name"] = {"old": location.name, "new": effective_name}

        if new_code != location.code:
            changes["code"] = {"old": location.code, "new": new_code}

        location.name = effective_name
        location.code = new_code

    if parent is not None:
        changes.update(move_room(session, location, parent))

    if "sort" in payload:
        try:
            new_sort = int(payload.get("sort"))
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=400,
                detail="sort должен быть числом.",
            )

        location.sort = new_sort

    if changes:
        session.add(
            History(
                entity="locations",
                entity_id=location.id,
                user_name=user["login"],
                changes=changes,
            )
        )

    session.commit()

    return {"ok": True, "id": location.id}


@router.post("/locations/{location_id}/archive")
def archive_location(
    location_id: int,
    user=Depends(require_editor),
    session=Depends(get_db),
):
    location = session.get(Location, location_id)

    if not location or location.archived:
        raise HTTPException(
            status_code=404,
            detail="Узел не найден.",
        )

    check_can_archive(session, location)

    location.archived = True

    session.add(
        History(
            entity="locations",
            entity_id=location.id,
            user_name=user["login"],
            changes={"archived": {"old": False, "new": True}},
        )
    )

    session.commit()

    return {"ok": True, "id": location.id}


def check_can_archive(session, location):
    """Узел можно убрать в архив, только если в нём нет рабочих узлов и ПК."""
    children = (
        session.query(func.count(Location.id))
        .filter(
            Location.parent_id == location.id,
            Location.archived == False,
        )
        .scalar()
    )

    if children:
        raise HTTPException(
            status_code=400,
            detail="Сначала архивируй дочерние узлы.",
        )

    computers = (
        session.query(func.count(Computer.id))
        .filter(Computer.location_id == location.id, Computer.archived == False)
        .scalar()
    )

    # ПК из архива узел не держат: у них остаётся прежнее расположение
    if computers:
        raise HTTPException(
            status_code=400,
            detail="В узле есть компьютеры. Сначала перемести их.",
        )

    # Принтеры (этап 44) – так же
    printers = (
        session.query(func.count(Printer.id))
        .filter(Printer.location_id == location.id, Printer.archived == False)
        .scalar()
    )

    if printers:
        raise HTTPException(
            status_code=400,
            detail="В узле есть принтеры. Сначала перемести их.",
        )


# ---------- Перенос кабинета в другое отделение (этап 58) ----------


def room_parent(session, value):
    """Отделение или этаж, куда переносится кабинет. С замком: два переноса в одно место
    проверяют повтор кабинета по очереди."""
    try:
        parent = session.query(Location).filter(Location.id == int(value)).with_for_update().first()
    except (TypeError, ValueError):
        parent = None

    if not parent:
        raise HTTPException(status_code=400, detail="Отделение не найдено. Обнови страницу.")

    if parent.archived:
        path = location_path(parent.id, load_locations(session))
        raise HTTPException(status_code=400, detail=f"Узел «{path}» в архиве – сначала верни его из архива.")

    if parent.kind not in ROOM_PARENTS:
        raise HTTPException(status_code=400, detail="Кабинет переносится только в отделение или на этаж.")

    return parent


def check_place(session, location):
    """Узел на своём месте не повторяет соседа (кабинет – по номеру, без номера – по названию)."""
    detail = "Такой узел здесь уже есть."

    if location.kind == "room":
        path = location_path(location.parent_id, load_locations(session))
        detail = f"В «{path}» уже есть кабинет {location.code or location.name}."

    check_duplicate(
        session, location.kind, location.parent_id, location.name, location.code,
        exclude_id=location.id, detail=detail,
    )


def move_room(session, room, parent, check=True):
    """Кабинет – сам узел с ПК и принтерами – в отделение или на этаж parent. Изменение для
    Истории – путь и id прежнего и нового места (отмена – по id, history_undo). check=False –
    повтор проверит вызывающий (отмена названия и места вместе)."""
    if room.kind != "room":
        raise HTTPException(status_code=400, detail="Перенести можно только кабинет.")

    if parent.id == room.parent_id:
        return {}

    locations = load_locations(session)
    change = {
        "old": location_path(room.parent_id, locations),
        "new": location_path(parent.id, locations),
        "old_id": room.parent_id,
        "new_id": parent.id,
    }
    room.sort = room_sort(session, parent.id, room.code)
    room.parent_id = parent.id

    # Узел из архива (отмена в Истории) места не занимает – повтор не проверяется, как у названия
    if check and not room.archived:
        check_place(session, room)

    # Следующие проверки того же действия (пустой такой же, отмена) должны видеть новое место
    session.flush()

    return {"parent_id": change}


def add_room_copy(session, room, parent_id, user, sort=None):
    """Такой же кабинет в другом месте: номер, название, правило имён. «Создан» в Истории – с
    пометкой move: отменяется вместе с переносом (кабинет уходит в архив, history_undo)."""
    copy = Location(
        parent_id=parent_id,
        kind="room",
        name=room.name,
        code=room.code,
        name_part=room.name_part,
        name_own=room.name_own,
        name_single=room.name_single,
        sort=room_sort(session, parent_id, room.code) if sort is None else sort,
    )
    session.add(copy)
    session.flush()

    session.add(
        History(
            entity="locations",
            entity_id=copy.id,
            user_name=user["login"],
            changes={"created": {"old": None, "new": copy.name, "move": True}},
        )
    )

    return copy


class RoomMoveIn(BaseModel):
    parent_id: int                      # отделение или этаж, куда
    whole: bool = False                 # весь кабинет; иначе – только ПК или принтер
    keep_old: bool = False              # весь кабинет: на старом месте остаётся пустой такой же
    computer_id: Optional[int] = None   # только этот ПК
    printer_id: Optional[int] = None    # только этот принтер
    version: Optional[int] = None       # версия ПК или принтера, которую видел пользователь


def lock_moved(session, payload):
    """ПК или принтер, который переезжает один: с блокировкой и той же версии."""
    if payload.computer_id is not None:
        obj = session.query(Computer).filter(Computer.id == payload.computer_id).with_for_update().first()
        what = "компьютер"
    elif payload.printer_id is not None:
        obj = session.query(Printer).filter(Printer.id == payload.printer_id).with_for_update().first()
        what = "принтер"
    else:
        raise HTTPException(status_code=400, detail="Не указано, что перенести.")

    if obj is None:
        raise HTTPException(status_code=404, detail=f"{what.capitalize()} не найден.")

    if payload.version is not None and payload.version != obj.version:
        raise HTTPException(
            status_code=409,
            detail=f"Этот {what} уже изменил другой пользователь. Таблица будет обновлена – проверь значение и повтори правку.",
        )

    return obj, what


@router.post("/locations/{location_id}/move")
def move_room_to(
    location_id: int,
    payload: RoomMoveIn,
    user=Depends(require_editor),
    session=Depends(get_db),
):
    """Перенос кабинета из ячейки «Кабинет» (схема пользователя 14.10). Весь кабинет – сам узел
    с ПК и принтерами; keep_old – на старом месте остаётся пустой такой же. Только ПК (принтер) –
    в новом отделении такой же кабинет (уже есть – этот), ПК – в него. Одно действие: Ctrl+Z
    отменяет всё, и созданный кабинет тоже."""
    # Замки – в том же порядке, что у отмены в Истории: ПК (принтер), кабинет, место
    obj, what = lock_moved(session, payload) if not payload.whole else (None, None)
    room = session.query(Location).filter(Location.id == location_id).with_for_update().first()

    if not room or room.archived or room.kind != "room":
        raise HTTPException(status_code=404, detail="Кабинет не найден. Обнови страницу.")

    if obj is not None and obj.location_id != room.id:
        raise HTTPException(status_code=409, detail=f"Этот {what} уже не в этом кабинете. Таблица будет обновлена.")

    parent = room_parent(session, payload.parent_id)

    if parent.id == room.parent_id:
        raise HTTPException(status_code=400, detail="Кабинет уже здесь.")

    if payload.whole:
        old_parent_id = room.parent_id
        old_sort = room.sort
        changes = move_room(session, room, parent)
        session.add(History(entity="locations", entity_id=room.id, user_name=user["login"], changes=changes))

        # Пустой такой же – на место перенесённого
        if payload.keep_old:
            add_room_copy(session, room, old_parent_id, user, sort=old_sort)

        session.commit()
        return {"ok": True, "id": room.id}

    target = (
        session.query(Location)
        .filter(
            Location.parent_id == parent.id,
            Location.kind == "room",
            Location.archived == False,
            Location.code == room.code if room.code else Location.name == room.name,
        )
        .order_by(Location.id)
        .first()
    ) or add_room_copy(session, room, parent.id, user)

    batch = ChangeBatch(user["login"])

    if isinstance(obj, Computer):
        changes = apply_fields(session, obj, {"location_id": target.id}, user_field_keys_of(session), batch)
    else:
        changes = apply_printer_fields(session, obj, {"location_id": target.id}, batch)

    save_changes(session, obj, changes, user["login"])
    batch.finish(session)
    session.commit()

    return {"ok": True, "id": target.id}
