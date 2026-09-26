import re

from fastapi import APIRouter, Body, Depends, HTTPException

from auth import require_editor
from db import SessionLocal
from models import ColumnStyle

router = APIRouter(prefix="/api/column-styles", tags=["column_styles"])

COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
FIELD_RE = re.compile(r"^[A-Za-z0-9_.Ѐ-ӿ]{1,40}$")


def style_dict(item):
    return {
        "field": item.field,
        "color": item.color,
        "bg_color": item.bg_color,
        "bold": item.bold,
        "italic": item.italic,
    }


@router.get("")
def list_column_styles():
    session = SessionLocal()
    try:
        return {"items": [style_dict(item) for item in session.query(ColumnStyle).all()]}
    finally:
        session.close()


def clean_color(value):
    value = (value or "").strip()
    if not value:
        return None
    if not COLOR_RE.match(value):
        raise HTTPException(status_code=400, detail="Цвет должен быть в виде #RRGGBB.")
    return value.lower()


@router.patch("/{field}")
def update_column_style(
    field: str,
    payload: dict = Body(...),
    user=Depends(require_editor),
):
    """Меняет только переданные свойства. Пустой стиль удаляется."""
    if not FIELD_RE.match(field):
        raise HTTPException(status_code=400, detail="Неизвестный столбец.")
    session = SessionLocal()
    try:
        item = session.get(ColumnStyle, field)
        existed = item is not None
        if not existed:
            item = ColumnStyle(field=field, bold=False, italic=False)
        if "color" in payload:
            item.color = clean_color(payload.get("color"))
        if "bg_color" in payload:
            item.bg_color = clean_color(payload.get("bg_color"))
        if "bold" in payload:
            item.bold = bool(payload.get("bold"))
        if "italic" in payload:
            item.italic = bool(payload.get("italic"))

        result = style_dict(item)
        empty = not (item.color or item.bg_color or item.bold or item.italic)
        if empty and existed:
            session.delete(item)
        elif not empty and not existed:
            session.add(item)
        session.commit()
        return {"ok": True, "item": result}
    except HTTPException:
        session.rollback()
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=f"Не удалось сохранить: {e}")
    finally:
        session.close()
