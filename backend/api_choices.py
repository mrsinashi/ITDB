from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func
from auth import get_current_user
from db import SessionLocal
from models import Choice

router = APIRouter(prefix="/api/choices", tags=["choices"])


@router.get("")
def list_choices():
    session = SessionLocal()
    try:
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
                }
                for c in choices
            ]
        }
    finally:
        session.close()


@router.post("")
def create_choice(
    payload: dict = Body(...),
    user=Depends(get_current_user),
):
    field = (payload.get("field") or "").strip()
    value = (payload.get("value") or "").strip()
    if not field or not value:
        raise HTTPException(
            status_code=400,
            detail="Нужно указать поле и значение.",
        )
    session = SessionLocal()
    try:
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
        session.commit()
        return {"ok": True, "id": choice.id}
    except HTTPException:
        session.rollback()
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(
            status_code=400,
            detail=f"Не удалось добавить: {e}",
        )
    finally:
        session.close()


@router.patch("/{choice_id}")
def update_choice(
    choice_id: int,
    payload: dict = Body(...),
    user=Depends(get_current_user),
):
    session = SessionLocal()
    try:
        choice = session.get(Choice, choice_id)
        if not choice:
            raise HTTPException(
                status_code=404,
                detail="Значение не найдено.",
            )
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
        if "sort" in payload:
            try:
                choice.sort = int(payload.get("sort"))
            except (TypeError, ValueError):
                raise HTTPException(
                    status_code=400,
                    detail="sort должен быть числом.",
                )
        session.commit()
        return {"ok": True, "id": choice.id}
    except HTTPException:
        session.rollback()
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(
            status_code=400,
            detail=f"Не удалось сохранить: {e}",
        )
    finally:
        session.close()