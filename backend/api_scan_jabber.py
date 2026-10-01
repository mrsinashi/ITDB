"""Пользователи Jabber (VACUUM) — вкладка «Vacuum» на «Сканировании» (этап 26д).

GET /api/scan/jabber — пользователи из последних сборов (scan_jabber_users):
группы общего ростера, в сети ли, с каких адресов (у тех, кто не в сети, —
последний известный IP) и какой ПК стоит на этом адресе: ПК таблицы с таким IP,
а если в таблице его нет — запись GLPI / GSIT с таким IP. Ничего не пишет.
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
from models import Computer, ScanJabberUser, ScanRecord, VacuumAccount, VacuumAccountComputer

router = APIRouter(prefix="/api/scan/jabber", tags=["scan"])


class HostOut(BaseModel):
    """ПК на адресе: из таблицы (computer_id) или запись источника (source)."""
    computer_id: Optional[int] = None
    hostname: Optional[str] = None
    place: Optional[str] = None
    source: Optional[str] = None      # «GLPI №12» — если ПК с таким IP в таблице нет
    vacuum: bool = False              # логин записан в VACUUM этого ПК


class AddressOut(BaseModel):
    ip: Optional[str]
    client: Optional[str]
    hosts: list[HostOut]


class JabberUserOut(BaseModel):
    login: str
    groups: list[str]
    online: bool
    addresses: list[AddressOut]       # в сети — текущие ресурсы, иначе — последний IP
    last_seen_at: Optional[datetime]
    vacuum_pcs: list[str]             # ПК, у которых логин записан в VACUUM


class JabberOut(BaseModel):
    enabled: bool
    configured: bool
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


def vacuum_index(session):
    """логин (строчными) → id ПК, у которых он записан в VACUUM."""
    result = {}
    rows = (
        session.query(VacuumAccount.login, VacuumAccountComputer.computer_id)
        .join(VacuumAccountComputer, VacuumAccountComputer.account_id == VacuumAccount.id)
    )

    for login, computer_id in rows:
        result.setdefault(login.lower(), set()).add(computer_id)

    return result


@router.get("", response_model=JabberOut)
def list_jabber(me=Depends(require_editor), session=Depends(get_db)):
    source = load_source(session, "jabber")
    computers, by_ip, records = address_index(session)
    vacuum = vacuum_index(session)
    users = []

    def hosts_of(ip, login):
        if not ip:
            return []

        mine = vacuum.get(login.lower(), set())

        if ip in by_ip:
            return [
                HostOut(computer_id=cid, hostname=computers[cid]["hostname"], place=computers[cid]["place"], vacuum=cid in mine)
                for cid in by_ip[ip]
            ]

        return [
            HostOut(hostname=name, source=f"{SOURCES[kind]['title']} №{source_id}")
            for kind, source_id, name in records.get(ip, [])
        ]

    for row in session.query(ScanJabberUser).order_by(ScanJabberUser.login):
        if row.online and row.resources:
            addresses = [
                AddressOut(ip=r.get("ip"), client=r.get("client"), hosts=hosts_of(r.get("ip"), row.login))
                for r in row.resources
            ]
        elif row.last_ip:
            addresses = [AddressOut(ip=row.last_ip, client=row.last_client, hosts=hosts_of(row.last_ip, row.login))]
        else:
            addresses = []

        users.append(JabberUserOut(
            login=row.login,
            groups=row.groups or [],
            online=row.online,
            addresses=addresses,
            last_seen_at=row.last_seen_at,
            vacuum_pcs=sorted({
                (computers[cid]["hostname"] or f"ПК №{cid}") for cid in vacuum.get(row.login.lower(), set()) if cid in computers
            }),
        ))

    return JabberOut(
        enabled=bool(source and source.enabled),
        configured=bool(source and source.url),
        users=users,
        last_run=last_run_of(session, "jabber"),
    )
