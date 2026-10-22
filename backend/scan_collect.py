"""Сбор из GLPI / GSIT (этап 25) и Jabber (этап 26д): запуск в фоне, запись
результата, отчёт.

Сбор идёт в отдельном потоке программы (служба – один процесс uvicorn),
со своей сессией базы. Пока идёт, в запуске (scan_runs.stats.progress)
обновляется «сделано из», страница спрашивает его раз в пару секунд.
Результат записывается целиком в конце одной транзакцией. Сбой на середине ничего
не портит – остаются прежние. Записи GLPI / GSIT не стираются (этап 57): пришедшие
заменяют прежние с теми же номерами, остальные остаются давними (save_records).

В таблицу ПК сбор ничего не пишет (правило 1): только scan_records (GLPI, GSIT),
scan_jabber_users (Jabber – пользователи не заменяются, а обновляются: у
ушедших из сети остаются последний IP и время) и scan_hosts (этап 28: DHCP –
аренды обновляются, привязки из настроек заменяются целиком; Сеть – ответившие
адреса обновляются; этап 73: Router – адрес-лист Mikrotik, заменяется целиком, как привязки
DHCP). Наблюдения по сроку не удаляются (этап 31): то, что старше
срока «Актуальны», остаётся последним известным – в «Сети» серым, в предложения
не идёт.
"""
import logging
import threading
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import func

from api_scan import (
    INTERRUPTED, SOURCES, connection_params, fresh_days_of, interrupted, load_source, remember_host, scan_subnets,
    source_ready,
)
from db import SessionLocal
from models import Choice, Computer, ScanAlias, ScanHost, ScanJabberUser, ScanLink, ScanRecord, ScanRun
from scan_dhcp import CONF_SOURCE, collect as dhcp_collect
from scan_glpi import collect as glpi_collect
from scan_jabber import collect as jabber_collect
from scan_net import collect as net_collect
from scan_router import collect as router_collect
from scan_http import SourceError
from scan_match import drop_shared_keys, find_duplicates, key_values, match_all
from scan_normalize import build
from scan_values import (
    COMPARE_FIELDS, MULTI_NAME_FIELDS, NAME_FIELDS, NUMBER_FIELDS, Names, board_names, lines_of, route_values,
)

logger = logging.getLogger("uvicorn.error")

COLLECTORS = {
    "glpi": glpi_collect, "gsit": glpi_collect, "jabber": jabber_collect, "dhcp": dhcp_collect, "net": net_collect,
    "router": router_collect,
}
# Источники записей о ПК (scan_records): сопоставление, названия, расхождения
RECORD_KINDS = ("glpi", "gsit")
# Источники наблюдений сети (scan_hosts): адрес – MAC – имя
HOST_KINDS = ("dhcp", "net")
# Какие строки scan_hosts пишет источник: DHCP – аренды и привязки из настроек
HOST_SOURCES = {"dhcp": ("dhcp", CONF_SOURCE), "net": ("net",)}
# Адрес-лист Mikrotik (этап 73) – тоже в scan_hosts, но это настройка роутера, а не наблюдение
# сети: в предложения (HOST_KINDS) не идёт, только «Сеть», журнал «IP» и кружки у IP
ROUTER = "router"
# Запуск, который «идёт» дольше, – оборвался (программу перезапускали)
RUN_TIMEOUT = timedelta(hours=2)
STATES = ("key", "link", "name", "conflict", "none", "dup")


class CollectRefused(Exception):
    """Сбор не начат: текст – для пользователя; code – HTTP-код."""

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


def check_only(session, kind, only):
    """Что собрать (этап 45): у сети – часть подсетей из отмеченных «Сканировать», у DHCP –
    аренды и / или привязки из файлов настроек. Всё – None."""
    if not only:
        return None

    if kind == "net" and only.get("subnets") is not None:
        marked = scan_subnets(session)
        wanted = set(only["subnets"])
        subnets = [cidr for cidr in marked if cidr in wanted]

        if not subnets:
            raise CollectRefused("Не выбраны подсети.")

        return {"subnets": subnets} if len(subnets) < len(marked) else None

    if kind == "dhcp":
        leases = only.get("leases", True)
        configs = only.get("configs", True)

        if not leases and not configs:
            raise CollectRefused("Не выбрано, что собрать из DHCP.")

        return None if leases and configs else {"leases": leases, "configs": configs}

    return None


def start(session, kind, user_name, background=True, only=None):
    """Начать сбор. Ответ – ScanRun; отказ – CollectRefused. only – что собрать
    (check_only); пишется в запуск (stats.only) и в его итог."""
    if kind not in COLLECTORS:
        raise CollectRefused("Из этого источника сбор пока не делается.", 404)

    title = SOURCES[kind]["title"]
    # Блокировка строки источника: два одновременных «Собрать» не начнут два сбора
    source = load_source(session, kind, lock=True)

    if SOURCES[kind]["form"] == "net":
        if source is None or not source.enabled:
            raise CollectRefused("«Сеть» выключена: отметь «Включён» и сохрани.")

        if not source_ready(session, kind, source):
            raise CollectRefused("Нет подсетей для сканирования: добавь подсеть и отметь «Сканировать».")
    elif source is None or not source.url:
        raise CollectRefused(f"Сначала укажи и сохрани адрес {title}.")

    if not source.enabled:
        raise CollectRefused(f"{title} выключен: отметь «Включён» и сохрани.")

    if running_run(session, kind):
        raise CollectRefused(f"Сбор из {title} уже идёт.", 409)

    only = check_only(session, kind, only)
    stats = {"progress": {"done": 0, "total": None}}

    if only:
        stats["only"] = only

    run = ScanRun(source=kind, status="running", user_name=user_name, stats=stats)
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
        except Exception as err:  # noqa: BLE001 – сбой не должен оставить запуск «идущим»
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
    # Только часть (этап 45): подсети сети, аренды или привязки DHCP
    only = (run.stats or {}).get("only") or {}
    params = dict(connection_params(kind, source, session=session), only=only)

    if only.get("subnets"):
        params["subnets"] = only["subnets"]
    fresh_days = fresh_days_of(source, kind)

    def progress(done, total):
        run.stats = dict(run.stats or {}, progress={"done": done, "total": total})
        session.commit()

    # Транзакцию не держать, пока идут сетевые запросы (этап 51): сбор DHCP или сети –
    # минуты, а открытая транзакция занимает соединение и не даёт миграции изменить таблицы
    session.commit()
    result = COLLECTORS[kind](params, fresh_days, progress)
    stats = dict(result["stats"], fresh_days=fresh_days, version=result.get("version"))

    if only:
        stats["only"] = only

    if kind in RECORD_KINDS:
        save_records(session, kind, run, result["items"], stats)
    elif kind in HOST_KINDS:
        save_hosts(session, kind, run, result["items"], fresh_days, only)
        remember_host(load_source(session, kind), result.get("seen"))
    elif kind == ROUTER:
        save_router(session, run, result["items"])
    else:
        save_jabber(
            session, run, result["items"],
            keep_groups=not result.get("groups_ok", True), users_ok=result.get("users_ok", False),
        )

    finish(session, run, "ok", "\n".join(result["warnings"]) or None, stats)


def save_records(session, kind, run, items, stats):
    """Записи из ответа заменяют прежние с теми же номерами. Прежние, которых в ответе нет
    (ПК выключен дольше срока «Актуальны», удалён в источнике, сбой или урезанный ответ),
    остаются последним известным – давними (этап 57: данные GLPI и GSIT не пропадают).
    Общие признаки и дубли – по записям этого сбора (признаки давних урезаны прежними
    сборами); давняя запись того же железа – дубль записи сбора. В stats – итог
    сопоставления записей этого сбора и kept – сколько прежних осталось без обновления."""
    built = []

    for item in items:
        values, keys, data = build(item["raw"])
        checked = item.get("checked_at")
        built.append({
            "source_id": item["id"],
            "name": values["hostname"],
            # Дата GLPI – время его сервера; считаем, что пояс тот же, что у ITDB
            "checked_at": checked.astimezone() if checked else None,
            "keys": keys,
            "data": data,
        })

    stats["shared"] = drop_shared_keys(built)
    dups = find_duplicates(built)
    existing = {r.source_id: r for r in session.query(ScanRecord).filter(ScanRecord.source == kind)}
    got = {record["source_id"] for record in built}
    # Признак → записи этого сбора (не дубли): к ним прежние записи того же железа
    owners = defaultdict(set)

    for record in built:
        if record["source_id"] not in dups:
            for key in key_values(record["keys"]):
                owners[key].add(record["source_id"])

    for record in built:
        row = existing.get(record["source_id"])

        if row is None:
            row = ScanRecord(source=kind, source_id=record["source_id"])
            session.add(row)

        row.name = record["name"]
        row.checked_at = record["checked_at"]
        row.data = record["data"]
        row.keys = record["keys"]
        row.dup_of = dups.get(record["source_id"])
        row.run_id = run.id
        # Время начала сбора: от него считается, какие записи действующие (active_since)
        row.seen_at = run.started_at

    kept = [row for source_id, row in existing.items() if source_id not in got]

    for row in kept:
        # Признак прежней записи есть ровно у одной записи сбора – то же железо (агент поставили
        # заново): прежняя – её дубль. У нескольких – не понять, чья: остаётся как была (через
        # давнюю запись две живые не склеиваются)
        sharers = set().union(*(owners.get(key, set()) for key in key_values(row.keys or {})))

        if len(sharers) == 1:
            row.dup_of = next(iter(sharers))

    session.flush()
    matches = match_sources(session, [kind])[kind].matches
    counts = {state: 0 for state in STATES}

    for source_id in got:
        counts[matches[source_id]["state"]] += 1

    stats.update(counts, kept=len(kept))


def save_hosts(session, kind, run, items, fresh_days, only=None):
    """Наблюдения сети. По сроку ничего не удаляется (этап 31): ПК может быть
    выключен месяцами и стоять на месте – последнее известное об адресе остаётся
    (что старше срока «Актуальны» – в «Сети» серым и в предложения не идёт).
    DHCP – аренды обновляются по адресу (аренда, которой в файле уже нет, остаётся
    как была), привязки из настроек – это настройка, а не наблюдение: заменяются
    целиком. Сеть – ответившие адреса обновляются, молчащие остаются.
    only (этап 45): у DHCP собраны только аренды или только привязки – другое не трогать."""
    only = only or {}
    leases = only.get("leases", True)

    if kind == "dhcp":
        if only.get("configs", True):
            session.query(ScanHost).filter(ScanHost.source == CONF_SOURCE).delete(synchronize_session=False)
        existing = {}

        for row in session.query(ScanHost).filter(ScanHost.source == kind):
            # Привязки, собранные до 28в, лежали строками dhcp с пометкой fixed
            if (row.data or {}).get("fixed"):
                session.delete(row)
            else:
                existing[row.ip] = row

        session.flush()
    else:
        existing = {row.ip: row for row in session.query(ScanHost).filter(ScanHost.source == kind)}

    for item in items:
        row = existing.get(item["ip"]) if (item.get("source") or kind) == kind else None

        if row is None:
            row = ScanHost(source=item.get("source") or kind, ip=item["ip"])
            session.add(row)

        # Адрес ответил, но MAC или имя в этот раз не узнали (ПК тот же) – прежние остаются
        if item.get("mac") or row.mac is None or kind == "dhcp":
            if row.mac and item.get("mac") and row.mac != item["mac"]:
                row.name = None   # на адресе другая машина – прежнее имя не её

            row.mac = item.get("mac")

        if item.get("name") or kind == "dhcp":
            row.name = item.get("name")

        row.data = item.get("data") or {}
        row.seen_at = item["seen_at"]
        row.run_id = run.id

    if kind == "dhcp" and leases:
        # Аренды в файле больше нет – она не действует; когда адрес был занят, остаётся
        found = {item["ip"] for item in items if (item.get("source") or kind) == kind}

        for ip, row in existing.items():
            if ip not in found and not (row.data or {}).get("gone"):
                row.data = dict(row.data or {}, active=False, gone=True)


def save_router(session, run, items):
    """Адрес-лист Mikrotik: настройка, а не наблюдение – заменяется целиком (как привязки DHCP).
    Пустой список сюда не доходит (сбор отказывает: опечатка в названии стёрла бы прежний)."""
    session.query(ScanHost).filter(ScanHost.source == ROUTER).delete(synchronize_session=False)
    seen_at = now()

    for item in items:
        session.add(ScanHost(
            source=ROUTER, ip=item["ip"], name=item.get("name"), data=item.get("data") or {}, seen_at=seen_at,
            run_id=run.id,
        ))


def save_jabber(session, run, items, keep_groups=False, users_ok=False):
    """Пользователи Jabber: обновить, кто в сети и откуда; последний IP и время
    в сети остаются у тех, кто сейчас не в сети. keep_groups – группы получить
    не удалось: прежние группы не трогать. users_ok – получен список всех
    пользователей: кого в нём нет – удалён (registered = False)."""
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
        Computer.id, Computer.hostname, Computer.ip, Computer.mac, Computer.serial, Computer.glpi_id, Computer.gsit_id,
        Computer.archived,
    ).all()
    return [
        {"id": r.id, "hostname": r.hostname, "ip": r.ip, "mac": r.mac, "serial": r.serial, "glpi_id": r.glpi_id,
         "gsit_id": r.gsit_id, "archived": r.archived}
        for r in rows
    ]


def links_of(session, kind):
    return session.query(ScanLink).filter(ScanLink.source == kind).all()


def active_since(session, kind):
    """С какого времени проверки запись источника действующая (этап 57): не раньше срока
    «Актуальны» до последнего сбора, который принёс записи. Срок – от сбора, а не от
    «сейчас»: между сборами записи не гаснут, а сбор, который ничего не принёс (сбой, все
    ПК выключены), не гасит прежние. Записей нет – None."""
    last = session.query(func.max(ScanRecord.seen_at)).filter(ScanRecord.source == kind).scalar()

    if last is None:
        return None

    return last - timedelta(days=fresh_days_of(load_source(session, kind), kind))


def is_active(record, since):
    return since is not None and record.checked_at is not None and record.checked_at >= since


def record_item(record, since):
    """Запись из базы – в виде для сопоставления (match_all)."""
    return {"source_id": record.source_id, "name": record.name, "keys": record.keys or {}, "dup_of": record.dup_of,
            "data": record.data, "active": is_active(record, since)}


class Matched:
    """Записи источника и их сопоставление с ПК: records – {source_id: ScanRecord},
    matches – {source_id: итог}; since – active_since."""

    def __init__(self, records, matches, since):
        self.records = records
        self.matches = matches
        self.since = since

    def active(self, record):
        """Действующая: из неё предложения, антивирусы, названия. Давняя – только
        последнее известное: видна на «GLPI / GSIT» и сопоставляется."""
        return is_active(record, self.since)


def match_sources(session, kinds=RECORD_KINDS):
    """Итог сопоставления записей источников с ПК ITDB – сейчас, по текущим данным таблицы
    и решениям администратора: {источник: Matched}. Один расчёт на запрос (этап 57):
    блочки, «Названия» и «GLPI / GSIT» раньше сопоставляли каждый источник дважды."""
    computers = computers_for_match(session)
    result = {}

    for kind in kinds:
        records = {r.source_id: r for r in session.query(ScanRecord).filter(ScanRecord.source == kind)}
        since = active_since(session, kind)
        links = [
            {"source_id": l.source_id, "computer_id": l.computer_id, "action": l.action}
            for l in links_of(session, kind)
        ]
        matches, _ = match_all([record_item(r, since) for r in records.values()], computers, links, kind)
        result[kind] = Matched(records, matches, since)

    return result


# ---------- Названия (этап 25б) ----------


def active_values(session):
    """{id ПК: {поле: значение}} рабочих ПК – для сравнения с записями."""
    columns = [getattr(Computer, field) for field in COMPARE_FIELDS]
    rows = session.query(Computer.id, *columns).filter(Computer.archived == False)  # noqa: E712
    return {row[0]: dict(zip(COMPARE_FIELDS, row[1:])) for row in rows}


def load_names(session, computers=None, matched=None):
    """Словарь названий: ручные соответствия, значения столбцов и Справочников,
    пары «источник – таблица» у сопоставленных ПК обоих источников (matched –
    match_sources по всем RECORD_KINDS, если уже посчитано)."""
    computers = computers if computers is not None else active_values(session)
    matched = matched if matched is not None else match_sources(session)
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
        records = matched[kind].records

        for source_id, item in matched[kind].matches.items():
            if item["state"] not in ("key", "link") or item["computer_id"] not in computers:
                continue

            if not matched[kind].active(records[source_id]):
                continue

            values = route_values((records[source_id].data or {}).get("values") or {}, boards)
            computer = computers[item["computer_id"]]

            for field in fields:
                if values.get(field) and computer.get(field):
                    pairs.append((field, values[field], computer[field]))

    return Names(aliases, table_values, choices, pairs)


def compare_record(names, values, computer):
    """Строки сравнения записи с ПК (или без ПК – как было бы названо)."""
    result = []
    values = route_values(values, names.boards)

    for field in COMPARE_FIELDS:
        item = names.compare(field, values.get(field), (computer or {}).get(field))
        item["field"] = field
        item["itdb"] = (computer or {}).get(field) or ""
        result.append(item)

    return result
