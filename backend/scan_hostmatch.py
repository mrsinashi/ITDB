"""Что сеть знает о ПК таблицы (этап 28): наблюдения DHCP и сетевого прохода
(scan_hosts: адрес — MAC — имя) → предложения MAC, IP и имени.

Чтобы данные чужого устройства не попали ПК:
- по MAC (надёжно): MAC наблюдения записан у одного ПК таблицы — это он. Если его
  видно только на адресах, которых в таблице нет, — предлагается IP; если машина
  называет себя иначе — имя (в таблице пусто — заполнить, иначе только сообщить);
- по IP (слабее): адрес записан у одного ПК, MAC с этого адреса в таблице нет.
  MAC предлагается, если машина на адресе называет себя как ПК (NetBIOS, имя из
  аренды DHCP) или адрес закреплён за MAC в настройках DHCP; имя неизвестно, а
  MAC у ПК пуст — «неточно»; имя другое, MAC чужого ПК или сам ПК виден на другом
  адресе — ничего не предлагается.
Случайные («локально назначенные») и виртуальные MAC не участвуют.
"""
from collections import defaultdict

from scan_match import short_host
from scan_normalize import is_virtual_mac, norm_mac, usable_ipv4

TITLES = {"dhcp": "DHCP", "net": "Сеть"}
# Имя NetBIOS — не длиннее 15 знаков: длинное имя ПК приходит обрезанным
NETBIOS_LEN = 15


def lines(text):
    return [line.strip() for line in str(text or "").splitlines() if line.strip()]


def same_name(table, seen):
    """Одно ли имя: без регистра и домена; имя из сети может быть обрезано до 15 знаков."""
    a, b = short_host(table), short_host(seen)

    if not a or not b:
        return False

    return a == b or (len(b) == NETBIOS_LEN and a.startswith(b))


def source_of(obs, by, value):
    return {
        "source": obs["source"], "title": TITLES.get(obs["source"], obs["source"]), "source_id": None,
        "checked_at": obs["seen_at"], "state": "key", "by": by, "value": value,
    }


def table_owners(computers):
    """(IP ПК, MAC ПК, чей IP, чей MAC) — по таблице; виртуальные MAC ничьи."""
    pc_ips, pc_macs = {}, {}
    ip_owner, mac_owner = defaultdict(set), defaultdict(set)

    for computer_id, values in computers.items():
        ips = {usable_ipv4(line) for line in lines(values.get("ip"))} - {None}
        macs = {norm_mac(line) for line in lines(values.get("mac"))} - {None}
        pc_ips[computer_id], pc_macs[computer_id] = ips, macs

        for ip in ips:
            ip_owner[ip].add(computer_id)

        for mac in macs:
            if not is_virtual_mac(mac):
                mac_owner[mac].add(computer_id)

    return pc_ips, pc_macs, ip_owner, mac_owner


def confirmed(computers, hosts):
    """ПК, которых сеть видит наверняка (этап 28б): {id ПК: [источники]}. По MAC —
    MAC наблюдения записан у одного ПК таблицы; по IP — адрес записан у одного ПК
    и машина на нём называет себя так же, как ПК в таблице."""
    _, _, ip_owner, mac_owner = table_owners(computers)
    result = defaultdict(list)

    for obs in hosts:
        found = None
        mac = obs.get("mac")

        if mac and len(mac_owner.get(mac, ())) == 1:
            found = next(iter(mac_owner[mac]))
        elif len(ip_owner.get(obs["ip"], ())) == 1 and not (mac and mac_owner.get(mac)):
            computer_id = next(iter(ip_owner[obs["ip"]]))

            if obs.get("name") and same_name(computers[computer_id].get("hostname"), obs["name"]):
                found = computer_id

        if found is not None and obs["source"] not in result[found]:
            result[found].append(obs["source"])

    return dict(result)


def host_rows(computers, hosts):
    """computers — {id: {"hostname", "ip", "mac"}} рабочих ПК; hosts — свежие
    наблюдения [{"source", "ip", "mac", "name", "seen_at", "data"}].

    Ответ: (предложения [{"computer_id", "field", "value", "unsure", "source"}],
    что видно в сети у ПК {id: {"ip": [...], "mac": [...], "hostname": [...]}})."""
    pc_ips, pc_macs, ip_owner, mac_owner = table_owners(computers)

    latest_by_mac = {}   # MAC → самое свежее наблюдение (действующая аренда — свежее ушедшей)
    by_ip = defaultdict(list)

    for obs in hosts:
        by_ip[obs["ip"]].append(obs)
        mac = obs.get("mac")

        if mac and (mac not in latest_by_mac or obs["seen_at"] > latest_by_mac[mac]["seen_at"]):
            latest_by_mac[mac] = obs

    proposals = []
    seen = defaultdict(lambda: {"ip": [], "mac": [], "hostname": []})
    moved = set()   # ПК, которых видно только на адресах не из таблицы

    def note(computer_id, field, value):
        if value and value not in seen[computer_id][field]:
            seen[computer_id][field].append(value)

    # --- по MAC ---
    for computer_id, macs in pc_macs.items():
        found = [latest_by_mac[mac] for mac in macs if mac in latest_by_mac and mac_owner.get(mac) == {computer_id}]

        if not found:
            continue

        found.sort(key=lambda obs: obs["seen_at"], reverse=True)

        for obs in found:
            note(computer_id, "ip", obs["ip"])
            note(computer_id, "mac", obs["mac"])
            note(computer_id, "hostname", obs.get("name"))

        ips = sorted({obs["ip"] for obs in found})

        if not pc_ips[computer_id] & set(ips):
            moved.add(computer_id)
            proposals.append({
                "computer_id": computer_id, "field": "ip", "value": "\n".join(ips), "unsure": "",
                "source": source_of(found[0], ["mac"], "\n".join(ips)),
            })

        named = next((obs for obs in found if obs.get("name")), None)
        table_name = computers[computer_id].get("hostname")

        if named and not same_name(table_name, named["name"]):
            proposals.append({
                "computer_id": computer_id, "field": "hostname", "value": named["name"], "unsure": "",
                "source": source_of(named, ["mac"], named["name"]),
            })

    # --- по IP ---
    for ip, owners in ip_owner.items():
        if len(owners) != 1 or ip not in by_ip:
            continue

        computer_id = next(iter(owners))

        if computer_id in moved:
            continue

        table_name = computers[computer_id].get("hostname")

        for obs in sorted(by_ip[ip], key=lambda o: o["seen_at"], reverse=True):
            mac = obs.get("mac")

            if not mac or is_virtual_mac(mac):
                continue

            if mac in pc_macs[computer_id]:
                continue   # уже записан (и учтён выше)

            if mac_owner.get(mac):
                break      # на адресе — другой ПК таблицы

            name = obs.get("name")
            fixed = bool((obs.get("data") or {}).get("fixed"))

            if fixed:
                by, unsure = ["ip", "reserve"], ""
            elif name and same_name(table_name, name):
                by, unsure = ["ip", "name"], ""
            elif name:
                break      # на адресе машина с другим именем
            elif not pc_macs[computer_id]:
                by, unsure = ["ip"], "ПК найден только по IP: имя машины по сети не подтвердилось"
            else:
                continue

            note(computer_id, "mac", mac)
            note(computer_id, "hostname", name)
            proposals.append({
                "computer_id": computer_id, "field": "mac", "value": mac, "unsure": unsure,
                "source": source_of(obs, by, mac),
            })
            break

    return proposals, {computer_id: dict(fields) for computer_id, fields in seen.items()}
