"""Пользовательские поля: ключи, занятые встроенными полями, не принимаются."""
import pytest

from conftest import add_computer, get_row, ok


@pytest.mark.parametrize(
    "key",
    ["hostname", "IP", "gsit", "метка", "archived", "location_id", "1abc", "has space", "a" * 41],
)
def test_bad_keys(editor, key):
    response = editor.post("/api/field-defs", json={"key": key, "label": "Поле"})
    assert response.status_code == 400


def test_user_field_in_rows(editor, room):
    ok(editor.post("/api/field-defs", json={"key": "room_phone", "label": "Телефон"}))

    items = ok(editor.get("/api/field-defs"))["items"]
    assert [(item["key"], item["reserved"]) for item in items] == [("room_phone", False)]

    computer_id = add_computer(editor, room["room"])
    data = ok(editor.patch(f"/api/computers/{computer_id}", json={"room_phone": " 12-34 "}))
    assert data["updated"]["room_phone"] == "12-34"
    assert data["changes"]["extra.room_phone"] == {"old": None, "new": "12-34"}

    assert get_row(editor, computer_id)["room_phone"] == "12-34"


def test_duplicate_key(editor):
    ok(editor.post("/api/field-defs", json={"key": "phone", "label": "Телефон"}))
    response = editor.post("/api/field-defs", json={"key": "phone", "label": "Ещё"})
    assert response.status_code == 400


def test_archived_field_leaves_rows(editor, room):
    field_id = ok(editor.post("/api/field-defs", json={"key": "phone", "label": "Телефон"}))["id"]
    computer_id = add_computer(editor, room["room"])

    ok(editor.post(f"/api/field-defs/{field_id}/archive"))

    assert "phone" not in get_row(editor, computer_id)
    response = editor.patch(f"/api/computers/{computer_id}", json={"phone": "1"})
    assert response.status_code == 400
