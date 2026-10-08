import re

from fastapi import APIRouter, Body, Depends, HTTPException

from auth import require_editor
from db import get_db
from history_log import column_label, log_change
from models import ColumnStyle

# Галочки: жирный, курсив, подчёркнутый, зачёркнутый, фон блочком (а не заливкой ячейки)
FLAG_FIELDS = ("bold", "italic", "underline", "strike", "chip")
STYLE_FIELDS = ("color", "bg_color") + FLAG_FIELDS

router = APIRouter(prefix="/api/column-styles", tags=["column_styles"])

COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
FIELD_RE = re.compile(r"^[A-Za-z0-9_.Ѐ-ӿ]{1,40}$")


def style_dict(item):
    return {
        "field": item.field,
        "color": item.color,
        "bg_color": item.bg_color,
        **{name: bool(getattr(item, name)) for name in FLAG_FIELDS},
    }


def is_empty(item):
    """Оформления нет («блочком» без фона ничего не значит) – строка не нужна."""
    return not (item.color or item.bg_color or item.bold or item.italic or item.underline or item.strike)


@router.get("")
def list_column_styles(session=Depends(get_db)):
    return {"items": [style_dict(item) for item in session.query(ColumnStyle).all()]}


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
    session=Depends(get_db),
):
    """Меняет только переданные свойства. Пустой стиль удаляется."""
    if not FIELD_RE.match(field):
        raise HTTPException(status_code=400, detail="Неизвестный столбец.")
    item = session.get(ColumnStyle, field)
    existed = item is not None
    if not existed:
        item = ColumnStyle(field=field, **{name: False for name in FLAG_FIELDS})
    before = style_dict(item)
    if "color" in payload:
        item.color = clean_color(payload.get("color"))
    if "bg_color" in payload:
        item.bg_color = clean_color(payload.get("bg_color"))
    for name in FLAG_FIELDS:
        if name in payload:
            setattr(item, name, bool(payload.get(name)))

    result = style_dict(item)
    # Оформление столбца: entity_id 0, столбец – в entity_key
    log_change(session, "column_styles", 0, user["login"],
               {name: {"old": before[name], "new": result[name]} for name in STYLE_FIELDS},
               title=column_label(session, field), entity_key=field)
    empty = is_empty(item)
    if empty and existed:
        session.delete(item)
    elif not empty and not existed:
        session.add(item)
    session.commit()
    return {"ok": True, "item": result}
