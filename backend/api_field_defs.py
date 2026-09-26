import re

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func
from api_computers import is_reserved_field_key
from auth import require_editor
from db import SessionLocal
from models import FieldDef

router = APIRouter(prefix="/api/field-defs", tags=["field_defs"])

# Латиница в нижнем регистре, цифры и "_", начинается с буквы
FIELD_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def validate_field_key(key):
    if not FIELD_KEY_RE.match(key):
        raise HTTPException(
            status_code=400,
            detail="Ключ поля: латинские буквы, цифры и «_», начинается с буквы, "
            "до 40 символов. Например: room_phone.",
        )

    if is_reserved_field_key(key):
        raise HTTPException(
            status_code=400,
            detail=f"Ключ «{key}» занят встроенным полем. Выбери другой.",
        )


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
                    # Старые поля, созданные до проверки ключа, могут совпадать
                    # со встроенными. В таблице они не показываются.
                    "reserved": is_reserved_field_key(f.key),
                }
                for f in items
            ]
        }
    finally:
        session.close()


@router.post("")
def create_field_def(
    payload: dict = Body(...),
    user=Depends(require_editor),
):
    key = (payload.get("key") or "").strip().lower()
    label = (payload.get("label") or "").strip()
    field_type = (payload.get("field_type") or "text").strip()
    if not key or not label:
        raise HTTPException(status_code=400, detail="Нужно указать ключ и название.")
    validate_field_key(key)
    if field_type not in ("text", "number", "date", "boolean"):
        raise HTTPException(status_code=400, detail="Неизвестный тип поля.")
    session = SessionLocal()
    try:
        exists = session.query(FieldDef).filter(FieldDef.key == key).first()
        if exists:
            if exists.archived:
                detail = "Поле с таким ключом уже есть в архиве. Выбери другой ключ."
            else:
                detail = "Поле с таким ключом уже есть."
            raise HTTPException(status_code=400, detail=detail)
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
    user=Depends(require_editor),
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
            try:
                fd.sort = int(payload.get("sort"))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="sort должен быть числом.")
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
    user=Depends(require_editor),
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