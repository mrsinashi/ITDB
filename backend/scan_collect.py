"""Сбор из GLPI / GSIT (этап 25) и Jabber (этап 26д): запуск в фоне, запись
результата, отчёт.

Сбор идёт в отдельном потоке программы (служба — один процесс uvicorn),
со своей сессией базы. Пока идёт, в запуске (scan_runs.stats.progress)
обновляется «сделано из», страница спрашивает его раз в пару секунд.
Результат записывается целиком в конце: записи источника заменяются новыми
одной транзакцией. Сбой на середине ничего не портит — остаются прежние.

В таблицу ПК сбор ничего не пишет (правило 1): только scan_records (GLPI, GSIT)
и scan_jabber_users (Jabber — пользователи не заменяются, а обновляются: у
ушедших из сети остаются последний IP и время).
"""
import logging
import threading
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from api_scan import INTERRUPTED, SOURCES, connection_params, fresh_days_of, interrupted, load_source
from db import SessionLocal
from models import Choice, Computer, ScanAlias, ScanJabberUser, ScanLink, ScanRecord, ScanRun
from scan_glpi import collect as glpi_collect
from scan_jabber import collect as jabber_collect
from scan_http import SourceError
from scan_match import drop_shared_keys, find_duplicates, match_all
from scan_normalize import build
from scan_values import (
    COMPARE_FIELDS, MULTI_NAME_FIELDS, NAME_FIELDS, NUMBER_FIELDS, Names, board_names, lines_of, route_values,
)

logger = logging.getLogger("uvicorn.error")

COLLECTORS = {"glpi": glpi_collect, "gsit": glpi_collect, "jabber": jabber_collect}
# Источники записей о ПК (scan_records): сопоставление, названия, расхождения
RECORD_KINDS = ("glpi", "gsit")
# Запуск, который «идёт» дольше, — оборвался (программу перезапускали)
RUN_TIMEOUT = timedelta(hours=2)
STATES = ("key", "link", "name", "conflict", "none", "dup")


class CollectRefused(Exception):
    """Сбор не начат: текст — для пользователя; code — HTTP-код."""

    def __init__(self, message, code=400):
        super().__init__(message)
        self.code = code


def now():
    return datetime.now(timezone.utc)


def running_run(session, kind):
    """Идущий запуск. Начатый до старта программы или «зависший» дольше
    RUN_TIMEOUT закрывается ошибкой."""
    run = (
        session.query(ScanRun)
        .filter(ScanRun.source == kind, ScanRun.status == "running")
        .order_by(ScanRun.id.desc())
        .first()
    )

    if run and (interrupted(run) or run.started_at < now() - RUN_TIMEOUT):
        run.status = "error"
        run.finished_at = now()
        run.message = INTERRUPTED
        session.commit()
        return None

    return run


def start(session, kind, user_name, background=True):
    """Начать сбор. Ответ — ScanRun; отказ — CollectRefused."""
    if kind not in COLLECTORS:
        raise CollectRefused("Из этого источника сбор пока не делается.", 404)

    title = SOURCES[kind]["title"]
    # Блокировка строки источника: два одновременных «Собрать» не начнут два сбора
    source = load_source(session, kind, lock=True)

    if source is None or not source.url:
        raise CollectRefused(f"Сначала укажи и сохрани адрес {title}.")

    if not source.enabled:
        raise CollectRefused(f"{title} выключен: отметь «Включён» и сохрани.")

    if running_run(session, kind):
        raise CollectRefused(f"Сбор из {title} уже идёт.", 409)

    run = ScanRun(source=kind, status="running", user_name=user_name, stats={"progress": {"done": 0, "total": None}})
    session.add(run)
    session.commit()

    if background:
        threading.Thread(target=execute, args=(run.id,), daemon=True, name=f"scan-{kind}").start()
    else:
        execute(run.id)

    return run


def execute(run_id):
    session = SessionLocal()

    try:
        run = session.get(ScanRun, run_id)

        try:
            collect_into(session, run)
        except SourceError as err:
            session.rollback()
            finish(session, run, "error", str(err))
        except Exception as err:  # noqa: BLE001 — сбой не должен оставить запуск «идущим»
            logger.exception("Сбор из %s: ошибка", run.source)
            session.rollback()
            finish(session, run, "error", f"Ошибка на сервере: {err}")
    finally:
        session.close()


def finish(session, run, status, message=None, stats=None):
    run = session.get(ScanRun, run.id)
    run.status = status
    run.finished_at = now()
    run.message = message

    if stats is not None:
        run.stats = stats
    else:
        run.stats = {key: value for key, value in (run.stats or {}).items() if key != "progress"}

    session.commit()


def collect_into(session, run):
    kind = run.source
    source = load_source(session, kind)
    params = connection_params(kind, source)
    fresh_days = fresh_days_of(source, kind)

    def progress(done, total):
        run.stats = dict(run.stats or {}, progress={"done": done, "total": total})
        session.commit()

    result = COLLECTORS[kind](params, fresh_days, progress)
    stats = dict(result["stats"], fresh_days=fresh_days, version=result.get("version"))

    if kind in RECORD_KINDS:
        save_records(session, kind, run, result["items"], stats)
    else:
        save_jabber(
            session, run, result["items"],
            keep_groups=not result.get("groups_ok", True), users_ok=result.get("users_ok", False),
        )

    finish(session, run, "ok", "\n".join(result["warnings"]) or None, stats)


def save_records(session, kind, run, items, stats):
    """Записи источника заменяются новыми; в stats — итог сопоставления."""
    built = []

    for item in items:
        values, keys, data = build(item["raw"])
        checked = item.get("checked_at")
        built.append({
            "source_id": item["id"],
            "name": values["hostname"],
            # Дата GLPI — время его сервера; считаем, что пояс тот же, что у ITDB
            "checked_at": checked.astimezone() if checked else None,
            "keys": keys,
            "data": data,
        })

    stats["shared"] = drop_shared_keys(built)
    dups = find_duplicates(built)

    session.query(ScanRecord).filter(ScanRecord.source == kind).delete()
    seen = now()

    for record in built:
        record["dup_of"] = dups.get(record["source_id"])
        session.add(ScanRecord(
            source=kind, source_id=record["source_id"], name=record["name"], checked_at=record["checked_at"],
            data=record["data"], keys=record["keys"], dup_of=record["dup_of"], run_id=run.id, seen_at=seen,
        ))

    session.flush()
    matches, _ = match(session, kind, built)
    counts = {state: 0 for state in STATES}

    for item in matches.values():
        counts[item["state"]] += 1

    stats.update(counts)


def save_jabber(session, run, items, keep_groups=False, users_ok=False):
    """Пользователи Jabber: обновить, кто в сети и откуда; последний IP и время
    в сети остаются у тех, кто сейчас не в сети. keep_groups — группы получить
    не удалось: прежние группы не трогать. users_ok — получен список всех
    пользователей: кого в нём нет — удалён (registered = False)."""
    seen_at = now()
    existing = {row.login.lower(): row for row in session.query(ScanJabberUser)}
    found = set()

    for item in items:
        key = item["login"].lower()
        row = existing.get(key)

        if row is None:
            row = ScanJabberUser(login=item["login"])
            session.add(row)
            existing[key] = row

        row.login = item["login"]

        if not keep_groups:
            row.groups = item["groups"]

        row.online = item["online"]
        row.resources = item["resources"] if item["online"] else []

        if item.get("registered") is not None:
            row.registered = item["registered"]

        if item["online"]:
            row.last_login_at = seen_at
        elif item.get("last_login"):
            row.last_login_at = item["last_login"]

        if item["online"]:
            row.last_seen_at = seen_at
            first = next((r for r in item["resources"] if r.get("ip")), None)

            if first:
                row.last_ip = first["ip"]
                row.last_client = first.get("client")

        row.run_id = run.id
        row.updated_at = seen_at
        found.add(key)

    for key, row in existing.items():
        if key in found:
            continue

        if users_ok and row.registered is not False:
            row.registered = False
            row.updated_at = seen_at

        if row.online or row.resources or (row.groups and not keep_groups):
            row.online = False
            row.resources = []

            if not keep_groups:
                row.groups = []

            row.updated_at = seen_at


# ---------- Сопоставление на лету ----------


def computers_for_match(session):
    rows = session.query(
        Computer.id, Computer.hostname, Computer.mac, Computer.serial, Computer.glpi_id, Computer.gsit_id, Computer.archived,
    ).all()
    return [
        {"id": r.id, "hostname": r.hostname, "mac": r.mac, "serial": r.serial, "glpi_id": r.glpi_id,
         "gsit_id": r.gsit_id, "archived": r.archived}
        for r in rows
    ]


def links_of(session, kind):
    return session.query(ScanLink).filter(ScanLink.source == kind).all()


def match(session, kind, records=None):
    """Итог сопоставления записей источника с ПК ITDB — сейчас, по текущим
    данным таблицы и решениям администратора. ({source_id: итог}, Index)."""
    if records is None:
        records = [
            {"source_id": r.source_id, "name": r.name, "keys": r.keys or {}, "dup_of": r.dup_of}
            for r in session.query(ScanRecord).filter(ScanRecord.source == kind)
        ]

    links = [
        {"source_id": l.source_id, "computer_id": l.computer_id, "action": l.action}
        for l in links_of(session, kind)
    ]
    return match_all(records, computers_for_match(session), links, kind)


# ---------- Названия (этап 25б) ----------


def active_values(session):
    """{id ПК: {поле: значение}} рабочих ПК — для сравнения с записями."""
    columns = [getattr(Computer, field) for field in COMPARE_FIELDS]
    rows = session.query(Computer.id, *columns).filter(Computer.archived == False)  # noqa: E712
    return {row[0]: dict(zip(COMPARE_FIELDS, row[1:])) for row in rows}


def load_names(session, computers=None):
    """Словарь названий: ручные соответствия, значения столбцов и Справочников,
    пары «источник — таблица» у сопоставленных ПК обоих источников."""
    computers = computers if computers is not None else active_values(session)
    aliases = [
        {"field": a.field, "source": a.source, "table": a.table_value, "kind": a.kind}
        for a in session.query(ScanAlias)
    ]
    fields = NAME_FIELDS + NUMBER_FIELDS
    table_values = {field: Counter() for field in fields}

    for values in computers.values():
        for field in fields:
            for line in (lines_of(values[field]) if field in MULTI_NAME_FIELDS else [values[field]]):
                if line and str(line).strip():
                    table_values[field][str(line).strip()] += 1

    choices = defaultdict(list)

    for field, value in session.query(Choice.field, Choice.value).filter(Choice.field.in_(fields)):
        choices[field].append(value)

    pairs = []
    boards = board_names(aliases)

    for kind in RECORD_KINDS:
        matches, _ = match(session, kind)
        records = {r.source_id: r for r in session.query(ScanRecord).filter(ScanRecord.source == kind)}

        for source_id, item in matches.items():
            if item["state"] not in ("key", "link") or item["computer_id"] not in computers:
                continue

            values = route_values((records[source_id].data or {}).get("values") or {}, boards)
            computer = computers[item["computer_id"]]

            for field in fields:
                if values.get(field) and computer.get(field):
                    pairs.append((field, values[field], computer[field]))

    return Names(aliases, table_values, choices, pairs)


def compare_record(names, values, computer):
    """Строки сравнения записи с ПК (или без ПК — как было бы названо)."""
    result = []
    values = route_values(values, names.boards)

    for field in COMPARE_FIELDS:
        item = names.compare(field, values.get(field), (computer or {}).get(field))
        item["field"] = field
        item["itdb"] = (computer or {}).get(field) or ""
        result.append(item)

    return result
