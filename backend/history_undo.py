"""Отмена изменений из Истории и возврат значения (этап 19).

Два действия над полем объекта (ПК или узла дерева):

- **Отменить** изменения — у поля в записи истории ставится пометка
  «cancelled» (кто и когда), новой записи нет. Значение поля пересчитывается
  по оставшимся изменениям: оно равно «стало» последнего неотменённого
  изменения (или «было» самого первого, если отменены все). Отмена обратима —
  «Восстановить» снимает пометку и пересчитывает так же.
- **Вернуть значение** — поле получает значение из выбранной строки истории
  (или исходное), в Историю пишется новая запись с пометкой «revert».

Перед отменой значение сверяется с историей: если поле с тех пор менялось не
через неё (например, узел переименовали, а в старой записи путь текстом),
ничего не делается — ошибка с объяснением.

Создание ПК или узла не отменяется (удаления в системе нет — только архив).
Служебные поля записей («Заменил», «Заменён на», старые поля) отменяются
только пометкой: значения у них нет.
"""
from datetime import datetime, timezone

from fastapi import HTTPException

from api_columns import EDITABLE_KEYS, EXTRA_FIELDS, HISTORY_LABELS, COLUMNS_BY_KEY
from api_computers import (
    DATE_FIELDS,
    apply_fields,
    format_date,
    get_main_person_link,
    get_vacuum_logins,
    load_locations,
    location_path,
    user_field_keys_of,
    vacuum_text,
)
from api_locations import check_can_archive, check_duplicate, clean, validate_name_code
from models import Computer, FieldDef, History, Location, Person

ENTITIES = ("computers", "locations")

# Поля узла дерева, которые можно вернуть
LOCATION_VALUE_FIELDS = {"name", "code", "archived"}
LOCATION_LABELS = {"name": "Название", "code": "Код", "archived": "Архив"}

# Ключ в extra → ключ в API (GSIT → gsit)
EXTRA_API_KEYS = {extra_key: key for key, extra_key in EXTRA_FIELDS.items()}


def field_kind(entity, field):
    """value — у поля есть значение (можно отменить и вернуть);
    info — служебная пометка (только отменить); created — создание (нельзя)."""
    if field == "created":
        return "created"

    if entity == "locations":
        return "value" if field in LOCATION_VALUE_FIELDS else "info"

    if field in ("archived", "location_id") or field.startswith("extra."):
        return "value"

    column = COLUMNS_BY_KEY.get(field)

    if field in EDITABLE_KEYS and column is not None and column.kind != "location":
        return "value"

    return "info"


def field_label(session, entity, field):
    if entity == "locations":
        return LOCATION_LABELS.get(field, HISTORY_LABELS.get(field, field))

    if field.startswith("extra."):
        key = field[6:]
        api_key = EXTRA_API_KEYS.get(key)

        if api_key:
            return COLUMNS_BY_KEY[api_key].card

        fd = session.query(FieldDef).filter(FieldDef.key == key).first()
        return fd.label if fd else key

    column = COLUMNS_BY_KEY.get(field)

    if column is not None:
        return column.card

    return HISTORY_LABELS.get(field, field)


def load_object(session, entity, entity_id, lock=True):
    if entity not in ENTITIES:
        raise HTTPException(status_code=400, detail="Для этого объекта отмены нет.")

    model = Computer if entity == "computers" else Location
    query = session.query(model).filter(model.id == entity_id)

    if lock:
        query = query.with_for_update()

    obj = query.first()

    if not obj:
        raise HTTPException(status_code=404, detail="Объект не найден.")

    return obj


def object_title(obj, entity):
    if entity == "computers":
        return obj.hostname or f"ПК #{obj.id}"

    return obj.name or obj.code or f"#{obj.id}"


def field_chain(session, entity, entity_id, field):
    """Записи истории объекта, где менялось поле, — от старых к новым."""
    records = (
        session.query(History)
        .filter(History.entity == entity, History.entity_id == entity_id)
        .order_by(History.at, History.id)
        .with_for_update()
        .all()
    )

    return [record for record in records if field in (record.changes or {})]


def effective_point(chain, field):
    """(изменение, сторона), чьё значение сейчас должно быть у поля:
    «стало» последнего неотменённого или «было» самого первого."""
    for record in reversed(chain):
        change = record.changes[field]

        if not change.get("cancelled"):
            return change, "new"

    return chain[0].changes[field], "old"


class Values:
    """Значения полей в сравнимом виде; у расположения — id узла
    (в старых записях без id — ищется по пути)."""

    def __init__(self, session):
        self.session = session
        self._path_ids = None

    def location_id(self, change, side):
        key = side + "_id"

        if key in change:
            return change[key]

        path = change.get(side)

        if path is None:
            return None

        if self._path_ids is None:
            locations = load_locations(self.session)
            self._path_ids = {}

            # Рабочие узлы важнее архивных с тем же путём
            for location in sorted(locations.values(), key=lambda item: not item.archived):
                self._path_ids[location_path(location.id, locations)] = location.id

        return self._path_ids.get(path, "?")

    def of_change(self, entity, field, change, side):
        if entity == "computers" and field == "location_id":
            return self.location_id(change, side)

        return change.get(side)

    def current(self, entity, obj, field):
        if entity == "locations":
            return getattr(obj, field)

        if field == "archived":
            return obj.archived

        if field == "location_id":
            return obj.location_id

        if field == "user":
            link, _ = get_main_person_link(self.session, obj.id)
            person = self.session.get(Person, link.person_id) if link else None
            return person.full_name if person else None

        if field == "vacuum":
            return vacuum_text(get_vacuum_logins(self.session, obj.id))

        if field.startswith("extra."):
            return (obj.extra or {}).get(field[6:])

        if field in DATE_FIELDS:
            return format_date(getattr(obj, field))

        return getattr(obj, field, None)

    def display(self, entity, field, value):
        """Значение для показа (у расположения — путь)."""
        if entity == "computers" and field == "location_id":
            if value is None or value == "?":
                return None

            return location_path(value, load_locations(self.session))

        return value


def same(field, a, b):
    if a in ("", None) and b in ("", None):
        return True

    if field == "vacuum":
        def lines(value):
            return {line.strip().lower() for line in str(value or "").splitlines() if line.strip()}

        return lines(a) == lines(b)

    if a == b:
        return True

    if isinstance(a, bool) or isinstance(b, bool):
        return False

    return a is not None and b is not None and str(a) == str(b)


def set_value(session, entity, obj, field, value, batch):
    """Поставить полю значение из истории. Возвращает изменения для записи
    истории ({поле: {"old", "new"}}); соседи со сдвинутым № места — в batch."""
    if entity == "locations":
        return set_location_value(session, obj, field, value)

    if field == "archived":
        value = bool(value)

        if obj.archived == value:
            return {}

        old = obj.archived
        obj.archived = value
        return {"archived": {"old": old, "new": value}}

    if field == "location_id":
        if value is None:
            raise HTTPException(status_code=400, detail="Без расположения ПК оставить нельзя.")

        if value == "?":
            raise HTTPException(
                status_code=400,
                detail="Узел из этой записи не найден (его переименовали или перенесли). "
                       "Выбери расположение в таблице.",
            )

        location = session.get(Location, value)

        if not location or location.archived:
            path = location_path(value, load_locations(session)) if location else None
            raise HTTPException(
                status_code=400,
                detail=f"Узел «{path or value}» в архиве — сначала верни его из архива.",
            )

        payload = {"location_id": value}
    elif field.startswith("extra."):
        key = field[6:]
        api_key = EXTRA_API_KEYS.get(key)

        if not api_key:
            if key not in user_field_keys_of(session):
                raise HTTPException(status_code=400, detail=f"Поля «{key}» больше нет.")

            api_key = key

        payload = {api_key: value}
    else:
        payload = {field: value}

    return apply_fields(session, obj, payload, user_field_keys_of(session), batch)


def set_location_value(session, location, field, value):
    old = getattr(location, field)

    if same(field, old, value):
        return {}

    if field == "archived":
        if value:
            check_can_archive(session, location)
        elif location.parent_id is not None:
            parent = session.get(Location, location.parent_id)

            if parent and parent.archived:
                raise HTTPException(
                    status_code=400,
                    detail=f"Сначала верни из архива узел выше: «{parent.name or parent.code}».",
                )

        location.archived = bool(value)
        return {"archived": {"old": old, "new": bool(value)}}

    value = clean(value)
    name = value if field == "name" else location.name
    code = value if field == "code" else location.code

    validate_name_code(location.kind, name, code)

    if not location.archived:
        check_duplicate(session, location.kind, location.parent_id, name or code, code, exclude_id=location.id)

    setattr(location, field, value if field == "code" else (name or code))
    return {field: {"old": old, "new": getattr(location, field)}}


def touch(entity, obj):
    """ПК изменился без новой записи истории — версия +1 (правка из таблицы
    со старой версией получит «обнови таблицу»)."""
    if entity == "computers":
        obj.version = (obj.version or 1) + 1
        obj.updated_at = datetime.now(timezone.utc)


def mark(record, field, cancelled_by):
    changes = dict(record.changes or {})
    change = dict(changes[field])

    if cancelled_by:
        change["cancelled"] = cancelled_by
    else:
        change.pop("cancelled", None)

    changes[field] = change
    record.changes = changes  # новый dict — иначе JSONB не заметит изменения
    record.cancelled = all(item.get("cancelled") for item in changes.values())


def cancel_changes(session, items, cancel, user, batch):
    """items — [(запись, поле)]. cancel=True — отменить, False — восстановить.
    Возвращает, сколько изменений отмечено."""
    groups = {}

    for record, field in items:
        change = (record.changes or {}).get(field)

        if change is None or bool(change.get("cancelled")) == cancel:
            continue

        if field_kind(record.entity, field) == "created":
            raise HTTPException(
                status_code=400,
                detail="Создание не отменяется: удаления в системе нет, только архив.",
            )

        if record.entity not in ENTITIES:
            raise HTTPException(status_code=400, detail="Эту запись отменить нельзя.")

        groups.setdefault((record.entity, record.entity_id, field), []).append(record.id)

    values = Values(session)
    stamp = {"by": user["login"], "at": datetime.now(timezone.utc).isoformat()} if cancel else None
    count = 0

    for (entity, entity_id, field), ids in groups.items():
        obj = load_object(session, entity, entity_id)
        chain = field_chain(session, entity, entity_id, field)
        kind = field_kind(entity, field)

        if kind == "value":
            change, side = effective_point(chain, field)
            expected = values.of_change(entity, field, change, side)
            current = values.current(entity, obj, field)

            if not same(field, expected, current):
                label = field_label(session, entity, field)
                shown = values.display(entity, field, current)
                raise HTTPException(
                    status_code=409,
                    detail=f"«{label}» у «{object_title(obj, entity)}» менялось не через историю "
                           f"(сейчас: {shown if shown not in (None, '') else '—'}). Отмена не выполнена.",
                )

        for record in chain:
            if record.id in ids:
                mark(record, field, stamp)
                count += 1

        if kind == "value":
            change, side = effective_point(chain, field)
            target = values.of_change(entity, field, change, side)

            if not same(field, target, values.current(entity, obj, field)):
                if set_value(session, entity, obj, field, target, batch):
                    touch(entity, obj)

    return count


def revert_value(session, record, field, initial, user, batch):
    """Поставить полю значение из записи истории («стало») или исходное
    («было» самого первого изменения). Новая запись — с пометкой revert."""
    entity = record.entity

    if entity not in ENTITIES or field_kind(entity, field) != "value":
        raise HTTPException(status_code=400, detail="У этого поля нет значения, которое можно вернуть.")

    obj = load_object(session, entity, record.entity_id)
    values = Values(session)

    if initial:
        chain = field_chain(session, entity, record.entity_id, field)
        change, side = chain[0].changes[field], "old"
    else:
        change, side = record.changes[field], "new"

    target = values.of_change(entity, field, change, side)

    if same(field, target, values.current(entity, obj, field)):
        raise HTTPException(status_code=400, detail="Значение уже такое.")

    changes = set_value(session, entity, obj, field, target, batch)

    if not changes:
        raise HTTPException(status_code=400, detail="Значение уже такое.")

    if field in changes:
        changes[field] = dict(changes[field], revert=True)

    touch(entity, obj)
    session.add(
        History(
            entity=entity,
            entity_id=obj.id,
            user_name=user["login"],
            changes=changes,
        )
    )

    return obj


def value_history(session, entity, entity_id, field):
    """История одного поля объекта для окна «История значения»."""
    obj = load_object(session, entity, entity_id, lock=False)
    records = [
        record
        for record in (
            session.query(History)
            .filter(History.entity == entity, History.entity_id == entity_id)
            .order_by(History.at.desc(), History.id.desc())
            .all()
        )
        if field in (record.changes or {})
    ]

    kind = field_kind(entity, field)
    values = Values(session)
    current = values.current(entity, obj, field) if kind == "value" else None

    items = []

    for record in records:
        change = record.changes[field]
        items.append(
            {
                "id": record.id,
                "at": record.at,
                "user_name": record.user_name,
                "old": change.get("old"),
                "new": change.get("new"),
                "cancelled": change.get("cancelled"),
                "revert": bool(change.get("revert")),
            }
        )

    return {
        "entity": entity,
        "entity_id": entity_id,
        "field": field,
        "label": field_label(session, entity, field),
        "title": object_title(obj, entity),
        "kind": kind,
        "current": values.display(entity, field, current),
        "initial": records[-1].changes[field].get("old") if records else None,
        "items": items,
    }
