"""Действия с выбранными ПК: переместить, поменять местами, заменить,
изменить поле у всех. На каждый затронутый ПК — одна запись истории."""
from fastapi import APIRouter, Body, Depends, HTTPException

from api_computers import (
    ChangeBatch,
    apply_fields,
    get_active_location,
    load_locations,
    location_path,
    parse_seat_no,
    replace_people,
    save_changes,
    seat_sort_in_location,
    shift_seats,
    user_field_keys_of,
)
from auth import require_editor
from db import get_db
from models import Computer

router = APIRouter(prefix="/api", tags=["computer actions"])

# Поля, которые нельзя менять всем выбранным сразу: расположение и № места —
# через «Переместить», значения, которые должны быть у каждого ПК свои, — по одному
BULK_EXCLUDED = {"location_id", "seat_no", "hostname", "ip", "mac", "inv_no", "serial", "vacuum"}


def parse_ids(value, count=None):
    if not isinstance(value, list) or not value:
        raise HTTPException(status_code=400, detail="Не выбраны компьютеры.")

    try:
        ids = [int(item) for item in value]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="ids должны быть числами.")

    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=400, detail="Компьютер выбран дважды.")

    if count is not None and len(ids) != count:
        raise HTTPException(status_code=400, detail=f"Нужно выбрать ровно {count} ПК.")

    return ids


def lock_computers(session, ids):
    """ПК в порядке ids, с блокировкой. Все должны быть и не в архиве."""
    rows = (
        session.query(Computer)
        .filter(Computer.id.in_(ids))
        .order_by(Computer.id)
        .with_for_update()
        .all()
    )
    by_id = {computer.id: computer for computer in rows}

    if len(by_id) != len(ids):
        raise HTTPException(status_code=404, detail="Часть компьютеров не найдена. Обнови таблицу.")

    if any(computer.archived for computer in rows):
        raise HTTPException(status_code=400, detail="Компьютер из архива сначала верни из архива.")

    return [by_id[computer_id] for computer_id in ids]


def set_location(batch, computer, location_id, locations_by_id):
    if computer.location_id != location_id:
        batch.record(
            computer,
            "location_id",
            location_path(computer.location_id, locations_by_id),
            location_path(location_id, locations_by_id),
        )
        computer.location_id = location_id


def set_seat(batch, computer, seat_no):
    batch.record(computer, "seat_no", computer.seat_no, seat_no)
    computer.seat_no = seat_no


@router.post("/computers/move")
def move_computers(
    payload: dict = Body(...),
    user=Depends(require_editor),
    session=Depends(get_db),
):
    """{ids, location_id, seat_no, with_people}. ПК встают в узел по порядку ids
    с номерами seat_no, seat_no+1, … (без номера — в конец узла). Занятые
    номера сдвигаются. with_people=false — пользователи и VACUUM снимаются."""
    ids = parse_ids(payload.get("ids"))
    location = get_active_location(session, payload.get("location_id"))
    start = parse_seat_no(payload.get("seat_no"))
    with_people = payload.get("with_people", True) is not False

    computers = lock_computers(session, ids)
    locations_by_id = load_locations(session)
    batch = ChangeBatch(user["login"])

    for index, computer in enumerate(computers):
        seat_no = start + index if start is not None else None

        set_location(batch, computer, location.id, locations_by_id)
        set_seat(batch, computer, seat_no)
        shift_seats(session, batch, location.id, seat_no, set(ids))
        session.flush()

        computer.seat_sort = seat_sort_in_location(
            session, location.id, seat_no, exclude_id=computer.id
        )
        session.flush()

        if not with_people:
            replace_people(session, batch, None, computer)

    batch.finish(session)
    session.commit()
    return {"ok": True, "ids": ids, "changed": batch.changed_ids()}


@router.post("/computers/swap")
def swap_computers(
    payload: dict = Body(...),
    user=Depends(require_editor),
    session=Depends(get_db),
):
    """{ids: [a, b]} — два ПК меняются местами (узел, № места, порядок строки).
    Всё остальное (пользователь, VACUUM, имя, IP…) остаётся при своём ПК."""
    ids = parse_ids(payload.get("ids"), 2)
    first, second = lock_computers(session, ids)
    locations_by_id = load_locations(session)
    batch = ChangeBatch(user["login"])

    place_first = (first.location_id, first.seat_no, first.seat_sort)
    place_second = (second.location_id, second.seat_no, second.seat_sort)

    for computer, (location_id, seat_no, seat_sort) in (
        (first, place_second),
        (second, place_first),
    ):
        set_location(batch, computer, location_id, locations_by_id)
        set_seat(batch, computer, seat_no)
        computer.seat_sort = seat_sort

    batch.finish(session)
    session.commit()
    return {"ok": True, "ids": ids, "changed": batch.changed_ids()}


@router.post("/computers/replace")
def replace_computer(
    payload: dict = Body(...),
    user=Depends(require_editor),
    session=Depends(get_db),
):
    """{old_id, new_id, location_id, with_people}. Новый ПК встаёт на место
    старого (узел, № места, порядок строки) со статусом «установлен»; старый
    уходит в узел location_id (например, склад) без номера места, статус
    «склад». with_people (по умолчанию да) — пользователи и VACUUM старого
    переходят к новому."""
    ids = parse_ids([payload.get("old_id"), payload.get("new_id")], 2)
    old, new = lock_computers(session, ids)
    target = get_active_location(session, payload.get("location_id"))
    with_people = payload.get("with_people", True) is not False

    locations_by_id = load_locations(session)
    batch = ChangeBatch(user["login"])

    place = (old.location_id, old.seat_no, old.seat_sort)

    set_location(batch, old, target.id, locations_by_id)
    set_seat(batch, old, None)
    session.flush()
    old.seat_sort = seat_sort_in_location(session, target.id, None, exclude_id=old.id)

    set_location(batch, new, place[0], locations_by_id)
    set_seat(batch, new, place[1])
    new.seat_sort = place[2]

    batch.record(old, "status", old.status, "склад")
    old.status = "склад"
    batch.record(new, "status", new.status, "установлен")
    new.status = "установлен"

    if with_people:
        replace_people(session, batch, old, new)

    batch.record(old, "replaced_by", None, new.hostname or f"ПК #{new.id}")
    batch.record(new, "replaced", None, old.hostname or f"ПК #{old.id}")

    batch.finish(session)
    session.commit()
    return {"ok": True, "ids": ids, "changed": batch.changed_ids()}


@router.post("/computers/bulk-update")
def bulk_update(
    payload: dict = Body(...),
    user=Depends(require_editor),
    session=Depends(get_db),
):
    """{ids, field, value} — одно поле у всех выбранных ПК (пустое — очистить)."""
    ids = parse_ids(payload.get("ids"))
    field = payload.get("field")

    if not isinstance(field, str) or not field or field in BULK_EXCLUDED:
        raise HTTPException(status_code=400, detail="Это поле нельзя менять сразу у нескольких ПК.")

    computers = lock_computers(session, ids)
    user_field_keys = user_field_keys_of(session)
    batch = ChangeBatch(user["login"])
    changed = []

    for computer in computers:
        changes = apply_fields(
            session, computer, {field: payload.get("value")}, user_field_keys, batch
        )

        if changes:
            save_changes(session, computer, changes, user["login"])
            changed.append(computer.id)

    batch.finish(session)
    session.commit()
    return {"ok": True, "ids": ids, "changed": changed}
