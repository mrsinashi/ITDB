"""Расписание сборов (этап 28) – вкладка «Расписание» в «Сканере». Только администратор.

- GET   /api/scan/schedule – настройка каждого источника, последний и следующий запуск;
- PATCH /api/scan/schedule/{kind} – изменить (пишется в Историю, видит администратор).
Сам запуск по расписанию – scan_schedule.py.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.dialects.postgresql import insert as pg_insert

import scan_collect
import scan_schedule
from api_scan import SOURCES, RunOut, last_run_of
from auth import require_admin
from db import get_db
from history_log import log_change
from models import AppSetting

router = APIRouter(prefix="/api/scan/schedule", tags=["scan"])

MINUTES_TEXT = {15: "каждые 15 мин", 30: "каждые 30 мин", 60: "каждый час", 120: "каждые 2 ч", 240: "каждые 4 ч", 480: "каждые 8 ч"}
DAYS_TEXT = {"all": "каждый день", "work": "по будням"}


class ScheduleOut(BaseModel):
    kind: str
    title: str
    available: bool                 # источник включён и настроен
    mode: str
    minutes: int
    time_from: str
    time_to: str
    time_at: str
    days: str
    last_run: Optional[RunOut]
    next_at: Optional[datetime]


class ScheduleList(BaseModel):
    items: list[ScheduleOut]
    minutes: list[int]


class ScheduleUpdate(BaseModel):
    mode: Optional[str] = None
    minutes: Optional[int] = None
    time_from: Optional[str] = None
    time_to: Optional[str] = None
    time_at: Optional[str] = None
    days: Optional[str] = None


def mode_text(conf):
    if conf["mode"] == "off":
        return "вручную"

    return "раз в день" if conf["mode"] == "daily" else MINUTES_TEXT[conf["minutes"]]


def time_text(conf):
    if conf["mode"] == "off":
        return None

    if conf["mode"] == "daily":
        return "в " + conf["time_at"]

    return "круглые сутки" if conf["time_from"] == conf["time_to"] else f"с {conf['time_from']} до {conf['time_to']}"


def days_text(conf):
    return None if conf["mode"] == "off" else DAYS_TEXT[conf["days"]]


def item_out(session, kind, conf):
    available = scan_schedule.available(session, kind)
    moment = scan_schedule.next_run(conf, scan_schedule.last_started(session, kind), datetime.now().astimezone())
    return ScheduleOut(
        kind=kind, title=SOURCES[kind]["title"], available=available, last_run=last_run_of(session, kind),
        next_at=moment.astimezone(timezone.utc) if moment and available else None, **conf,
    )


@router.get("", response_model=ScheduleList)
def get_schedule(me=Depends(require_admin), session=Depends(get_db)):
    return ScheduleList(
        items=[item_out(session, kind, conf) for kind, conf in scan_schedule.load(session).items()],
        minutes=list(scan_schedule.MINUTES),
    )


@router.patch("/{kind}", response_model=ScheduleOut)
def update_schedule(kind: str, payload: ScheduleUpdate, me=Depends(require_admin), session=Depends(get_db)):
    if kind not in scan_collect.COLLECTORS:
        raise HTTPException(status_code=404, detail="Нет такого источника.")

    data = payload.model_dump(exclude_none=True)

    if "mode" in data and data["mode"] not in scan_schedule.MODES:
        raise HTTPException(status_code=400, detail="Неизвестный вид запуска.")

    if "minutes" in data and data["minutes"] not in scan_schedule.MINUTES:
        raise HTTPException(status_code=400, detail="Такой частоты нет.")

    if "days" in data and data["days"] not in scan_schedule.DAYS:
        raise HTTPException(status_code=400, detail="Дни – каждый день или по будням.")

    for field in ("time_from", "time_to", "time_at"):
        if field in data and scan_schedule.parse_time(data[field]) is None:
            raise HTTPException(status_code=400, detail="Время – в виде ЧЧ:ММ.")

    # Строка настроек одна на все источники: два изменения разом не должны её ни
    # создать дважды, ни затереть друг друга
    session.execute(pg_insert(AppSetting).values(key=scan_schedule.KEY, value={}).on_conflict_do_nothing())
    row = session.query(AppSetting).filter(AppSetting.key == scan_schedule.KEY).with_for_update().one()

    before = scan_schedule.clean((row.value or {}).get(kind))
    after = scan_schedule.clean(dict(before, **data))
    row.value = dict(row.value or {}, **{kind: after})
    row.updated_at = datetime.now(timezone.utc)

    log_change(
        session, "scan_schedule", 0, me["login"],
        {
            "run_mode": {"old": mode_text(before), "new": mode_text(after)},
            "run_time": {"old": time_text(before), "new": time_text(after)},
            "run_days": {"old": days_text(before), "new": days_text(after)},
        },
        title=SOURCES[kind]["title"], entity_key=kind,
    )
    session.flush()
    out = item_out(session, kind, after)
    session.commit()
    return out
