"""Выделения значений в Таблице (этап 26к): как показывать значение, когда с ним
что-то не так, — повтор, логина нет в Jabber, логин давно не подключался, имя на
ПК другое (по сканеру), дата просрочена, — или наоборот, всё в порядке: ПК проверен
и GLPI / GSIT, и сетью (этап 28б; по умолчанию не выделяется). Вид — общий для всех,
настраивается в Справочниках, как оформление значений; хранится в app_settings
(«table_marks»), нет строки — вид по умолчанию. Фон — блочком у самого значения или
(chip = False) на всю ячейку."""
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import get_current_user, require_editor
from db import get_db
from history_log import log_change
from models import AppSetting

router = APIRouter(prefix="/api/table-marks", tags=["table"])

KEY = "table_marks"
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
COLORS = ("color", "bg_color")
FLAGS = ("bold", "italic", "underline", "strike", "chip")
PLAIN = {"color": None, "bg_color": None, "bold": False, "italic": False, "underline": False, "strike": False, "chip": True}

# вид → (название, столбец-образец, вид по умолчанию); порядок — как в Справочниках
MARKS = {
    "dup": ("Повтор", {"bg_color": "#ffd6d6"}),
    "hostname": ("Имя на ПК другое", {"color": "#cc0000", "bold": True}),
    "gone": ("Нет в Jabber", {"color": "#cc0000", "bold": True}),
    "stale": ("Давно не подключался", {"color": "#b35c00", "bold": True}),
    "overdue": ("Срок прошёл", {"color": "#cc0000", "bold": True}),
    "verified": ("Проверен сетью и GLPI / GSIT", {}),
}


class MarkOut(BaseModel):
    kind: str
    label: str
    color: Optional[str]
    bg_color: Optional[str]
    bold: bool
    italic: bool
    underline: bool
    strike: bool
    chip: bool      # фон блочком у значения (иначе — на всю ячейку)
    changed: bool   # вид не как по умолчанию


class MarkUpdate(BaseModel):
    """None — не менять; у цветов "" — убрать; reset — вернуть вид по умолчанию."""
    color: Optional[str] = None
    bg_color: Optional[str] = None
    bold: Optional[bool] = None
    italic: Optional[bool] = None
    underline: Optional[bool] = None
    strike: Optional[bool] = None
    chip: Optional[bool] = None
    reset: Optional[bool] = None


def default_of(kind):
    return {**PLAIN, **MARKS[kind][1]}


def marks(session):
    """{вид: оформление} — сохранённое поверх вида по умолчанию."""
    row = session.get(AppSetting, KEY)
    saved = (row.value if row else None) or {}
    result = {}

    for kind in MARKS:
        own = saved.get(kind) or {}
        result[kind] = {field: own.get(field, value) for field, value in default_of(kind).items()}

    return result


def mark_out(kind, style):
    return MarkOut(kind=kind, label=MARKS[kind][0], changed=style != default_of(kind), **style)


@router.get("", response_model=list[MarkOut])
def list_marks(me=Depends(get_current_user), session=Depends(get_db)):
    return [mark_out(kind, style) for kind, style in marks(session).items()]


@router.patch("/{kind}", response_model=MarkOut)
def update_mark(kind: str, payload: MarkUpdate, me=Depends(require_editor), session=Depends(get_db)):
    if kind not in MARKS:
        raise HTTPException(status_code=404, detail="Нет такого выделения.")

    all_marks = marks(session)
    style = all_marks[kind]
    data = payload.model_dump(exclude_none=True)

    if data.pop("reset", False):
        data = {**default_of(kind), **data}

    changes = {}

    for field, value in data.items():
        if field in COLORS:
            value = (value or "").strip().lower() or None

            if value is not None and not COLOR_RE.match(value):
                raise HTTPException(status_code=400, detail="Цвет — в виде #RRGGBB.")

        if style[field] != value:
            changes[field] = {"old": style[field], "new": value}
            style[field] = value

    if changes:
        row = session.get(AppSetting, KEY)

        if row is None:
            row = AppSetting(key=KEY)
            session.add(row)

        row.value = all_marks
        row.updated_at = datetime.now(timezone.utc)
        log_change(session, "table_marks", 0, me["login"], changes, title=MARKS[kind][0], entity_key=kind)
        session.commit()

    return mark_out(kind, style)
