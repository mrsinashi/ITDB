"""Принтеры и МФУ (этап 44): таблица принтеров, справочник моделей, вход на веб-страницу.

- Принтер стоит в узле дерева, как ПК; № в кабинете у МФУ и у принтеров – свой счёт
  (в кабинете сначала МФУ 1, 2…, потом принтеры 1, 2…). Новый № занят – принтеры с
  ним и следующими подряд сдвигаются на +1, как № места у ПК; переехал принтер или
  сменился тип, а № там занят – следующий свободный.
- Модель – ссылка на справочник (printer_models): тип, производитель, печать и
  дуплекс берутся из модели; правка модели меняет все её принтеры.
- Веб-страница: есть / нет и адрес (пусто – http://IP); логин и пароль от неё –
  зашифрованными (secret_box.py). Показать их можно только по логину и паролю
  администратора ITDB – кто бы ни смотрел.
- Подключение к ПК – printer_links.py; имя по правилам узлов считает фронт.
- История – entity "printers", модели – "printer_models" (отменяются, как ПК и
  справочники); логин и пароль – без значений и без отмены.
"""
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func

from api_columns import PRINTER_BULK_EXCLUDED, PRINTER_EDITABLE_KEYS
from api_computer_actions import parse_ids
from api_computers import (
    LOCATION_PART_FIELDS, ChangeBatch, get_active_location, load_locations, location_parts, location_path,
    normalize_ip, normalize_multiline, normalize_single,
)
from auth import get_current_user, require_editor, verify_password
from db import get_db
from history_log import PASSWORD_SET, log_change
from models import History, Location, Printer, PrinterModel, User
from printer_links import computer_title, computers_by_printer, links_ids, links_refs, links_text, set_printer_computers
from secret_box import decrypt, encrypt

router = APIRouter(prefix="/api", tags=["printers"])

KINDS = {"mfu": "МФУ", "printer": "Принтер"}
# В кабинете сначала МФУ, потом принтеры, потом без модели
KIND_ORDER = {"mfu": 0, "printer": 1}
YES_NO = {True: "есть", False: "нет"}
COLOR = {True: "цветная", False: "ч/б"}

# Логин и пароль Web: в таблице – только есть ли они
SECRET_FIELDS = ("login", "password")
SECRET_REMOVED = "удалён"

FLAG_WORDS = {"есть": True, "да": True, "+": True, "нет": False, "-": False, "–": False}

ARCHIVED_FILTERS = ("no", "yes", "all")


# ---------- Значения ----------


def parse_number(value):
    """№ в кабинете: целое число; пусто – None."""
    text = normalize_single(value)

    if text is None:
        return None

    try:
        number = float(text.replace(",", "."))
    except ValueError:
        number = None

    if number is None or not number.is_integer():
        raise HTTPException(status_code=400, detail="№ в кабинете – целое число.")

    return int(number)


def parse_flag(value, label):
    """«есть» / «нет» (и да / нет); пусто – None."""
    if isinstance(value, bool) or value is None:
        return value

    text = (normalize_single(value) or "").lower()

    if not text:
        return None

    if text not in FLAG_WORDS:
        raise HTTPException(status_code=400, detail=f"{label}: «есть» или «нет».")

    return FLAG_WORDS[text]


def normalize_url(value):
    """Адрес веб-страницы; без схемы – http://."""
    text = normalize_single(value)

    if text is None:
        return None

    return text if "://" in text else "http://" + text


def model_title(model):
    """«Kyocera ECOSYS M2040dn» – как модель называется в списке выбора."""
    if model is None:
        return None

    return " ".join(part for part in (model.maker, model.model) if part)


def title_key(text):
    return " ".join(str(text or "").lower().split())


def find_model(session, value):
    """Модель справочника по названию (с производителем или без); пусто – None."""
    text = normalize_single(value)

    if text is None:
        return None

    key = title_key(text)
    models = session.query(PrinterModel).all()
    found = [model for model in models if title_key(model_title(model)) == key]

    if not found:
        found = [model for model in models if title_key(model.model) == key]

    if not found:
        raise HTTPException(
            status_code=400,
            detail=f"Модели «{text}» нет в справочнике – добавь её: Справочники → Модели принтеров.",
        )

    if len(found) > 1:
        raise HTTPException(status_code=400, detail=f"«{text}» – несколько моделей: укажи производителя.")

    return found[0]


# ---------- № в кабинете ----------


def kind_of(session, printer):
    """mfu / printer – по модели; без модели – None."""
    if printer.model_id is None:
        return None

    model = session.get(PrinterModel, printer.model_id)
    return model.kind if model else None


def same_group(session, location_id, kind, exclude_ids=(), lock=False):
    """Рабочие принтеры узла того же типа: у них общий счёт №."""
    query = session.query(Printer).filter(Printer.location_id == location_id, Printer.archived == False)  # noqa: E712

    if kind is None:
        query = query.filter(Printer.model_id.is_(None))
    else:
        query = query.join(PrinterModel, Printer.model_id == PrinterModel.id).filter(PrinterModel.kind == kind)

    if exclude_ids:
        query = query.filter(Printer.id.notin_(list(exclude_ids)))

    if lock:
        query = query.with_for_update(of=Printer)

    return query.all()


def next_number(session, location_id, kind, exclude_ids=()):
    numbers = [p.number for p in same_group(session, location_id, kind, exclude_ids) if p.number is not None]
    return max(numbers, default=0) + 1


def shift_numbers(session, batch, location_id, kind, number, exclude_ids=()):
    """№ занят – принтеры с ним и следующими подряд номерами сдвигаются на +1
    (3, 4, 5 → 4, 5, 6; после пропуска – не трогаются)."""
    if location_id is None or number is None:
        return

    by_number = defaultdict(list)

    for printer in same_group(session, location_id, kind, exclude_ids, lock=True):
        if printer.number is not None:
            by_number[printer.number].append(printer)

    shifted = []

    while number in by_number:
        shifted.extend(by_number[number])
        number += 1

    for printer in shifted:
        batch.record(printer, "number", printer.number, printer.number + 1)
        printer.number += 1

    session.flush()


# ---------- Строки таблицы ----------


def location_sort_keys(locations):
    """id узла → порядок в дереве (sort узлов по пути)."""
    by_id = {location.id: location for location in locations}
    keys = {}

    for location in locations:
        parts = []
        current = location
        depth = 0

        while current and depth < 20:
            parts.append(current.sort or 0)
            current = by_id.get(current.parent_id)
            depth += 1

        keys[location.id] = tuple(reversed(parts))

    return keys


def printer_row(printer, parts, model, links):
    row = {field: parts[field] for field in LOCATION_PART_FIELDS}
    row.update(
        {
            "id": printer.id,
            "location_id": printer.location_id,
            "number": printer.number,
            "name": printer.name,
            "computers": links_text(links, computer_title),
            "computer_refs": links_refs(links, computer_title),
            "ip": printer.ip,
            "kind": KINDS.get(model.kind) if model else None,
            "kind_key": model.kind if model else None,
            "maker": model.maker if model else None,
            "model": model.model if model else None,
            "model_id": printer.model_id,
            "model_title": model_title(model),
            "color": COLOR.get(model.color) if model else None,
            "duplex": YES_NO.get(model.duplex) if model else None,
            "web": YES_NO.get(printer.web),
            "web_url": printer.web_url,
            "web_auth": YES_NO[True] if any(printer.web_secrets.get(key) for key in SECRET_FIELDS) else None,
            "inv_no": printer.inv_no,
            "serial": printer.serial,
            "note": printer.note,
            "archived": printer.archived,
            "version": printer.version,
            "updated_at": printer.updated_at,
        }
    )
    return row


def printer_rows(session, archived="no", ids=None):
    """Строки таблицы принтеров: дерево → МФУ, принтеры, без модели → № → имя."""
    query = session.query(Printer)

    if archived == "no":
        query = query.filter(Printer.archived == False)  # noqa: E712
    elif archived == "yes":
        query = query.filter(Printer.archived == True)  # noqa: E712

    if ids is not None:
        query = query.filter(Printer.id.in_(list(ids) or [0]))

    printers = query.all()
    locations = session.query(Location).all()
    by_id = {location.id: location for location in locations}
    sort_keys = location_sort_keys(locations)
    models = {model.id: model for model in session.query(PrinterModel).all()}
    links = computers_by_printer(session, [p.id for p in printers] if ids is not None else None)
    parts_cache = {}
    rows = []

    for printer in printers:
        if printer.location_id not in parts_cache:
            parts_cache[printer.location_id] = location_parts(printer.location_id, by_id)

        rows.append(printer_row(printer, parts_cache[printer.location_id], models.get(printer.model_id), links.get(printer.id, [])))

    def sort_key(row):
        return (
            sort_keys.get(row["location_id"], (999999,)),
            KIND_ORDER.get(row["kind_key"], 2),
            row["number"] is None,
            row["number"] or 0,
            (row["name"] or "").lower(),
            row["id"],
        )

    rows.sort(key=sort_key)
    return rows


def one_row(session, printer_id):
    rows = printer_rows(session, "all", [printer_id])
    return rows[0] if rows else None


@router.get("/printers")
def list_printers(archived: str = "no", session=Depends(get_db)):
    """archived: no – рабочие (по умолчанию), yes – архив, all – все (признак archived)."""
    if archived not in ARCHIVED_FILTERS:
        raise HTTPException(status_code=400, detail="archived: no, yes или all.")

    return {"rows": printer_rows(session, archived)}


@router.get("/printers/{printer_id}")
def get_printer(printer_id: int, session=Depends(get_db)):
    """Карточка принтера: строка и история."""
    row = one_row(session, printer_id)

    if row is None:
        raise HTTPException(status_code=404, detail="Принтер не найден.")

    items = (
        session.query(History)
        .filter(History.entity == "printers", History.entity_id == printer_id)
        .order_by(History.at.desc(), History.id.desc())
        .all()
    )

    return {
        "row": row,
        "history": [
            {"id": item.id, "at": item.at, "user_name": item.user_name, "changes": item.changes or {}, "cancelled": item.cancelled}
            for item in items
        ],
    }


# ---------- Правка ----------


def apply_printer_fields(session, printer, payload, batch):
    """Правка полей одного принтера (PATCH, массовая правка, отмена из Истории).
    Возвращает изменения этого принтера; сдвинутые соседи по № – в batch."""
    changes = {}
    old_kind = kind_of(session, printer)
    moved = False
    number_given = False
    locations_by_id = None

    for field, value in payload.items():
        if field not in PRINTER_EDITABLE_KEYS and field not in ("location_id", "model_id"):
            raise HTTPException(status_code=400, detail=f"Неизвестное поле: {field}")

        if field == "location_id":
            location = get_active_location(session, value)

            if location.id != printer.location_id:
                locations_by_id = locations_by_id or load_locations(session)
                changes["location_id"] = {
                    "old": location_path(printer.location_id, locations_by_id),
                    "new": location_path(location.id, locations_by_id),
                    "old_id": printer.location_id,
                    "new_id": location.id,
                }
                printer.location_id = location.id
                moved = True

            continue

        if field == "computers":
            result = set_printer_computers(session, printer, value)

            if result:
                changes["computers"] = result

            continue

        if field in ("model", "model_id"):
            if field == "model":
                model = find_model(session, value)
            else:
                model = session.get(PrinterModel, int(value)) if value not in (None, "") else None

                if value not in (None, "") and model is None:
                    raise HTTPException(status_code=400, detail="Этой модели больше нет в справочнике.")

            new_id = model.id if model else None

            if new_id != printer.model_id:
                old_model = session.get(PrinterModel, printer.model_id) if printer.model_id else None
                # id моделей – чтобы откат из Истории не зависел от названий
                changes["model"] = {
                    "old": model_title(old_model), "new": model_title(model),
                    "old_id": printer.model_id, "new_id": new_id,
                }
                printer.model_id = new_id

            continue

        if field == "web":
            new_value = parse_flag(value, "Веб-страница")

            if new_value != printer.web:
                changes["web"] = {"old": YES_NO.get(printer.web), "new": YES_NO.get(new_value)}
                printer.web = new_value

            continue

        if field == "number":
            new_value = parse_number(value)
            number_given = new_value != printer.number
        elif field == "ip":
            new_value = normalize_ip(value)
        elif field == "note":
            new_value = normalize_multiline(value)
        elif field == "web_url":
            new_value = normalize_url(value)
        else:
            new_value = normalize_single(value)

        old_value = getattr(printer, field)

        if old_value != new_value:
            changes[field] = {"old": old_value, "new": new_value}
            setattr(printer, field, new_value)

    session.flush()
    kind = kind_of(session, printer)

    if number_given:
        shift_numbers(session, batch, printer.location_id, kind, printer.number, {printer.id})
    elif (moved or kind != old_kind) and printer.number is not None and not printer.archived:
        taken = any(p.number == printer.number for p in same_group(session, printer.location_id, kind, {printer.id}))

        if taken:
            number = next_number(session, printer.location_id, kind, {printer.id})
            changes["number"] = {"old": printer.number, "new": number}
            printer.number = number

    return changes


def save_printer_changes(session, printer, changes, user_name):
    if not changes:
        return

    printer.version = (printer.version or 1) + 1
    printer.updated_at = datetime.now(timezone.utc)
    session.add(History(entity="printers", entity_id=printer.id, user_name=user_name, changes=changes))


def lock_printer(session, printer_id):
    printer = session.query(Printer).filter(Printer.id == printer_id).with_for_update().first()

    if not printer:
        raise HTTPException(status_code=404, detail="Принтер не найден.")

    return printer


def lock_printers(session, ids):
    printers = session.query(Printer).filter(Printer.id.in_(ids)).with_for_update().all()

    if len(printers) != len(ids):
        raise HTTPException(status_code=404, detail="Часть принтеров не найдена. Обнови таблицу.")

    by_id = {printer.id: printer for printer in printers}
    return [by_id[printer_id] for printer_id in ids]


@router.post("/printers")
def create_printer(payload: dict = Body(...), user=Depends(require_editor), session=Depends(get_db)):
    """Новый принтер: расположение обязательно; №, имя, IP, модель – по желанию.
    Без № – следующий свободный в кабинете (у МФУ и принтеров – свой счёт)."""
    location = get_active_location(session, payload.get("location_id"))

    if payload.get("model_id") not in (None, ""):
        model = session.get(PrinterModel, int(payload["model_id"]))

        if model is None:
            raise HTTPException(status_code=400, detail="Этой модели больше нет в справочнике.")
    else:
        model = find_model(session, payload.get("model"))

    kind = model.kind if model else None
    number = parse_number(payload.get("number"))
    name = normalize_single(payload.get("name"))
    ip = normalize_ip(payload.get("ip"))

    batch = ChangeBatch(user["login"])

    if number is None:
        number = next_number(session, location.id, kind)
    else:
        shift_numbers(session, batch, location.id, kind, number)

    batch.finish(session)

    printer = Printer(location_id=location.id, number=number, name=name, ip=ip, model_id=model.id if model else None, web_secrets={})
    session.add(printer)
    session.flush()

    changes = {"created": {"old": None, "new": location_path(location.id, load_locations(session))}}

    for field, value in (("number", number), ("name", name), ("ip", ip)):
        if value is not None:
            changes[field] = {"old": None, "new": value}

    if model:
        changes["model"] = {"old": None, "new": model_title(model), "old_id": None, "new_id": model.id}

    session.add(History(entity="printers", entity_id=printer.id, user_name=user["login"], changes=changes))
    session.commit()

    return {"ok": True, "id": printer.id, "shifted": batch.changed_ids("printers")}


@router.patch("/printers/{printer_id}")
def update_printer(printer_id: int, payload: dict = Body(...), user=Depends(require_editor), session=Depends(get_db)):
    payload = dict(payload)
    expected_version = payload.pop("_version", None)
    printer = lock_printer(session, printer_id)

    if expected_version is not None:
        try:
            expected_version = int(expected_version)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="_version должен быть числом.")

        if expected_version != printer.version:
            raise HTTPException(
                status_code=409,
                detail="Этот принтер уже изменил другой пользователь. Таблица будет обновлена – проверь значение и повтори правку.",
            )

    batch = ChangeBatch(user["login"])
    changes = apply_printer_fields(session, printer, payload, batch)

    if changes:
        save_printer_changes(session, printer, changes, user["login"])
        batch.finish(session)
        session.commit()
    else:
        session.rollback()

    return {
        "ok": True,
        "id": printer_id,
        "changes": changes,
        "updated": one_row(session, printer_id),
        # Соседи, которым сдвинули №: таблицу надо перечитать
        "shifted": batch.changed_ids("printers"),
    }


@router.post("/printers/archive")
def archive_printers(payload: dict = Body(...), user=Depends(require_editor), session=Depends(get_db)):
    """{"ids": [...], "archived": true/false}: в архив или обратно, запись Истории у каждого."""
    ids = parse_ids(payload.get("ids"))
    archived = payload.get("archived")

    if not isinstance(archived, bool):
        raise HTTPException(status_code=400, detail="archived должен быть true или false.")

    changed = []

    for printer in lock_printers(session, ids):
        if printer.archived == archived:
            continue

        save_printer_changes(session, printer, {"archived": {"old": printer.archived, "new": archived}}, user["login"])
        printer.archived = archived
        changed.append(printer.id)

    session.commit()
    return {"ok": True, "changed": sorted(changed)}


@router.post("/printers/bulk-update")
def bulk_update_printers(payload: dict = Body(...), user=Depends(require_editor), session=Depends(get_db)):
    """{ids, field, value} – одно поле у всех выбранных принтеров (пустое – очистить)."""
    ids = parse_ids(payload.get("ids"))
    field = payload.get("field")

    if not isinstance(field, str) or field not in PRINTER_EDITABLE_KEYS or field in PRINTER_BULK_EXCLUDED:
        raise HTTPException(status_code=400, detail="Это поле нельзя менять сразу у нескольких принтеров.")

    batch = ChangeBatch(user["login"])
    changed = []

    for printer in lock_printers(session, ids):
        changes = apply_printer_fields(session, printer, {field: payload.get("value")}, batch)

        if changes:
            save_printer_changes(session, printer, changes, user["login"])
            changed.append(printer.id)

    batch.finish(session)
    session.commit()
    return {"ok": True, "ids": ids, "changed": changed}


# ---------- Логин и пароль от веб-страницы ----------


class WebAuthUpdate(BaseModel):
    login: Optional[str] = None      # None – не менять, "" – удалить
    password: Optional[str] = None


@router.put("/printers/{printer_id}/web-auth")
def set_web_auth(printer_id: int, payload: WebAuthUpdate, user=Depends(require_editor), session=Depends(get_db)):
    """Задать или удалить логин и пароль Web; в Историю – без значений."""
    printer = lock_printer(session, printer_id)
    secrets = dict(printer.web_secrets or {})
    changes = {}

    for key in SECRET_FIELDS:
        value = getattr(payload, key)

        if value is None:
            continue

        value = value.strip() if key == "login" else value

        if value:
            secrets[key] = encrypt(value)
            changes["web_" + key] = {"old": None, "new": PASSWORD_SET}
        elif key in secrets:
            del secrets[key]
            changes["web_" + key] = {"old": None, "new": SECRET_REMOVED}

    if changes:
        printer.web_secrets = secrets
        save_printer_changes(session, printer, changes, user["login"])
        session.commit()

    return {"ok": True, "updated": one_row(session, printer_id)}


# Попытки показать логин и пароль с неверными данными администратора: как вход –
# не больше 5 за 5 минут с одного адреса
show_attempts = defaultdict(list)
SHOW_MAX_ATTEMPTS = 5
SHOW_WINDOW_SECONDS = 300


class AdminCheck(BaseModel):
    login: str
    password: str


@router.post("/printers/{printer_id}/web-auth/show")
def show_web_auth(printer_id: int, payload: AdminCheck, request: Request, user=Depends(get_current_user), session=Depends(get_db)):
    """Логин и пароль Web – по логину и паролю администратора ITDB."""
    ip = request.client.host if request.client else "unknown"
    now = datetime.now(timezone.utc)
    show_attempts[ip] = [at for at in show_attempts[ip] if (now - at).total_seconds() < SHOW_WINDOW_SECONDS]

    if len(show_attempts[ip]) >= SHOW_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Слишком много попыток. Попробуй позже.")

    admin = (
        session.query(User)
        .filter(func.lower(User.login) == payload.login.strip().lower(), User.archived == False)  # noqa: E712
        .first()
    )

    if not admin or admin.role != "admin" or not verify_password(payload.password, admin.password_hash):
        show_attempts[ip].append(now)
        raise HTTPException(status_code=403, detail="Нужны логин и пароль администратора.")

    show_attempts.pop(ip, None)
    printer = session.get(Printer, printer_id)

    if not printer:
        raise HTTPException(status_code=404, detail="Принтер не найден.")

    secrets = printer.web_secrets or {}

    return {
        "login": decrypt(secrets["login"], "логин") if secrets.get("login") else None,
        "password": decrypt(secrets["password"]) if secrets.get("password") else None,
    }


# ---------- Справочник моделей ----------


class ModelIn(BaseModel):
    kind: Optional[str] = None
    maker: Optional[str] = None
    model: Optional[str] = None
    color: Optional[bool] = None
    duplex: Optional[bool] = None


MODEL_FIELDS = ("kind", "maker", "model", "color", "duplex")


def model_out(model, count):
    return {
        "id": model.id,
        "kind": model.kind,
        "maker": model.maker,
        "model": model.model,
        "title": model_title(model),
        "color": model.color,
        "duplex": model.duplex,
        "printers": count,
    }


def model_counts(session):
    """id модели → число принтеров (и в архиве: они тоже на неё ссылаются)."""
    return dict(session.query(Printer.model_id, func.count(Printer.id)).filter(Printer.model_id.isnot(None)).group_by(Printer.model_id).all())


def check_model(session, model):
    """Тип известен, название есть, такой модели (производитель + название) ещё нет."""
    if model.kind not in KINDS:
        raise HTTPException(status_code=400, detail="Тип: МФУ или принтер.")

    if not model.model:
        raise HTTPException(status_code=400, detail="Нужно название модели.")

    key = title_key(model_title(model))

    for other in session.query(PrinterModel).filter(PrinterModel.id != (model.id or 0)).all():
        if title_key(model_title(other)) == key:
            raise HTTPException(status_code=400, detail=f"Модель «{model_title(model)}» уже есть.")


def clean_model_value(field, value):
    if field in ("maker", "model"):
        return normalize_single(value)

    return value


def renumber_after_kind_change(session, model, batch):
    """Тип модели сменился: её принтеры – в другом счёте №; где № занят – следующий свободный."""
    session.flush()
    printers = (
        session.query(Printer)
        .filter(Printer.model_id == model.id, Printer.archived == False, Printer.number.isnot(None))  # noqa: E712
        .order_by(Printer.location_id, Printer.number, Printer.id)
        .with_for_update()
        .all()
    )

    for printer in printers:
        others = same_group(session, printer.location_id, model.kind, {printer.id})

        if any(p.number == printer.number for p in others):
            number = next_number(session, printer.location_id, model.kind, {printer.id})
            batch.record(printer, "number", printer.number, number)
            printer.number = number
            session.flush()


@router.get("/printer-models")
def list_models(session=Depends(get_db)):
    counts = model_counts(session)
    models = session.query(PrinterModel).all()
    models.sort(key=lambda m: (KIND_ORDER.get(m.kind, 2), title_key(model_title(m))))
    return {"items": [model_out(model, counts.get(model.id, 0)) for model in models]}


@router.post("/printer-models")
def create_model(payload: ModelIn, user=Depends(require_editor), session=Depends(get_db)):
    model = PrinterModel(
        kind=payload.kind or "printer",
        maker=normalize_single(payload.maker),
        model=normalize_single(payload.model),
        color=payload.color,
        duplex=payload.duplex,
    )
    check_model(session, model)
    session.add(model)
    session.flush()
    log_change(session, "printer_models", model.id, user["login"],
               {"created": {"old": None, "new": model_title(model)}}, title=model_title(model))
    session.commit()
    return model_out(model, 0)


@router.patch("/printer-models/{model_id}")
def update_model(model_id: int, payload: ModelIn, user=Depends(require_editor), session=Depends(get_db)):
    """Правка модели меняет все её принтеры (в Истории – у модели)."""
    model = session.query(PrinterModel).filter(PrinterModel.id == model_id).with_for_update().first()

    if not model:
        raise HTTPException(status_code=404, detail="Модели нет в справочнике. Обнови страницу.")

    before = {field: getattr(model, field) for field in MODEL_FIELDS}

    for field in payload.model_fields_set:
        setattr(model, field, clean_model_value(field, getattr(payload, field)))

    check_model(session, model)
    batch = ChangeBatch(user["login"])

    if model.kind != before["kind"]:
        renumber_after_kind_change(session, model, batch)

    log_change(session, "printer_models", model.id, user["login"],
               {field: {"old": before[field], "new": getattr(model, field)} for field in MODEL_FIELDS}, title=model_title(model))
    batch.finish(session)
    session.commit()
    return model_out(model, model_counts(session).get(model.id, 0))


@router.delete("/printer-models/{model_id}")
def delete_model(model_id: int, user=Depends(require_editor), session=Depends(get_db)):
    """Модель без принтеров (и в архиве) можно удалить, как значение справочника."""
    model = session.get(PrinterModel, model_id)

    if not model:
        raise HTTPException(status_code=404, detail="Модели нет в справочнике. Обнови страницу.")

    count = model_counts(session).get(model.id, 0)

    if count:
        raise HTTPException(status_code=400, detail=f"У модели есть принтеры: {count}.")

    log_change(session, "printer_models", model.id, user["login"],
               {"deleted": {"old": model_title(model), "new": None}}, title=model_title(model))
    session.delete(model)
    session.commit()
    return {"ok": True}


# ---------- Для Истории: текущие значения принтера ----------


def printer_value(session, printer, field):
    """Значение поля принтера, как его пишет История (для отмены и возврата)."""
    if field == "computers":
        return links_ids(computers_by_printer(session, [printer.id]).get(printer.id, []))

    if field == "web":
        return YES_NO.get(printer.web)

    if field == "model":
        return printer.model_id

    return getattr(printer, field, None)


def printer_display(session, field, value):
    if field == "model":
        return model_title(session.get(PrinterModel, value)) if value is not None else None

    return value
