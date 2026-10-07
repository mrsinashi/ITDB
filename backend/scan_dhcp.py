"""DHCP (isc-dhcpd) — этап 28: кому какой адрес выдан. Файл аренд
(/var/lib/dhcpd/dhcpd.leases) читается по SSH (scan_ssh.py).

Из файла берётся:
- аренды: «lease IP { starts …; ends …; binding state …; hardware ethernet MAC;
  client-hostname "ИМЯ"; }» — у адреса действует последняя запись в файле;
  время — UTC (или «epoch N» при db-time-format local);
- привязки (резервы): «host ИМЯ { hardware ethernet MAC; fixed-address IP; }» — из
  файлов настроек (dhcpd.conf и его части, поля «Конфиг N» подключения). Привязка —
  это настройка, а не наблюдение: адрес на машине могли поменять вручную. Поэтому
  она хранится отдельно от аренд (scan_hosts.source = dhcp_conf) и уступает всему,
  что видно в сети на самом деле (scan_hostmatch.py).

Актуальны аренды, которые действуют сейчас или кончились не раньше N дней назад
(настройка подключения): адрес давно ушедшего устройства ни о чём не говорит.
В таблицу ничего не пишется — только наблюдения (scan_hosts).
"""
import ipaddress
import re
from datetime import datetime, timedelta, timezone

import scan_ssh
from scan_http import SourceError
from scan_normalize import norm_mac

DEFAULT_PATH = "/var/lib/dhcpd/dhcpd.leases"
# Привязки MAC — IP из файлов настроек: отдельный вид строк scan_hosts
CONF_SOURCE = "dhcp_conf"

LEASE_START = re.compile(r"^\s*lease\s+(\d+\.\d+\.\d+\.\d+)\s*\{")
HOST_BLOCK = re.compile(r"\bhost\s+([^\s{]+)\s*\{([^{}]*)\}", re.S)
STATEMENT = re.compile(r"^\s*(starts|ends|binding state|hardware ethernet|client-hostname)\s+(.*?);\s*$")
TIME = re.compile(r"(\d{4})/(\d\d)/(\d\d)\s+(\d\d):(\d\d):(\d\d)")
EPOCH = re.compile(r"epoch\s+(\d+)")
HARDWARE = re.compile(r"hardware\s+ethernet\s+([0-9a-fA-F:]+)\s*;")
FIXED = re.compile(r"fixed-address\s+([^;]+);")


def lease_time(text):
    """«4 2026/10/01 08:12:33» (UTC) или «epoch 1790843553» → время; «never» → None."""
    found = EPOCH.search(text)

    if found:
        return datetime.fromtimestamp(int(found.group(1)), timezone.utc)

    found = TIME.search(text)

    if not found:
        return None

    try:
        return datetime(*(int(part) for part in found.groups()), tzinfo=timezone.utc)
    except ValueError:
        return None


def clean_name(text):
    name = (text or "").strip().strip('"').strip()
    return name if name and len(name) <= 255 and not re.search(r"[\s\\]", name) else None


def valid_ip(text):
    try:
        address = ipaddress.ip_address(text.strip())
    except ValueError:
        return None

    return str(address) if address.version == 4 else None


def parse(text):
    """Файл аренд (и настроек) → (аренды {ip: запись}, резервы [запись]).
    Аренда: {"ip", "mac", "name", "starts", "ends", "state"}."""
    leases = {}
    current = None
    plain = []

    for line in text.splitlines():
        if current is None:
            found = LEASE_START.match(line)

            if found:
                current = {"ip": valid_ip(found.group(1)), "mac": None, "name": None, "starts": None, "ends": None, "state": None}
            else:
                plain.append(line.split("#", 1)[0])

            continue

        if line.strip() == "}":
            if current["ip"]:
                leases[current["ip"]] = current   # позже в файле — новее

            current = None
            continue

        found = STATEMENT.match(line)

        if not found:
            continue

        key, value = found.groups()

        if key == "starts":
            current["starts"] = lease_time(value)
        elif key == "ends":
            current["ends"] = lease_time(value)
        elif key == "binding state":
            current["state"] = value.strip()
        elif key == "hardware ethernet":
            current["mac"] = norm_mac(value)
        elif key == "client-hostname":
            current["name"] = clean_name(value)

    hosts = []

    for name, body in HOST_BLOCK.findall("\n".join(plain)):
        mac = HARDWARE.search(body)
        fixed = FIXED.search(body)

        if not mac or not fixed or not norm_mac(mac.group(1)):
            continue

        for address in fixed.group(1).split(","):
            ip = valid_ip(address)

            if ip:
                hosts.append({"ip": ip, "mac": norm_mac(mac.group(1)), "name": clean_name(name)})

    return leases, hosts


def parse_files(files):
    """[(путь, текст)] → (аренды {ip: запись}, привязки [запись с "file"])."""
    leases, hosts = {}, []

    for path, text in files:
        found, fixed = parse(text)
        leases.update(found)
        hosts.extend(dict(host, file=path) for host in fixed)

    return leases, hosts


def build(files, fresh_days, now=None):
    """Наблюдения для scan_hosts и счётчики. files — текст файла или [(путь, текст)].
    У привязок из настроек — "source": CONF_SOURCE."""
    if isinstance(files, str):
        files = [(None, files)]

    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=fresh_days)
    leases, hosts = parse_files(files)
    items = {}
    active = stale = no_mac = 0

    for lease in leases.values():
        if not lease["mac"]:
            no_mac += 1
            continue

        is_active = lease["state"] == "active" and (lease["ends"] is None or lease["ends"] > now)
        last = now if is_active else (lease["ends"] or lease["starts"])

        if is_active:
            active += 1
        elif last is None:
            stale += 1
            continue   # ни начала, ни конца — когда адрес был занят, неизвестно
        elif last < since:
            stale += 1   # давняя аренда сохраняется: в «Сети» — серым, в предложения не идёт

        items[lease["ip"]] = {
            "ip": lease["ip"], "mac": lease["mac"], "name": lease["name"], "seen_at": last,
            "data": {
                "state": lease["state"], "active": is_active,
                "starts": lease["starts"].isoformat() if lease["starts"] else None,
                "ends": lease["ends"].isoformat() if lease["ends"] else None,
            },
        }

    fixed = {}

    for host in hosts:
        # Адрес привязан дважды — действует последняя запись
        data = {"fixed": True, "host": host["name"]}

        if host.get("file"):
            data["file"] = host["file"]

        fixed[host["ip"]] = {
            "source": CONF_SOURCE, "ip": host["ip"], "mac": host["mac"], "name": None, "seen_at": now, "data": data,
        }

    stats = {
        "total": len(leases) + len(fixed), "fresh": len(leases) - no_mac - stale + len(fixed), "active": active,
        "stale": stale,
        "fixed": len(fixed), "no_mac": no_mac,
    }
    return list(items.values()) + list(fixed.values()), stats


def file_warnings(files, params, info):
    """Что не так с файлами настроек: не прочитан, без привязок, ключ на сервере
    читает прежний набор файлов."""
    configs = scan_ssh.config_paths(params.get("configs"))
    warnings = []

    if not configs:
        return warnings

    read = dict(files)
    by_key = info.get("auth") == "key"

    # Со входом по ключу сервер выполняет команду, записанную вместе с ключом: меток
    # нет (ключ ставила прежняя версия) или в ней нет этих файлов
    if by_key and (None in read or any(path not in read for path in configs)):
        return ["Ключ на сервере читает прежний набор файлов — поставь ключ заново."]

    if None in read:
        return warnings

    for path in configs:
        text = read.get(path)

        if text is None or not text.strip():
            warnings.append(f"{path} — не прочитан.")
        elif not parse(text)[1]:
            warnings.append(f"{path} — привязок MAC — IP нет.")

    if info.get("read_error") and any("не прочитан" in line for line in warnings):
        warnings.append(info["read_error"])

    return warnings


def summary(stats, info):
    how = "по ключу" if info.get("auth") == "key" else "по паролю"
    parts = [f"аренд {stats['total'] - stats['fixed']}", f"действуют {stats['active']}"]

    if stats["fixed"]:
        parts.append(f"привязок {stats['fixed']}")

    return f"Подключено ({info.get('server') or 'SSH'}, вход {how}): " + ", ".join(parts) + "."


def check(params):
    files, info = scan_ssh.read_files(params)
    _, stats = build(files, 36500)

    if not stats["total"]:
        raise SourceError("Файл прочитан, но аренд в нём нет: это точно dhcpd.leases?")

    params["seen"] = info
    return " ".join([summary(stats, info)] + file_warnings(files, params, info))


def collect(params, fresh_days=None, progress=None):
    files, info = scan_ssh.read_files(params)
    items, stats = build(files, fresh_days or 30)
    warnings = file_warnings(files, params, info)

    if not stats["total"]:
        raise SourceError("Файл прочитан, но аренд в нём нет: это точно dhcpd.leases?")

    if info.get("auth") == "password":
        warnings.append("Вход по паролю: поставь ключ — тогда пароль можно не хранить.")

    if progress:
        progress(len(items), len(items))

    return {"items": items, "stats": stats, "warnings": warnings, "seen": info}
