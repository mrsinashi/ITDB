from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func
from auth import require_editor
from db import get_db
from history_log import choice_title, diff, log_change
from models import Choice

# Поля значения справочника, которые пишутся в историю (порядок – нет)
# Галочки оформления: жирный, курсив, подчёркнутый, зачёркнутый, фон блочком
FLAG_FIELDS = ("bold", "italic", "underline", "strike", "chip")
HISTORY_FIELDS = ("value", "color", "bg_color") + FLAG_FIELDS

router = APIRouter(prefix="/api/choices", tags=["choices"])


@router.get("")
def list_choices(session=Depends(get_db)):
    choices = (
        session.query(Choice)
        .order_by(Choice.field, Choice.sort, Choice.id)
        .all()
    )
    return {
        "items": [
            {
                "id": c.id,
                "field": c.field,
                "value": c.value,
                "sort": c.sort,
                "color": c.color,
                "bg_color": c.bg_color,
                **{name: getattr(c, name) for name in FLAG_FIELDS},
            }
            for c in choices
        ]
    }


@router.post("")
def create_choice(
    payload: dict = Body(...),
    user=Depends(require_editor),
    session=Depends(get_db),
):
    field = (payload.get("field") or "").strip()
    value = (payload.get("value") or "").strip()
    if not field or not value:
        raise HTTPException(
            status_code=400,
            detail="Нужно указать поле и значение.",
        )
    exists = (
        session.query(Choice)
        .filter(Choice.field == field, Choice.value == value)
        .first()
    )
    if exists:
        raise HTTPException(
            status_code=400,
            detail="Такое значение уже есть в этом справочнике.",
        )
    max_sort = (
        session.query(func.max(Choice.sort))
        .filter(Choice.field == field)
        .scalar()
    ) or 0
    choice = Choice(field=field, value=value, sort=max_sort + 1)
    session.add(choice)
    session.flush()
    log_change(session, "choices", choice.id, user["login"],
               {"created": {"old": None, "new": value}}, title=choice_title(session, choice))
    session.commit()
    return {"ok": True, "id": choice.id}


@router.patch("/{choice_id}")
def update_choice(
    choice_id: int,
    payload: dict = Body(...),
    user=Depends(require_editor),
    session=Depends(get_db),
):
    choice = session.get(Choice, choice_id)
    if not choice:
        raise HTTPException(
            status_code=404,
            detail="Значение не найдено.",
        )
    before = {name: getattr(choice, name) for name in HISTORY_FIELDS}
    if "value" in payload:
        new_value = (payload.get("value") or "").strip()
        if not new_value:
            raise HTTPException(
                status_code=400,
                detail="Значение не может быть пустым.",
            )
        exists = (
            session.query(Choice)
            .filter(
                Choice.field == choice.field,
                Choice.value == new_value,
                Choice.id != choice_id,
            )
            .first()
        )
        if exists:
            raise HTTPException(
                status_code=400,
                detail="Такое значение уже есть в этом справочнике.",
            )
        choice.value = new_value
    if "color" in payload:
        color = (payload.get("color") or "").strip()
        choice.color = color if color else None
    if "bg_color" in payload:
        bg = (payload.get("bg_color") or "").strip()
        choice.bg_color = bg if bg else None
    for name in FLAG_FIELDS:
        if name in payload:
            setattr(choice, name, bool(payload.get(name)))
    if "sort" in payload:
        try:
            choice.sort = int(payload.get("sort"))
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=400,
                detail="sort должен быть числом.",
            )
    log_change(session, "choices", choice.id, user["login"],
               diff(choice, HISTORY_FIELDS, before), title=choice_title(session, choice))
    session.commit()
    return {"ok": True, "id": choice.id}

@router.delete("/{choice_id}")
def delete_choice(
    choice_id: int,
    user=Depends(require_editor),
    session=Depends(get_db),
):
    choice = session.get(Choice, choice_id)
    if not choice:
        raise HTTPException(status_code=404, detail="Значение не найдено.")
    log_change(session, "choices", choice.id, user["login"],
               {"deleted": {"old": choice.value, "new": None}}, title=choice_title(session, choice))
    session.delete(choice)
    session.commit()
    return {"ok": True, "id": choice_id}
