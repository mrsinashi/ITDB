"""Сессия базы на запрос (get_db) и общий обработчик непредвиденных ошибок."""
from fastapi.testclient import TestClient

import api_computers
from conftest import PASSWORDS, add_computer, ok
from db import engine
from main import app


def client_without_raise(role="editor"):
    """Клиент, который отдаёт ответ 500, а не пробрасывает ошибку в тест."""
    client = TestClient(app, raise_server_exceptions=False)
    ok(client.post("/api/auth/login", json={"login": role, "password": PASSWORDS[role]}))
    return client


def test_unexpected_error_is_rolled_back(room, monkeypatch):
    client = client_without_raise()

    def broken(*args, **kwargs):
        raise RuntimeError("проверочный сбой\nподробности только в журнале")

    # Сбой после того, как ПК уже записан в сессию (перед записью истории)
    monkeypatch.setattr(api_computers, "location_path", broken)

    response = client.post("/api/computers", json={"location_id": room["room"], "hostname": "x"})
    assert response.status_code == 500
    assert response.json()["detail"] == "Ошибка на сервере: проверочный сбой"

    monkeypatch.undo()

    rows = ok(client.get("/api/computers", params={"archived": "all"}))["rows"]
    assert rows == []
    items = ok(client.get("/api/history"))["items"]
    assert [item for item in items if item["entity"] == "computers"] == []


def test_expected_errors_keep_their_status(editor, room):
    computer_id = add_computer(editor, room["room"])

    assert editor.get("/api/computers/999999").status_code == 404
    assert editor.patch(f"/api/computers/{computer_id}", json={"nope": 1}).status_code == 400
    assert editor.get("/api/computers", params={"archived": "maybe"}).status_code == 400


def test_sessions_return_to_pool(editor, reader, room):
    computer_id = add_computer(editor, room["room"])

    for _ in range(5):
        ok(editor.get("/api/computers"))
        ok(editor.get(f"/api/computers/{computer_id}"))
        editor.get("/api/computers/999999")
        reader.patch(f"/api/computers/{computer_id}", json={"os": "x"})
        ok(editor.patch(f"/api/computers/{computer_id}", json={"os": "Win 10"}))
        assert reader.get("/api/export/computers.xlsx").status_code == 200

    assert engine.pool.checkedout() == 0
