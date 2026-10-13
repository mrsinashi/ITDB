"""Что сеть знает о ПК таблицы (этап 28): наблюдения DHCP и сетевого прохода
(scan_hosts: адрес – MAC – имя) → предложения MAC, IP и имени.

Чтобы данные чужого устройства не попали ПК:
- по MAC (надёжно): MAC наблюдения записан у одного ПК таблицы – это он. Адреса ПК –
  все, где этот MAC виден сейчас (у каждого источника – последний сбор, где он был:
  у ПК бывает несколько адресов в разных подсетях, этап 40). Видно только на
  адресах, которых в таблице нет, – предлагается заменить IP; часть адресов в
  таблице есть – дописать недостающие; если машина называет себя иначе – имя (в
  таблице пусто – заполнить, иначе только сообщить);
- по IP (слабее): адрес записан у одного ПК, MAC с этого адреса в таблице нет.
  MAC предлагается, если машина на адресе называет себя как ПК (NetBIOS, имя из
  аренды DHCP); имя неизвестно, а MAC у ПК пуст – «неточно»; имя другое, MAC
  чужого ПК или сам ПК виден на другом адресе – ничего не предлагается.
Привязки MAC – IP из настроек DHCP (data.fixed) – не наблюдения: адрес на машине
могли поменять вручную. Они слабее всего, что видно на самом деле (этап 28в):
- MAC по привязке предлагается, только если на адресе ПК сеть и аренды никакого MAC
  не показали и MAC привязки нигде больше не виден; уверенно – когда host в
  настройках называется как ПК (или так себя назвала машина на адресе), иначе, при
  пустом MAC в таблице, – «неточно»;
- IP по привязке предлагается только ПК без IP в таблице, всегда «неточно»;
- имя и «проверен сетью» по привязкам не считаются.
Случайные («локально назначенные») и виртуальные MAC не участвуют.
Этап 47: принтерам – MAC по IP (printer_rows).
"""
from collections import defaultdict

from scan_match import short_host
from scan_normalize import is_virtual_mac, norm_mac, usable_ipv4

TITLES = {"dhcp": "DHCP", "net": "Сеть"}
# Имя NetBIOS – не длиннее 15 знаков: длинное имя ПК приходит обрезанным
NETBIOS_LEN = 15


def lines(text):
    return [line.strip() for line in str(text or "").splitlines() if line.strip()]


def same_name(table, seen):
    """Одно ли имя: без регистра и домена; имя из сети может быть обрезано до 15 знаков."""
    a, b = short_host(table), short_host(seen)

    if not a or not b:
        return False

    return a == b or (len(b) == NETBIOS_LEN and a.startswith(b))


def ip_order(ip):
    """Адреса по порядку чисел: 10.0.5.9 раньше 10.0.5.10."""
    parts = str(ip).split(".")
    return [int(part) for part in parts] if all(part.isdigit() for part in parts) else [999, str(ip)]


def is_fixed(obs):
    """Привязка из настроек DHCP, а не наблюдение."""
    return bool((obs.get("data") or {}).get("fixed"))


def source_of(obs, by, value):
    return {
        "source": obs["source"], "title": TITLES.get(obs["source"], obs["source"]), "source_id": None,
        "checked_at": obs["seen_at"], "state": "key", "by": by, "value": value,
    }


def table_owners(computers):
    """(IP ПК, MAC ПК, чей IP, чей MAC) – по таблице; виртуальные MAC ничьи."""
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
    """ПК, которых сеть видит наверняка (этап 28б): {id ПК: [источники]}. По MAC –
    MAC наблюдения записан у одного ПК таблицы; по IP – адрес записан у одного ПК
    и машина на нём называет себя так же, как ПК в таблице."""
    _, _, ip_owner, mac_owner = table_owners(computers)
    result = defaultdict(list)

    for obs in hosts:
        if is_fixed(obs):
            continue   # привязка в настройках не значит, что машину видно в сети

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


class Net:
    """Наблюдения сети, разложенные для host_rows."""

    def __init__(self, hosts):
        self.latest_by_mac = {}   # MAC → самое свежее наблюдение (действующая аренда – свежее ушедшей)
        self.by_ip = defaultdict(list)
        self.fixed_by_ip = {}     # адрес → привязка из настроек DHCP
        self.fixed_by_mac = defaultdict(list)
        by_mac_source = defaultdict(list)

        for obs in hosts:
            if is_fixed(obs):
                self.fixed_by_ip[obs["ip"]] = obs

                if obs.get("mac"):
                    self.fixed_by_mac[obs["mac"]].append(obs)

                continue

            self.by_ip[obs["ip"]].append(obs)
            mac = obs.get("mac")

            if mac:
                by_mac_source[(mac, obs["source"])].append(obs)

                if mac not in self.latest_by_mac or obs["seen_at"] > self.latest_by_mac[mac]["seen_at"]:
                    self.latest_by_mac[mac] = obs

        # Где MAC виден сейчас (этап 40): у каждого источника – адреса его последнего сбора с
        # этим MAC (проход подсетей – одно время у всех адресов, действующие аренды – время
        # сбора). Прежний адрес после смены аренды или переезда – давнее, не в счёт
        self.current_by_mac = defaultdict(list)

        for (mac, _), found in by_mac_source.items():
            last = max(obs["seen_at"] for obs in found)
            self.current_by_mac[mac].extend(obs for obs in found if obs["seen_at"] == last)


def note_seen(seen, computer_id, field, value):
    """Что видно в сети у ПК: значение – в список поля, без повторов."""
    if value and value not in seen[computer_id][field]:
        seen[computer_id][field].append(value)


def mac_rows(computers, table, net, seen, proposals):
    """По MAC: IP (заменить или дописать) и имя. Ответ – ПК, которых видно только на
    адресах не из таблицы."""
    pc_ips, pc_macs, _, mac_owner = table
    moved = set()

    for computer_id, macs in pc_macs.items():
        found = [
            obs for mac in macs if mac in net.latest_by_mac and mac_owner.get(mac) == {computer_id}
            for obs in net.current_by_mac[mac]
        ]

        if not found:
            continue

        found.sort(key=lambda obs: obs["seen_at"], reverse=True)

        for obs in found:
            note_seen(seen, computer_id, "ip", obs["ip"])
            note_seen(seen, computer_id, "mac", obs["mac"])
            note_seen(seen, computer_id, "hostname", obs.get("name"))

        ips = sorted({obs["ip"] for obs in found}, key=ip_order)
        new = [ip for ip in ips if ip not in pc_ips[computer_id]]

        if new:
            if pc_ips[computer_id] & set(ips):
                # Часть адресов в таблице есть – дописать недостающие, записанные не убирать
                value = "\n".join(lines(computers[computer_id].get("ip")) + new)
            else:
                moved.add(computer_id)
                value = "\n".join(ips)

            proposals.append({
                "computer_id": computer_id, "field": "ip", "value": value, "unsure": "",
                "source": source_of(found[0], ["mac"], "\n".join(ips)),
            })

        named = next((obs for obs in found if obs.get("name")), None)
        table_name = computers[computer_id].get("hostname")

        if named and not same_name(table_name, named["name"]):
            proposals.append({
                "computer_id": computer_id, "field": "hostname", "value": named["name"], "unsure": "",
                "source": source_of(named, ["mac"], named["name"]),
            })

    return moved


def reserve_ip_rows(table, net, proposals):
    """По MAC, только из настроек DHCP: адрес – лишь ПК без IP в таблице."""
    pc_ips, pc_macs, ip_owner, mac_owner = table

    for computer_id, macs in pc_macs.items():
        if pc_ips[computer_id] or any(mac in net.latest_by_mac for mac in macs):
            continue   # IP в таблице есть (мог быть задан вручную) или ПК виден в сети

        found = [
            obs for mac in macs if mac_owner.get(mac) == {computer_id} and not is_virtual_mac(mac)
            for obs in net.fixed_by_mac.get(mac, []) if not ip_owner.get(obs["ip"])
        ]

        if found:
            ips = sorted({obs["ip"] for obs in found})
            proposals.append({
                "computer_id": computer_id, "field": "ip", "value": "\n".join(ips),
                "unsure": "IP из настроек DHCP: в сети ПК на нём не виден",
                "source": source_of(found[0], ["mac", "reserve"], "\n".join(ips)),
            })


def ip_mac_row(computer_id, table_name, pc_macs, mac_owner, real, seen):
    """По IP: MAC, который видно на адресе ПК (real – наблюдения, свежие первыми), –
    предложение или None."""
    for obs in real:
        mac = obs.get("mac")

        if not mac or is_virtual_mac(mac):
            continue

        if mac in pc_macs[computer_id]:
            continue   # уже записан (и учтён выше)

        if mac_owner.get(mac):
            return None   # на адресе – другой ПК таблицы

        name = obs.get("name")

        if name and same_name(table_name, name):
            by, unsure = ["ip", "name"], ""
        elif name:
            return None   # на адресе машина с другим именем
        elif not pc_macs[computer_id]:
            by, unsure = ["ip"], "ПК найден только по IP: имя машины по сети не подтвердилось"
        else:
            continue

        note_seen(seen, computer_id, "mac", mac)
        note_seen(seen, computer_id, "hostname", name)
        return {
            "computer_id": computer_id, "field": "mac", "value": mac, "unsure": unsure,
            "source": source_of(obs, by, mac),
        }

    return None


def reserve_mac_row(computer_id, table_name, pc_macs, mac_owner, net, obs, real):
    """По IP: MAC привязки из настроек DHCP (obs) – когда на адресе никакого MAC на самом
    деле не видно. Предложение или None."""
    if obs is None or any(o.get("mac") for o in real):
        return None

    mac = obs.get("mac")

    if not mac or is_virtual_mac(mac) or mac in pc_macs[computer_id] or mac_owner.get(mac) or mac in net.latest_by_mac:
        return None   # уже записан, MAC другого ПК или машина с ним видна на другом адресе

    names = [o["name"] for o in real if o.get("name")]

    if names and not any(same_name(table_name, name) for name in names):
        return None   # на адресе машина с другим именем

    if names or same_name(table_name, (obs.get("data") or {}).get("host")):
        unsure = ""
    elif not pc_macs[computer_id]:
        unsure = "MAC из настроек DHCP: в сети не подтвердился"
    else:
        return None

    return {
        "computer_id": computer_id, "field": "mac", "value": mac, "unsure": unsure,
        "source": source_of(obs, ["ip", "reserve"], mac),
    }


def ip_rows(computers, table, net, moved, seen, proposals):
    """По IP: MAC, который видно на адресе ПК, а если никакого не видно – из привязки."""
    _, pc_macs, ip_owner, mac_owner = table

    for ip, owners in ip_owner.items():
        if len(owners) != 1 or (ip not in net.by_ip and ip not in net.fixed_by_ip):
            continue

        computer_id = next(iter(owners))

        if computer_id in moved:
            continue

        table_name = computers[computer_id].get("hostname")
        real = sorted(net.by_ip.get(ip, []), key=lambda o: o["seen_at"], reverse=True)

        for row in (
            ip_mac_row(computer_id, table_name, pc_macs, mac_owner, real, seen),
            reserve_mac_row(computer_id, table_name, pc_macs, mac_owner, net, net.fixed_by_ip.get(ip), real),
        ):
            if row:
                proposals.append(row)


def host_rows(computers, hosts):
    """computers – {id: {"hostname", "ip", "mac"}} рабочих ПК; hosts – свежие
    наблюдения [{"source", "ip", "mac", "name", "seen_at", "data"}].

    Ответ: (предложения [{"computer_id", "field", "value", "unsure", "source"}],
    что видно в сети у ПК {id: {"ip": [...], "mac": [...], "hostname": [...]}})."""
    table = table_owners(computers)
    net = Net(hosts)
    proposals = []
    seen = defaultdict(lambda: {"ip": [], "mac": [], "hostname": []})

    moved = mac_rows(computers, table, net, seen, proposals)
    reserve_ip_rows(table, net, proposals)
    ip_rows(computers, table, net, moved, seen, proposals)

    return proposals, {computer_id: dict(fields) for computer_id, fields in seen.items()}


def printer_rows(printers, computers, hosts):
    """MAC принтеров по IP (этап 47): printers – {id: {"ip", "mac"}} рабочих принтеров,
    computers – так же ПК (чужие адреса и MAC), hosts – свежие наблюдения.

    Принтер в сети себя ПК-именем не называет, поэтому его узнают только по адресу:
    адрес записан у одного принтера и ни у одного ПК – MAC, который на нём видно (самый
    свежий), предлагается принтеру. Не видно никакого – MAC привязки из настроек DHCP,
    если этот MAC не виден на другом адресе. MAC уже записан у принтера, принадлежит
    ПК или другому принтеру таблицы – ничего не предлагается.

    Ответ: [{"printer_id", "field": "mac", "value", "unsure", "source"}]."""
    _, _, pc_ip_owner, pc_mac_owner = table_owners(computers)
    _, pr_macs, pr_ip_owner, pr_mac_owner = table_owners(printers)

    by_ip = defaultdict(list)
    fixed_by_ip = {}
    seen_at_ips = defaultdict(set)   # MAC → адреса, где его видно на самом деле

    for obs in hosts:
        if is_fixed(obs):
            fixed_by_ip[obs["ip"]] = obs
            continue

        by_ip[obs["ip"]].append(obs)

        if obs.get("mac"):
            seen_at_ips[obs["mac"]].add(obs["ip"])

    proposals = []

    for ip, owners in sorted(pr_ip_owner.items(), key=lambda item: ip_order(item[0])):
        if len(owners) != 1 or pc_ip_owner.get(ip):
            continue   # адрес у двух принтеров или у ПК – чей на нём MAC, не понять

        printer_id = next(iter(owners))
        real = [
            obs for obs in sorted(by_ip.get(ip, []), key=lambda o: o["seen_at"], reverse=True)
            if obs.get("mac") and not is_virtual_mac(obs["mac"])
        ]

        if real:
            obs, by = real[0], ["ip"]
        else:
            obs, by = fixed_by_ip.get(ip), ["ip", "reserve"]

            if obs is None or not obs.get("mac") or is_virtual_mac(obs["mac"]) or seen_at_ips.get(obs["mac"], set()) - {ip}:
                continue

        mac = obs["mac"]

        if mac in pr_macs[printer_id] or pc_mac_owner.get(mac) or pr_mac_owner.get(mac, set()) - {printer_id}:
            continue

        proposals.append({
            "printer_id": printer_id, "field": "mac", "value": mac, "unsure": "",
            "source": source_of(obs, by, mac),
        })

    return proposals
