"""Общие настройки программы, которые меняются в интерфейсе (этап 28б).

Пока одна: «vnc_default» – каким VNC подключаться к ПК, у которого тип VNC в
таблице не указан (Enter по выбранной строке; радиокнопка в Справочниках, блок
«Тип VNC»). Хранится в app_settings. Смотреть – все, менять – редактор.
"""
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from auth import get_current_user, require_editor
from db import get_db
from history_log import log_change
from models import AppSetting

router = APIRouter(prefix="/api/settings", tags=["settings"])

VNC_KEY = "vnc_default"
VNC_KINDS = {"tight": "TightVNC", "ultra": "UltraVNC"}
VNC_DEFAULT = "tight"


class SettingsOut(BaseModel):
    vnc_default: str


class SettingsUpdate(BaseModel):
    vnc_default: Optional[Literal["tight", "ultra"]] = None


def vnc_default(session):
    row = session.get(AppSetting, VNC_KEY)
    value = (row.value or {}).get("kind") if row else None
    return value if value in VNC_KINDS else VNC_DEFAULT


@router.get("", response_model=SettingsOut)
def get_settings(me=Depends(get_current_user), session=Depends(get_db)):
    return SettingsOut(vnc_default=vnc_default(session))


@router.patch("", response_model=SettingsOut)
def update_settings(payload: SettingsUpdate, me=Depends(require_editor), session=Depends(get_db)):
    old = vnc_default(session)
    new = payload.vnc_default

    if new and new != old:
        row = session.get(AppSetting, VNC_KEY)

        if row is None:
            row = AppSetting(key=VNC_KEY)
            session.add(row)

        row.value = {"kind": new}
        row.updated_at = datetime.now(timezone.utc)
        log_change(
            session, "app_settings", 0, me["login"],
            {VNC_KEY: {"old": VNC_KINDS[old], "new": VNC_KINDS[new]}}, title="VNC по умолчанию", entity_key=VNC_KEY,
        )
        session.commit()

    return SettingsOut(vnc_default=vnc_default(session))
