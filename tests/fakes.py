"""Поддельные источники сканера для тестов (этап 54): GLPI и веб-админка ejabberd 14.12 –
маленькие HTTP-серверы, DHCP – сервер SSH на paramiko, все в этом же процессе. Серверы
поднимают фикстуры `glpi_url`, `jabber_url`, `ssh_port` из conftest.py, данные задаёт
каждый тест (`Glpi`, `Ejabberd`, `Ssh`), перед каждым тестом они сбрасываются
(`reset_fakes`). Здесь же – подключить источник и собрать с него."""
import base64
import json
import socket
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import paramiko

import scan_dhcp
from conftest import ago, ok


def serve_http(handler):
    """HTTP-сервер на свободном порту (для фикстуры): адрес, после модуля – остановить."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


# ---------- GLPI / GSIT ----------


def pc(name, days=0, serial=None, uuid=None, ports=(), cpu="Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz",
       memory=(8192,), disks=(("Samsung SSD 870 EVO 250GB", 250059),), gpus=(), soft=(), maker="HP",
       model="ProDesk 400 G7", os_name="Microsoft Windows 10 Pro"):
    return {
        "name": name, "date": ago(days) if days is not None else None, "serial": serial, "uuid": uuid,
        "ports": list(ports), "cpu": cpu, "memory": list(memory), "disks": list(disks), "gpus": list(gpus),
        "soft": list(soft), "maker": maker, "model": model, "os": os_name,
    }


ETH = "Realtek PCIe GbE Family Controller"


class Glpi:
    computers = {}
    antivirus = []
    fresh_field = True
    fail_details = False
    disk_models = True   # отдавать ли список моделей дисков (DeviceHardDrive)


class FakeGlpi(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, body, headers=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path[len("/apirest.php/"):]
        query = urllib.parse.parse_qs(parts.query)

        if path == "initSession":
            return self.send(200, {"session_token": "s1"})

        if self.headers.get("Session-Token") != "s1":
            return self.send(401, ["ERROR_SESSION_TOKEN_INVALID", "нет сессии"])

        if path == "killSession":
            return self.send(200, {})

        if path == "getGlpiConfig":
            return self.send(200, {"cfg_glpi": {"version": "11.0.7"}})

        if path == "listSearchOptions/Computer":
            options = {
                "common": "Характеристики",
                "1": {"table": "glpi_computers", "field": "name"},
                "2": {"table": "glpi_computers", "field": "id"},
                "45": {"table": "glpi_operatingsystems", "field": "name"},
                "901": {"table": "glpi_agents", "field": "tag"},
            }
            if Glpi.fresh_field:
                options["9"] = {"table": "glpi_computers", "field": "last_inventory_update"}
            return self.send(200, options)

        if path == "search/Computer":
            start, end = (int(x) for x in query["range"][0].split("-"))
            rows = [
                {"1": c["name"], "2": cid, "9": c["date"], "45": c["os"], "901": "med"}
                for cid, c in sorted(Glpi.computers.items())
            ]
            page = rows[start:end + 1]
            return self.send(200, {"totalcount": len(rows), "count": len(page), "data": page})

        if path in ("ComputerAntivirus", "ItemAntivirus"):
            start, end = (int(x) for x in query["range"][0].split("-"))
            return self.send(200, Glpi.antivirus[start:end + 1])

        if path == "DeviceHardDrive":
            # модели дисков с интерфейсом: диск ПК – (название, объём[, интерфейс])
            if not Glpi.disk_models:
                return self.send(403, ["ERROR_RIGHT_MISSING", "нет права"])
            start, end = (int(x) for x in query["range"][0].split("-"))
            models = sorted({(d[0], d[2] if len(d) > 2 else 0) for c in Glpi.computers.values() for d in c["disks"]}, key=str)
            rows = [{"id": i + 1, "designation": n, "interfacetypes_id": kind} for i, (n, kind) in enumerate(models)]
            return self.send(200, rows[start:end + 1])

        if path.startswith("Computer/"):
            if Glpi.fail_details:
                return self.send(401, ["ERROR_SESSION_TOKEN_INVALID", "сессия кончилась"])
            cid = int(path.split("/")[1])
            c = Glpi.computers.get(cid)
            if c is None:
                return self.send(404, ["ERROR_ITEM_NOT_FOUND", "нет"])
            return self.send(200, {
                "id": cid, "name": c["name"], "serial": c["serial"], "uuid": c["uuid"],
                "manufacturers_id": c["maker"] or 0, "computermodels_id": c["model"] or 0,
                "_devices": {
                    "Item_DeviceProcessor": {"1": {"deviceprocessors_id": c["cpu"]}},
                    "Item_DeviceMemory": {str(i): {"size": m} for i, m in enumerate(c["memory"])},
                    "Item_DeviceHardDrive": {str(i): {"deviceharddrives_id": d[0], "capacity": d[1]} for i, d in enumerate(c["disks"])},
                    "Item_DeviceGraphicCard": {str(i): {"devicegraphiccards_id": g} for i, g in enumerate(c["gpus"])},
                },
                "_networkports": {
                    "NetworkPortEthernet": [
                        {"name": n, "mac": m, "NetworkName": {"IPAddress": [{"name": ip} for ip in ips]}}
                        for n, m, ips in c["ports"]
                    ],
                    "NetworkPortLocal": [{"name": "lo", "mac": "00:00:00:00:00:00"}],
                },
                "_softwares": [{"softwares_id": s} for s in c["soft"]],
            })

        return self.send(404, ["ERROR", "нет"])


# ---------- Веб-админка ejabberd 14.12 (страницы прислал пользователь 30.09) ----------


DOMAIN = "jabber.test"
AUTH = "Basic " + base64.b64encode(f"admin@{DOMAIN}:pw".encode()).decode()


class Ejabberd:
    groups = {}      # группа → [JID]
    online = {}      # логин → [(клиент, адрес)]
    roster_fails = False
    users = None     # список пользователей (этап 26ж): логин → «Последнее подключение»; None – страницы нет
    asked = []       # какие страницы users/… спрашивали


def page(body):
    return ("<?xml version='1.0'?><html xmlns='http://www.w3.org/1999/xhtml' xml:lang='ru-RU'><head>"
            "<title>Ejabberd Web Admin</title></head><body><div id='content'>" + body +
            "</div><p>ejabberd (c) 2002-2014 ProcessOne</p></body></html>")


class FakeEjabberd(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, html):
        data = html.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.headers.get("Authorization") != AUTH:
            return self.send(401, "no")
        path = urllib.parse.unquote(self.path.split("?")[0])
        rest = path[len(f"/admin/server/{DOMAIN}/"):]

        if rest.startswith("users/"):
            Ejabberd.asked.append(rest)

            if Ejabberd.users is None:
                return self.send(404, "Not Found")

            first, last = (int(x) for x in rest[len("users/"):].strip("/").split("-"))
            rows = "".join(
                f"<tr><td><a href='../../user/{urllib.parse.quote(u)}/'>{u}@{DOMAIN}</a></td>"
                f"<td><a href='../../user/{u}/queue/'>0</a></td><td>{when}</td></tr>"
                for u, when in sorted(Ejabberd.users.items())[first - 1:last])
            return self.send(200, page(
                "<h1>Пользователи</h1><table><thead><tr><td>Пользователь</td><td>Офлайновые сообщения</td>"
                "<td>Последнее подключение</td></tr></thead><tbody>" + rows + "</tbody></table>"))

        if rest == "online-users/":
            return self.send(200, page("".join(
                f"<a href='../user/{urllib.parse.quote(u)}/'>{u}@{DOMAIN}</a><br/>" for u in sorted(Ejabberd.online))))

        if rest == "shared-roster/":
            if Ejabberd.roster_fails:
                return self.send(500, "error")
            rows = "".join(
                f"<tr><td><input type='checkbox' name='selected' value='{g}'/></td><td><a href='{g}/'>{g}</a></td></tr>"
                for g in Ejabberd.groups)
            return self.send(200, page(
                "<form action='' method='post'><table>" + rows +
                "<tr><td><input type='text' name='namenew' value=''/></td></tr></table></form>"))

        if rest.startswith("shared-roster/"):
            group = rest[len("shared-roster/"):].rstrip("/")
            if group not in Ejabberd.groups:
                return self.send(404, "Not Found")
            members = "".join(f"{jid}\n" for jid in Ejabberd.groups[group])
            return self.send(200, page(
                f"<input type='text' name='name' value='{group}'/><textarea name='description'></textarea>"
                f"<textarea name='members' rows='3' cols='20'>{members}</textarea>"
                f"<textarea name='dispgroups' rows='3' cols='20'>{group}\n</textarea>"))

        if rest.startswith("user/"):
            user = rest[len("user/"):].rstrip("/")
            items = "".join(f"<li>{c} (plain://{ip}:10394#ejabberd@localhost)</li>" for c, ip in Ejabberd.online.get(user, []))
            return self.send(200, page(f"<h1>Пользователь {user}@{DOMAIN}</h1><h3>Подключённые ресурсы:</h3><ul>{items}</ul>"))

        return self.send(404, "Not Found")


# ---------- DHCP: файл аренд и сервер SSH (как старый OpenSSH: о подписях не сообщает,
# по ключу выполняет только свою команду) ----------


NOW = datetime.now(timezone.utc)


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


def serve_ssh():
    """Сервер SSH на свободном порту (для фикстуры): порт, после модуля – остановить."""
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


def reset_fakes():
    """Данные всех поддельных источников – как в начале (перед каждым тестом)."""
    Glpi.computers = {}
    Glpi.antivirus = []
    Glpi.fresh_field = True
    Glpi.fail_details = False
    Glpi.disk_models = True

    Ejabberd.groups = {}
    Ejabberd.online = {}
    Ejabberd.roster_fails = False
    Ejabberd.users = None
    Ejabberd.asked = []

    Ssh.password = "pw"
    Ssh.files = {scan_dhcp.DEFAULT_PATH: LEASES}
    Ssh.authorized = []
    Ssh.commands = []


# ---------- Подключить источник и собрать ----------


def setup_source(admin, url, kind="glpi", enabled=True, login="itdb", **more):
    """Подключение источника kind: адрес, логин, пароль «pw», включено."""
    body = dict({"url": url, "login": login, "password": "pw", "enabled": enabled}, **more)
    return ok(admin.patch(f"/api/scan/sources/{kind}", json=body))


def setup_jabber(admin, url):
    return setup_source(admin, f"{url}/admin/server/{DOMAIN}/", "jabber", login="admin")


def setup_dhcp(admin, port, **more):
    return setup_source(admin, f"127.0.0.1:{port}", "dhcp", login="itdbscan", **more)


def source(client, kind):
    """Подключение kind, как его отдаёт /api/scan/sources."""
    return next(s for s in ok(client.get("/api/scan/sources"))["sources"] if s["kind"] == kind)


def collect(admin, kind="glpi", body=None, status=200):
    """Собрать с источника kind и дождаться итога; status не 200 – сбор не начался,
    ответ – отказ."""
    response = admin.post(f"/api/scan/sources/{kind}/collect", json=body)

    if status != 200:
        assert response.status_code == status, response.text
        return response.json()

    run = ok(response)

    for _ in range(200):
        run = ok(admin.get(f"/api/scan/runs/{run['id']}"))

        if run["status"] != "running":
            return run

        time.sleep(0.05)

    raise AssertionError("сбор не закончился")
