from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func

from auth import get_current_user
from db import SessionLocal
from models import Computer, History, Location

router = APIRouter(prefix="/api", tags=["locations"])

LOCATION_KINDS = ("building", "department", "floor", "room")

ALLOWED_CHILDREN = {
    "building": ("department",),
    "department": ("floor", "room"),
    "floor": ("room",),
}


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


def check_duplicate(session, kind, parent_id, name, code, exclude_id=None):
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
            detail="Такой узел здесь уже есть.",
        )


def next_sort(session, parent_id):
    if parent_id is None:
        filters = [Location.parent_id.is_(None)]
    else:
        filters = [Location.parent_id == parent_id]

    max_sort = (
        session.query(func.max(Location.sort)).filter(*filters).scalar()
    ) or 0

    return max_sort + 1


@router.get("/locations/tree")
def locations_tree():
    session = SessionLocal()

    try:
        locations = (
            session.query(Location)
            .filter(Location.archived == False)
            .all()
        )

        computer_counts = (
            session.query(Computer.location_id, func.count(Computer.id))
            .group_by(Computer.location_id)
            .all()
        )

        direct_counts = {}

        for location_id, count in computer_counts:
            if location_id is not None:
                direct_counts[location_id] = count

        unlocated = (
            session.query(func.count(Computer.id))
            .filter(Computer.location_id.is_(None))
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

    finally:
        session.close()


@router.post("/locations")
def create_location(
    payload: dict = Body(...),
    user=Depends(get_current_user),
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

    session = SessionLocal()

    try:
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
                detail="Без родителя можно создать только здание.",
            )

        validate_name_code(kind, name, code)
        check_duplicate(session, kind, parent_id, name, code)

        location = Location(
            parent_id=parent_id,
            kind=kind,
            name=name or code,
            code=code,
            sort=next_sort(session, parent_id),
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

    except HTTPException:
        session.rollback()
        raise

    except Exception as e:
        session.rollback()
        raise HTTPException(
            status_code=400,
            detail=f"Не удалось создать узел: {e}",
        )

    finally:
        session.close()


@router.patch("/locations/{location_id}")
def update_location(
    location_id: int,
    payload: dict = Body(...),
    user=Depends(get_current_user),
):
    session = SessionLocal()

    try:
        location = session.get(Location, location_id)

        if not location or location.archived:
            raise HTTPException(
                status_code=404,
                detail="Узел не найден.",
            )

        changes = {}

        if "name" in payload or "code" in payload:
            new_name = clean(payload.get("name", location.name))
            new_code = clean(payload.get("code", location.code))

            validate_name_code(location.kind, new_name, new_code)
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

    except HTTPException:
        session.rollback()
        raise

    except Exception as e:
        session.rollback()
        raise HTTPException(
            status_code=400,
            detail=f"Не удалось сохранить узел: {e}",
        )

    finally:
        session.close()


@router.post("/locations/{location_id}/archive")
def archive_location(
    location_id: int,
    user=Depends(get_current_user),
):
    session = SessionLocal()

    try:
        location = session.get(Location, location_id)

        if not location or location.archived:
            raise HTTPException(
                status_code=404,
                detail="Узел не найден.",
            )

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
            .filter(Computer.location_id == location.id)
            .scalar()
        )

        if computers:
            raise HTTPException(
                status_code=400,
                detail="В узле есть компьютеры. Сначала перемести их.",
            )

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

    except HTTPException:
        session.rollback()
        raise

    except Exception as e:
        session.rollback()
        raise HTTPException(
            status_code=400,
            detail=f"Не удалось архивировать: {e}",
        )

    finally:
        session.close()