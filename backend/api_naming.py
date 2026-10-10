"""Имена ПК по правилам (этап 35): части имени у узлов дерева, «своё имя» у ПК.

Имя ПК по правилу – части имени узлов по пути через «-» и номер: отделение ter,
кабинет proc → ter-proc-1. Узел с «только своей» частью не берёт части узлов
выше, с одним местом – имя без номера. Какое имя должно быть у ПК, считает фронт
(js/naming.js) по дереву и строкам таблицы; здесь – хранение с проверками:

- часть имени и галочки – поля узла (name_part, name_own, name_single), правка
  пишется в Историю узла и отменяется, как его название;
- «своё имя» у ПК (имя не по правилу и так и надо) – app_settings «name_keep»:
  {id ПК: {name, location_id, by, at}}; действует, пока у ПК то же имя и то же
  расположение (переехал или переименован – проверяется снова);
- переименовать по правилу несколько ПК – обычная правка HOSTNAME одним
  действием (одна отмена Ctrl+Z).

Принтеры (этап 44): имя – начало узла, тип и номер (ter-proc-mfu-1), считает фронт;
«своё имя» – app_settings «printer_name_keep», переименование – как у ПК (kind=printer).
"""
import re
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.dialects.postgresql import insert as pg_insert

from api_computer_actions import lock_computers, parse_ids
from api_computers import ChangeBatch, apply_fields, save_changes, user_field_keys_of
from auth import require_editor
from db import get_db
from history_log import log_change
from api_printers import apply_printer_fields, lock_printers, save_printer_changes
from models import AppSetting, Computer, History, Location, Printer

router = APIRouter(prefix="/api/naming", tags=["naming"])

KEEP_KEY = "name_keep"
# «Своё имя» принтеров (этап 44): ключ настройки, таблица, поле имени, ключ id в ответе
KEEPS = {
    "pc": (KEEP_KEY, Computer, "hostname", "computer_id"),
    "printer": ("printer_name_keep", Printer, "name", "printer_id"),
}


def keep_kind(kind):
    if kind not in KEEPS:
        raise HTTPException(status_code=400, detail="kind: pc или printer.")

    return KEEPS[kind]

# Длина части не ограничена (этап 44: бывают имена длиннее 15 знаков NetBIOS)
PART_RE = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")

RULE_FIELDS = {"part": "name_part", "own": "name_own", "single": "name_single"}


def clean_part(value):
    """Часть имени: строчными, латиница, цифры и «-» между ними; пусто – None."""
    text = str(value or "").strip().lower().strip("-")

    if not text:
        return None

    if not PART_RE.fullmatch(text):
        raise HTTPException(status_code=400, detail="Часть имени – латиница, цифры и «-».")

    return text


def set_rule(location, field, value):
    """Поле правила узла; изменения – для Истории ({поле: {"old", "new"}})."""
    old = getattr(location, field)
    new = clean_part(value) if field == "name_part" else bool(value)

    if old == new:
        return {}

    setattr(location, field, new)
    return {field: {"old": old, "new": new}}


class NodeRule(BaseModel):
    id: int
    part: Optional[str] = None
    own: Optional[bool] = None
    single: Optional[bool] = None


class NodesUpdate(BaseModel):
    items: List[NodeRule]


@router.patch("/nodes")
def update_nodes(payload: NodesUpdate, me=Depends(require_editor), session=Depends(get_db)):
    """Правила узлов: у каждого – только переданные поля. Одно действие – все
    узлы сразу («Взять из таблицы»), запись Истории у каждого изменённого.
    nodes – правила этих узлов после правки."""
    ids = [item.id for item in payload.items]

    if not ids:
        raise HTTPException(status_code=400, detail="Нет узлов.")

    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=400, detail="Узел указан дважды.")

    locations = session.query(Location).filter(Location.id.in_(ids)).with_for_update().all()
    by_id = {location.id: location for location in locations}
    changed = []

    for item in payload.items:
        location = by_id.get(item.id)

        if location is None or location.archived:
            raise HTTPException(status_code=404, detail="Узел не найден. Обнови страницу.")

        changes = {}

        for key, field in RULE_FIELDS.items():
            if key in item.model_fields_set:
                changes.update(set_rule(location, field, getattr(item, key)))

        if changes:
            session.add(History(entity="locations", entity_id=location.id, user_name=me["login"], changes=changes))
            changed.append(location.id)

    session.commit()
    nodes = [
        {"id": loc.id, "name_part": loc.name_part, "name_own": loc.name_own, "name_single": loc.name_single}
        for loc in (by_id[item.id] for item in payload.items)
    ]
    return {"ok": True, "changed": changed, "nodes": nodes}


# ---------- «Своё имя» у ПК ----------


def keep_items(session, kind="pc"):
    row = session.get(AppSetting, keep_kind(kind)[0])
    return dict(row.value or {}) if row else {}


def keep_list(items, kind="pc"):
    id_key = keep_kind(kind)[3]
    return [dict(value, **{id_key: int(key)}) for key, value in sorted(items.items(), key=lambda kv: int(kv[0]))]


@router.get("/keep")
def get_keep(kind: str = "pc", session=Depends(get_db)):
    """ПК (kind=printer – принтеры) со своим именем. Устаревшие (переименовали,
    перенесли) фронт не считает; убираются при следующей правке списка."""
    return {"items": keep_list(keep_items(session, kind), kind)}


class KeepUpdate(BaseModel):
    ids: List[int]
    keep: bool
    kind: str = "pc"


@router.post("/keep")
def update_keep(payload: KeepUpdate, me=Depends(require_editor), session=Depends(get_db)):
    """keep – оставить ПК (принтерам) их нынешние имена (на их нынешнем месте); иначе –
    снова по правилу. В Истории – «Своё имя» (entity naming; у принтера – entity_key printer)."""
    setting_key, model, name_field, _ = keep_kind(payload.kind)
    printer = payload.kind == "printer"
    what = "Принтер" if printer else "Компьютер"
    ids = parse_ids(payload.ids)
    objects = session.query(model).filter(model.id.in_(ids)).all()

    if len(objects) != len(ids):
        raise HTTPException(status_code=404, detail=f"Часть {'принтеров' if printer else 'компьютеров'} не найдена. Обнови таблицу.")

    session.execute(pg_insert(AppSetting).values(key=setting_key, value={}).on_conflict_do_nothing())
    row = session.query(AppSetting).filter(AppSetting.key == setting_key).with_for_update().one()
    items = dict(row.value or {})

    # Устаревшие записи – без следа: они и так уже не действуют
    current = {
        obj.id: obj
        for obj in session.query(model).filter(model.id.in_([int(key) for key in items])).all()
    } if items else {}

    for key in list(items):
        obj = current.get(int(key))

        if (obj is None or obj.archived or getattr(obj, name_field) != items[key].get("name")
                or obj.location_id != items[key].get("location_id")):
            del items[key]

    now = datetime.now(timezone.utc).isoformat()
    entity_key = "printer" if printer else None

    for obj in objects:
        key = str(obj.id)
        old = items.get(key)
        name = getattr(obj, name_field)

        if payload.keep:
            if obj.archived:
                raise HTTPException(status_code=400, detail=f"{what} из архива сначала верни из архива.")

            if not name:
                raise HTTPException(status_code=400, detail=f"У {'принтера' if printer else 'компьютера'} нет имени.")

            if old:
                continue

            items[key] = {"name": name, "location_id": obj.location_id, "by": me["login"], "at": now}
            log_change(session, "naming", obj.id, me["login"],
                       {"name_keep": {"old": None, "new": name}}, title=name, entity_key=entity_key)
        elif old:
            del items[key]
            log_change(session, "naming", obj.id, me["login"],
                       {"name_keep": {"old": old.get("name"), "new": None}}, title=name or old.get("name"), entity_key=entity_key)

    row.value = items
    row.updated_at = datetime.now(timezone.utc)
    session.commit()
    return {"items": keep_list(items, payload.kind)}


# ---------- Переименовать по правилу ----------


class RenameItem(BaseModel):
    id: int
    hostname: str


class RenameRequest(BaseModel):
    items: List[RenameItem]
    kind: str = "pc"   # printer – принтеры (этап 44): hostname – их новое имя


@router.post("/rename")
def rename(payload: RenameRequest, me=Depends(require_editor), session=Depends(get_db)):
    """Новые имена нескольким ПК (принтерам) одним действием – как правка имени в таблице."""
    ids = parse_ids([item.id for item in payload.items])

    if payload.kind == "printer":
        return rename_printers(session, ids, payload.items, me)

    computers = lock_computers(session, ids)
    user_field_keys = user_field_keys_of(session)
    batch = ChangeBatch(me["login"])
    changed = []

    for computer, item in zip(computers, payload.items):
        if not item.hostname.strip():
            raise HTTPException(status_code=400, detail="Пустое имя.")

        changes = apply_fields(session, computer, {"hostname": item.hostname}, user_field_keys, batch)

        if changes:
            save_changes(session, computer, changes, me["login"])
            changed.append(computer.id)

    batch.finish(session)
    session.commit()
    return {"ok": True, "changed": changed}


def rename_printers(session, ids, items, me):
    """Принтеры (этап 44): новое имя – как правка «Имени» в таблице принтеров."""
    batch = ChangeBatch(me["login"])
    changed = []

    for printer, item in zip(lock_printers(session, ids), items):
        if not item.hostname.strip():
            raise HTTPException(status_code=400, detail="Пустое имя.")

        changes = apply_printer_fields(session, printer, {"name": item.hostname}, batch)

        if changes:
            save_printer_changes(session, printer, changes, me["login"])
            changed.append(printer.id)

    batch.finish(session)
    session.commit()
    return {"ok": True, "changed": changed}
