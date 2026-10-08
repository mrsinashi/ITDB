"""Этап 41: кружок «в сети» у VACUUM (быстрая проверка Jabber, настройка в «Подключениях»),
группы Jabber логинов VACUUM для подсказки в Таблице."""
import socket
import threading

import pytest

import api_scan_jabber
from conftest import add_computer, get_row, ok
from test_scan_jabber import DOMAIN, Ejabberd, collect, jabber_url, reset_jabber, secret_key, setup_jabber  # noqa: F401


@pytest.fixture(autouse=True)
def forget_online():
    """Итог быстрой проверки – в памяти процесса: тесты не должны видеть чужой."""
    api_scan_jabber._online.update(when=None, at=None, logins=None, error=None, key=None)


def jabber_source(client):
    return next(s for s in ok(client.get("/api/scan/sources"))["sources"] if s["kind"] == "jabber")


def test_online_settings(admin):
    source = jabber_source(admin)
    assert (source["online_watch"], source["online_minutes"]) == (True, 2)

    for minutes in (0, 61):
        response = admin.patch("/api/scan/sources/jabber", json={"online_minutes": minutes})
        assert response.status_code == 400 and "1–60" in response.json()["detail"]

    saved = ok(admin.patch("/api/scan/sources/jabber", json={"online_watch": False, "online_minutes": 5}))
    assert (saved["online_watch"], saved["online_minutes"]) == (False, 5)
    assert (jabber_source(admin)["online_watch"], jabber_source(admin)["online_minutes"]) == (False, 5)

    # В Истории – оба поля; у других источников настройки нет
    item = ok(admin.get("/api/history?entity=scan_sources"))["items"][0]
    assert item["changes"]["online_watch"] == {"old": True, "new": False}
    assert item["changes"]["online_minutes"] == {"old": 2, "new": 5}
    glpi = ok(admin.patch("/api/scan/sources/glpi", json={"online_watch": False}))
    assert glpi["online_watch"] is None


def test_online_check(admin, reader, jabber_url, monkeypatch):
    # Не настроен – проверки нет
    assert ok(reader.get("/api/scan/jabber/online")) == {
        "enabled": False, "minutes": 2, "checked_at": None, "next_in": 0, "online": None, "error": None,
    }

    Ejabberd.online = {"Ivanov": [("Vacuum-IM", "10.0.2.11")], "petrova": []}
    setup_jabber(admin, jabber_url)
    first = ok(reader.get("/api/scan/jabber/online"))
    assert first["enabled"] and first["online"] == ["ivanov", "petrova"] and first["error"] is None
    assert 110 <= first["next_in"] <= 120 and first["checked_at"]

    # Раньше срока – прежний итог, ejabberd не спрашивается
    Ejabberd.online = {"sidorov": []}
    assert ok(reader.get("/api/scan/jabber/online"))["online"] == ["ivanov", "petrova"]
    assert ok(reader.get("/api/scan/jabber/online?click=1"))["online"] == ["ivanov", "petrova"]

    # Клик по строке ПК – заново, если с прошлой проверки прошло больше CLICK_SECONDS
    monkeypatch.setattr(api_scan_jabber, "CLICK_SECONDS", 0)
    clicked = ok(reader.get("/api/scan/jabber/online?click=1"))
    assert clicked["online"] == ["sidorov"] and clicked["next_in"] >= 110

    # Настройки сменились – проверить заново, не дожидаясь срока
    Ejabberd.online = {}
    ok(admin.patch("/api/scan/sources/jabber", json={"online_minutes": 10}))
    fresh = ok(reader.get("/api/scan/jabber/online"))
    assert fresh["online"] == [] and fresh["minutes"] == 10 and fresh["next_in"] > 500

    # ejabberd не отвечает – список не получен, ошибка словами
    ok(admin.patch("/api/scan/sources/jabber", json={"url": f"http://127.0.0.1:1/admin/server/{DOMAIN}/"}))
    failed = ok(reader.get("/api/scan/jabber/online"))
    assert failed["enabled"] and failed["online"] is None and failed["error"]

    # Выключена – проверки нет
    ok(admin.patch("/api/scan/sources/jabber", json={"online_watch": False}))
    assert ok(reader.get("/api/scan/jabber/online"))["enabled"] is False


def test_online_dropped_connection(admin, reader):
    """Сервер обрывает соединение без ответа – ошибка словами, а не 500."""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen()

    def drop():
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            conn.recv(4096)
            conn.close()

    threading.Thread(target=drop, daemon=True).start()
    try:
        setup_jabber(admin, f"http://127.0.0.1:{server.getsockname()[1]}")
        result = ok(reader.get("/api/scan/jabber/online"))
        assert result["online"] is None and "Не удалось подключиться" in result["error"]
    finally:
        server.close()


def test_vacuum_groups(admin, editor, room, jabber_url):
    """Группы Jabber логинов из ячеек VACUUM – для подсказки в Таблице."""
    pc = add_computer(editor, room["room"], hostname="ter-201-1", ip="10.0.2.11")
    ok(editor.patch(f"/api/computers/{pc}", json={"vacuum": "Ivanov\npetrova", "_version": get_row(editor, pc)["version"]}))
    Ejabberd.groups = {"Терапия": [f"ivanov@{DOMAIN}", f"sidorov@{DOMAIN}"], "ИТ": [f"ivanov@{DOMAIN}"]}
    Ejabberd.online = {"ivanov": [("Vacuum-IM", "10.0.2.11")], "petrova": [], "sidorov": []}
    setup_jabber(admin, jabber_url)
    assert collect(admin)["status"] == "ok"

    # petrova – без групп, sidorov – не в таблице
    assert ok(editor.get("/api/scan/diffs"))["vacuum_groups"] == {"ivanov": ["Терапия", "ИТ"]}
