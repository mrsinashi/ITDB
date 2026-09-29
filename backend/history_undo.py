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
from collections import namedtuple
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
from api_users import ROLES, end_sessions
from history_log import choice_title, column_label
from models import Choice, ColumnStyle, Computer, FieldDef, History, Location, Person, User

# Объект истории: вид, id и ключ (у оформления столбца id = 0, ключ — столбец)
Ref = namedtuple("Ref", "entity entity_id entity_key")

# Поля узла дерева, которые можно вернуть
LOCATION_VALUE_FIELDS = {"name", "code", "archived"}
LOCATION_LABELS = {"name": "Название", "code": "Код", "archived": "Архив"}

# Этап 19б: справочники, польз. поля, оформление столбцов, пользователи системы.
# fields — поля, которые можно отменить и вернуть; admin — только администратор.
SIMPLE = {
    "choices": {"model": Choice, "fields": {"value", "color", "bg_color", "bold", "italic"}},
    "field_defs": {"model": FieldDef, "fields": {"label", "archived"}},
    "column_styles": {"model": ColumnStyle, "fields": {"color", "bg_color", "bold", "italic"}},
    "users": {"model": User, "fields": {"role", "archived"}, "admin": True},
}
SIMPLE_LABELS = {
    "value": "Значение", "color": "Цвет текста", "bg_color": "Фон", "bold": "Жирный",
    "italic": "Курсив", "label": "Название", "archived": "Архив", "role": "Роль",
    "password": "Пароль", "created": "Создано", "deleted": "Удалено",
}

ENTITIES = ("computers", "locations") + tuple(SIMPLE)

# Не отменяются: создание, удаление (удалённое не вернуть), смена пароля
FIXED_FIELDS = {"created", "deleted", "password"}

# Ключ в extra → ключ в API (GSIT → gsit)
EXTRA_API_KEYS = {extra_key: key for key, extra_key in EXTRA_FIELDS.items()}


def ref_of(record):
    return Ref(record.entity, record.entity_id, record.entity_key)


def check_rights(entity, user):
    if entity not in ENTITIES:
        raise HTTPException(status_code=400, detail="Для этого объекта отмены нет.")

    if SIMPLE.get(entity, {}).get("admin") and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Это действие доступно только администратору.")


def field_kind(entity, field):
    """value — у поля есть значение (можно отменить и вернуть);
    info — служебная пометка (только отменить); fixed — создание, удаление,
    смена пароля (нельзя)."""
    if field in FIXED_FIELDS:
        return "fixed"

    if entity in SIMPLE:
        return "value" if field in SIMPLE[entity]["fields"] else "info"

    if entity == "locations":
        return "value" if field in LOCATION_VALUE_FIELDS else "info"

    if field in ("archived", "location_id") or field.startswith("extra."):
        return "value"

    column = COLUMNS_BY_KEY.get(field)

    if field in EDITABLE_KEYS and column is not None and column.kind != "location":
        return "value"

    return "info"


def field_label(session, entity, field):
    if entity in SIMPLE:
        return SIMPLE_LABELS.get(field, field)

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


def find_object(session, ref, lock=True):
    """Объект истории или None, если его уже нет (удалённое значение справочника).
    Оформления столбца может не быть (пустое удаляется) — тогда пустое, не в базе."""
    if ref.entity not in ENTITIES:
        raise HTTPException(status_code=400, detail="Для этого объекта отмены нет.")

    if ref.entity == "column_styles":
        obj = session.get(ColumnStyle, ref.entity_key)
        return obj or ColumnStyle(field=ref.entity_key, bold=False, italic=False)

    models = {"computers": Computer, "locations": Location}
    model = models.get(ref.entity) or SIMPLE[ref.entity]["model"]
    query = session.query(model).filter(model.id == ref.entity_id)

    if lock:
        query = query.with_for_update()

    return query.first()


def load_object(session, ref, lock=True):
    obj = find_object(session, ref, lock)

    if obj is None:
        detail = "Значения больше нет в справочнике." if ref.entity == "choices" else "Объект не найден."
        raise HTTPException(status_code=404, detail=detail)

    return obj


def object_title(session, obj, ref):
    entity = ref.entity

    if entity == "computers":
        return obj.hostname or f"ПК #{obj.id}"

    if entity == "locations":
        return obj.name or obj.code or f"#{obj.id}"

    if entity == "choices":
        return choice_title(session, obj)

    if entity == "field_defs":
        return obj.label

    if entity == "column_styles":
        return column_label(session, ref.entity_key)

    return obj.login


def field_chain(session, ref, field):
    """Записи истории объекта, где менялось поле, — от старых к новым."""
    query = session.query(History).filter(
        History.entity == ref.entity, History.entity_id == ref.entity_id
    )

    if ref.entity_key is not None:
        query = query.filter(History.entity_key == ref.entity_key)

    records = query.order_by(History.at, History.id).with_for_update().all()

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
        if entity == "locations" or entity in SIMPLE:
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


def set_value(session, entity, obj, field, value, batch, user):
    """Поставить полю значение из истории. Возвращает изменения для записи
    истории ({поле: {"old", "new"}}); соседи со сдвинутым № места — в batch."""
    if entity == "locations":
        return set_location_value(session, obj, field, value)

    if entity in SIMPLE:
        return set_simple_value(session, entity, obj, field, value, user)

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


def set_simple_value(session, entity, obj, field, value, user):
    """Справочник, польз. поле, оформление столбца, пользователь системы —
    с теми же проверками, что и при обычной правке."""
    old = getattr(obj, field)

    if same(field, old, value):
        return {}

    if field in ("bold", "italic", "archived"):
        value = bool(value)
    elif field in ("color", "bg_color"):
        value = value or None
    elif field in ("value", "label"):
        value = (value or "").strip()

        if not value:
            raise HTTPException(status_code=400, detail="Значение не может быть пустым.")

    if entity == "choices" and field == "value":
        exists = (
            session.query(Choice)
            .filter(Choice.field == obj.field, Choice.value == value, Choice.id != obj.id)
            .first()
        )

        if exists:
            raise HTTPException(status_code=400, detail=f"«{value}» уже есть в этом справочнике.")

    if entity == "users":
        if obj.id == user["id"]:
            raise HTTPException(status_code=400, detail="Свою роль и отключение себя изменить нельзя.")

        if field == "role" and value not in ROLES:
            raise HTTPException(status_code=400, detail="Неизвестная роль.")

        if field == "archived" and value:
            end_sessions(session, obj.id)

    setattr(obj, field, value)

    # Оформление столбца: пустое удаляется, новое добавляется
    if entity == "column_styles":
        empty = not (obj.color or obj.bg_color or obj.bold or obj.italic)
        stored = session.get(ColumnStyle, obj.field) is not None

        if empty and stored:
            session.delete(obj)
        elif not empty and not stored:
            session.add(obj)

        # Следующее свойство того же столбца (в одной отмене) должно увидеть строку
        session.flush()

    return {field: {"old": old, "new": value}}


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

        check_rights(record.entity, user)

        if field_kind(record.entity, field) == "fixed":
            raise HTTPException(
                status_code=400,
                detail="Создание, удаление и смена пароля не отменяются.",
            )

        groups.setdefault((ref_of(record), field), []).append(record.id)

    values = Values(session)
    stamp = {"by": user["login"], "at": datetime.now(timezone.utc).isoformat()} if cancel else None
    count = 0

    for (ref, field), ids in groups.items():
        entity = ref.entity
        obj = load_object(session, ref)
        chain = field_chain(session, ref, field)
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
                    detail=f"«{label}» у «{object_title(session, obj, ref)}» менялось не через историю "
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
                if set_value(session, entity, obj, field, target, batch, user):
                    touch(entity, obj)

    return count


def revert_value(session, record, field, initial, user, batch):
    """Поставить полю значение из записи истории («стало») или исходное
    («было» самого первого изменения). Новая запись — с пометкой revert."""
    entity = record.entity
    ref = ref_of(record)
    check_rights(entity, user)

    if field_kind(entity, field) != "value":
        raise HTTPException(status_code=400, detail="У этого поля нет значения, которое можно вернуть.")

    obj = load_object(session, ref)
    values = Values(session)

    if initial:
        chain = field_chain(session, ref, field)
        change, side = chain[0].changes[field], "old"
    else:
        change, side = record.changes[field], "new"

    target = values.of_change(entity, field, change, side)

    if same(field, target, values.current(entity, obj, field)):
        raise HTTPException(status_code=400, detail="Значение уже такое.")

    changes = set_value(session, entity, obj, field, target, batch, user)

    if not changes:
        raise HTTPException(status_code=400, detail="Значение уже такое.")

    if field in changes:
        changes[field] = dict(changes[field], revert=True)

    touch(entity, obj)
    session.add(
        History(
            entity=entity,
            entity_id=ref.entity_id,
            entity_key=ref.entity_key,
            title=object_title(session, obj, ref) if entity in SIMPLE else None,
            user_name=user["login"],
            changes=changes,
        )
    )

    return obj


def value_history(session, ref, field):
    """История одного поля объекта для окна «История значения».
    Удалённого объекта (значение справочника) нет — история только для просмотра."""
    obj = find_object(session, ref, lock=False)
    query = session.query(History).filter(
        History.entity == ref.entity, History.entity_id == ref.entity_id
    )

    if ref.entity_key is not None:
        query = query.filter(History.entity_key == ref.entity_key)

    records = [
        record
        for record in query.order_by(History.at.desc(), History.id.desc()).all()
        if field in (record.changes or {})
    ]

    kind = field_kind(ref.entity, field) if obj is not None else "gone"
    values = Values(session)
    current = values.current(ref.entity, obj, field) if kind == "value" else None

    if obj is not None:
        title = object_title(session, obj, ref)
    else:
        title = next((record.title for record in records if record.title), f"#{ref.entity_id}")

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
        "entity": ref.entity,
        "entity_id": ref.entity_id,
        "entity_key": ref.entity_key,
        "field": field,
        "label": field_label(session, ref.entity, field),
        "title": title,
        "kind": kind,
        "current": values.display(ref.entity, field, current),
        "initial": records[-1].changes[field].get("old") if records else None,
        "items": items,
    }
