"""Сеть (этап 28): что отвечает по адресам подсетей из списка «Подсети».

По каждому адресу (подсети с «Сканировать: да»):
- отвечает ли: ping (ICMP), иначе запрос имени NetBIOS, иначе порт 445; в своей
  подсети сервера – ещё и запись ARP (её не скрыть брандмауэром);
- MAC: из ARP (только подсеть самого сервера ITDB) или из ответа NetBIOS;
- имя ПК, как он сам себя называет, – NetBIOS (UDP 137); имя в DNS – справочно;
- по желанию – открытые порты (22, 80, 135, 139, 443, 445, 3389, 5900, 8080; у 5900 –
  версия VNC).

Служба работает без прав root: ping – через «ICMP без привилегий» (в Debian
разрешён всем, net.ipv4.ping_group_range); нельзя – обходится остальным.
Только стандартная библиотека. В таблицу ничего не пишется – наблюдения
(scan_hosts), из них предложения MAC / IP / имени считает scan_hostmatch.py.
"""
import ipaddress
import os
import random
import select
import socket
import struct
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from scan_http import SourceError
from scan_normalize import norm_mac

WORKERS = 100
MAX_ADDRESSES = 70000
PING_TIMEOUT = 0.6
PING_TRIES = 2
NBNS_TIMEOUT = 0.7
TCP_TIMEOUT = 0.6
ALIVE_PORT = 445
# SSH, HTTP, RPC, NetBIOS, HTTPS, SMB, RDP, VNC, HTTP (8080)
PORTS = (22, 80, 135, 139, 443, 445, 3389, 5900, 8080)
ARP_FILE = "/proc/net/arp"
# DNS, который не отвечает, не должен тормозить весь проход
DNS_SLOW = 3.0
DNS_SLOW_LIMIT = 3

# Запрос NetBIOS «статус узла» (NBSTAT) имени «*»
NBNS_QUERY_TAIL = b"\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00" + b"\x20CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\x00" + b"\x00\x21\x00\x01"


def targets(subnets):
    """Адреса для прохода: все адреса подсетей без адреса сети и широковещательного."""
    seen = set()
    result = []

    for cidr in subnets:
        network = ipaddress.ip_network(cidr, strict=False)

        for address in (network.hosts() if network.prefixlen < 31 else network):
            if address not in seen:
                seen.add(address)
                result.append(str(address))

                if len(result) > MAX_ADDRESSES:
                    raise SourceError(f"Слишком много адресов (больше {MAX_ADDRESSES}): отметь для сканирования меньше подсетей.")

    return result


# ---------- ping ----------


def icmp_socket():
    """Сокет ICMP без привилегий; нельзя – None."""
    try:
        return socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP)
    except OSError:
        return None


def checksum(data):
    if len(data) % 2:
        data += b"\x00"

    total = sum(struct.unpack(f"!{len(data) // 2}H", data))
    total = (total >> 16) + (total & 0xFFFF)
    total += total >> 16
    return ~total & 0xFFFF


def ping(ip, timeout=PING_TIMEOUT, tries=PING_TRIES):
    """True – ответил, False – нет, None – ICMP недоступен."""
    sock = icmp_socket()

    if sock is None:
        return None

    try:
        for seq in range(1, tries + 1):
            body = struct.pack("!HH", 0, seq) + b"itdb-scan"
            packet = struct.pack("!BBH", 8, 0, 0) + body
            packet = struct.pack("!BBH", 8, 0, checksum(packet)) + body

            try:
                sock.sendto(packet, (ip, 0))
            except OSError:
                return False

            deadline = time.monotonic() + timeout

            while True:
                left = deadline - time.monotonic()

                if left <= 0 or not select.select([sock], [], [], left)[0]:
                    break

                try:
                    data, peer = sock.recvfrom(1024)
                except OSError:
                    break

                # Ответ «эхо» (тип 0) от самого адреса; «недоступен» приходит от шлюза
                if peer[0] == ip and data[:1] == b"\x00":
                    return True

        return False
    finally:
        sock.close()


# ---------- NetBIOS ----------


def parse_nbstat(data):
    """Ответ NBSTAT → {"name", "group", "mac"} или None."""
    try:
        if len(data) < 57 or not data[2] & 0x80:
            return None

        offset = 12

        # Имя в ответе: длина + 32 знака + 0 (или сжатая ссылка 0xC0xx)
        if data[offset] & 0xC0 == 0xC0:
            offset += 2
        else:
            while data[offset]:
                offset += data[offset] + 1

            offset += 1

        rtype, _, _, length = struct.unpack("!HHIH", data[offset:offset + 10])
        offset += 10

        if rtype != 0x21 or length < 1:
            return None

        count = data[offset]
        offset += 1
        name = group = None

        for index in range(count):
            entry = data[offset + index * 18:offset + index * 18 + 18]

            if len(entry) < 18:
                return None

            text = entry[:15].decode("cp866", errors="replace").strip()
            suffix = entry[15]
            flags = struct.unpack("!H", entry[16:18])[0]

            if suffix == 0x00 and text:
                if flags & 0x8000:
                    group = group or text
                else:
                    name = name or text

        mac_bytes = data[offset + count * 18:offset + count * 18 + 6]
        mac = norm_mac(mac_bytes.hex()) if len(mac_bytes) == 6 else None

        if mac == "00:00:00:00:00:00":
            mac = None

        return {"name": name, "group": group, "mac": mac}
    except (IndexError, struct.error):
        return None


def nbstat(ip, timeout=NBNS_TIMEOUT):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    try:
        sock.settimeout(timeout)
        query = struct.pack("!H", random.randint(1, 0xFFFF))
        sock.sendto(query + NBNS_QUERY_TAIL, (ip, 137))
        data, peer = sock.recvfrom(2048)
        return parse_nbstat(data) if peer[0] == ip and data[:2] == query else None
    except OSError:
        return None
    finally:
        sock.close()


# ---------- TCP ----------


def tcp_state(ip, port, timeout=TCP_TIMEOUT):
    """«open» – принимает, «closed» – отказал (значит, адрес жив), None – молчит."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)

    try:
        sock.connect((ip, port))
        return "open"
    except ConnectionRefusedError:
        return "closed"
    except OSError:
        return None
    finally:
        sock.close()


def rfb_version(ip, timeout=1.0):
    """Версия протокола VNC на порту 5900: «003.008»; не VNC – None."""
    try:
        with socket.create_connection((ip, 5900), timeout=timeout) as sock:
            sock.settimeout(timeout)
            banner = sock.recv(12)
    except OSError:
        return None

    return banner[4:11].decode("ascii", errors="replace") if banner.startswith(b"RFB ") else None


# ---------- ARP и DNS ----------


def arp_table(path=ARP_FILE):
    """{IP: MAC} из таблицы ARP сервера (только его собственная подсеть)."""
    result = {}

    try:
        with open(path, encoding="ascii", errors="replace") as file:
            lines = file.read().splitlines()[1:]
    except OSError:
        return result

    for line in lines:
        parts = line.split()

        # IP, тип, флаги (0x2 – запись полная), MAC, маска, интерфейс
        if len(parts) >= 4 and int(parts[2], 16) & 0x2:
            mac = norm_mac(parts[3])

            if mac and mac != "00:00:00:00:00:00":
                result[parts[0]] = mac

    return result


class Dns:
    """Имя по адресу; после нескольких долгих неудач подряд больше не спрашивает."""

    def __init__(self):
        self.slow = 0

    def name(self, ip):
        if self.slow >= DNS_SLOW_LIMIT:
            return None

        started = time.monotonic()

        try:
            name = socket.gethostbyaddr(ip)[0]
            self.slow = 0
            return name if name and name != ip else None
        except OSError:
            if time.monotonic() - started > DNS_SLOW:
                self.slow += 1

            return None


# ---------- Проход ----------


def probe(ip, options, dns):
    """Один адрес: None – молчит; иначе наблюдение без MAC из ARP (его допишет collect)."""
    how = []
    netbios = None
    answered = ping(ip)

    if answered:
        how.append("ping")

    if options.get("names") or not answered:
        netbios = nbstat(ip)

        if netbios:
            how.append("netbios")

    if not how and tcp_state(ip, ALIVE_PORT):
        how.append("tcp")

    if not how:
        return None

    data = {"how": how}
    name = None

    if netbios:
        name = netbios["name"]
        data["netbios"] = netbios["name"]
        data["group"] = netbios["group"]

    if options.get("names"):
        data["dns"] = dns.name(ip)

    if options.get("ports"):
        data["ports"] = [port for port in PORTS if tcp_state(ip, port) == "open"]

        if 5900 in data["ports"]:
            data["rfb"] = rfb_version(ip)

    return {"ip": ip, "mac": netbios["mac"] if netbios else None, "name": name, "data": data}


def collect(params, fresh_days=None, progress=None):
    """Пройти адреса подсетей. Ответ: {"items": [{"ip", "mac", "name", "seen_at",
    "data"}], "stats", "warnings"}."""
    subnets = params.get("subnets") or []

    if not subnets:
        raise SourceError("Нет подсетей для сканирования: добавь подсеть и отметь «Сканировать».")

    addresses = targets(subnets)
    total = len(addresses)
    options = {"names": params.get("names", True), "ports": params.get("ports", False)}
    dns = Dns()
    found = {}
    done = 0

    if progress:
        progress(0, total)

    with ThreadPoolExecutor(max_workers=min(WORKERS, max(total, 1)), thread_name_prefix="scan-net") as pool:
        for item in pool.map(lambda ip: (ip, probe(ip, options, dns)), addresses):
            done += 1

            if item[1]:
                found[item[0]] = item[1]

            if progress and (done % 20 == 0 or done == total):
                progress(done, total)

    # MAC из ARP: и у тех, кто промолчал (брандмауэр ARP не скрывает)
    wanted = set(addresses)
    arp = {ip: mac for ip, mac in arp_table().items() if ip in wanted}

    for ip, mac in arp.items():
        item = found.setdefault(ip, {"ip": ip, "mac": None, "name": None, "data": {"how": []}})
        item["data"]["how"].append("arp")
        item["data"]["mac_from"] = "arp"
        item["mac"] = mac

    seen_at = datetime.now(timezone.utc)
    items = []

    for ip in addresses:
        item = found.get(ip)

        if item:
            if item["mac"] and not item["data"].get("mac_from"):
                item["data"]["mac_from"] = "netbios"

            item["seen_at"] = seen_at
            items.append(item)

    warnings = []

    if icmp_socket() is None:
        warnings.append("ping недоступен службе – адреса проверены по NetBIOS, порту 445 и ARP.")

    if options["names"] and dns.slow >= DNS_SLOW_LIMIT:
        warnings.append("DNS не отвечает на запросы имён по адресу – имена только из NetBIOS.")

    stats = {
        "total": total, "alive": len(items), "subnets": len(subnets),
        "mac": sum(1 for i in items if i["mac"]), "names": sum(1 for i in items if i["name"]),
    }
    return {"items": items, "stats": stats, "warnings": warnings}


def check(params):
    subnets = params.get("subnets") or []

    if not subnets:
        raise SourceError("Нет подсетей для сканирования: добавь подсеть и отметь «Сканировать».")

    total = len(targets(subnets))
    sock = icmp_socket()

    if sock is not None:
        sock.close()

    can_arp = os.access(ARP_FILE, os.R_OK)
    parts = [
        "ping – " + ("есть" if sock is not None else "нет (обойдётся NetBIOS и портом 445)"),
        "ARP – " + ("есть" if can_arp else "нет"),
    ]
    return f"Готов: подсетей {len(subnets)}, адресов {total}; " + ", ".join(parts) + "."
