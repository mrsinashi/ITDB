"""Запись в историю для справочников, польз. полей, оформления столбцов и
пользователей системы (этап 19б). ПК и узлы дерева пишут историю сами."""
from api_columns import COLUMNS_BY_KEY
from models import FieldDef, History

# Смена пароля пишется без самого пароля
PASSWORD_SET = "задан новый"


def log_change(session, entity, entity_id, user_name, changes, title=None, entity_key=None):
    """Одна запись истории, если что-то изменилось. changes – {поле: {"old", "new"}},
    поля без изменения (old == new) отбрасываются."""
    changes = {
        field: change
        for field, change in changes.items()
        if change.get("old") != change.get("new")
    }

    if not changes:
        return None

    record = History(
        entity=entity,
        entity_id=entity_id or 0,
        entity_key=entity_key,
        title=title,
        user_name=user_name,
        changes=changes,
    )
    session.add(record)
    return record


def diff(obj, fields, before):
    """Изменения полей объекта: before – {поле: значение до правки}."""
    return {field: {"old": before[field], "new": getattr(obj, field)} for field in fields}


def column_label(session, field):
    """Название столбца для истории: встроенного (как в карточке) или польз. поля."""
    column = COLUMNS_BY_KEY.get(field)

    if column is not None:
        return column.card

    fd = session.query(FieldDef).filter(FieldDef.key == field).first()
    return fd.label if fd else field


def choice_title(session, choice):
    return f"{column_label(session, choice.field)}: {choice.value}"
