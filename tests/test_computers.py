"""Список, карточка, добавление и правка ПК, смена расположения, история."""
from conftest import add_computer, add_location, get_row, ok


def test_create_computer(editor, room):
    computer_id = add_computer(editor, room["room"], seat_no="2", hostname=" ter-201-2 ", ip="10.0.2.12")

    row = get_row(editor, computer_id)
    assert row["hostname"] == "ter-201-2"
    assert row["ip"] == "10.0.2.12"
    assert row["seat_no"] == 2
    assert row["status"] == "установлен"
    assert row["building"] == "ул. Ленина, 1"
    assert row["department"] == "Терапия"
    assert row["room_code"] == "201"
    assert row["room_name"] == "Ординаторская"
    assert row["archived"] is False

    history = ok(editor.get(f"/api/computers/{computer_id}"))["history"]
    assert len(history) == 1
    changes = history[0]["changes"]
    assert changes["created"]["new"] == "ул. Ленина, 1 / Терапия / 201 Ординаторская"
    assert changes["hostname"]["new"] == "ter-201-2"
    assert history[0]["user_name"] == "editor"


def test_create_needs_location(editor):
    response = editor.post("/api/computers", json={"hostname": "x"})
    assert response.status_code == 400

    response = editor.post("/api/computers", json={"location_id": 999})
    assert response.status_code == 400


def test_seat_no_must_be_integer(editor, room):
    response = editor.post("/api/computers", json={"location_id": room["room"], "seat_no": "2,5"})
    assert response.status_code == 400


def test_rows_sorted_by_seat(editor, room):
    third = add_computer(editor, room["room"], seat_no="3", hostname="c")
    first = add_computer(editor, room["room"], seat_no="1", hostname="a")
    second = add_computer(editor, room["room"], seat_no="2", hostname="b")

    rows = ok(editor.get("/api/computers"))["rows"]
    assert [row["id"] for row in rows] == [first, second, third]


def test_patch_and_history(editor, room):
    computer_id = add_computer(editor, room["room"], hostname="ter-201-1")
    version = get_row(editor, computer_id)["version"]

    data = ok(editor.patch(
        f"/api/computers/{computer_id}",
        json={
            "_version": version,
            "os": "Win 10",
            "mac": "aa:bb:cc:dd:ee:ff, 11:22:33:44:55:66",
            "ip": "10.0.2.11 10.0.9.1",
            "user": "Иванов  Иван",
            "vacuum": "user1\nuser2",
            "gsit": "есть",
        },
    ))
    assert data["updated"]["mac"] == "AA:BB:CC:DD:EE:FF\n11:22:33:44:55:66"
    assert data["updated"]["ip"] == "10.0.2.11\n10.0.9.1"
    assert data["updated"]["user"] == "Иванов Иван"
    assert data["updated"]["vacuum"] == "user1\nuser2"
    assert data["updated"]["version"] == version + 1

    row = get_row(editor, computer_id)
    assert row["os"] == "Win 10"
    assert row["gsit"] == "есть"

    card = ok(editor.get(f"/api/computers/{computer_id}"))
    assert card["people"][0]["full_name"] == "Иванов Иван"
    assert card["vacuum"] == ["user1", "user2"]
    changes = card["history"][0]["changes"]
    assert changes["os"] == {"old": None, "new": "Win 10"}
    assert changes["extra.GSIT"] == {"old": None, "new": "есть"}


def test_patch_without_changes_keeps_version(editor, room):
    computer_id = add_computer(editor, room["room"], hostname="a")
    version = get_row(editor, computer_id)["version"]

    data = ok(editor.patch(f"/api/computers/{computer_id}", json={"hostname": "a"}))
    assert data["changes"] == {}
    assert data["updated"]["version"] == version


def test_patch_stale_version_409(editor, admin, room):
    computer_id = add_computer(editor, room["room"], hostname="a")
    version = get_row(editor, computer_id)["version"]

    ok(admin.patch(f"/api/computers/{computer_id}", json={"_version": version, "os": "Win 11"}))

    response = editor.patch(f"/api/computers/{computer_id}", json={"_version": version, "os": "Win 7"})
    assert response.status_code == 409
    assert get_row(editor, computer_id)["os"] == "Win 11"


def test_patch_unknown_field(editor, room):
    computer_id = add_computer(editor, room["room"])
    response = editor.patch(f"/api/computers/{computer_id}", json={"archived": True})
    assert response.status_code == 400


def test_patch_missing_computer(editor):
    assert editor.patch("/api/computers/999", json={"os": "x"}).status_code == 404
    assert editor.get("/api/computers/999").status_code == 404


def test_change_location(editor, room):
    other = add_location(editor, "room", "Процедурная", room["department"], code="202")
    computer_id = add_computer(editor, room["room"], seat_no="1", hostname="a")

    data = ok(editor.patch(f"/api/computers/{computer_id}", json={"location_id": other}))
    assert data["updated"]["room_code"] == "202"
    assert data["changes"]["location_id"] == {
        "old": "ул. Ленина, 1 / Терапия / 201 Ординаторская",
        "new": "ул. Ленина, 1 / Терапия / 202 Процедурная",
        # id узлов – для отмены из истории (этап 19)
        "old_id": room["room"],
        "new_id": other,
    }

    assert get_row(editor, computer_id)["location_id"] == other


def test_duplicate_values_are_saved(editor, room):
    """Дубли не блокируют сохранение (только подсветка на экране)."""
    add_computer(editor, room["room"], hostname="same", ip="10.0.0.1")
    add_computer(editor, room["room"], hostname="same", ip="10.0.0.1")

    assert ok(editor.get("/api/computers"))["total"] == 2


def test_history_list(editor, room):
    computer_id = add_computer(editor, room["room"], hostname="ter-201-1")

    items = ok(editor.get("/api/history"))["items"]
    computer_items = [item for item in items if item["entity"] == "computers"]
    assert computer_items[0]["entity_id"] == computer_id
    assert computer_items[0]["title"] == "ter-201-1"
