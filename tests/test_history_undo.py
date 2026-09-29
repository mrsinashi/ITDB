"""Отмена изменений из Истории, возврат значения, фильтры Истории (этап 19)."""
from conftest import add_computer, add_location, get_row, ok


def history_of(client, computer_id, field):
    return ok(client.get("/api/history/value", params={
        "entity": "computers", "entity_id": computer_id, "field": field,
    }))


def set_os(client, computer_id, *values):
    for value in values:
        ok(client.patch(f"/api/computers/{computer_id}", json={"os": value}))


def cancel(client, items, cancel=True, status=200):
    return ok(client.post("/api/history/cancel", json={"items": items, "cancel": cancel}), status)


def test_cancel_last_change_restores_value(editor, room):
    pc = add_computer(editor, room["room"], hostname="pc-1")
    set_os(editor, pc, "Win 7", "Win 10")

    items = history_of(editor, pc, "os")["items"]
    assert [i["new"] for i in items] == ["Win 10", "Win 7"]

    assert cancel(editor, [{"id": items[0]["id"], "field": "os"}])["count"] == 1
    assert get_row(editor, pc)["os"] == "Win 7"

    value = history_of(editor, pc, "os")
    assert value["items"][0]["cancelled"]["by"] == "editor"
    assert value["current"] == "Win 7"


def test_cancel_middle_change_keeps_value(editor, room):
    pc = add_computer(editor, room["room"], hostname="pc-1")
    set_os(editor, pc, "A", "B", "C")
    items = history_of(editor, pc, "os")["items"]   # C, B, A

    cancel(editor, [{"id": items[1]["id"], "field": "os"}])
    assert get_row(editor, pc)["os"] == "C"

    # Отменены все — значение исходное (до первого изменения)
    cancel(editor, [{"id": items[0]["id"]}, {"id": items[2]["id"]}])
    assert get_row(editor, pc)["os"] is None

    # Восстановить последнее — снова C
    cancel(editor, [{"id": items[0]["id"]}], cancel=False)
    assert get_row(editor, pc)["os"] == "C"


def test_cancelled_records_hidden_and_not_counted(editor, room):
    pc = add_computer(editor, room["room"], hostname="pc-1")
    set_os(editor, pc, "A")
    before = ok(editor.get("/api/history"))
    record = before["items"][0]

    cancel(editor, [{"id": record["id"]}])

    after = ok(editor.get("/api/history"))
    assert after["total"] == before["total"] - 1
    assert record["id"] not in [i["id"] for i in after["items"]]

    shown = ok(editor.get("/api/history", params={"cancelled": True}))
    assert shown["total"] == before["total"]
    item = next(i for i in shown["items"] if i["id"] == record["id"])
    assert item["cancelled"] is True
    assert item["changes"]["os"]["cancelled"]


def test_cancel_one_field_of_record(editor, room):
    pc = add_computer(editor, room["room"], hostname="pc-1")
    ok(editor.patch(f"/api/computers/{pc}", json={"os": "A", "cpu": "i5"}))
    record = ok(editor.get("/api/history"))["items"][0]

    cancel(editor, [{"id": record["id"], "field": "os"}])
    row = get_row(editor, pc)
    assert row["os"] is None and row["cpu"] == "i5"

    # Запись отменена не целиком — видна и считается
    data = ok(editor.get("/api/history"))
    item = next(i for i in data["items"] if i["id"] == record["id"])
    assert item["cancelled"] is False


def test_revert_to_point_writes_record(editor, room):
    pc = add_computer(editor, room["room"], hostname="pc-1")
    set_os(editor, pc, "A", "B", "C")
    items = history_of(editor, pc, "os")["items"]   # C, B, A

    ok(editor.post("/api/history/revert", json={"id": items[2]["id"], "field": "os"}))
    assert get_row(editor, pc)["os"] == "A"

    latest = history_of(editor, pc, "os")["items"][0]
    assert latest["old"] == "C" and latest["new"] == "A" and latest["revert"] is True

    # Исходное значение — «было» первого изменения
    ok(editor.post("/api/history/revert", json={"id": items[0]["id"], "field": "os", "initial": True}))
    assert get_row(editor, pc)["os"] is None

    # То же значение ещё раз — не нужно
    response = editor.post("/api/history/revert", json={"id": items[0]["id"], "field": "os", "initial": True})
    assert response.status_code == 400


def test_changed_outside_history_is_refused(editor, room):
    """В старых записях расположение — путь текстом; узел переименовали —
    путь не найти, отмена не выполняется."""
    pc = add_computer(editor, room["room"], hostname="pc-1")
    other = add_location(editor, "room", "Процедурная", room["department"], code="202")
    ok(editor.patch(f"/api/computers/{pc}", json={"location_id": other}))

    record = ok(editor.get("/api/history"))["items"][0]
    change = record["changes"]["location_id"]
    assert change["old_id"] == room["room"] and change["new_id"] == other

    # С id узлов отмена работает и после переименования
    ok(editor.patch(f"/api/locations/{room['room']}", json={"name": "Ординаторская 2"}))
    cancel(editor, [{"id": record["id"]}])
    assert get_row(editor, pc)["location_id"] == room["room"]


def test_legacy_location_path_resolved(editor, room):
    from db import SessionLocal
    from models import History

    pc = add_computer(editor, room["room"], hostname="pc-1")
    other = add_location(editor, "room", "Процедурная", room["department"], code="202")
    ok(editor.patch(f"/api/computers/{pc}", json={"location_id": other}))
    record_id = ok(editor.get("/api/history"))["items"][0]["id"]

    # Как в записях до этапа 19: без id узлов
    session = SessionLocal()
    record = session.get(History, record_id)
    change = dict(record.changes["location_id"])
    change.pop("old_id")
    change.pop("new_id")
    record.changes = {"location_id": change}
    session.commit()
    session.close()

    cancel(editor, [{"id": record_id}])
    assert get_row(editor, pc)["location_id"] == room["room"]

    # Узел переименовали — старый путь уже не найти: восстановление отказывает
    ok(editor.patch(f"/api/locations/{other}", json={"name": "Другая"}))
    response = editor.post("/api/history/cancel", json={"items": [{"id": record_id}], "cancel": False})
    assert response.status_code == 400
    assert get_row(editor, pc)["location_id"] == room["room"]


def test_value_changed_without_history_is_refused(editor, room):
    from db import SessionLocal
    from models import Computer

    pc = add_computer(editor, room["room"], hostname="pc-1")
    set_os(editor, pc, "A")
    record_id = history_of(editor, pc, "os")["items"][0]["id"]

    session = SessionLocal()
    session.get(Computer, pc).os = "руками"
    session.commit()
    session.close()

    response = editor.post("/api/history/cancel", json={"items": [{"id": record_id}]})
    assert response.status_code == 409
    assert "не через историю" in response.json()["detail"]
    assert get_row(editor, pc)["os"] == "руками"


def test_created_cannot_be_cancelled(editor, room):
    pc = add_computer(editor, room["room"], hostname="pc-1")
    created = history_of(editor, pc, "created")["items"][0]

    response = editor.post("/api/history/cancel", json={"items": [{"id": created["id"]}]})
    assert response.status_code == 400
    assert get_row(editor, pc) is not None


def test_cancel_archive_and_extra_and_user(editor, room):
    pc = add_computer(editor, room["room"], hostname="pc-1")
    ok(editor.patch(f"/api/computers/{pc}", json={"label": "Мед", "user": "Иванов", "vacuum": "u1\nu2"}))
    record = ok(editor.get("/api/history"))["items"][0]
    assert set(record["changes"]) == {"extra.Метка", "user", "vacuum"}

    ok(editor.post("/api/computers/archive", json={"ids": [pc], "archived": True}))
    archived = ok(editor.get("/api/history"))["items"][0]

    cancel(editor, [{"id": archived["id"]}, {"id": record["id"]}])
    row = get_row(editor, pc)
    assert row["archived"] is False
    assert row["label"] is None and row["user"] is None and row["vacuum"] is None


def test_seat_revert_shifts_neighbours(editor, room):
    first = add_computer(editor, room["room"], hostname="pc-1", seat_no=1)
    second = add_computer(editor, room["room"], hostname="pc-2", seat_no=2)
    ok(editor.patch(f"/api/computers/{second}", json={"seat_no": 5}))
    ok(editor.patch(f"/api/computers/{first}", json={"seat_no": 2}))

    items = history_of(editor, second, "seat_no")["items"]   # 2 → 5; создан с № 2
    assert items[1]["new"] == 2
    result = ok(editor.post("/api/history/revert", json={"id": items[1]["id"], "field": "seat_no"}))
    # № 2 занят первым ПК — он сдвинулся на 3
    assert result["shifted"] == [first]
    assert get_row(editor, second)["seat_no"] == 2
    assert get_row(editor, first)["seat_no"] == 3


def test_location_rename_and_archive_undo(editor, room):
    ok(editor.patch(f"/api/locations/{room['department']}", json={"name": "Кардиология"}))
    rename = ok(editor.get("/api/history", params={"entity": "locations"}))["items"][0]

    spare = add_location(editor, "room", "Пустой", room["department"], code="299")
    ok(editor.post(f"/api/locations/{spare}/archive"))
    archived = ok(editor.get("/api/history", params={"entity": "locations"}))["items"][0]

    cancel(editor, [{"id": rename["id"]}, {"id": archived["id"]}])

    tree = ok(editor.get("/api/locations/tree"))
    text = str(tree)
    assert "Терапия" in text and "Кардиология" not in text and "Пустой" in text


def test_reader_cannot_cancel_or_revert(reader, editor, room):
    pc = add_computer(editor, room["room"], hostname="pc-1")
    set_os(editor, pc, "A")
    record_id = history_of(reader, pc, "os")["items"][0]["id"]

    assert reader.post("/api/history/cancel", json={"items": [{"id": record_id}]}).status_code == 403
    assert reader.post("/api/history/revert", json={"id": record_id, "field": "os"}).status_code == 403


def test_history_filters(admin, editor, room):
    pc = add_computer(editor, room["room"], hostname="pc-1")
    other = add_computer(editor, room["room"], hostname="pc-2")
    set_os(admin, pc, "A")
    set_os(editor, other, "B")

    data = ok(editor.get("/api/history", params={"user": "admin"}))
    assert data["total"] == 1 and data["items"][0]["entity_id"] == pc
    assert {"admin", "editor"} <= set(data["users"])

    data = ok(editor.get("/api/history", params={"entity": "computers", "entity_id": other}))
    assert {i["entity_id"] for i in data["items"]} == {other}
    assert data["total"] == 2   # создание + правка

    data = ok(editor.get("/api/history", params={"entity": "locations"}))
    assert {i["entity"] for i in data["items"]} == {"locations"}
    assert data["total"] == sum(data["days"].values())
