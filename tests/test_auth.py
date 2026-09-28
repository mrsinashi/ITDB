"""Вход, сессия и роли: reader только читает, импорт — только admin."""
import pytest

from conftest import add_computer, ok


def test_login_and_me(admin):
    me = ok(admin.get("/api/auth/me"))
    assert me["login"] == "admin"
    assert me["role"] == "admin"


def test_wrong_password(anon):
    response = anon.post("/api/auth/login", json={"login": "admin", "password": "нет"})
    assert response.status_code == 401


def test_login_rate_limit(anon):
    for _ in range(5):
        anon.post("/api/auth/login", json={"login": "admin", "password": "нет"})

    # После пяти неудачных попыток не пускает даже с верным паролем
    response = anon.post("/api/auth/login", json={"login": "admin", "password": "admin-pass"})
    assert response.status_code == 429


def test_without_login_401(anon):
    assert anon.get("/api/computers").status_code == 401
    assert anon.get("/api/export/computers.xlsx").status_code == 401


def test_logout(anon):
    response = anon.post("/api/auth/login", json={"login": "reader", "password": "reader-pass"})
    assert response.status_code == 200
    assert anon.get("/api/auth/me").status_code == 200

    ok(anon.post("/api/auth/logout"))
    assert anon.get("/api/auth/me").status_code == 401


@pytest.mark.parametrize(
    "method, url, payload",
    [
        ("post", "/api/computers", {"location_id": 1}),
        ("patch", "/api/computers/1", {"note": "x"}),
        ("post", "/api/computers/archive", {"ids": [1], "archived": True}),
        ("post", "/api/locations", {"kind": "building", "name": "Адрес"}),
        ("post", "/api/field-defs", {"key": "phone", "label": "Телефон"}),
        ("post", "/api/choices", {"field": "os", "value": "Win 10"}),
        ("patch", "/api/column-styles/os", {"bold": True}),
    ],
)
def test_reader_cannot_change(reader, method, url, payload):
    response = getattr(reader, method)(url, json=payload)
    assert response.status_code == 403


def test_reader_can_read(reader, editor, room):
    add_computer(editor, room["room"], hostname="ter-201-1")

    assert ok(reader.get("/api/computers"))["total"] == 1
    assert ok(reader.get("/api/locations/tree"))["roots"]
    assert ok(reader.get("/api/history"))["items"]


def test_import_only_admin(editor):
    response = editor.post(
        "/api/import/apply",
        files={"file": ("list.xlsx", b"", "application/octet-stream")},
        data={"confirm": "false"},
    )
    assert response.status_code == 403
