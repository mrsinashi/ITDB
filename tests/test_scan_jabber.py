"""Jabber (VACUUM, этап 26д): сбор пользователей из веб-админки ejabberd 14.12 и
вкладка «Vacuum». Веб-админка изображается маленьким HTTP-сервером в этом же
процессе: страницы — как у ejabberd 14.12 (прислал пользователь 30.09)."""
import base64
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from cryptography.fernet import Fernet

import scan_jabber as sj
from conftest import add_computer, get_row, ok

KEY = Fernet.generate_key().decode()
DOMAIN = "jabber.test"
AUTH = "Basic " + base64.b64encode(f"admin@{DOMAIN}:pw".encode()).decode()


@pytest.fixture(autouse=True)
def secret_key(monkeypatch):
    monkeypatch.setenv("ITDB_SECRET_KEY", KEY)


class Ejabberd:
    groups = {}      # группа → [JID]
    online = {}      # логин → [(клиент, адрес)]
    roster_fails = False


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


@pytest.fixture(scope="module")
def jabber_url():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeEjabberd)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture(autouse=True)
def reset_jabber():
    Ejabberd.groups = {}
    Ejabberd.online = {}
    Ejabberd.roster_fails = False


def setup_jabber(admin, url):
    ok(admin.patch("/api/scan/sources/jabber", json={
        "url": f"{url}/admin/server/{DOMAIN}/", "login": "admin", "password": "pw", "enabled": True,
    }))


def collect(admin):
    run = ok(admin.post("/api/scan/sources/jabber/collect"))
    for _ in range(200):
        run = ok(admin.get(f"/api/scan/runs/{run['id']}"))
        if run["status"] != "running":
            return run
        time.sleep(0.05)
    raise AssertionError("сбор не закончился")


def users_of(client):
    return {u["login"]: u for u in ok(client.get("/api/scan/jabber"))["users"]}


def test_parse_pages():
    html = ("<input type='checkbox' name='selected' value='Регистратура &amp; Приём'/>"
            "<input type='checkbox' name=\"selected\" value=\"ИТ\"/><input type='text' name='namenew' value=''/>")
    assert sj.roster_groups(html) == ["Регистратура & Приём", "ИТ"]
    title, members = sj.group_page("<input type='text' name='name' value='ИТ'/><textarea name='members'>a@x\nb@x\n\n</textarea>"
                                   "<textarea name='dispgroups'>ИТ</textarea>")
    assert (title, members) == ("ИТ", ["a@x", "b@x"])
    assert sj.login_of("ivanov@jabber.lan", "jabber.lan") == "ivanov"
    assert sj.login_of("Petrov@Jabber.LAN/Vacuum", "jabber.lan") == "Petrov"
    assert sj.login_of("guest@other.lan", "jabber.lan") == "guest@other.lan"
    assert sj.login_of("@all@", "jabber.lan") is None
    assert sj.user_resources(
        "<ul><li>Vacuum-IM (plain://192.168.99.231:10394#ejabberd@localhost)</li>"
        "<li>Psi+ (tls://::ffff:10.0.0.5:5222)</li><li>web (http_bind://[::1]:5280)</li></ul>"
    ) == [{"client": "Vacuum-IM", "ip": "192.168.99.231"}, {"client": "Psi+", "ip": "10.0.0.5"}, {"client": "web", "ip": None}]


def test_collect_and_tab(admin, editor, reader, room, jabber_url):
    loc = room["room"]
    pc1 = add_computer(editor, loc, hostname="ter-201-1", ip="10.0.2.11")
    ok(editor.patch(f"/api/computers/{pc1}", json={"vacuum": "ivanov", "_version": get_row(editor, pc1)["version"]}))
    add_computer(editor, loc, hostname="ter-201-2", ip="10.0.2.12")

    Ejabberd.groups = {"Терапия": [f"ivanov@{DOMAIN}", f"petrova@{DOMAIN}", "@all@"], "ИТ": [f"petrova@{DOMAIN}"]}
    Ejabberd.online = {"ivanov": [("Vacuum-IM", "10.0.2.11")], "petrova": [("Vacuum-IM", "10.0.2.12"), ("Vacuum-IM", "10.9.9.9")]}
    setup_jabber(admin, jabber_url)

    run = collect(admin)
    assert run["status"] == "ok", run
    assert (run["stats"]["total"], run["stats"]["online"], run["stats"]["groups"]) == (2, 2, 2)

    users = users_of(editor)
    assert users["ivanov"]["groups"] == ["Терапия"] and users["ivanov"]["online"]
    assert users["petrova"]["groups"] == ["Терапия", "ИТ"]
    host = users["ivanov"]["addresses"][0]["hosts"][0]
    assert (host["hostname"], host["vacuum"], users["ivanov"]["addresses"][0]["client"]) == ("ter-201-1", True, "Vacuum-IM")
    addresses = users["petrova"]["addresses"]
    assert [a["ip"] for a in addresses] == ["10.0.2.12", "10.9.9.9"]
    assert addresses[0]["hosts"][0]["vacuum"] is False and addresses[1]["hosts"] == []
    assert users["ivanov"]["vacuum_pcs"] == ["ter-201-1"]

    # Ушёл из сети — остаются последний IP и время; пропал из групп — без групп
    seen = users["ivanov"]["last_seen_at"]
    Ejabberd.online = {"petrova": [("Vacuum-IM", "10.0.2.12")]}
    Ejabberd.groups = {"ИТ": [f"petrova@{DOMAIN}"]}
    assert collect(admin)["status"] == "ok"
    users = users_of(admin)
    ivanov = users["ivanov"]
    assert not ivanov["online"] and ivanov["groups"] == [] and ivanov["last_seen_at"] == seen
    assert [a["ip"] for a in ivanov["addresses"]] == ["10.0.2.11"]
    assert users["petrova"]["groups"] == ["ИТ"]

    # Группы не получены — прежние остаются, в итоге сбора — предупреждение
    Ejabberd.roster_fails = True
    run = collect(admin)
    assert run["status"] == "ok" and "Группы не получены" in run["message"]
    assert users_of(admin)["petrova"]["groups"] == ["ИТ"]

    # Смотреть — редактор и администратор; собирать — администратор
    assert reader.get("/api/scan/jabber").status_code == 403
    assert editor.post("/api/scan/sources/jabber/collect").status_code == 403
    data = ok(editor.get("/api/scan/jabber"))
    assert data["enabled"] and data["configured"] and data["last_run"]["source"] == "jabber"


def test_collect_errors(admin, jabber_url):
    ok(admin.patch("/api/scan/sources/jabber", json={
        "url": f"{jabber_url}/admin/server/{DOMAIN}/", "login": "admin", "password": "wrong", "enabled": True,
    }))
    run = collect(admin)
    assert run["status"] == "error" and "не пустил" in run["message"]
    assert ok(admin.get("/api/scan/jabber"))["users"] == []
