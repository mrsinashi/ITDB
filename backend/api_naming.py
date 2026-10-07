"""Имена ПК по правилам (этап 35): части имени у узлов дерева, «своё имя» у ПК.

Имя ПК по правилу — части имени узлов по пути через «-» и номер: отделение ter,
кабинет proc → ter-proc-1. Узел с «только своей» частью не берёт части узлов
выше, с одним местом — имя без номера. Какое имя должно быть у ПК, считает фронт
(js/naming.js) по дереву и строкам таблицы; здесь — хранение с проверками:

- часть имени и галочки — поля узла (name_part, name_own, name_single), правка
  пишется в Историю узла и отменяется, как его название;
- «своё имя» у ПК (имя не по правилу и так и надо) — app_settings «name_keep»:
  {id ПК: {name, location_id, by, at}}; действует, пока у ПК то же имя и то же
  расположение (переехал или переименован — проверяется снова);
- переименовать по правилу несколько ПК — обычная правка HOSTNAME одним
  действием (одна отмена Ctrl+Z).
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
from models import AppSetting, Computer, History, Location

router = APIRouter(prefix="/api/naming", tags=["naming"])

KEEP_KEY = "name_keep"

# Имя компьютера в Windows (NetBIOS) — не длиннее 15 знаков
NAME_MAX = 15
PART_RE = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")

RULE_FIELDS = {"part": "name_part", "own": "name_own", "single": "name_single"}


def clean_part(value):
    """Часть имени: строчными, латиница, цифры и «-» между ними; пусто — None."""
    text = str(value or "").strip().lower().strip("-")

    if not text:
        return None

    if not PART_RE.fullmatch(text):
        raise HTTPException(status_code=400, detail="Часть имени — латиница, цифры и «-».")

    if len(text) > NAME_MAX:
        raise HTTPException(status_code=400, detail=f"Часть имени длиннее {NAME_MAX} знаков.")

    return text


def set_rule(location, field, value):
    """Поле правила узла; изменения — для Истории ({поле: {"old", "new"}})."""
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
    """Правила узлов: у каждого — только переданные поля. Одно действие — все
    узлы сразу («Взять из таблицы»), запись Истории у каждого изменённого.
    nodes — правила этих узлов после правки."""
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


def keep_items(session):
    row = session.get(AppSetting, KEEP_KEY)
    return dict(row.value or {}) if row else {}


def keep_list(items):
    return [dict(value, computer_id=int(key)) for key, value in sorted(items.items(), key=lambda kv: int(kv[0]))]


@router.get("/keep")
def get_keep(session=Depends(get_db)):
    """ПК со своим именем. Устаревшие (ПК переименовали, перенесли) фронт не
    считает; убираются при следующей правке списка."""
    return {"items": keep_list(keep_items(session))}


class KeepUpdate(BaseModel):
    ids: List[int]
    keep: bool


@router.post("/keep")
def update_keep(payload: KeepUpdate, me=Depends(require_editor), session=Depends(get_db)):
    """keep — оставить ПК их нынешние имена (на их нынешнем месте); иначе — снова по правилу."""
    ids = parse_ids(payload.ids)
    computers = session.query(Computer).filter(Computer.id.in_(ids)).all()

    if len(computers) != len(ids):
        raise HTTPException(status_code=404, detail="Часть компьютеров не найдена. Обнови таблицу.")

    session.execute(pg_insert(AppSetting).values(key=KEEP_KEY, value={}).on_conflict_do_nothing())
    row = session.query(AppSetting).filter(AppSetting.key == KEEP_KEY).with_for_update().one()
    items = dict(row.value or {})

    # Устаревшие записи — без следа: они и так уже не действуют
    current = {
        computer.id: computer
        for computer in session.query(Computer).filter(Computer.id.in_([int(key) for key in items])).all()
    } if items else {}

    for key in list(items):
        computer = current.get(int(key))

        if (computer is None or computer.archived or computer.hostname != items[key].get("name")
                or computer.location_id != items[key].get("location_id")):
            del items[key]

    now = datetime.now(timezone.utc).isoformat()

    for computer in computers:
        key = str(computer.id)
        old = items.get(key)

        if payload.keep:
            if computer.archived:
                raise HTTPException(status_code=400, detail="Компьютер из архива сначала верни из архива.")

            if not computer.hostname:
                raise HTTPException(status_code=400, detail="У компьютера нет имени.")

            if old:
                continue

            items[key] = {"name": computer.hostname, "location_id": computer.location_id, "by": me["login"], "at": now}
            log_change(session, "naming", computer.id, me["login"],
                       {"name_keep": {"old": None, "new": computer.hostname}}, title=computer.hostname)
        elif old:
            del items[key]
            log_change(session, "naming", computer.id, me["login"],
                       {"name_keep": {"old": old.get("name"), "new": None}}, title=computer.hostname or old.get("name"))

    row.value = items
    row.updated_at = datetime.now(timezone.utc)
    session.commit()
    return {"items": keep_list(items)}


# ---------- Переименовать по правилу ----------


class RenameItem(BaseModel):
    id: int
    hostname: str


class RenameRequest(BaseModel):
    items: List[RenameItem]


@router.post("/rename")
def rename(payload: RenameRequest, me=Depends(require_editor), session=Depends(get_db)):
    """Новые имена нескольким ПК одним действием — как правка HOSTNAME в таблице."""
    ids = parse_ids([item.id for item in payload.items])
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
