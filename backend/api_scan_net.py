"""Вкладка «Сеть» «Сканера» (этап 28б): что собрали DHCP и проход подсетей.

GET /api/scan/hosts — адреса из scan_hosts, по строке на адрес: MAC и имя машины,
что говорит DHCP (аренда, привязка в настройках) и что ответило при проходе подсети
(чем ответил, открытые порты), и какой ПК таблицы на этом адресе: по IP из таблицы
или по MAC. Источники говорят разное — значения показываются все, у каждого —
откуда оно (этап 28в); первым — то, что видно на самом деле (сеть, потом аренда),
последним — привязка из настроек DHCP. Наблюдения по сроку не удаляются (этап 31):
что старше срока «Актуальны» своего источника — stale (на странице серым); имя
источника у значений — как их зовёт пользователь: Сканер, Leases, DHCP Config.
Ничего не пишет.
Сбор — POST /api/scan/sources/{dhcp|net}/collect. Смотреть — редактор и администратор.
"""
import ipaddress
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

import scan_collect
from api_computers import load_locations, location_path
from api_scan import SOURCES, RunOut, fresh_days_of, last_run_of, load_source
from auth import require_editor
from db import get_db
from models import Computer, ScanHost
from scan_dhcp import CONF_SOURCE
from scan_hostmatch import lines, same_name
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
    stale: bool = False        # старше срока «Актуальны» — последнее известное


class HostPc(BaseModel):
    computer_id: int
    hostname: Optional[str]
    place: Optional[str]
    by: list[str]              # ip, mac, conf (MAC привязки из настроек DHCP) — по чему найден


class ValueOut(BaseModel):
    """Значение и кто его назвал: «Сканер», «Leases», «DHCP Config»."""
    value: str
    sources: list[str]
    stale: bool = False        # все, кто его назвал, — давно


class HostOut(BaseModel):
    ip: str
    mac: list[ValueOut]
    name: list[ValueOut]
    dhcp: Optional[SeenOut] = None    # аренда
    conf: Optional[SeenOut] = None    # привязка из настроек DHCP
    net: Optional[SeenOut] = None
    ports: Optional[list[int]] = None   # открытые порты; None — не проверялись
    rfb: Optional[str] = None           # версия VNC на порту 5900
    seen_at: Optional[datetime] = None  # когда адрес был занят на самом деле (привязка не в счёт)
    seen_by: Optional[str] = None       # кто видел последним: «Сканер» / «Leases»
    stale: bool = False                 # всё, что видели на адресе, — давно (привязка не в счёт)
    differ: bool = False                # источники сейчас называют разный MAC или имя
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


WHO = {"net": "Сканер", "dhcp": "Leases", "conf": "DHCP Config"}
# Сначала — что видно на самом деле; привязка из настроек — последней
ORDER = ("net", "dhcp", "conf")


def dhcp_seen(row, stale=False):
    data = row.data or {}
    details = []
    text = "аренда" if data.get("active") else "аренда кончилась"

    if data.get("gone"):
        details.append("в файле аренд уже нет")
    elif data.get("state"):
        details.append("состояние: " + str(data["state"]))

    return SeenOut(mac=row.mac, name=row.name, seen_at=row.seen_at, text=text, details=details, stale=stale)


def conf_seen(row, elsewhere):
    """Привязка из настроек DHCP; elsewhere — адреса, где этот MAC виден на самом деле."""
    data = row.data or {}
    details = []

    if data.get("host"):
        details.append("host " + str(data["host"]))

    if data.get("file"):
        details.append("файл: " + str(data["file"]))

    if elsewhere:
        details.append("MAC сейчас на " + ", ".join(elsewhere))

    return SeenOut(mac=row.mac, name=data.get("host"), seen_at=row.seen_at, text="привязка", details=details)


def net_seen(row, stale=False):
    data = row.data or {}
    how = data.get("how") or []
    how = how if isinstance(how, list) else [how]
    details = []

    if data.get("dns"):
        details.append("DNS: " + str(data["dns"]))

    if data.get("group"):
        details.append("группа: " + str(data["group"]))

    return SeenOut(
        mac=row.mac, name=row.name, seen_at=row.seen_at,
        text=", ".join(HOW.get(item, str(item)) for item in how) or "ответил", details=details, stale=stale,
    )


def ports_of(row):
    """Открытые порты адреса: список; порты не проверялись — None."""
    ports = (row.data or {}).get("ports") if row is not None else None

    if not isinstance(ports, list):
        return None

    return sorted(port for port in ports if isinstance(port, int))


def merge(values, same):
    """[(значение, кто назвал, давно ли)] → [ValueOut]: одинаковые значения — одной
    строкой; значение «давнее», если давно его называли все."""
    result = []

    for value, who, stale in values:
        if not value:
            continue

        found = next((item for item in result if same(item.value, value)), None)

        if found is None:
            result.append(ValueOut(value=value, sources=[who], stale=stale))
        else:
            found.stale = found.stale and stale

            if who not in found.sources:
                found.sources.append(who)

    return result


def same_host(a, b):
    return a.lower() == b.lower() or same_name(a, b) or same_name(b, a)


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
    kinds = [kind for group in scan_collect.HOST_SOURCES.values() for kind in group]
    seen_macs = {}   # MAC → адреса, где он виден на самом деле (сеть, аренда) и недавно
    moment_now = datetime.now(timezone.utc)
    # Раньше этого времени — «давно» (срок «Актуальны» источника)
    since = {
        kind: moment_now - timedelta(days=fresh_days_of(load_source(session, kind), kind))
        for kind in scan_collect.HOST_KINDS
    }
    old = {}         # адрес → виды строк, которые видели давно

    for row in session.query(ScanHost).filter(ScanHost.source.in_(kinds)):
        # Привязки, собранные до 28в, лежат строками dhcp с пометкой fixed
        fixed = row.source == CONF_SOURCE or bool((row.data or {}).get("fixed"))
        kind = "conf" if fixed else row.source
        found.setdefault(row.ip, {})[kind] = row
        stale = not fixed and row.seen_at < since[row.source]

        if stale:
            old.setdefault(row.ip, set()).add(kind)

        if not fixed and not stale and row.mac:
            seen_macs.setdefault(row.mac, set()).add(row.ip)

    hosts = []

    for ip, entry in found.items():
        stale = old.get(ip, set())
        macs = merge(
            [(entry[kind].mac, WHO[kind], kind in stale) for kind in ORDER if kind in entry], lambda a, b: a == b,
        )
        names = merge(
            [
                ((entry[kind].data or {}).get("host") if kind == "conf" else entry[kind].name, WHO[kind], kind in stale)
                for kind in ORDER if kind in entry
            ],
            same_host,
        )
        conf = entry.get("conf")
        pcs = {}

        for computer_id in by_ip.get(ip, []):
            pcs.setdefault(computer_id, []).append("ip")

        for kind in ORDER:
            row = entry.get(kind)

            for computer_id in (by_mac.get(row.mac, []) if row is not None and row.mac else []):
                pcs.setdefault(computer_id, []).append("conf" if kind == "conf" else "mac")

        for by in pcs.values():
            if "mac" in by and "conf" in by:
                by.remove("conf")

        real = [(entry[kind].seen_at, kind) for kind in ("net", "dhcp") if kind in entry]
        last = max(real) if real else None
        # Давнее значение рядом с нынешним — не расхождение, а прошлое
        fresh = [[value for value in values if not value.stale] or values for values in (macs, names)]
        elsewhere = sorted(seen_macs.get(conf.mac, set()) - {ip}, key=ip_key) if conf is not None and conf.mac else []
        net = entry.get("net")

        hosts.append(HostOut(
            ip=ip, mac=macs, name=names,
            dhcp=dhcp_seen(entry["dhcp"], "dhcp" in stale) if "dhcp" in entry else None,
            conf=conf_seen(conf, elsewhere) if conf is not None else None,
            net=net_seen(net, "net" in stale) if net is not None else None,
            ports=ports_of(net),
            rfb=(net.data or {}).get("rfb") if net is not None else None,
            seen_at=last[0] if last else None,
            seen_by=WHO[last[1]] if last else None,
            stale=bool(real) and all(kind in stale for _, kind in real),
            differ=any(len(values) > 1 for values in fresh),
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
