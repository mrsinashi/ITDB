from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func
from auth import get_current_user
from db import SessionLocal
from models import FieldDef

router = APIRouter(prefix="/api/field-defs", tags=["field_defs"])


@router.get("")
def list_field_defs():
    session = SessionLocal()
    try:
        items = (
            session.query(FieldDef)
            .filter(FieldDef.archived == False)
            .order_by(FieldDef.sort, FieldDef.id)
            .all()
        )
        return {
            "items": [
                {
                    "id": f.id,
                    "key": f.key,
                    "label": f.label,
                    "field_type": f.field_type,
                    "sort": f.sort,
                }
                for f in items
            ]
        }
    finally:
        session.close()


@router.post("")
def create_field_def(
    payload: dict = Body(...),
    user=Depends(get_current_user),
):
    key = (payload.get("key") or "").strip()
    label = (payload.get("label") or "").strip()
    field_type = (payload.get("field_type") or "text").strip()
    if not key or not label:
        raise HTTPException(status_code=400, detail="Нужно указать ключ и название.")
    if field_type not in ("text", "number", "date", "boolean"):
        raise HTTPException(status_code=400, detail="Неизвестный тип поля.")
    session = SessionLocal()
    try:
        exists = session.query(FieldDef).filter(FieldDef.key == key).first()
        if exists:
            raise HTTPException(status_code=400, detail="Поле с таким ключом уже есть.")
        max_sort = session.query(func.max(FieldDef.sort)).scalar() or 0
        fd = FieldDef(key=key, label=label, field_type=field_type, sort=max_sort + 1)
        session.add(fd)
        session.commit()
        return {"ok": True, "id": fd.id}
    except HTTPException:
        session.rollback()
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=f"Не удалось создать: {e}")
    finally:
        session.close()


@router.patch("/{field_def_id}")
def update_field_def(
    field_def_id: int,
    payload: dict = Body(...),
    user=Depends(get_current_user),
):
    session = SessionLocal()
    try:
        fd = session.get(FieldDef, field_def_id)
        if not fd:
            raise HTTPException(status_code=404, detail="Поле не найдено.")
        if "label" in payload:
            new_label = (payload.get("label") or "").strip()
            if not new_label:
                raise HTTPException(status_code=400, detail="Название не может быть пустым.")
            fd.label = new_label
        if "sort" in payload:
            fd.sort = int(payload.get("sort"))
        session.commit()
        return {"ok": True, "id": fd.id}
    except HTTPException:
        session.rollback()
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=f"Не удалось сохранить: {e}")
    finally:
        session.close()


@router.post("/{field_def_id}/archive")
def archive_field_def(
    field_def_id: int,
    user=Depends(get_current_user),
):
    session = SessionLocal()
    try:
        fd = session.get(FieldDef, field_def_id)
        if not fd or fd.archived:
            raise HTTPException(status_code=404, detail="Поле не найдено.")
        fd.archived = True
        session.commit()
        return {"ok": True, "id": fd.id}
    except HTTPException:
        session.rollback()
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=f"Не удалось архивировать: {e}")
    finally:
        session.close()