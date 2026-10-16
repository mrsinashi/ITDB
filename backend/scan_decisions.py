"""Решения сканера с отменой (этап 53): сопоставление записей GLPI / GSIT с ПК
(scan_links: «Это ПК» / «Привязать», «Не этот ПК», «Забыть решения») и соответствия
названий (scan_aliases: «одно и то же», «разное», «в таблице своё», «материнская
плата», забыть, удалить).

У изменения в Истории – снимок строк решения до и после: undo = {"before": [...],
"after": [...]} (у названий ещё "source_key"). Отменить – строки снова как «до», если
сейчас они как «после»; восстановить – наоборот; иначе решение с тех пор меняли – 409.
У записей до этапа 53 снимка нет – они не отменяются. Решение без изменений (то же ещё
раз) в Историю не пишется.

Снимок берёт замок решения (одной записи источника / одного значения источника) до конца
транзакции: решение и его отмена об одном и том же идут по очереди.
"""
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import text

from models import Computer, ScanAlias, ScanLink

DECISION_ENTITIES = ("scan_records", "scan_aliases")


def iso(value):
    return value.isoformat() if value else None


def lock(session, key):
    session.execute(text("select pg_advisory_xact_lock(hashtext(:key))"), {"key": key})


def when(row):
    """Время решения из снимка – как было (новая строка без него – время сейчас)."""
    return {"at": datetime.fromisoformat(row["at"])} if row.get("at") else {}


# ---------- Сопоставление записей (scan_links) ----------


def link_query(session, kind, source_id):
    return session.query(ScanLink).filter(ScanLink.source == kind, ScanLink.source_id == source_id).order_by(ScanLink.id)


def links_state(session, kind, source_id):
    """Решения о записи – снимком (без id: при отмене строки создаются заново)."""
    lock(session, f"scan_links:{kind}:{source_id}")
    rows = [
        {"computer_id": link.computer_id, "action": link.action, "title": link.title,
         "user_name": link.user_name, "at": iso(link.at)}
        for link in link_query(session, kind, source_id)
    ]
    return sorted(rows, key=link_key)


def set_links(session, kind, source_id, rows):
    # ПК из снимка удалили насовсем (правки этапа 66) – решение не вернуть
    wanted = {row["computer_id"] for row in rows}
    found = {computer_id for (computer_id,) in session.query(Computer.id).filter(Computer.id.in_(wanted))} if wanted else set()

    if wanted - found:
        raise HTTPException(status_code=400, detail=f"ПК №{min(wanted - found)} удалён насовсем – решение не вернуть.")

    for link in link_query(session, kind, source_id).with_for_update():
        session.delete(link)

    session.flush()

    for row in rows:
        session.add(ScanLink(
            source=kind, source_id=source_id, computer_id=row["computer_id"], action=row["action"],
            title=row.get("title"), user_name=row.get("user_name"), **when(row),
        ))

    session.flush()


def links_undo(session, kind, source_id, before):
    """Снимок для Истории: before – links_state до решения, после – сейчас; ничего не
    изменилось – None (в Историю не писать)."""
    session.flush()
    after = links_state(session, kind, source_id)
    return {"before": before, "after": after} if keys_of(before, link_key) != keys_of(after, link_key) else None


# ---------- Соответствия названий (scan_aliases) ----------


def alias_query(session, field, source_key):
    return session.query(ScanAlias).filter(ScanAlias.field == field, ScanAlias.source_key == source_key).order_by(ScanAlias.id)


def aliases_state(session, field, source_key):
    lock(session, f"scan_aliases:{field}:{source_key}")
    rows = [
        {"source": alias.source, "table": alias.table_value, "table_key": alias.table_key, "kind": alias.kind,
         "user_name": alias.user_name, "at": iso(alias.at)}
        for alias in alias_query(session, field, source_key)
    ]
    return sorted(rows, key=alias_key)


def set_aliases(session, field, source_key, rows):
    for alias in alias_query(session, field, source_key).with_for_update():
        session.delete(alias)

    session.flush()

    for row in rows:
        session.add(ScanAlias(
            field=field, source=row["source"], source_key=source_key, table_value=row["table"],
            table_key=row["table_key"], kind=row["kind"], user_name=row.get("user_name"), **when(row),
        ))

    session.flush()


def aliases_undo(session, field, source_key, before):
    session.flush()
    after = aliases_state(session, field, source_key)

    if keys_of(before, alias_key) == keys_of(after, alias_key):
        return None

    return {"source_key": source_key, "before": before, "after": after}


# ---------- Отмена из Истории ----------


def check_decision(record, field, user):
    """Можно ли отменять: снимок есть; чужое решение – только админ (Ctrl+Z редактора –
    его «Привязать» из Таблицы; в Истории решения видит только админ)."""
    if "undo" not in (record.changes or {}).get(field, {}):
        raise HTTPException(status_code=400, detail="Это решение сканера записано до того, как их стало можно отменять.")

    if user["role"] != "admin" and record.user_name != user["login"]:
        raise HTTPException(status_code=403, detail="Чужое решение сканера отменяет только администратор.")


def apply_decision(session, record, field, cancel):
    """Отменить (cancel) или восстановить решение: строки – как в снимке «до» / «после»."""
    undo = record.changes[field]["undo"]
    expected, target = (undo["after"], undo["before"]) if cancel else (undo["before"], undo["after"])

    if record.entity == "scan_records":
        kind, _, number = (record.entity_key or "").partition(":")
        scope, state, put, key = (kind, int(number)), links_state, set_links, link_key
    else:
        scope, state, put, key = (record.entity_key, undo["source_key"]), aliases_state, set_aliases, alias_key

    if keys_of(state(session, *scope), key) != keys_of(expected, key):
        action = "Отмена не выполнена" if cancel else "Восстановление не выполнено"
        raise HTTPException(status_code=409, detail=f"Решение «{record.title or record.entity_key}» с тех пор меняли. {action}.")

    put(session, *scope, target)


def link_key(row):
    return row["computer_id"], row["action"]


def alias_key(row):
    return row["table_key"], row["kind"]


def keys_of(rows, key):
    return sorted(map(key, rows))
