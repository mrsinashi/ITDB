"""Этап 15: сдвиг номеров мест, переместить, поменять местами, заменить,
изменить поле у выбранных."""
import pytest

from conftest import add_computer, add_location, get_row, ok


def seats(client, location_id):
    """{hostname: № места} ПК узла в порядке таблицы."""
    rows = ok(client.get("/api/computers"))["rows"]
    return [(row["hostname"], row["seat_no"]) for row in rows if row["location_id"] == location_id]


def history(client, computer_id):
    return ok(client.get(f"/api/computers/{computer_id}"))["history"]


@pytest.fixture
def five(editor, room):
    """Кабинет с ПК на местах 1…5 (имена pc1…pc5)."""
    return [add_computer(editor, room["room"], seat_no=str(n), hostname=f"pc{n}") for n in range(1, 6)]


# ---------- Сдвиг номеров ----------


def test_create_on_taken_seat_shifts(editor, room, five):
    data = ok(editor.post("/api/computers", json={"location_id": room["room"], "seat_no": "3", "hostname": "new"}))
    assert data["shifted"] == five[2:]

    assert seats(editor, room["room"]) == [
        ("pc1", 1), ("pc2", 2), ("new", 3), ("pc3", 4), ("pc4", 5), ("pc5", 6),
    ]
    assert history(editor, five[2])[0]["changes"] == {"seat_no": {"old": 3, "new": 4}}


def test_shift_stops_at_gap(editor, room):
    for n in (1, 2, 3, 5):
        add_computer(editor, room["room"], seat_no=str(n), hostname=f"pc{n}")

    add_computer(editor, room["room"], seat_no="2", hostname="new")

    assert seats(editor, room["room"]) == [
        ("pc1", 1), ("new", 2), ("pc2", 3), ("pc3", 4), ("pc5", 5),
    ]


def test_archived_do_not_take_seats(editor, room, five):
    ok(editor.post("/api/computers/archive", json={"ids": [five[2]], "archived": True}))

    data = ok(editor.post("/api/computers", json={"location_id": room["room"], "seat_no": "3"}))
    assert data["shifted"] == []


def test_patch_seat_reorders(editor, room, five):
    """№ места 5 → 2: 2, 3, 4 сдвигаются на 3, 4, 5, строка встаёт на место."""
    data = ok(editor.patch(f"/api/computers/{five[4]}", json={"seat_no": "2"}))
    assert data["shifted"] == five[1:4]

    assert seats(editor, room["room"]) == [
        ("pc1", 1), ("pc5", 2), ("pc2", 3), ("pc3", 4), ("pc4", 5),
    ]


# ---------- Переместить ----------


def test_move_block_with_numbers(editor, room, five):
    other = add_location(editor, "room", "Процедурная", room["department"], code="202")
    first = add_computer(editor, other, seat_no="1", hostname="o1")
    second = add_computer(editor, other, seat_no="2", hostname="o2")

    data = ok(editor.post("/api/computers/move", json={
        "ids": [five[3], five[0]], "location_id": other, "seat_no": "2",
    }))
    assert set(data["changed"]) == {five[3], five[0], second}

    assert seats(editor, other) == [("o1", 1), ("pc4", 2), ("pc1", 3), ("o2", 4)]
    assert get_row(editor, first)["seat_no"] == 1

    changes = history(editor, five[3])[0]["changes"]
    assert changes["location_id"]["new"] == "ул. Ленина, 1 / Терапия / 202 Процедурная"
    assert changes["seat_no"] == {"old": 4, "new": 2}


def test_move_without_number_goes_last(editor, room, five):
    store = add_location(editor, "room", "Склад", room["department"], code="299")
    add_computer(editor, store, seat_no="1", hostname="s1")

    ok(editor.post("/api/computers/move", json={"ids": [five[0]], "location_id": store, "seat_no": ""}))
    assert seats(editor, store) == [("s1", 1), ("pc1", None)]


def test_move_with_and_without_people(editor, room, five):
    ok(editor.patch(f"/api/computers/{five[0]}", json={"user": "Иванов", "vacuum": "user1"}))
    ok(editor.patch(f"/api/computers/{five[1]}", json={"user": "Петрова", "vacuum": "user2"}))
    store = add_location(editor, "room", "Склад", room["department"], code="299")

    ok(editor.post("/api/computers/move", json={"ids": [five[0]], "location_id": store}))
    row = get_row(editor, five[0])
    assert (row["user"], row["vacuum"]) == ("Иванов", "user1")

    ok(editor.post("/api/computers/move", json={"ids": [five[1]], "location_id": store, "with_people": False}))
    row = get_row(editor, five[1])
    assert (row["user"], row["vacuum"]) == (None, None)
    changes = history(editor, five[1])[0]["changes"]
    assert changes["user"] == {"old": "Петрова", "new": None}
    assert changes["vacuum"] == {"old": "user2", "new": None}


def test_move_errors(editor, reader, room, five):
    assert editor.post("/api/computers/move", json={"ids": [five[0]], "location_id": None}).status_code == 400
    assert editor.post("/api/computers/move", json={"ids": [], "location_id": room["room"]}).status_code == 400
    assert editor.post("/api/computers/move", json={"ids": [999], "location_id": room["room"]}).status_code == 404
    assert reader.post("/api/computers/move", json={"ids": [five[0]], "location_id": room["room"]}).status_code == 403

    ok(editor.post("/api/computers/archive", json={"ids": [five[0]], "archived": True}))
    assert editor.post("/api/computers/move", json={"ids": [five[0]], "location_id": room["room"]}).status_code == 400


# ---------- Поменять местами ----------


def test_swap(editor, room, five):
    other = add_location(editor, "room", "Процедурная", room["department"], code="202")
    lone = add_computer(editor, other, seat_no="7", hostname="lone")
    ok(editor.patch(f"/api/computers/{five[1]}", json={"user": "Иванов"}))

    ok(editor.post("/api/computers/swap", json={"ids": [five[1], lone]}))

    assert seats(editor, room["room"]) == [("pc1", 1), ("lone", 2), ("pc3", 3), ("pc4", 4), ("pc5", 5)]
    assert seats(editor, other) == [("pc2", 7)]
    # Пользователь остаётся при своём ПК
    assert get_row(editor, five[1])["user"] == "Иванов"


def test_swap_needs_two(editor, five):
    assert editor.post("/api/computers/swap", json={"ids": five[:3]}).status_code == 400


# ---------- Заменить ----------


def test_replace(editor, room, five):
    store = add_location(editor, "room", "Склад", room["department"], code="299")
    spare = add_computer(editor, store, seat_no="1", hostname="spare")
    ok(editor.patch(f"/api/computers/{spare}", json={"user": "Старый хозяин", "status": "склад"}))
    ok(editor.patch(f"/api/computers/{five[2]}", json={"user": "Иванов", "vacuum": "user3"}))

    ok(editor.post("/api/computers/replace", json={
        "old_id": five[2], "new_id": spare, "location_id": store,
    }))

    assert seats(editor, room["room"]) == [
        ("pc1", 1), ("pc2", 2), ("spare", 3), ("pc4", 4), ("pc5", 5),
    ]
    new = get_row(editor, spare)
    assert (new["status"], new["user"], new["vacuum"]) == ("установлен", "Иванов", "user3")

    old = get_row(editor, five[2])
    assert (old["location_id"], old["seat_no"], old["status"]) == (store, None, "склад")
    assert (old["user"], old["vacuum"]) == (None, None)

    changes = history(editor, spare)[0]["changes"]
    assert changes["replaced"] == {"old": None, "new": "pc3"}
    assert changes["user"] == {"old": "Старый хозяин", "new": "Иванов"}


def test_replace_without_people(editor, room, five):
    store = add_location(editor, "room", "Склад", room["department"], code="299")
    spare = add_computer(editor, store, hostname="spare")
    ok(editor.patch(f"/api/computers/{five[0]}", json={"user": "Иванов"}))

    ok(editor.post("/api/computers/replace", json={
        "old_id": five[0], "new_id": spare, "location_id": store, "with_people": False,
    }))

    assert get_row(editor, five[0])["user"] == "Иванов"
    assert get_row(editor, spare)["user"] is None


def test_replace_errors(editor, room, five):
    body = {"old_id": five[0], "new_id": five[0], "location_id": room["room"]}
    assert editor.post("/api/computers/replace", json=body).status_code == 400

    body = {"old_id": five[0], "new_id": five[1], "location_id": 999}
    assert editor.post("/api/computers/replace", json=body).status_code == 400


# ---------- Изменить поле у выбранных ----------


def test_bulk_update(editor, room, five):
    ok(editor.patch(f"/api/computers/{five[0]}", json={"os": "Win 10"}))

    data = ok(editor.post("/api/computers/bulk-update", json={
        "ids": five[:3], "field": "os", "value": "Win 10",
    }))
    assert data["changed"] == five[1:3]
    assert [get_row(editor, i)["os"] for i in five[:3]] == ["Win 10"] * 3

    ok(editor.post("/api/computers/bulk-update", json={"ids": five[:2], "field": "label", "value": "Мед"}))
    assert get_row(editor, five[1])["label"] == "Мед"

    ok(editor.post("/api/computers/bulk-update", json={"ids": five[:2], "field": "os", "value": ""}))
    assert get_row(editor, five[0])["os"] is None


@pytest.mark.parametrize("field", ["hostname", "ip", "seat_no", "location_id", "nonexistent", ""])
def test_bulk_bad_field(editor, five, field):
    response = editor.post("/api/computers/bulk-update", json={"ids": five[:2], "field": field, "value": "x"})
    assert response.status_code == 400
