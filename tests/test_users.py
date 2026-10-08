"""Пользователи системы: список и правка – только admin; смена своего пароля – любой роли.

Таблица users между тестами не чистится (там живут admin/editor/reader на всю сессию),
поэтому каждый тест заводит своих пользователей с уникальными логинами."""
import itertools

import pytest
from fastapi.testclient import TestClient

from conftest import https_client, ok
from main import app

_numbers = itertools.count(1)


def new_login(prefix="u"):
    return f"{prefix}{next(_numbers)}"


def create(admin, login=None, role="reader", password="secret1"):
    login = login or new_login()
    return ok(admin.post("/api/users", json={"login": login, "role": role, "password": password}))


def sign_in(login, password):
    client = https_client()
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
    # Логин хранится как ввели, вход – в любом регистре
    user = create(admin, login="  Ivanov.P ", role="editor")
    assert user["login"] == "Ivanov.P"
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
    # Роль читается при каждом запросе – действует сразу, без нового входа
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

    # Отключённые – в конце списка
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

    # То же значение – не изменение, не ошибка
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


# ---------- Этап 22: регистр логина, ФИО, должность, свой профиль, только https ----------


def test_login_case_and_duplicates(admin):
    create(admin, login="Petrov.A")

    for variant in ("petrov.a", "PETROV.A", "Petrov.A"):
        _, status = sign_in(variant, "secret1")
        assert status == 200, variant

    response = admin.post("/api/users", json={"login": "PETROV.a", "password": "secret1"})
    assert response.status_code == 409


def test_create_with_full_name(admin):
    user = ok(admin.post("/api/users", json={
        "login": new_login("fio"), "password": "secret1", "role": "reader",
        "full_name": "  Иванов   Иван  Иванович ", "position": "Инженер",
    }))
    assert user["full_name"] == "Иванов Иван Иванович"
    assert user["position"] == "Инженер"


def test_admin_edits_profile(admin):
    user = create(admin)
    other = create(admin)

    changed = ok(admin.patch(f"/api/users/{user['id']}", json={
        "login": "Sidorov.P", "full_name": "Сидоров Пётр", "position": "Врач",
    }))
    assert (changed["login"], changed["full_name"], changed["position"]) == ("Sidorov.P", "Сидоров Пётр", "Врач")

    # Вход – по новому логину, в любом регистре
    _, status = sign_in("sidorov.p", "secret1")
    assert status == 200

    # Занятый логин (без учёта регистра) – нельзя
    response = admin.patch(f"/api/users/{other['id']}", json={"login": "SIDOROV.P"})
    assert response.status_code == 409

    # Пустые ФИО и должность – очищаются
    cleared = ok(admin.patch(f"/api/users/{user['id']}", json={"full_name": "", "position": "  "}))
    assert cleared["full_name"] is None and cleared["position"] is None

    response = admin.patch(f"/api/users/{user['id']}", json={"login": "Сидоров"})
    assert response.status_code == 400


def test_edit_profile_only_admin(editor):
    response = editor.patch("/api/users/1", json={"full_name": "Кто-то"})
    assert response.status_code == 403


def test_own_profile_any_role(admin):
    login = new_login("self")
    create(admin, login=login, role="reader")
    client, _ = sign_in(login, "secret1")

    me = ok(client.patch("/api/auth/me/profile", json={
        "login": login.upper(), "full_name": "Кузнецова Ольга Петровна", "position": "Медсестра",
    }))
    assert me["login"] == login.upper()
    assert me["full_name"] == "Кузнецова Ольга Петровна"
    assert me["role"] == "reader"

    # Вход не прервался, данные видны в /me
    assert ok(client.get("/api/auth/me"))["position"] == "Медсестра"

    # Чужой логин занять нельзя
    response = client.patch("/api/auth/me/profile", json={"login": "ADMIN"})
    assert response.status_code == 409

    # В Истории – запись о пользователе (видит admin)
    records = ok(admin.get("/api/history", params={"entity": "users", "limit": 50}))["items"]
    record = next(r for r in records if r["entity_id"] == me["id"] and "full_name" in r["changes"])
    assert record["changes"]["full_name"]["new"] == "Кузнецова Ольга Петровна"


def test_undo_full_name(admin):
    user = create(admin)
    ok(admin.patch(f"/api/users/{user['id']}", json={"full_name": "Старое Имя"}))
    ok(admin.patch(f"/api/users/{user['id']}", json={"full_name": "Новое Имя"}))

    records = ok(admin.get("/api/history", params={"entity": "users", "entity_id": user["id"]}))["items"]
    last = next(r for r in records if r["changes"].get("full_name", {}).get("new") == "Новое Имя")
    ok(admin.post("/api/history/cancel", json={"items": [{"id": last["id"], "field": "full_name"}]}))

    users = ok(admin.get("/api/users"))
    assert next(u for u in users if u["id"] == user["id"])["full_name"] == "Старое Имя"


def test_http_refused(database):
    """Не по https (и не с самого сервера) – отказ, даже страница входа."""
    client = TestClient(app)  # http://testserver, адрес клиента «testclient»

    for url in ("/login.html", "/", "/api/auth/me"):
        response = client.get(url)
        assert response.status_code == 403, url
        assert "https" in response.text

    response = client.post("/api/auth/login", json={"login": "admin", "password": "admin-pass"})
    assert response.status_code == 403
    assert "set-cookie" not in response.headers


def test_http_from_server_itself(database):
    """С самого сервера (127.0.0.1) http разрешён – проверка curl'ом, туннель SSH."""
    client = TestClient(app, client=("127.0.0.1", 50000))
    assert client.get("/login.html").status_code == 200
