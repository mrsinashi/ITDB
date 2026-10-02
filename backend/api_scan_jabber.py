"""Пользователи Jabber (VACUUM) — страница «Vacuum» (этап 26д; с 26ж — вкладка меню).

GET /api/scan/jabber — пользователи из последних сборов (scan_jabber_users):
группы общего ростера, в сети ли, когда подключался, с каких адресов (у тех, кто
не в сети, — последний известный IP) и какой ПК стоит на этом адресе: ПК таблицы
с таким IP, а если в таблице его нет — запись GLPI / GSIT с таким IP. ПК ищется
только по IP (этап 26ж). Пометки: gone — пользователя нет, а в группе он остался
(убрать из группы); no_group — не входит ни в одну группу. Ничего не пишет.
Сбор — POST /api/scan/sources/jabber/collect (api_scan_records.py). Смотреть —
редактор и администратор.
"""
import ipaddress
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

import scan_collect
from api_computers import load_locations, location_path
from api_scan import SOURCES, RunOut, last_run_of, load_source
from auth import require_editor
from db import get_db
from models import Computer, ScanJabberUser, ScanRecord

router = APIRouter(prefix="/api/scan/jabber", tags=["scan"])


class HostOut(BaseModel):
    """ПК на адресе: из таблицы (computer_id) или запись источника (source)."""
    computer_id: Optional[int] = None
    hostname: Optional[str] = None
    place: Optional[str] = None
    source: Optional[str] = None      # «GLPI №12» — если ПК с таким IP в таблице нет


class AddressOut(BaseModel):
    ip: Optional[str]
    client: Optional[str]
    hosts: list[HostOut]


class JabberUserOut(BaseModel):
    login: str
    groups: list[str]
    online: bool
    addresses: list[AddressOut]       # в сети — текущие ресурсы, иначе — последний IP
    last_seen_at: Optional[datetime]  # когда ITDB видел в сети (к последнему IP)
    last_login_at: Optional[datetime] # «Последнее подключение» по списку ejabberd
    gone: bool = False                # пользователя нет, а в группе остался
    no_group: bool = False            # не входит ни в одну группу


class JabberOut(BaseModel):
    enabled: bool
    configured: bool
    listed: bool                      # список всех пользователей получен (пометки точные)
    users: list[JabberUserOut]
    last_run: Optional[RunOut]


def ipv4_lines(text):
    result = []

    for line in (text or "").splitlines():
        try:
            address = ipaddress.ip_address(line.strip())
        except ValueError:
            continue

        if address.version == 4:
            result.append(str(address))

    return result


def address_index(session):
    """IP → ПК таблицы (рабочие) и IP → записи GLPI / GSIT (без дублей)."""
    locations = load_locations(session)
    computers = {}
    by_ip = {}

    for c in session.query(Computer.id, Computer.hostname, Computer.ip, Computer.location_id).filter(Computer.archived == False):  # noqa: E712
        computers[c.id] = {"hostname": c.hostname, "place": location_path(c.location_id, locations)}

        for ip in ipv4_lines(c.ip):
            by_ip.setdefault(ip, []).append(c.id)

    records = {}

    for r in session.query(ScanRecord).filter(ScanRecord.source.in_(scan_collect.RECORD_KINDS), ScanRecord.dup_of.is_(None)):
        values = (r.data or {}).get("values") or {}

        for ip in ipv4_lines(values.get("ip")):
            records.setdefault(ip, []).append((r.source, r.source_id, r.name))

    return computers, by_ip, records


@router.get("", response_model=JabberOut)
def list_jabber(me=Depends(require_editor), session=Depends(get_db)):
    source = load_source(session, "jabber")
    computers, by_ip, records = address_index(session)
    rows = session.query(ScanJabberUser).order_by(ScanJabberUser.login).all()
    listed = any(row.registered is not None for row in rows)
    users = []

    def hosts_of(ip):
        if not ip:
            return []

        if ip in by_ip:
            return [
                HostOut(computer_id=cid, hostname=computers[cid]["hostname"], place=computers[cid]["place"])
                for cid in by_ip[ip]
            ]

        return [
            HostOut(hostname=name, source=f"{SOURCES[kind]['title']} №{source_id}")
            for kind, source_id, name in records.get(ip, [])
        ]

    for row in rows:
        groups = row.groups or []

        # Удалённый пользователь, которого нет и в группах, — показывать нечего
        if row.registered is False and not groups:
            continue

        if row.online and row.resources:
            addresses = [
                AddressOut(ip=r.get("ip"), client=r.get("client"), hosts=hosts_of(r.get("ip")))
                for r in row.resources
            ]
        elif row.last_ip:
            addresses = [AddressOut(ip=row.last_ip, client=row.last_client, hosts=hosts_of(row.last_ip))]
        else:
            addresses = []

        users.append(JabberUserOut(
            login=row.login,
            groups=groups,
            online=row.online,
            addresses=addresses,
            last_seen_at=row.last_seen_at,
            last_login_at=row.last_login_at,
            gone=row.registered is False,
            no_group=bool(listed and row.registered and not groups),
        ))

    return JabberOut(
        enabled=bool(source and source.enabled),
        configured=bool(source and source.url),
        listed=listed,
        users=users,
        last_run=last_run_of(session, "jabber"),
    )
