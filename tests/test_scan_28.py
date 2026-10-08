"""Этап 28: DHCP по SSH (файл аренд, ключ ITDB), сеть (проход подсетей),
предложения MAC / IP / имени из сети, расписание сборов.

Сервер SSH изображает paramiko в этом же процессе – как старый OpenSSH: о
подписях не сообщает, по ключу выполняет только свою команду."""
import socket
import threading
import time
from datetime import datetime, timedelta, timezone

import paramiko
import pytest

import scan_collect
import scan_dhcp
import scan_net
import scan_schedule
import scan_ssh
from conftest import ok
from db import SessionLocal
from models import ScanHost
from scan_hostmatch import confirmed, host_rows, same_name
from scan_http import SourceError
from test_scan_collect import add_pc, collect, secret_key  # noqa: F401

UTC = timezone.utc
NOW = datetime.now(UTC)


def stamp(moment):
    return moment.strftime("%w %Y/%m/%d %H:%M:%S")


def lease(ip, mac, name=None, state="active", ends=None, starts=None):
    lines = [
        f"lease {ip} {{",
        f"  starts {stamp(starts or NOW - timedelta(hours=1))};",
        f"  ends {stamp(ends or NOW + timedelta(days=1))};",
        f"  binding state {state};",
        f"  hardware ethernet {mac};",
        '  uid "\\001\\330}\\212";',
    ]

    if name:
        lines.append(f'  client-hostname "{name}";')

    return "\n".join(lines + ["}"])


LEASES = "\n".join([
    "# dhcpd.leases",
    'server-duid "\\000\\001";',
    lease("10.0.5.11", "d8:cb:8a:00:00:11", "OLD-NAME", ends=NOW - timedelta(days=2), state="free"),
    lease("10.0.5.11", "d8:cb:8a:00:00:11", "pc-1.corp.lan"),
    lease("10.0.5.12", "d8:cb:8a:00:00:12", "pc-2", state="free", ends=NOW - timedelta(days=40), starts=NOW - timedelta(days=41)),
    lease("10.0.5.13", "d8:cb:8a:00:00:13", state="free", ends=NOW - timedelta(days=3), starts=NOW - timedelta(days=4)),
    "host printer-1 { hardware ethernet 00:1b:a9:00:00:01; fixed-address 10.0.5.200; }",
    "host two {\n  hardware ethernet 00:1b:a9:00:00:02;\n  fixed-address 10.0.5.201, 10.0.5.202;\n}",
])


# ---------- Файл аренд ----------


def test_parse_leases():
    leases, hosts = scan_dhcp.parse(LEASES)
    assert set(leases) == {"10.0.5.11", "10.0.5.12", "10.0.5.13"}
    # У адреса действует последняя запись в файле
    assert leases["10.0.5.11"]["name"] == "pc-1.corp.lan" and leases["10.0.5.11"]["state"] == "active"
    assert leases["10.0.5.11"]["mac"] == "D8:CB:8A:00:00:11"
    assert leases["10.0.5.13"]["name"] is None
    assert [(h["ip"], h["mac"], h["name"]) for h in hosts] == [
        ("10.0.5.200", "00:1B:A9:00:00:01", "printer-1"),
        ("10.0.5.201", "00:1B:A9:00:00:02", "two"),
        ("10.0.5.202", "00:1B:A9:00:00:02", "two"),
    ]
    assert scan_dhcp.lease_time("epoch 1790843553; # Fri").year == 2026
    assert scan_dhcp.lease_time("never") is None


def test_build_fresh_only():
    items, stats = scan_dhcp.build(LEASES, 30)
    by_ip = {item["ip"]: item for item in items}
    # Аренда, кончившаяся 40 дней назад, тоже сохраняется (этап 31: давнее не удаляется,
    # а помечается) – «свежей» не считается
    assert set(by_ip) == {"10.0.5.11", "10.0.5.12", "10.0.5.13", "10.0.5.200", "10.0.5.201", "10.0.5.202"}
    assert by_ip["10.0.5.12"]["seen_at"] < NOW - timedelta(days=39) and by_ip["10.0.5.12"]["data"]["active"] is False
    assert stats == {"total": 6, "fresh": 5, "active": 1, "stale": 1, "fixed": 3, "no_mac": 0}
    assert by_ip["10.0.5.11"]["data"]["active"] is True and "source" not in by_ip["10.0.5.11"]
    assert by_ip["10.0.5.200"]["data"] == {"fixed": True, "host": "printer-1"} and by_ip["10.0.5.200"]["name"] is None
    # Привязка из настроек – строкой своего вида, отдельно от аренд
    assert by_ip["10.0.5.200"]["source"] == scan_dhcp.CONF_SOURCE
    items, stats = scan_dhcp.build(LEASES, 2)
    assert len(items) == 6 and stats["fresh"] == 4 and stats["stale"] == 2


def test_build_lease_and_binding_on_one_address():
    """На адресе и аренда, и привязка из файла настроек – остаются обе; файл привязки запоминается."""
    conf = "subnet 10.0.5.0 netmask 255.255.255.0 {\n  host pc-1 { hardware ethernet d8:cb:8a:00:00:aa; fixed-address 10.0.5.11; }\n}"
    items, stats = scan_dhcp.build([("/var/lib/dhcpd/dhcpd.leases", LEASES), ("/etc/dhcp/sub5.conf", conf)], 30)
    on_address = [item for item in items if item["ip"] == "10.0.5.11"]
    assert [(item.get("source"), item["mac"]) for item in on_address] == [
        (None, "D8:CB:8A:00:00:11"), (scan_dhcp.CONF_SOURCE, "D8:CB:8A:00:00:AA"),
    ]
    assert on_address[1]["data"] == {"fixed": True, "host": "pc-1", "file": "/etc/dhcp/sub5.conf"}
    assert stats["fixed"] == 4 and stats["total"] == 7


def test_read_command_and_split_files():
    command = scan_ssh.read_command(["/a/leases", "/b/c.conf"])
    assert command == "echo; echo '#ITDB-FILE /a/leases'; cat -- /a/leases; echo; echo '#ITDB-FILE /b/c.conf'; cat -- /b/c.conf"
    out = "\n#ITDB-FILE /a/leases\nlease 1\nno newline\n#ITDB-FILE /b/c.conf\nhost x {}\n"
    assert scan_ssh.split_files(out) == [("/a/leases", "lease 1\nno newline\n"), ("/b/c.conf", "host x {}\n")]
    # Ключ на сервере – с прежней командой «cat»: меток нет
    assert scan_ssh.split_files("lease 1\n") == [(None, "lease 1\n")]
    assert scan_ssh.all_paths({"path": "/a/leases", "configs": ["/b/c.conf", " ", "/b/c.conf", "/d"]}) == ["/a/leases", "/b/c.conf", "/d"]

    with pytest.raises(SourceError):
        scan_ssh.config_paths(["etc/dhcpd.conf"])


def test_ssh_address_and_paths():
    assert scan_ssh.split_host("dhcp.lan") == ("dhcp.lan", 22)
    assert scan_ssh.split_host("ssh://root@10.0.0.5:2222/") == ("10.0.0.5", 2222)
    assert scan_ssh.clean_address("10.0.0.5:22") == "10.0.0.5"

    for bad in ("", "a b", "host:port"):
        with pytest.raises(SourceError):
            scan_ssh.split_host(bad)

    assert scan_ssh.split_paths("/var/lib/dhcpd/dhcpd.leases  /etc/dhcp/dhcpd.conf") == [
        "/var/lib/dhcpd/dhcpd.leases", "/etc/dhcp/dhcpd.conf",
    ]

    for bad in ("", "dhcpd.leases", "/tmp/a;rm", "/tmp/$(id)", "/tmp/../etc/shadow", "/tmp/a'b"):
        with pytest.raises(SourceError):
            scan_ssh.split_paths(bad)


# ---------- Поддельный сервер SSH ----------


OLD_SERVER = {"pubkeys": ["rsa-sha2-512", "rsa-sha2-256"], "keys": ["rsa-sha2-512", "rsa-sha2-256"]}


class Ssh:
    password = "pw"
    files = {}
    authorized = []     # строки authorized_keys
    commands = []
    host_key = paramiko.RSAKey.generate(2048)


class FakeSsh(paramiko.ServerInterface):
    def __init__(self):
        self.by_key = False

    def get_allowed_auths(self, username):
        return "publickey,password"

    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if (username, password) == ("itdbscan", Ssh.password) else paramiko.AUTH_FAILED

    def check_auth_publickey(self, username, key):
        blob = key.get_base64()

        if username == "itdbscan" and any(blob in line for line in Ssh.authorized):
            self.by_key = True
            return paramiko.AUTH_SUCCESSFUL

        return paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED

    def check_channel_exec_request(self, channel, command):
        threading.Thread(target=self.execute, args=(channel, command.decode()), daemon=True).start()
        return True

    def execute(self, channel, command):
        time.sleep(0.05)   # сначала клиенту уходит «команда принята»
        Ssh.commands.append(command)
        out, err, code = b"", b"", 0

        if self.by_key:
            # Ключ с command="…": что бы ни просили, выполняется команда из authorized_keys
            command = next(line for line in Ssh.authorized).split('"')[1]

        if "cat -- " in command and "authorized_keys" not in command:
            # «echo; echo '#ITDB-FILE путь'; cat -- путь; …» (или прежнее «cat -- a b»)
            for step in command.split(";"):
                step = step.strip()

                if step == "echo":
                    out += b"\n"
                elif step.startswith("echo "):
                    out += step[len("echo "):].strip("'").encode() + b"\n"
                elif step.startswith("cat -- "):
                    for path in step[len("cat -- "):].split():
                        if path in Ssh.files:
                            out += Ssh.files[path].encode()
                            code = 0
                        else:
                            err, code = f"cat: {path}: No such file or directory".encode(), 1
        elif "authorized_keys" in command:
            data = b""

            while not data.endswith(b"\n"):
                chunk = channel.recv(4096)

                if not chunk:
                    break

                data += chunk

            Ssh.authorized = [line for line in Ssh.authorized if not line.endswith(" itdb")] + [data.decode().strip()]
        else:
            err, code = b"unknown command", 127

        channel.sendall(out)
        channel.sendall_stderr(err)
        channel.send_exit_status(code)
        channel.close()


@pytest.fixture(scope="module")
def ssh_port():
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(20)
    transports = []

    def serve():
        while True:
            try:
                client, _ = listener.accept()
            except OSError:
                return

            # Как OpenSSH 5.3: о подписях не сообщает и подписи rsa-sha2 не принимает
            transport = paramiko.Transport(client, server_sig_algs=False, disabled_algorithms=OLD_SERVER)
            transports.append(transport)   # иначе соединение закроет сборщик мусора
            transport.add_server_key(Ssh.host_key)

            try:
                transport.start_server(server=FakeSsh())
            except Exception:  # noqa: BLE001 – клиент оборвал соединение
                pass

    threading.Thread(target=serve, daemon=True).start()
    yield listener.getsockname()[1]
    listener.close()


@pytest.fixture(autouse=True)
def reset_ssh():
    Ssh.password = "pw"
    Ssh.files = {scan_dhcp.DEFAULT_PATH: LEASES}
    Ssh.authorized = []
    Ssh.commands = []


def source(admin, kind):
    return next(s for s in ok(admin.get("/api/scan/sources"))["sources"] if s["kind"] == kind)


def setup_dhcp(admin, port, **more):
    body = dict({"url": f"127.0.0.1:{port}", "login": "itdbscan", "password": "pw", "enabled": True}, **more)
    return ok(admin.patch("/api/scan/sources/dhcp", json=body))


def hosts(kind):
    session = SessionLocal()

    try:
        return {row.ip: row for row in session.query(ScanHost).filter(ScanHost.source == kind)}
    finally:
        session.close()


def all_hosts():
    session = SessionLocal()

    try:
        return session.query(ScanHost).all()
    finally:
        session.close()


def diffs_of(client):
    data = ok(client.get("/api/scan/diffs"))
    return data, {(d["computer_id"], d["field"]): d for d in data["items"]}


# ---------- DHCP: подключение, ключ, сбор ----------


def test_dhcp_source_form(admin, editor, ssh_port):
    saved = source(admin, "dhcp")
    assert saved["form"] == "ssh" and saved["path"] == scan_dhcp.DEFAULT_PATH and saved["fresh_days"] == 30
    assert saved["ready"] is False and saved["has_key"] is False and saved["host_key"] is None

    assert admin.patch("/api/scan/sources/dhcp", json={"path": "dhcpd.leases"}).status_code == 400
    assert admin.patch("/api/scan/sources/dhcp", json={"url": "a b"}).status_code == 400
    assert admin.patch("/api/scan/sources/dhcp", json={"fresh_days": 366}).status_code == 400
    saved = setup_dhcp(admin, ssh_port, fresh_days=10)
    assert saved["ready"] and saved["url"] == f"127.0.0.1:{ssh_port}" and saved["secrets"] == {"password": True}
    assert editor.post("/api/scan/sources/dhcp/key").status_code == 403
    assert admin.post("/api/scan/sources/glpi/key").status_code == 404


def test_dhcp_check_pins_host_key(admin, ssh_port):
    setup_dhcp(admin, ssh_port)
    result = ok(admin.post("/api/scan/sources/dhcp/check"))
    assert result["ok"] and result["saved"], result
    assert "вход по паролю" in result["message"] and "аренд 3" in result["message"] and "привязок 3" in result["message"]
    pinned = source(admin, "dhcp")["host_key"]
    assert pinned.startswith("SHA256:")

    # Сервер предъявил другой ключ – отказ, пока отпечаток не забыт
    old, Ssh.host_key = Ssh.host_key, paramiko.RSAKey.generate(2048)

    try:
        result = ok(admin.post("/api/scan/sources/dhcp/check"))
        assert not result["ok"] and "изменился" in result["message"]
        saved = ok(admin.patch("/api/scan/sources/dhcp", json={"forget_host": True}))
        assert saved["host_key"] is None
        assert ok(admin.post("/api/scan/sources/dhcp/check"))["ok"]
        assert source(admin, "dhcp")["host_key"] != pinned
    finally:
        Ssh.host_key = old

    # Неверный пароль и нет файла – понятные ошибки
    ok(admin.patch("/api/scan/sources/dhcp", json={"forget_host": True}))
    result = ok(admin.post("/api/scan/sources/dhcp/check", json={"password": "bad"}))
    assert not result["ok"] and "неверный логин или пароль" in result["message"] and not result["saved"]
    result = ok(admin.post("/api/scan/sources/dhcp/check", json={"path": "/var/none", "forget_host": True}))
    assert not result["ok"] and "No such file" in result["message"]


def test_dhcp_key_install_and_collect(admin, editor, room, ssh_port):
    setup_dhcp(admin, ssh_port)
    key = ok(admin.post("/api/scan/sources/dhcp/key"))
    assert key["created"] and key["public"].startswith("ssh-rsa ") and key["public"].endswith(" itdb")
    leases = scan_dhcp.DEFAULT_PATH
    assert key["line"].startswith(f"command=\"echo; echo '#ITDB-FILE {leases}'; cat -- {leases}\",no-pty,")
    again = ok(admin.post("/api/scan/sources/dhcp/key", json={"path": "/a/b /c", "configs": ["/d"]}))
    assert not again["created"] and again["public"] == key["public"]
    assert all(f"cat -- {path}" in again["line"] for path in ("/a/b", "/c", "/d"))

    # Без пароля ключ не поставить
    ok(admin.patch("/api/scan/sources/dhcp", json={"password": ""}))
    result = ok(admin.post("/api/scan/sources/dhcp/key/install"))
    assert not result["ok"] and "пароль" in result["message"]

    result = ok(admin.post("/api/scan/sources/dhcp/key/install", json={"password": "pw"}))
    assert result["ok"], result
    assert Ssh.authorized == [key["line"]]
    assert result["source"]["has_key"] and result["source"]["host_key"]

    # Дальше – по ключу, пароль не хранится; старый сервер подписи rsa-sha2 не знает
    result = ok(admin.post("/api/scan/sources/dhcp/check"))
    assert result["ok"] and "вход по ключу" in result["message"], result

    first = add_pc(editor, room["room"], "pc-1", ip="10.0.5.11")
    run = collect(admin, "dhcp")
    assert run["status"] == "ok", run
    assert run["stats"]["fresh"] == 5 and run["stats"]["active"] == 1 and run["stats"]["fresh_days"] == 30
    assert run["message"] is None
    saved = hosts("dhcp")
    assert saved["10.0.5.11"].mac == "D8:CB:8A:00:00:11" and saved["10.0.5.11"].name == "pc-1.corp.lan"

    data, diffs = diffs_of(editor)
    assert "dhcp" in data["sources"]
    diff = diffs[(first, "mac")]
    assert diff["kind"] == "fill" and diff["proposed"] == "D8:CB:8A:00:00:11"
    assert diff["sources"][0]["title"] == "DHCP" and diff["sources"][0]["by"] == ["ip", "name"]
    assert data["net"][str(first)]["mac"] == ["D8:CB:8A:00:00:11"]

    ok(editor.post("/api/scan/diffs/accept", json={"items": [
        {"computer_id": first, "field": "mac", "value": diff["proposed"], "table": "", "source": "DHCP"},
    ]}))
    _, diffs = diffs_of(editor)
    assert (first, "mac") not in diffs

    # Давняя аренда сохранена, но в предложения не идёт; в «Сети» она помечена
    assert set(saved) == {"10.0.5.11", "10.0.5.12", "10.0.5.13"}
    second = add_pc(editor, room["room"], "pc-2", ip="10.0.5.12")
    _, diffs = diffs_of(editor)
    assert (second, "mac") not in diffs
    page = {h["ip"]: h for h in ok(editor.get("/api/scan/hosts"))["hosts"]}
    assert page["10.0.5.12"]["stale"] and page["10.0.5.12"]["dhcp"]["stale"] and page["10.0.5.12"]["mac"][0]["stale"]
    assert not page["10.0.5.11"]["stale"] and not page["10.0.5.200"]["stale"]

    # Файл сменился – прежние аренды не удаляются (этап 31), но уже не действуют;
    # привязки из настроек – копия файла; сбой – всё остаётся как было
    Ssh.files = {scan_dhcp.DEFAULT_PATH: lease("10.0.5.50", "d8:cb:8a:00:00:50", "pc-50")}
    assert collect(admin, "dhcp")["status"] == "ok"
    saved = hosts("dhcp")
    assert set(saved) == {"10.0.5.11", "10.0.5.12", "10.0.5.13", "10.0.5.50"}
    assert saved["10.0.5.11"].data["active"] is False and saved["10.0.5.11"].data["gone"] is True
    assert saved["10.0.5.11"].mac == "D8:CB:8A:00:00:11" and saved["10.0.5.50"].data["active"] is True
    assert hosts(scan_dhcp.CONF_SOURCE) == {}
    Ssh.files = {}
    run = collect(admin, "dhcp")
    assert run["status"] == "error" and "не прочитать" in run["message"]
    assert set(hosts("dhcp")) == {"10.0.5.11", "10.0.5.12", "10.0.5.13", "10.0.5.50"}


# ---------- Что сеть знает о ПК ----------


def obs(ip, mac=None, name=None, source="dhcp", days=0, **data):
    return {"source": source, "ip": ip, "mac": mac, "name": name, "seen_at": NOW - timedelta(days=days), "data": data}


def test_same_name():
    assert same_name("PC-1", "pc-1.corp.lan") and same_name("glaz-kdp-hall-12", "GLAZ-KDP-HALL-1")
    assert not same_name("pc-1", "pc-10") and not same_name("", "pc") and not same_name("pc", None)


def test_host_rows():
    computers = {
        1: {"hostname": "pc-1", "ip": "10.0.5.11", "mac": ""},                    # имя подтвердилось
        2: {"hostname": "pc-2", "ip": "10.0.5.12", "mac": ""},                    # на адресе – другое имя
        3: {"hostname": "pc-3", "ip": "10.0.5.13", "mac": ""},                    # имя неизвестно
        4: {"hostname": "pc-4", "ip": "10.0.5.14", "mac": "D8:CB:8A:00:00:14"},   # переехал на другой адрес
        5: {"hostname": "pc-5", "ip": "10.0.5.15", "mac": "D8:CB:8A:00:00:15"},   # всё совпадает, имя другое
        6: {"hostname": "pc-6", "ip": "10.0.5.16", "mac": "D8:CB:8A:00:00:16"},   # на адресе – MAC ПК 4
        7: {"hostname": "pc-7", "ip": "10.0.5.17", "mac": "D8:CB:8A:00:00:17"},   # привязка: другой MAC, в сети не виден
        8: {"hostname": "pc-8", "ip": "10.0.5.18", "mac": "D8:CB:8A:00:00:18"},   # имя неизвестно, MAC есть
        9: {"hostname": "", "ip": "10.0.5.19", "mac": "D8:CB:8A:00:00:19"},       # имени в таблице нет
    }
    seen = [
        obs("10.0.5.11", "D8:CB:8A:00:00:11", "PC-1"),
        obs("10.0.5.12", "D8:CB:8A:00:00:12", "other"),
        obs("10.0.5.13", "D8:CB:8A:00:00:13", source="net"),
        obs("10.0.5.16", "D8:CB:8A:00:00:14", "pc-4"),
        obs("10.0.5.14", "D8:CB:8A:00:00:14", "pc-4", days=3),
        obs("10.0.5.15", "D8:CB:8A:00:00:15", "DESKTOP-5"),
        obs("10.0.5.17", "D8:CB:8A:00:00:77", fixed=True),
        obs("10.0.5.18", "D8:CB:8A:00:00:88", source="net"),
        obs("10.0.5.19", "D8:CB:8A:00:00:19", "pc-9"),
        obs("10.0.5.99", "02:00:00:00:00:01", "phone"),
    ]
    proposals, net = host_rows(computers, seen)
    got = {(p["computer_id"], p["field"]): p for p in proposals}
    assert set(got) == {(1, "mac"), (3, "mac"), (4, "ip"), (5, "hostname"), (9, "hostname")}
    assert got[(1, "mac")]["value"] == "D8:CB:8A:00:00:11" and got[(1, "mac")]["source"]["by"] == ["ip", "name"]
    assert got[(3, "mac")]["unsure"] and got[(3, "mac")]["source"]["title"] == "Сеть"
    assert got[(4, "ip")]["value"] == "10.0.5.16" and got[(4, "ip")]["source"]["by"] == ["mac"]
    assert got[(5, "hostname")]["value"] == "DESKTOP-5"
    assert got[(9, "hostname")]["value"] == "pc-9"
    assert net[4]["ip"] == ["10.0.5.16"] and net[5]["hostname"] == ["DESKTOP-5"]


def test_host_rows_bindings_are_weakest():
    """Привязка MAC – IP из настроек DHCP слабее всего, что видно на самом деле (этап 28в)."""
    computers = {
        1: {"hostname": "pc-1", "ip": "10.0.5.11", "mac": ""},                    # host называется как ПК
        2: {"hostname": "pc-2", "ip": "10.0.5.12", "mac": ""},                    # host называется иначе
        3: {"hostname": "pc-3", "ip": "10.0.5.13", "mac": "D8:CB:8A:00:00:13"},   # MAC уже есть, host иначе
        4: {"hostname": "pc-4", "ip": "10.0.5.14", "mac": ""},                    # на адресе виден другой MAC
        5: {"hostname": "pc-5", "ip": "10.0.5.15", "mac": ""},                    # MAC привязки виден на другом адресе
        6: {"hostname": "pc-6", "ip": "", "mac": "D8:CB:8A:00:00:66"},            # IP в таблице пуст
        7: {"hostname": "pc-7", "ip": "10.0.5.77", "mac": "D8:CB:8A:00:00:67"},   # IP задан вручную – другой
        8: {"hostname": "pc-8", "ip": "10.0.5.18", "mac": ""},                    # имя на адресе подтвердилось, MAC – из привязки
    }
    seen = [
        obs("10.0.5.11", "D8:CB:8A:00:0A:11", fixed=True, host="PC-1"),
        obs("10.0.5.12", "D8:CB:8A:00:0A:12", fixed=True, host="buh"),
        obs("10.0.5.13", "D8:CB:8A:00:0A:13", fixed=True, host="x"),
        obs("10.0.5.14", "D8:CB:8A:00:0A:14", fixed=True, host="pc-4"),
        obs("10.0.5.14", "D8:CB:8A:00:0B:14", source="net"),
        obs("10.0.5.15", "D8:CB:8A:00:0A:15", fixed=True, host="pc-5"),
        obs("10.0.5.99", "D8:CB:8A:00:0A:15", source="net"),
        obs("10.0.5.16", "D8:CB:8A:00:00:66", fixed=True, host="pc-6"),
        obs("10.0.5.17", "D8:CB:8A:00:00:67", fixed=True, host="pc-7"),
        obs("10.0.5.18", "D8:CB:8A:00:0A:18", fixed=True, host="x"),
        obs("10.0.5.18", None, "PC-8", source="net"),
    ]
    proposals, _ = host_rows(computers, seen)
    got = {(p["computer_id"], p["field"]): p for p in proposals}
    assert set(got) == {(1, "mac"), (2, "mac"), (4, "mac"), (6, "ip"), (8, "mac")}
    assert got[(1, "mac")]["source"]["by"] == ["ip", "reserve"] and not got[(1, "mac")]["unsure"]
    assert got[(2, "mac")]["unsure"] and got[(2, "mac")]["value"] == "D8:CB:8A:00:0A:12"
    # На адресе виден настоящий MAC – предлагается он, а не привязка
    assert got[(4, "mac")]["value"] == "D8:CB:8A:00:0B:14" and got[(4, "mac")]["source"]["title"] == "Сеть"
    assert got[(6, "ip")]["value"] == "10.0.5.16" and got[(6, "ip")]["unsure"]
    assert got[(8, "mac")]["value"] == "D8:CB:8A:00:0A:18" and not got[(8, "mac")]["unsure"]
    # «Проверен сетью» по привязке не считается (ПК 8 сеть видит сама: имя на адресе)
    assert confirmed(computers, seen) == {8: ["net"]}


def test_net_proposals_in_diffs(admin, editor, room, ssh_port):
    """MAC из сети дописывается к записанным; имя машины – только сообщается."""
    setup_dhcp(admin, ssh_port)
    loc = room["room"]
    second = add_pc(editor, loc, "pc-7", ip="10.0.5.200", mac="D8:CB:8A:00:00:07")
    named = add_pc(editor, loc, "pc-wrong", ip="10.0.5.60", mac="D8:CB:8A:00:00:60")
    Ssh.files = {scan_dhcp.DEFAULT_PATH: LEASES + "\n" + lease("10.0.5.60", "d8:cb:8a:00:00:60", "DESKTOP-60")}
    assert collect(admin, "dhcp")["status"] == "ok"

    # Привязка адреса ПК к другому MAC в настройках (host printer-1) – не повод менять MAC
    _, diffs = diffs_of(editor)
    assert (second, "mac") not in diffs

    # host в файле настроек называется как ПК – MAC привязки предлагается дописать
    conf = "/etc/dhcp/hosts.conf"
    Ssh.files[conf] = "host pc-7 { hardware ethernet 00:1b:a9:00:00:77; fixed-address 10.0.5.200; }"
    saved = ok(admin.patch("/api/scan/sources/dhcp", json={"configs": [conf, " "]}))
    assert saved["configs"] == [conf] and saved["path"] == scan_dhcp.DEFAULT_PATH
    run = collect(admin, "dhcp")
    assert run["status"] == "ok" and run["stats"]["fixed"] == 3, run
    rows = {(row.source, row.ip): row for row in all_hosts()}
    assert rows[("dhcp_conf", "10.0.5.200")].data == {"fixed": True, "host": "pc-7", "file": conf}

    _, diffs = diffs_of(editor)
    diff = diffs[(second, "mac")]
    assert diff["kind"] == "diff" and diff["proposed"] == "D8:CB:8A:00:00:07\n00:1B:A9:00:00:77" and diff["raw"] == "00:1B:A9:00:00:77"
    assert diff["sources"][0]["by"] == ["ip", "reserve"]
    name = diffs[(named, "hostname")]
    assert name["proposed"] == "DESKTOP-60" and name["can_take"] is False

    # Источник выключен – предложений нет
    ok(admin.patch("/api/scan/sources/dhcp", json={"enabled": False}))
    data, diffs = diffs_of(editor)
    assert not diffs and "dhcp" not in data["sources"]


def test_dhcp_config_files(admin, ssh_port):
    """Файлы настроек – отдельным списком; ключ на сервере с прежним набором файлов – предупреждение."""
    setup_dhcp(admin, ssh_port)
    assert source(admin, "dhcp")["configs"] == []
    assert admin.patch("/api/scan/sources/dhcp", json={"configs": ["etc/a.conf"]}).status_code == 400
    assert admin.patch("/api/scan/sources/dhcp", json={"configs": ["/etc/a b.conf; rm"]}).status_code == 400

    # Прежняя запись «Файл: аренды и настройки через пробел» – первый путь аренды, остальные – настройки
    saved = ok(admin.patch("/api/scan/sources/dhcp", json={"path": scan_dhcp.DEFAULT_PATH + " /etc/dhcp/dhcpd.conf"}))
    assert saved["path"] == scan_dhcp.DEFAULT_PATH and saved["configs"] == ["/etc/dhcp/dhcpd.conf"]
    saved = ok(admin.patch("/api/scan/sources/dhcp", json={"configs": []}))
    assert saved["configs"] == []

    # Ключ поставлен, когда файлов настроек не было
    assert ok(admin.post("/api/scan/sources/dhcp/key/install"))["ok"]
    ok(admin.patch("/api/scan/sources/dhcp", json={"password": ""}))
    one, two = "/etc/dhcp/sub1.conf", "/etc/dhcp/sub2.conf"
    Ssh.files[one] = "host a { hardware ethernet 00:1b:a9:00:01:01; fixed-address 10.0.6.1; }"
    Ssh.files[two] = "# пусто"
    saved = ok(admin.patch("/api/scan/sources/dhcp", json={"configs": [one, two]}))
    assert saved["configs"] == [one, two] and saved["check_ok"] is None
    run = collect(admin, "dhcp")
    assert run["status"] == "ok" and "поставь ключ заново" in run["message"] and run["stats"]["fixed"] == 3

    # Ключ поставлен заново – читаются все файлы; файл без привязок – предупреждение
    assert ok(admin.post("/api/scan/sources/dhcp/key/install", json={"password": "pw"}))["ok"]
    assert all(f"cat -- {path}" in Ssh.authorized[0] for path in (scan_dhcp.DEFAULT_PATH, one, two))
    run = collect(admin, "dhcp")
    assert run["status"] == "ok" and run["stats"]["fixed"] == 4, run
    assert run["message"] == f"{two} – привязок MAC – IP нет."
    result = ok(admin.post("/api/scan/sources/dhcp/check"))
    assert result["ok"] and "привязок 4" in result["message"]

    # Файла настроек на сервере нет – аренды всё равно собраны
    del Ssh.files[two]
    assert ok(admin.post("/api/scan/sources/dhcp/key/install", json={"password": "pw"}))["ok"]
    run = collect(admin, "dhcp")
    assert run["status"] == "ok" and f"{two} – не прочитан." in run["message"] and "No such file" in run["message"]


# ---------- Сеть: проход подсетей ----------


def test_nbstat_and_arp(tmp_path):
    import struct

    names = b"".join([b"TER-201-1      \x00\x04\x00", b"WORKGROUP      \x00\x84\x00", b"TER-201-1      \x20\x04\x00"])
    answer = (
        b"\x12\x34\x84\x00\x00\x00\x00\x01\x00\x00\x00\x00" + b"\x20CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\x00"
        + struct.pack("!HHIH", 0x21, 1, 0, 101) + bytes([3]) + names + bytes.fromhex("d8cb8a112233") + b"\x00" * 40
    )
    assert scan_net.parse_nbstat(answer) == {"name": "TER-201-1", "group": "WORKGROUP", "mac": "D8:CB:8A:11:22:33"}
    assert scan_net.parse_nbstat(b"\x12\x34\x00") is None and scan_net.parse_nbstat(answer[:70]) is None

    arp = tmp_path / "arp"
    arp.write_text(
        "IP address       HW type     Flags       HW address            Mask     Device\n"
        "192.168.0.10     0x1         0x2         d8:cb:8a:11:22:33     *        eth0\n"
        "192.168.0.11     0x1         0x0         00:00:00:00:00:00     *        eth0\n"
    )
    assert scan_net.arp_table(str(arp)) == {"192.168.0.10": "D8:CB:8A:11:22:33"}
    assert scan_net.targets(["10.0.5.0/30", "10.0.5.0/30", "10.0.6.7/32"]) == ["10.0.5.1", "10.0.5.2", "10.0.6.7"]
    assert {22, 80, 443, 8080, 3389, 5900} <= set(scan_net.PORTS)


def test_net_collect(admin, editor, room, monkeypatch):
    alive = {
        "10.0.7.1": {"mac": "D8:CB:8A:00:07:01", "name": "PC-71", "data": {"how": ["ping", "netbios"]}},
        "10.0.7.2": {"mac": None, "name": None, "data": {"how": ["ping"]}},
    }
    asked = []

    def probe(ip, options, dns):
        asked.append(options)
        return dict(alive[ip], ip=ip, data=dict(alive[ip]["data"])) if ip in alive else None

    monkeypatch.setattr(scan_net, "probe", probe)
    monkeypatch.setattr(scan_net, "arp_table", lambda: {"10.0.7.2": "D8:CB:8A:00:07:02", "10.9.9.9": "D8:CB:8A:00:09:09"})

    saved = source(admin, "net")
    assert saved["form"] == "net" and saved["names"] is True and saved["ports"] is False and not saved["ready"]
    # Без подсетей сканировать нечего
    ok(admin.patch("/api/scan/sources/net", json={"enabled": True, "ports": True}))
    assert admin.post("/api/scan/sources/net/collect").status_code == 400
    result = ok(admin.post("/api/scan/sources/net/check"))
    assert not result["ok"] and "Нет подсетей" in result["message"]

    ok(admin.post("/api/scan/subnets", json={"cidr": "10.0.7.0/29"}))
    ok(admin.post("/api/scan/subnets", json={"cidr": "10.0.8.0/24", "scan": False}))
    assert source(admin, "net")["ready"]
    assert ok(admin.post("/api/scan/sources/net/check"))["ok"]

    first = add_pc(editor, room["room"], "pc-71", ip="10.0.7.1")
    second = add_pc(editor, room["room"], "pc-72", ip="10.0.7.2")
    run = collect(admin, "net")
    assert run["status"] == "ok", run
    assert run["stats"]["total"] == 6 and run["stats"]["alive"] == 2 and run["stats"]["mac"] == 2
    assert asked[0] == {"names": True, "ports": True}
    saved = hosts("net")
    assert set(saved) == {"10.0.7.1", "10.0.7.2"}
    assert saved["10.0.7.2"].mac == "D8:CB:8A:00:07:02" and saved["10.0.7.2"].data["mac_from"] == "arp"

    _, diffs = diffs_of(editor)
    assert diffs[(first, "mac")]["kind"] == "fill" and diffs[(first, "mac")]["sources"][0]["title"] == "Сеть"
    assert diffs[(second, "mac")]["kind"] == "unsure"

    # Адрес замолчал – наблюдение остаётся и когда устареет (этап 31: ПК может быть
    # выключен месяцами): в «Сети» – пометка stale, предложений по нему нет
    del alive["10.0.7.1"]
    session = SessionLocal()
    session.query(ScanHost).filter(ScanHost.ip == "10.0.7.2").update({"seen_at": NOW - timedelta(days=30)})
    session.commit()
    session.close()
    monkeypatch.setattr(scan_net, "arp_table", lambda: {})
    alive.pop("10.0.7.2")
    assert collect(admin, "net")["status"] == "ok"
    saved = hosts("net")
    assert set(saved) == {"10.0.7.1", "10.0.7.2"} and saved["10.0.7.2"].mac == "D8:CB:8A:00:07:02"
    page = {h["ip"]: h for h in ok(editor.get("/api/scan/hosts"))["hosts"]}
    assert page["10.0.7.2"]["stale"] and page["10.0.7.2"]["net"]["stale"] and not page["10.0.7.1"]["stale"]
    assert [c["computer_id"] for c in page["10.0.7.2"]["computers"]] == [second]
    _, diffs = diffs_of(editor)
    assert (second, "mac") not in diffs and (first, "mac") in diffs


# ---------- Расписание ----------


def at(text):
    return datetime.fromisoformat(text).astimezone()


def conf(**fields):
    return scan_schedule.clean(fields)


def test_next_run():
    every = conf(mode="every", minutes=30, time_from="08:00", time_to="18:00", days="work")
    # 2026-10-02 – пятница
    assert scan_schedule.next_run(conf(), None, at("2026-10-02T10:00")) is None
    assert scan_schedule.next_run(every, None, at("2026-10-02T10:00")) == at("2026-10-02T10:00")
    assert scan_schedule.next_run(every, at("2026-10-02T09:50"), at("2026-10-02T10:00")) == at("2026-10-02T10:20")
    assert scan_schedule.next_run(every, at("2026-10-02T09:00"), at("2026-10-02T10:00")) == at("2026-10-02T09:30")
    # После рабочих часов в пятницу – в понедельник с утра
    assert scan_schedule.next_run(every, at("2026-10-02T17:50"), at("2026-10-02T18:30")) == at("2026-10-05T08:00")
    assert scan_schedule.next_run(every, at("2026-10-02T17:50"), at("2026-10-05T09:00")) == at("2026-10-05T08:00")
    round_clock = conf(mode="every", minutes=60, time_from="00:00", time_to="00:00")
    assert scan_schedule.next_run(round_clock, at("2026-10-03T23:30"), at("2026-10-03T23:40")) == at("2026-10-04T00:30")

    daily = conf(mode="daily", time_at="07:00", days="work")
    assert scan_schedule.next_run(daily, None, at("2026-10-02T06:00")) == at("2026-10-02T07:00")
    assert scan_schedule.next_run(daily, at("2026-10-01T07:00"), at("2026-10-02T09:00")) == at("2026-10-02T07:00")
    assert scan_schedule.next_run(daily, at("2026-10-02T07:00"), at("2026-10-02T09:00")) == at("2026-10-05T07:00")
    assert scan_schedule.clean({"mode": "x", "minutes": 7, "time_at": "25:00", "days": 1}) == scan_schedule.DEFAULT


def test_schedule_api(admin, editor, ssh_port):
    assert editor.get("/api/scan/schedule").status_code == 403
    data = ok(admin.get("/api/scan/schedule"))
    assert [item["kind"] for item in data["items"]] == ["glpi", "gsit", "jabber", "dhcp", "net"]
    assert all(item["mode"] == "off" and item["next_at"] is None and not item["available"] for item in data["items"])

    for bad in ({"mode": "often"}, {"minutes": 7}, {"time_at": "7 утра"}, {"days": "sunday"}):
        assert admin.patch("/api/scan/schedule/dhcp", json=bad).status_code == 400

    assert admin.patch("/api/scan/schedule/printers", json={"mode": "off"}).status_code == 404
    setup_dhcp(admin, ssh_port)
    item = ok(admin.patch("/api/scan/schedule/dhcp", json={"mode": "every", "minutes": 30, "time_from": "0:00", "time_to": "00:00"}))
    assert item["available"] and item["mode"] == "every" and item["time_from"] == "00:00" and item["next_at"]

    history = ok(admin.get("/api/history", params={"entity": "scan_schedule"}))["items"]
    assert history[0]["title"] == "DHCP" and history[0]["changes"]["run_mode"] == {"old": "вручную", "new": "каждые 30 мин"}
    assert history[0]["changes"]["run_time"]["new"] == "круглые сутки"
    assert ok(editor.get("/api/history", params={"limit": 50}))["total"] == 0


def test_schedule_tick(admin, ssh_port, monkeypatch):
    setup_dhcp(admin, ssh_port)
    ok(admin.patch("/api/scan/schedule/dhcp", json={"mode": "every", "minutes": 15, "time_from": "00:00", "time_to": "00:00"}))
    ok(admin.patch("/api/scan/schedule/glpi", json={"mode": "daily"}))   # источник не настроен – пропуск
    started = []
    real = scan_collect.start

    def start(session, kind, user_name, background=True):
        # Не в фоне: тест ждёт конца сбора
        started.append((kind, user_name))
        return real(session, kind, user_name, background=False)

    monkeypatch.setattr(scan_collect, "start", start)

    session = SessionLocal()

    try:
        assert scan_schedule.tick(session) == ["dhcp"]
        assert started == [("dhcp", "расписание")]
        # Только что собирали – следующий раз через 15 минут
        assert scan_schedule.tick(session) == []
        assert scan_schedule.tick(session, datetime.now().astimezone() + timedelta(minutes=16)) == ["dhcp"]
    finally:
        session.close()

    runs = ok(admin.get("/api/scan/runs", params={"source": "dhcp"}))
    assert len(runs) == 2 and runs[0]["user_name"] == "расписание" and runs[0]["status"] == "ok"
