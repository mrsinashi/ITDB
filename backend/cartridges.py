"""Картриджи (этап 47): справочник картриджей и какие картриджи подходят модели принтера.

- Картриджи – у модели (printer_model_cartridges): в столбце «Картриджи» принтера – картриджи
  его модели, правка ячейки меняет модель (как правка модели в справочнике – у всех её
  принтеров); у принтера без модели картриджей нет. История – у модели (поле cartridges,
  названия через перенос строки), отменяется, как остальные поля модели.
- Справочник пополняется сам: картридж, вписанный модели, которого в нём ещё нет,
  добавляется. Название без учёта регистра – одно («cf283a» – это «CF283A» из справочника).
  Справочники → «Картриджи»: новый, переименовать (у всех моделей сразу), модели картриджа,
  удалить – картридж без моделей. История – entity "cartridges".
"""
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func

from auth import require_editor
from db import get_db
from history_log import log_change
from models import Cartridge, Printer, PrinterModel, PrinterModelCartridge

router = APIRouter(prefix="/api", tags=["printers"])

# Картриджи в одном поле – строками, через запятую или точку с запятой
SPLIT_RE = re.compile(r"[\n,;]+")


def clean_name(value):
    return " ".join(str(value or "").split())


def parse_names(value):
    """Текст («CF283A, CF283X» или строками) или список → названия без повторов."""
    parts = value if isinstance(value, list) else SPLIT_RE.split(str(value or ""))
    result, seen = [], set()

    for part in parts:
        name = clean_name(part)

        if name and name.lower() not in seen:
            seen.add(name.lower())
            result.append(name)

    return result


def names_text(names):
    return "\n".join(names) or None


def model_title(model):
    return " ".join(part for part in (model.maker, model.model) if part)


def cartridges_by_model(session, model_ids=None):
    """id модели → [названия картриджей] в том порядке, как вписали."""
    query = session.query(PrinterModelCartridge.model_id, Cartridge.name).join(
        Cartridge, PrinterModelCartridge.cartridge_id == Cartridge.id,
    )

    if model_ids is not None:
        query = query.filter(PrinterModelCartridge.model_id.in_(list(model_ids) or [0]))

    result = {}

    for model_id, name in query.order_by(PrinterModelCartridge.id):
        result.setdefault(model_id, []).append(name)

    return result


def model_cartridges_text(session, model_id):
    return names_text(cartridges_by_model(session, [model_id]).get(model_id, []))


def find_cartridge(session, name, exclude_id=None):
    query = session.query(Cartridge).filter(func.lower(Cartridge.name) == name.lower())

    if exclude_id is not None:
        query = query.filter(Cartridge.id != exclude_id)

    return query.first()


def ensure_cartridge(session, name, user_name):
    """Картридж справочника по названию; нет – добавить (справочник пополняется сам)."""
    found = find_cartridge(session, name)

    if found is not None:
        return found

    cartridge = Cartridge(name=name)
    session.add(cartridge)
    session.flush()
    log_change(session, "cartridges", cartridge.id, user_name, {"created": {"old": None, "new": name}}, title=name)
    return cartridge


def set_model_cartridges(session, model, value, user_name):
    """Картриджи модели – из текста или списка названий; новые – в справочник.
    Ответ – изменение для Истории модели {"old", "new"} (текстом) или None."""
    cartridges = [ensure_cartridge(session, name, user_name) for name in parse_names(value)]
    links = (
        session.query(PrinterModelCartridge)
        .filter(PrinterModelCartridge.model_id == model.id)
        .order_by(PrinterModelCartridge.id)
        .all()
    )
    old_ids = [link.cartridge_id for link in links]

    if old_ids == [c.id for c in cartridges]:
        return None

    old = model_cartridges_text(session, model.id)

    for link in links:
        session.delete(link)

    session.flush()

    for cartridge in cartridges:
        session.add(PrinterModelCartridge(model_id=model.id, cartridge_id=cartridge.id))

    session.flush()
    return {"old": old, "new": names_text([c.name for c in cartridges])}


def set_printer_cartridges(session, printer, value, user_name):
    """Ячейка «Картриджи» принтера: картриджи – его модели (запись в Истории модели).
    Ответ – изменилось ли."""
    model = session.get(PrinterModel, printer.model_id) if printer.model_id else None

    if model is None:
        raise HTTPException(status_code=400, detail="У принтера нет модели – картриджи пишутся модели.")

    change = set_model_cartridges(session, model, value, user_name)

    if change is None:
        return False

    log_change(session, "printer_models", model.id, user_name, {"cartridges": change}, title=model_title(model))
    return True


# ---------- Справочник картриджей ----------


class CartridgeIn(BaseModel):
    name: Optional[str] = None
    model_ids: Optional[list[int]] = None   # модели, которым картридж подходит


def cartridge_rows(session):
    """Картриджи по названию: модели и сколько рабочих принтеров этих моделей."""
    models = {model.id: model for model in session.query(PrinterModel).all()}
    printers = dict(
        session.query(Printer.model_id, func.count(Printer.id))
        .filter(Printer.model_id.isnot(None), Printer.archived == False)  # noqa: E712
        .group_by(Printer.model_id)
        .all()
    )
    by_cartridge = {}

    for link in session.query(PrinterModelCartridge).order_by(PrinterModelCartridge.id):
        by_cartridge.setdefault(link.cartridge_id, []).append(link.model_id)

    items = []

    for cartridge in session.query(Cartridge).all():
        model_ids = by_cartridge.get(cartridge.id, [])
        listed = sorted(
            ({"id": mid, "title": model_title(models[mid])} for mid in model_ids if mid in models),
            key=lambda m: m["title"].lower(),
        )
        items.append({
            "id": cartridge.id,
            "name": cartridge.name,
            "models": listed,
            "printers": sum(printers.get(mid, 0) for mid in model_ids),
        })

    items.sort(key=lambda item: item["name"].lower())
    return items


def check_name(session, value, exclude_id=None):
    name = clean_name(value)

    if not name:
        raise HTTPException(status_code=400, detail="Нужно название картриджа.")

    if find_cartridge(session, name, exclude_id) is not None:
        raise HTTPException(status_code=400, detail=f"Картридж «{name}» уже есть.")

    return name


def set_cartridge_models(session, cartridge, model_ids, user_name):
    """Модели картриджа (из справочника картриджей): у каждой модели, где он появился
    или пропал, – запись в Истории модели («Картриджи»)."""
    wanted = list(dict.fromkeys(model_ids))
    models = {model.id: model for model in session.query(PrinterModel).filter(PrinterModel.id.in_(wanted or [0]))}

    if len(models) != len(wanted):
        raise HTTPException(status_code=400, detail="Части моделей уже нет в справочнике. Обнови страницу.")

    links = session.query(PrinterModelCartridge).filter(PrinterModelCartridge.cartridge_id == cartridge.id).all()
    now = {link.model_id for link in links}
    touched = (now - set(wanted)) | (set(wanted) - now)

    for model_id in sorted(touched):
        model = models.get(model_id) or session.get(PrinterModel, model_id)
        names = cartridges_by_model(session, [model_id]).get(model_id, [])

        if model_id in now:
            names = [name for name in names if name.lower() != cartridge.name.lower()]
        else:
            names = names + [cartridge.name]

        change = set_model_cartridges(session, model, names, user_name)

        if change is not None:
            log_change(session, "printer_models", model.id, user_name, {"cartridges": change}, title=model_title(model))


@router.get("/cartridges")
def list_cartridges(session=Depends(get_db)):
    return {"items": cartridge_rows(session)}


@router.post("/cartridges")
def create_cartridge(payload: CartridgeIn, user=Depends(require_editor), session=Depends(get_db)):
    name = check_name(session, payload.name)
    cartridge = ensure_cartridge(session, name, user["login"])

    if payload.model_ids:
        set_cartridge_models(session, cartridge, payload.model_ids, user["login"])

    session.commit()
    return {"ok": True, "id": cartridge.id, "name": cartridge.name}


@router.patch("/cartridges/{cartridge_id}")
def update_cartridge(cartridge_id: int, payload: CartridgeIn, user=Depends(require_editor), session=Depends(get_db)):
    """Переименовать (у всех моделей сразу – название одно) и (или) задать модели."""
    cartridge = session.query(Cartridge).filter(Cartridge.id == cartridge_id).with_for_update().first()

    if cartridge is None:
        raise HTTPException(status_code=404, detail="Картриджа нет в справочнике. Обнови страницу.")

    if payload.name is not None:
        name = check_name(session, payload.name, cartridge.id)

        if name != cartridge.name:
            log_change(session, "cartridges", cartridge.id, user["login"], {"name": {"old": cartridge.name, "new": name}}, title=name)
            cartridge.name = name
            session.flush()

    if payload.model_ids is not None:
        set_cartridge_models(session, cartridge, payload.model_ids, user["login"])

    session.commit()
    return {"ok": True, "id": cartridge.id, "name": cartridge.name}


@router.delete("/cartridges/{cartridge_id}")
def delete_cartridge(cartridge_id: int, user=Depends(require_editor), session=Depends(get_db)):
    """Картридж без моделей можно удалить, как значение справочника."""
    cartridge = session.get(Cartridge, cartridge_id)

    if cartridge is None:
        raise HTTPException(status_code=404, detail="Картриджа нет в справочнике. Обнови страницу.")

    count = session.query(PrinterModelCartridge).filter(PrinterModelCartridge.cartridge_id == cartridge.id).count()

    if count:
        raise HTTPException(status_code=400, detail=f"Картридж подходит моделям: {count}.")

    log_change(session, "cartridges", cartridge.id, user["login"], {"deleted": {"old": cartridge.name, "new": None}}, title=cartridge.name)
    session.delete(cartridge)
    session.commit()
    return {"ok": True}
