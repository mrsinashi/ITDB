"""Расписание сборов (этап 28): когда программа сама собирает данные из
источников. Работает внутри службы – отдельным потоком того же процесса, что и
сам сбор (scan_collect.start); раз в полминуты смотрит, не пора ли.

Настройка у каждого источника своя (app_settings, ключ «schedule»):
- mode: off – только вручную; every – каждые minutes минут, в часы с time_from до
  time_to (одинаковые – круглые сутки); daily – раз в день в time_at;
- days: all – каждый день, work – по будням.
Время – по часам сервера ITDB.

Следующий запуск считается от последнего (любого – и ручного): «каждые 30 мин»
значит «не чаще, чем через 30 минут после прошлого». Сбор ещё идёт или источник
выключен – запуск пропускается. Пропущенное за время простоя программы не
навёрстывается пачкой: будет один запуск.
"""
import logging
import threading
from datetime import datetime, time, timedelta, timezone

import scan_collect
from api_scan import SOURCES, load_source, source_ready
from db import SessionLocal
from models import AppSetting, ScanRun

logger = logging.getLogger("uvicorn.error")

KEY = "schedule"
USER = "расписание"
TICK_SECONDS = 30
MINUTES = (15, 30, 60, 120, 240, 480)
MODES = ("off", "every", "daily")
DAYS = ("all", "work")
DEFAULT = {"mode": "off", "minutes": 60, "time_from": "08:00", "time_to": "18:00", "time_at": "07:00", "days": "all"}
# Журнал запусков: сколько дней хранить
RUNS_KEEP_DAYS = 90


def parse_time(text):
    """«8:05» → time(8, 5); не время – None."""
    try:
        hours, minutes = str(text or "").strip().split(":")
        return time(int(hours), int(minutes))
    except ValueError:
        return None


def clean(conf):
    """Настройка источника: сохранённое поверх значений по умолчанию, без мусора."""
    result = dict(DEFAULT)
    conf = conf if isinstance(conf, dict) else {}

    if conf.get("mode") in MODES:
        result["mode"] = conf["mode"]

    if conf.get("minutes") in MINUTES:
        result["minutes"] = conf["minutes"]

    if conf.get("days") in DAYS:
        result["days"] = conf["days"]

    for field in ("time_from", "time_to", "time_at"):
        value = parse_time(conf.get(field))

        if value is not None:
            result[field] = value.strftime("%H:%M")

    return result


def load(session):
    """{источник: настройка} для всех источников, из которых можно собирать."""
    row = session.get(AppSetting, KEY)
    saved = (row.value if row else None) or {}
    return {kind: clean(saved.get(kind)) for kind in scan_collect.COLLECTORS}


def day_allowed(day, days):
    return days == "all" or day.weekday() < 5


def in_window(moment, start, end):
    if start == end:
        return True

    now = moment.time()
    return start <= now < end if start < end else (now >= start or now < end)


def next_run(conf, last, now):
    """Когда следующий запуск (время сервера, с поясом); None – только вручную.
    last – когда начался прошлый сбор; время в прошлом – пора сейчас."""
    if conf["mode"] == "off":
        return None

    if conf["mode"] == "daily":
        at = parse_time(conf["time_at"])
        moment = now.replace(hour=at.hour, minute=at.minute, second=0, microsecond=0)

        if last is not None and last >= moment:
            moment += timedelta(days=1)

        while not day_allowed(moment, conf["days"]):
            moment += timedelta(days=1)

        return moment

    start, end = parse_time(conf["time_from"]), parse_time(conf["time_to"])
    moment = last + timedelta(minutes=conf["minutes"]) if last is not None else now
    moment = max(moment, now - timedelta(days=1))

    # Не тот день или не те часы – на ближайшее начало разрешённых часов
    for _ in range(16):
        if day_allowed(moment, conf["days"]) and in_window(moment, start, end):
            return moment

        opening = moment.replace(hour=start.hour, minute=start.minute, second=0, microsecond=0)

        if opening <= moment:
            opening += timedelta(days=1)

        moment = opening

    return moment


def last_started(session, kind):
    run = session.query(ScanRun).filter(ScanRun.source == kind).order_by(ScanRun.id.desc()).first()
    return run.started_at.astimezone() if run else None


def available(session, kind):
    """Можно ли собирать по расписанию: источник включён и настроен."""
    source = load_source(session, kind)
    return bool(source and source.enabled and source_ready(session, kind, source))


def tick(session, now=None):
    """Запустить сборы, которым пора. Ответ – какие источники запущены."""
    now = now or datetime.now().astimezone()
    started = []

    for kind, conf in load(session).items():
        if conf["mode"] == "off" or not available(session, kind):
            continue

        moment = next_run(conf, last_started(session, kind), now)

        if moment is None or moment > now:
            continue

        try:
            scan_collect.start(session, kind, USER)
            started.append(kind)
        except scan_collect.CollectRefused:
            session.rollback()   # ещё идёт прошлый – в другой раз

    return started


def prune_runs(session):
    """Журнал запусков не растёт без конца; последний запуск источника остаётся."""
    since = datetime.now(timezone.utc) - timedelta(days=RUNS_KEEP_DAYS)
    keep = set()

    for kind in SOURCES:
        run = session.query(ScanRun.id).filter(ScanRun.source == kind).order_by(ScanRun.id.desc()).first()

        if run:
            keep.add(run.id)

    query = session.query(ScanRun).filter(ScanRun.started_at < since, ScanRun.status != "running")

    if keep:
        query = query.filter(ScanRun.id.notin_(keep))

    query.delete(synchronize_session=False)
    session.commit()


_stop = threading.Event()
_thread = None


def _loop():
    ticks = 0

    while not _stop.wait(TICK_SECONDS):
        session = SessionLocal()

        try:
            tick(session)

            if ticks % 120 == 0:   # раз в час
                prune_runs(session)

            ticks += 1
        except Exception:  # noqa: BLE001 – сбой одного прохода не должен остановить расписание
            logger.exception("Расписание сборов: ошибка")
            session.rollback()
        finally:
            session.close()


def start():
    global _thread

    if _thread is None or not _thread.is_alive():
        _stop.clear()
        _thread = threading.Thread(target=_loop, daemon=True, name="scan-schedule")
        _thread.start()


def stop():
    _stop.set()
