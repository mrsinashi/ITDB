"""Пользователи системы: список и правка — только admin; смена своего пароля — любой роли.

Таблица users между тестами не чистится (там живут admin/editor/reader на всю сессию),
поэтому каждый тест заводит своих пользователей с уникальными логинами."""
import itertools

import pytest
from fastapi.testclient import TestClient

from conftest import ok
from main import app

_numbers = itertools.count(1)


def new_login(prefix="u"):
    return f"{prefix}{next(_numbers)}"


def create(admin, login=None, role="reader", password="secret1"):
    login = login or new_login()
    return ok(admin.post("/api/users", json={"login": login, "role": role, "password": password}))


def sign_in(login, password):
    client = TestClient(app)
    response = client.post("/api/auth/login", json={"login": login, "password": password})
    return client, response.status_code


def test_list_only_admin(admin, editor, reader, anon):
    users = ok(admin.get("/api/users"))
    logins = [u["login"] for u in users]
    assert {"admin", "editor", "reader"} <= set(logins)
    assert next(u for u in users if u["login"] == "admin")["is_self"] is True

    assert editor.get("/api/users").status_code == 403
    assert reader.get("/api/users").status_code == 403
    assert anon.get("/api/users").status_code == 401


@pytest.mark.parametrize("method, url", [("post", "/api/users"), ("patch", "/api/users/1")])
def test_change_only_admin(editor, method, url):
    response = getattr(editor, method)(url, json={"login": "x1", "password": "secret1", "role": "reader"})
    assert response.status_code == 403


def test_create_and_login(admin):
    user = create(admin, login="  Ivanov.P ", role="editor")
    assert user["login"] == "ivanov.p"
    assert user["role"] == "editor"
    assert user["archived"] is False

    client, status = sign_in("IVANOV.P", "secret1")
    assert status == 200
    assert ok(client.get("/api/auth/me"))["role"] == "editor"


@pytest.mark.parametrize(
    "payload, text",
    [
        ({"login": "", "password": "secret1"}, "логин"),
        ({"login": "иванов", "password": "secret1"}, "латинские"),
        ({"login": "ok-login", "password": "123"}, "короткий"),
        ({"login": "ok-login", "password": "      "}, "пробелов"),
        ({"login": "ok-login", "password": "secret1", "role": "boss"}, "роль"),
    ],
)
def test_create_checks(admin, payload, text):
    response = admin.post("/api/users", json=payload)
    assert response.status_code == 400
    assert text in response.json()["detail"]


def test_create_duplicate(admin):
    user = create(admin)
    response = admin.post("/api/users", json={"login": user["login"].upper(), "password": "secret1"})
    assert response.status_code == 409


def test_change_role(admin):
    user = create(admin, role="reader")
    client, _ = sign_in(user["login"], "secret1")
    assert client.post("/api/field-defs", json={"key": "phone", "label": "Телефон"}).status_code == 403

    ok(admin.patch(f"/api/users/{user['id']}", json={"role": "editor"}))
    # Роль читается при каждом запросе — действует сразу, без нового входа
    assert ok(client.get("/api/auth/me"))["role"] == "editor"
    ok(client.post("/api/field-defs", json={"key": "phone", "label": "Телефон"}))


def test_reset_password_ends_sessions(admin):
    user = create(admin)
    client, _ = sign_in(user["login"], "secret1")

    ok(admin.patch(f"/api/users/{user['id']}", json={"password": "newpass1"}))

    assert client.get("/api/auth/me").status_code == 401
    assert sign_in(user["login"], "secret1")[1] == 401
    assert sign_in(user["login"], "newpass1")[1] == 200


def test_disable_and_enable(admin):
    user = create(admin)
    client, _ = sign_in(user["login"], "secret1")

    row = ok(admin.patch(f"/api/users/{user['id']}", json={"archived": True}))
    assert row["archived"] is True
    assert client.get("/api/auth/me").status_code == 401
    assert sign_in(user["login"], "secret1")[1] == 401

    # Отключённые — в конце списка
    users = ok(admin.get("/api/users"))
    assert users[-1]["archived"] is True

    ok(admin.patch(f"/api/users/{user['id']}", json={"archived": False}))
    assert sign_in(user["login"], "secret1")[1] == 200


def test_admin_cannot_demote_or_disable_self(admin):
    me = ok(admin.get("/api/auth/me"))

    response = admin.patch(f"/api/users/{me['id']}", json={"role": "reader"})
    assert response.status_code == 400
    response = admin.patch(f"/api/users/{me['id']}", json={"archived": True})
    assert response.status_code == 400

    # То же значение — не изменение, не ошибка
    ok(admin.patch(f"/api/users/{me['id']}", json={"role": "admin", "archived": False}))
    assert ok(admin.get("/api/auth/me"))["role"] == "admin"


def test_missing_user(admin):
    assert admin.patch("/api/users/999999", json={"role": "reader"}).status_code == 404


def test_change_own_password(admin):
    user = create(admin, role="reader")
    client, _ = sign_in(user["login"], "secret1")
    other, _ = sign_in(user["login"], "secret1")   # второй вход (другой компьютер)

    response = client.post("/api/auth/me/password", json={"current": "wrong", "new": "newpass1"})
    assert response.status_code == 400
    response = client.post("/api/auth/me/password", json={"current": "secret1", "new": "123"})
    assert response.status_code == 400
    response = client.post("/api/auth/me/password", json={"current": "secret1", "new": "secret1"})
    assert response.status_code == 400

    ok(client.post("/api/auth/me/password", json={"current": "secret1", "new": "newpass1"}))

    # Этот вход остаётся, другие завершены
    assert client.get("/api/auth/me").status_code == 200
    assert other.get("/api/auth/me").status_code == 401
    assert sign_in(user["login"], "newpass1")[1] == 200


def test_change_own_password_rate_limit(admin):
    user = create(admin)
    client, _ = sign_in(user["login"], "secret1")

    for _ in range(5):
        client.post("/api/auth/me/password", json={"current": "wrong", "new": "newpass1"})

    response = client.post("/api/auth/me/password", json={"current": "secret1", "new": "newpass1"})
    assert response.status_code == 429


def test_accent_header_users_page(reader):
    prefs = ok(reader.patch("/api/auth/me/prefs", json={"accent_headers": {"users": False}}))["prefs"]
    assert prefs["accent_headers"]["users"] is False
