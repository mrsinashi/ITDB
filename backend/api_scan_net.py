"""Вкладка «Сеть» «Сканера» (этап 28б): что собрали DHCP и проход подсетей.

GET /api/scan/hosts — адреса из scan_hosts, по строке на адрес: MAC и имя машины,
что говорит DHCP (аренда или резерв) и что ответило при проходе подсети, и какой
ПК таблицы на этом адресе: по IP из таблицы или по MAC. Ничего не пишет.
Сбор — POST /api/scan/sources/{dhcp|net}/collect. Смотреть — редактор и администратор.
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
from models import Computer, ScanHost
from scan_hostmatch import lines
from scan_normalize import is_virtual_mac, norm_mac, usable_ipv4

router = APIRouter(prefix="/api/scan/hosts", tags=["scan"])

HOW = {"ping": "ping", "netbios": "NetBIOS", "arp": "ARP", "tcp": "порт 445"}


class SeenOut(BaseModel):
    """Что один источник знает об адресе."""
    mac: Optional[str]
    name: Optional[str]
    seen_at: datetime
    text: str                  # коротко: «аренда», «резерв», «ping, NetBIOS»
    details: list[str] = []    # подробности — для подсказки


class HostPc(BaseModel):
    computer_id: int
    hostname: Optional[str]
    place: Optional[str]
    by: list[str]              # ip, mac — по чему найден


class HostOut(BaseModel):
    ip: str
    mac: list[str]
    name: list[str]
    dhcp: Optional[SeenOut] = None
    net: Optional[SeenOut] = None
    computers: list[HostPc]


class HostSource(BaseModel):
    kind: str
    title: str
    enabled: bool
    last_run: Optional[RunOut]


class HostsOut(BaseModel):
    hosts: list[HostOut]
    sources: list[HostSource]


def moment(value):
    """«2026-10-02T03:00:00+00:00» → время; не разобрать — None."""
    try:
        return datetime.fromisoformat(value) if value else None
    except ValueError:
        return None


def dhcp_seen(row):
    data = row.data or {}
    details = []

    if data.get("fixed"):
        text = "резерв"

        if data.get("host"):
            details.append("host " + str(data["host"]))
    else:
        text = "аренда" if data.get("active") else "аренда кончилась"

        if data.get("state"):
            details.append("состояние: " + str(data["state"]))

    return SeenOut(mac=row.mac, name=row.name, seen_at=row.seen_at, text=text, details=details)


def net_seen(row):
    data = row.data or {}
    how = data.get("how") or []
    how = how if isinstance(how, list) else [how]
    details = []

    if data.get("dns"):
        details.append("DNS: " + str(data["dns"]))

    if data.get("group"):
        details.append("группа: " + str(data["group"]))

    if data.get("ports"):
        details.append("порты: " + ", ".join(str(port) for port in data["ports"]))

    if data.get("rfb"):
        details.append("VNC: " + str(data["rfb"]))

    return SeenOut(
        mac=row.mac, name=row.name, seen_at=row.seen_at,
        text=", ".join(HOW.get(item, str(item)) for item in how) or "ответил", details=details,
    )


def ip_key(ip):
    try:
        return int(ipaddress.ip_address(ip))
    except ValueError:
        return 0


@router.get("", response_model=HostsOut)
def list_hosts(me=Depends(require_editor), session=Depends(get_db)):
    locations = load_locations(session)
    computers, by_ip, by_mac = {}, {}, {}

    for c in session.query(Computer.id, Computer.hostname, Computer.ip, Computer.mac, Computer.location_id).filter(Computer.archived == False):  # noqa: E712
        computers[c.id] = {"hostname": c.hostname, "place": location_path(c.location_id, locations)}

        for line in lines(c.ip):
            ip = usable_ipv4(line)

            if ip:
                by_ip.setdefault(ip, []).append(c.id)

        for line in lines(c.mac):
            mac = norm_mac(line)

            if mac and not is_virtual_mac(mac):
                by_mac.setdefault(mac, []).append(c.id)

    found = {}

    for row in session.query(ScanHost).filter(ScanHost.source.in_(scan_collect.HOST_KINDS)):
        entry = found.setdefault(row.ip, {})
        entry[row.source] = row

    hosts = []

    for ip, entry in found.items():
        macs, names = [], []

        # Сеть видит машину сейчас — её MAC и имя первыми
        for kind in ("net", "dhcp"):
            row = entry.get(kind)

            if row is None:
                continue

            if row.mac and row.mac not in macs:
                macs.append(row.mac)

            if row.name and row.name.lower() not in [name.lower() for name in names]:
                names.append(row.name)

        pcs = {}

        for computer_id in by_ip.get(ip, []):
            pcs.setdefault(computer_id, []).append("ip")

        for mac in macs:
            for computer_id in by_mac.get(mac, []):
                pcs.setdefault(computer_id, []).append("mac")

        hosts.append(HostOut(
            ip=ip, mac=macs, name=names,
            dhcp=dhcp_seen(entry["dhcp"]) if "dhcp" in entry else None,
            net=net_seen(entry["net"]) if "net" in entry else None,
            computers=[
                HostPc(computer_id=computer_id, hostname=computers[computer_id]["hostname"],
                       place=computers[computer_id]["place"], by=sorted(set(by)))
                for computer_id, by in pcs.items()
            ],
        ))

    hosts.sort(key=lambda host: ip_key(host.ip))
    sources = []

    for kind in scan_collect.HOST_KINDS:
        source = load_source(session, kind)
        sources.append(HostSource(
            kind=kind, title=SOURCES[kind]["title"], enabled=bool(source and source.enabled),
            last_run=last_run_of(session, kind),
        ))

    return HostsOut(hosts=hosts, sources=sources)
