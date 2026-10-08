"""Сканирование, этап 24: подключения к источникам (пароли зашифрованы, проверка
подключения) и подсети. Всё – только администратор.

GLPI и веб-админку Jabber изображает маленький HTTP-сервер в этом же процессе."""
import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text

from conftest import add_computer, add_location, ok
from db import engine

KEY = Fernet.generate_key().decode()


@pytest.fixture(autouse=True)
def secret_key(monkeypatch):
    monkeypatch.setenv("ITDB_SECRET_KEY", KEY)


def basic(login, password):
    return "Basic " + base64.b64encode(f"{login}:{password}".encode()).decode()


class FakeHandler(BaseHTTPRequestHandler):
    """GLPI (apirest.php) и веб-админка ejabberd – ровно то, что нужно проверке."""

    def log_message(self, *args):
        pass

    def send(self, status, body, headers=None, content_type="application/json"):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        auth = self.headers.get("Authorization", "")

        if path == "/glpi/apirest.php/initSession":
            if auth in (basic("itdb", "secret"), "user_token tok"):
                return self.send(200, {"session_token": "s1"})
            return self.send(401, ["ERROR_GLPI_LOGIN", "Неверный логин"])

        if path == "/off/apirest.php/initSession":
            return self.send(400, ["ERROR", "API отключено"])

        if path.startswith("/glpi/apirest.php/"):
            if self.headers.get("Session-Token") != "s1":
                return self.send(401, ["ERROR_SESSION_TOKEN_INVALID", "нет сессии"])
            name = path[len("/glpi/apirest.php/"):]
            if name == "getGlpiConfig":
                return self.send(200, {"cfg_glpi": {"version": "10.0.99"}})
            if name == "Computer":
                return self.send(206, [{"id": 1}], {"Content-Range": "0-0/5"})
            if name == "listSearchOptions/Computer":
                return self.send(200, {
                    "common": "Характеристики",
                    "1": {"name": "Наименование", "table": "glpi_computers", "field": "name"},
                    "9": {"name": "Дата последней инвентаризации", "table": "glpi_computers", "field": "last_inventory_update"},
                })
            if name == "killSession":
                return self.send(200, {})
            return self.send(404, ["ERROR_RESOURCE_NOT_FOUND_NOR_COMMONDBTM", "нет"])

        if path == "/admin/server/jabber.test/online-users/":
            if auth != basic("admin@jabber.test", "pw"):
                return self.send(401, "no", content_type="text/html")
            html = (
                '<html><title>ejabberd Web Admin</title>'
                '<a href="../user/ivanov/">ivanov</a><a href="../user/%D0%BF%D0%B5%D1%82%D1%80%D0%BE%D0%B2/">петров</a>'
                '<a href="../user/ivanov/">ivanov</a></html>'
            )
            return self.send(200, html, content_type="text/html; charset=utf-8")

        return self.send(404, "not found", content_type="text/html")


@pytest.fixture(scope="module")
def fake():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def history_of(admin, entity):
    items = ok(admin.get("/api/history", params={"entity": entity}))["items"]
    return items


# ---------- Доступ ----------


def test_only_admin(admin, editor, reader, anon):
    ok(admin.get("/api/scan/sources"))
    ok(admin.get("/api/scan/subnets"))

    for client in (editor, reader):
        assert client.get("/api/scan/sources").status_code == 403
        assert client.get("/api/scan/subnets").status_code == 403
        assert client.patch("/api/scan/sources/glpi", json={"url": "http://x"}).status_code == 403
        assert client.post("/api/scan/subnets", json={"cidr": "10.0.0.0/24"}).status_code == 403

    assert anon.get("/api/scan/sources").status_code == 401


# ---------- Источники ----------


def test_defaults(admin):
    data = ok(admin.get("/api/scan/sources"))
    assert data["key_ready"] is True
    kinds = {s["kind"]: s for s in data["sources"]}
    assert list(kinds) == ["glpi", "gsit", "jabber", "dhcp", "net"]
    assert kinds["glpi"]["fresh_days"] == 3
    assert kinds["glpi"]["secrets"] == {"password": False, "user_token": False, "app_token": False}
    assert kinds["jabber"]["fresh_days"] == 7
    assert kinds["jabber"]["secrets"] == {"password": False}
    assert kinds["glpi"]["enabled"] is False and kinds["glpi"]["verify_tls"] is True


def test_save_password_encrypted(admin, editor):
    saved = ok(admin.patch("/api/scan/sources/glpi", json={
        "url": " https://glpi.lan/ ", "login": "itdb", "password": "s3cret-Пароль", "fresh_days": 5,
    }))
    assert saved["url"] == "https://glpi.lan"
    assert saved["secrets"]["password"] is True
    assert saved["fresh_days"] == 5
    assert "s3cret" not in json.dumps(saved)

    with engine.connect() as conn:
        stored = conn.execute(text("select secrets::text from scan_sources where kind = 'glpi'")).scalar()

    assert "s3cret" not in stored
    token = json.loads(stored)["password"]
    assert Fernet(KEY.encode()).decrypt(token.encode()).decode() == "s3cret-Пароль"

    # История: пароль – «задан новый», сам пароль нигде
    items = history_of(admin, "scan_sources")
    assert items[0]["title"] == "GLPI"
    changes = items[0]["changes"]
    assert changes["password"]["new"] == "задан новый"
    assert changes["url"]["new"] == "https://glpi.lan"
    assert changes["fresh_days"] == {"old": 3, "new": 5}
    assert "s3cret" not in json.dumps(items)

    # Редактор записей о настройках сканирования не видит
    visible = ok(editor.get("/api/history"))["items"]
    assert all(item["entity"] not in ("scan_sources", "scan_subnets") for item in visible)
    assert editor.get("/api/history", params={"entity": "scan_sources"}).json()["total"] == 0


def test_keep_and_clear_secret(admin):
    ok(admin.patch("/api/scan/sources/gsit", json={"url": "http://gsit", "password": "p1", "app_token": "a1"}))
    kept = ok(admin.patch("/api/scan/sources/gsit", json={"login": "u"}))
    assert kept["secrets"] == {"password": True, "user_token": False, "app_token": True}

    cleared = ok(admin.patch("/api/scan/sources/gsit", json={"app_token": ""}))
    assert cleared["secrets"]["app_token"] is False
    assert cleared["secrets"]["password"] is True
    assert history_of(admin, "scan_sources")[0]["changes"] == {"app_token": {"old": None, "new": "удалён"}}


def test_no_key(admin, monkeypatch):
    monkeypatch.delenv("ITDB_SECRET_KEY")
    assert ok(admin.get("/api/scan/sources"))["key_ready"] is False
    response = admin.patch("/api/scan/sources/glpi", json={"url": "http://glpi", "password": "x"})
    assert response.status_code == 400
    assert "ITDB_SECRET_KEY" in response.json()["detail"]

    # Без пароля – сохраняется
    ok(admin.patch("/api/scan/sources/glpi", json={"url": "http://glpi"}))


def test_changed_key(admin, monkeypatch):
    ok(admin.patch("/api/scan/sources/glpi", json={"url": "http://127.0.0.1:1", "login": "a", "password": "x"}))
    monkeypatch.setenv("ITDB_SECRET_KEY", Fernet.generate_key().decode())
    response = admin.post("/api/scan/sources/glpi/check")
    assert response.status_code == 400
    assert "введ" in response.json()["detail"].lower()


def test_source_validation(admin):
    assert admin.patch("/api/scan/sources/glpi", json={"url": "glpi.lan"}).status_code == 400
    assert admin.patch("/api/scan/sources/glpi", json={"enabled": True}).status_code == 400
    assert admin.patch("/api/scan/sources/glpi", json={"fresh_days": 0}).status_code == 400
    assert admin.patch("/api/scan/sources/glpi", json={"fresh_days": 61}).status_code == 400
    assert admin.patch("/api/scan/sources/nope", json={"url": "http://x"}).status_code == 404
    # У Jabber нет токенов – лишнее игнорируется; срок «давно не в сети» – свой, до года
    saved = ok(admin.patch("/api/scan/sources/jabber", json={"url": "http://j:5280", "user_token": "t", "fresh_days": 90}))
    assert saved["secrets"] == {"password": False}
    assert saved["fresh_days"] == 90
    assert admin.patch("/api/scan/sources/jabber", json={"fresh_days": 366}).status_code == 400


def test_check_glpi(admin, fake):
    ok(admin.patch("/api/scan/sources/glpi", json={"url": fake + "/glpi", "login": "itdb", "password": "secret"}))
    result = ok(admin.post("/api/scan/sources/glpi/check"))
    assert result["ok"] is True, result
    assert result["saved"] is True
    assert "GLPI 10.0.99" in result["message"]
    assert "компьютеров: 5" in result["message"]
    assert "дата последней инвентаризации" in result["message"]

    source = ok(admin.get("/api/scan/sources"))["sources"][0]
    assert source["check_ok"] is True and source["checked_at"]

    # Несохранённая форма с неверным паролем: ошибка, но сохранённый итог не меняется
    bad = ok(admin.post("/api/scan/sources/glpi/check", json={"password": "wrong"}))
    assert bad["ok"] is False and bad["saved"] is False
    assert "неверный логин" in bad["message"]
    assert ok(admin.get("/api/scan/sources"))["sources"][0]["check_ok"] is True

    # Адрес изменили – прошлая проверка сброшена
    ok(admin.patch("/api/scan/sources/glpi", json={"url": fake + "/other"}))
    assert ok(admin.get("/api/scan/sources"))["sources"][0]["checked_at"] is None

    # Токен пользователя вместо пароля; адрес – сразу …/apirest.php
    by_token = ok(admin.post("/api/scan/sources/glpi/check", json={"url": fake + "/glpi/apirest.php", "user_token": "tok"}))
    assert by_token["ok"] is True, by_token


def test_check_errors(admin, fake):
    result = ok(admin.post("/api/scan/sources/glpi/check"))
    assert result["ok"] is False and "адрес" in result["message"].lower()

    result = ok(admin.post("/api/scan/sources/glpi/check", json={"url": fake + "/nothing", "login": "a", "password": "b"}))
    assert result["ok"] is False and "404" in result["message"]

    # Выключенный REST API (GLPI 11 отвечает так на языке интерфейса)
    result = ok(admin.post("/api/scan/sources/glpi/check", json={"url": fake + "/off", "login": "a", "password": "b"}))
    assert result["ok"] is False and "устаревший REST API" in result["message"]

    result = ok(admin.post("/api/scan/sources/glpi/check", json={"url": "http://127.0.0.1:1", "login": "a", "password": "b"}))
    assert result["ok"] is False and "не принимает подключения" in result["message"]


def test_check_jabber(admin, fake):
    # Адрес любой страницы админки – домен возьмётся из него; логин без @ – допишется
    saved = ok(admin.patch("/api/scan/sources/jabber", json={
        "url": fake + "/admin/server/jabber.test/shared-roster/", "login": "admin", "password": "pw",
    }))
    assert saved["url"] == fake
    assert saved["domain"] == "jabber.test"
    result = ok(admin.post("/api/scan/sources/jabber/check"))
    assert result["ok"] is True, result
    assert result["message"] == "Подключено: сейчас в сети 2."

    bad = ok(admin.post("/api/scan/sources/jabber/check", json={"password": "nope"}))
    assert bad["ok"] is False and "неверный логин" in bad["message"]


# ---------- Подсети ----------


def test_subnets(admin, editor):
    building = add_location(editor, "building", "ул. Ленина, 1")
    room = add_location(editor, "room", "Каб", add_location(editor, "department", "Терапия", building))
    add_computer(editor, room, hostname="a", ip="192.168.89.10")
    add_computer(editor, room, hostname="b", ip="192.168.89.11\n10.8.0.2")
    add_computer(editor, room, hostname="c", ip="192.168.90.5")
    add_computer(editor, room, hostname="p", ip="192.168.89.200")

    created = ok(admin.post("/api/scan/subnets", json={"cidr": "192.168.89.7/24", "location_id": building}))
    assert created["cidr"] == "192.168.89.0/24"
    printers = ok(admin.post("/api/scan/subnets", json={"cidr": "192.168.89.192/26", "purpose": "printers", "note": " принтеры "}))
    ok(admin.post("/api/scan/subnets", json={"cidr": "10.0.5.0", "scan": False}))

    data = ok(admin.get("/api/scan/subnets"))
    by_cidr = {s["cidr"]: s for s in data["subnets"]}
    assert list(by_cidr) == ["10.0.5.0/24", "192.168.89.0/24", "192.168.89.192/26"]
    # ПК – в самой узкой подсети: .200 – только в /26
    assert by_cidr["192.168.89.0/24"]["computers"] == 2
    assert by_cidr["192.168.89.192/26"]["computers"] == 1
    assert by_cidr["192.168.89.192/26"]["note"] == "принтеры"
    assert by_cidr["10.0.5.0/24"]["scan"] is False
    assert by_cidr["192.168.89.0/24"]["location_id"] == building
    assert {u["cidr"]: u["computers"] for u in data["uncovered"]} == {"10.8.0.0/24": 1, "192.168.90.0/24": 1}
    assert data["buildings"] == [{"id": building, "name": "ул. Ленина, 1"}]
    assert data["purposes"]["printers"] == "Принтеры"

    # Ошибки
    assert admin.post("/api/scan/subnets", json={"cidr": "192.168.89.0/24"}).status_code == 409
    assert admin.post("/api/scan/subnets", json={"cidr": "10.0.0.0/8"}).status_code == 400
    assert admin.post("/api/scan/subnets", json={"cidr": "fe80::/64"}).status_code == 400
    assert admin.post("/api/scan/subnets", json={"cidr": "abc"}).status_code == 400
    assert admin.post("/api/scan/subnets", json={"cidr": "10.1.0.0/24", "purpose": "x"}).status_code == 400
    assert admin.post("/api/scan/subnets", json={"cidr": "10.1.0.0/24", "location_id": room}).status_code == 400

    # Правка и удаление – в Истории
    ok(admin.patch(f"/api/scan/subnets/{printers['id']}", json={"purpose": "mixed", "scan": False}))
    ok(admin.patch(f"/api/scan/subnets/{created['id']}", json={"clear_location": True}))
    ok(admin.delete(f"/api/scan/subnets/{printers['id']}"))
    assert admin.delete(f"/api/scan/subnets/{printers['id']}").status_code == 404

    items = history_of(admin, "scan_subnets")
    assert items[0]["changes"] == {"deleted": {"old": "192.168.89.192/26", "new": None}}
    assert items[0]["title"] == "192.168.89.192/26"
    assert items[1]["changes"] == {"building": {"old": "ул. Ленина, 1", "new": None}}
    assert items[2]["changes"] == {"purpose": {"old": "Принтеры", "new": "Всё подряд"}, "scan": {"old": True, "new": False}}

    # Отмены у этих записей нет
    response = admin.post("/api/history/cancel", json={"items": [{"id": items[2]["id"]}], "cancel": True})
    assert response.status_code == 400
