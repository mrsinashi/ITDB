"""Этап 58: перенос кабинета в другое отделение (схема пользователя 14.10).

Из ячейки «Кабинет»: весь кабинет (сам узел с ПК и принтерами; «Оставить» – на старом месте
пустой такой же) или только ПК / принтер (в новом отделении – такой же кабинет). В Структуре –
место в форме «Изменить кабинет». Ctrl+Z отменяет перенос целиком, созданный кабинет – в архив.
"""
import pytest

from conftest import add_location, add_pc, get_row, history, ok


@pytest.fixture
def tree(editor, room):
    """Терапия (кабинеты 105, 201 «Ординаторская» с правилом имён, 305) и Хирургия (110, 410)
    на ул. Ленина, 1; Поликлиника с этажом 2 на ул. Мира, 5."""
    ids = dict(room)
    ids["t105"] = add_location(editor, "room", None, room["department"], code="105")
    ok(editor.patch(f"/api/locations/{ids['t105']}", json={"sort": 0}))
    ids["t305"] = add_location(editor, "room", None, room["department"], code="305")
    ok(editor.patch("/api/naming/nodes", json={"items": [{"id": room["room"], "part": "ord"}]}))
    ids["surgery"] = add_location(editor, "department", "Хирургия", room["building"])
    ids["s110"] = add_location(editor, "room", None, ids["surgery"], code="110")
    ids["s410"] = add_location(editor, "room", None, ids["surgery"], code="410")
    clinic_building = add_location(editor, "building", "ул. Мира, 5")
    ids["clinic"] = add_location(editor, "department", "Поликлиника", clinic_building)
    ids["floor"] = add_location(editor, "floor", "2", ids["clinic"])
    return ids


def nodes(client):
    """Узлы дерева: id → узел (с parent_id), и дети по порядку."""
    found = {}

    def walk(items):
        for item in items:
            found[item["id"]] = item
            walk(item["children"])

    walk(ok(client.get("/api/locations/tree"))["roots"])
    return found


def children(client, parent_id):
    return [(child["code"] or child["name"]) for child in nodes(client)[parent_id]["children"]]


def move(client, room_id, **body):
    """Перенос; без whole – весь кабинет (в запросе по умолчанию – только ПК)."""
    body.setdefault("whole", True)
    return client.post(f"/api/locations/{room_id}/move", json=body)


def printer_row(client, printer_id):
    return next(row for row in ok(client.get("/api/printers", params={"archived": "all"}))["rows"] if row["id"] == printer_id)


def test_whole_room(admin, editor, reader, tree):
    room = tree["room"]
    first = add_pc(editor, room, "pc-1")
    second = add_pc(editor, room, "pc-2")
    printer = ok(editor.post("/api/printers", json={"location_id": room}))["id"]

    assert move(reader, room, parent_id=tree["surgery"]).status_code == 403
    ok(move(editor, room, parent_id=tree["surgery"]))

    # Тот же узел – в Хирургии, по номеру между 110 и 410; в Терапии его нет
    assert nodes(editor)[room]["parent_id"] == tree["surgery"]
    assert children(editor, tree["surgery"]) == ["110", "201", "410"]
    assert children(editor, tree["department"]) == ["105", "305"]
    for pc in (first, second):
        row = get_row(editor, pc)
        assert (row["department"], row["room_code"], row["location_id"]) == ("Хирургия", "201", room)
    assert printer_row(editor, printer)["department"] == "Хирургия"

    # В Истории – место кабинета путём и id
    change = history(admin, "locations", room)[0]["changes"]["parent_id"]
    assert change == {
        "old": "ул. Ленина, 1 / Терапия", "new": "ул. Ленина, 1 / Хирургия",
        "old_id": tree["department"], "new_id": tree["surgery"],
    }

    undone = ok(editor.post("/api/history/undo-last"))
    assert undone["text"] == "Ординаторская – Расположение"
    assert nodes(editor)[room]["parent_id"] == tree["department"]
    assert children(editor, tree["department"]) == ["105", "201", "305"]
    assert get_row(editor, first)["department"] == "Терапия"

    # Ctrl+Y
    ok(editor.post("/api/history/cancel", json={"items": undone["items"], "cancel": False}))
    assert nodes(editor)[room]["parent_id"] == tree["surgery"]


def test_whole_room_keep_old(admin, editor, tree):
    room = tree["room"]
    pc = add_pc(editor, room, "pc-1")
    ok(move(editor, room, parent_id=tree["floor"], keep_old=True))

    found = nodes(editor)
    assert found[room]["parent_id"] == tree["floor"] and found[room]["direct_count"] == 1
    assert get_row(editor, pc)["department"] == "Поликлиника"

    # На старом месте – пустой такой же: номер, название, правило имён, прежнее место среди соседей
    assert children(editor, tree["department"]) == ["105", "201", "305"]
    copy = next(node for node in found.values() if node["parent_id"] == tree["department"] and node["code"] == "201")
    assert copy["id"] != room and copy["direct_count"] == 0
    assert (copy["name"], copy["name_part"]) == ("Ординаторская", "ord")
    assert history(admin, "locations", copy["id"])[0]["changes"] == {"created": {"old": None, "new": "Ординаторская", "move": True}}

    # Ctrl+Z – пустой в архив, кабинет на место; Ctrl+Y – снова оба
    undone = ok(editor.post("/api/history/undo-last"))
    assert undone["text"] == "Ординаторская – Расположение" and undone["count"] == 2
    found = nodes(editor)
    assert copy["id"] not in found and found[room]["parent_id"] == tree["department"]
    assert get_row(editor, pc)["department"] == "Терапия"

    ok(editor.post("/api/history/cancel", json={"items": undone["items"], "cancel": False}))
    found = nodes(editor)
    assert found[room]["parent_id"] == tree["floor"] and found[copy["id"]]["parent_id"] == tree["department"]


def test_only_computer(admin, editor, tree):
    room = tree["room"]
    first = add_pc(editor, room, "pc-1", seat_no="2")
    second = add_pc(editor, room, "pc-2")
    version = get_row(editor, first)["version"]

    # Чужая версия, ПК не из этого кабинета, не сказано, что переносить
    assert move(editor, room, parent_id=tree["surgery"], whole=False, computer_id=first, version=version - 1).status_code == 409
    assert move(editor, tree["t105"], parent_id=tree["surgery"], whole=False, computer_id=first).status_code == 409
    assert move(editor, room, parent_id=tree["surgery"], whole=False).status_code == 400

    created = ok(move(editor, room, parent_id=tree["surgery"], whole=False, computer_id=first, version=version))["id"]
    found = nodes(editor)
    assert created != room and found[created]["parent_id"] == tree["surgery"]
    assert (found[created]["code"], found[created]["name"], found[created]["name_part"]) == ("201", "Ординаторская", "ord")
    assert children(editor, tree["surgery"]) == ["110", "201", "410"]
    row = get_row(editor, first)
    assert (row["location_id"], row["department"], row["seat_no"]) == (created, "Хирургия", 2)
    assert get_row(editor, second)["location_id"] == room
    assert history(admin, "computers", first)[0]["changes"]["location_id"]["new_id"] == created

    undone = ok(editor.post("/api/history/undo-last"))
    assert undone["text"] == "pc-1 – Расположение" and undone["count"] == 2
    assert get_row(editor, first)["location_id"] == room and created not in nodes(editor)

    ok(editor.post("/api/history/cancel", json={"items": undone["items"], "cancel": False}))
    assert get_row(editor, first)["location_id"] == created and created in nodes(editor)

    # Второй ПК (запрос без whole – только ПК) – в уже созданный кабинет, нового не появляется
    ok(editor.post(f"/api/locations/{room}/move", json={"parent_id": tree["surgery"], "computer_id": second}))
    assert get_row(editor, second)["location_id"] == created and nodes(editor)[room]["parent_id"] == tree["department"]
    assert children(editor, tree["surgery"]) == ["110", "201", "410"]
    assert len(history(admin, "locations", created)) == 1


def test_only_computer_room_taken_meanwhile(admin, editor, tree):
    """Ctrl+Z переноса одного ПК, когда в созданный кабинет уже перенесли другой: ПК
    возвращается, кабинет с чужим ПК остаётся."""
    room = tree["room"]
    first = add_pc(editor, room, "pc-1")
    second = add_pc(editor, room, "pc-2")
    created = ok(move(editor, room, parent_id=tree["surgery"], whole=False, computer_id=first))["id"]
    ok(move(admin, room, parent_id=tree["surgery"], whole=False, computer_id=second))

    undone = ok(editor.post("/api/history/undo-last"))
    assert undone["text"] == "pc-1 – Расположение" and undone["count"] == 1
    assert get_row(editor, first)["location_id"] == room and get_row(editor, second)["location_id"] == created
    assert created in nodes(editor) and history(admin, "locations", created)  # «Создан» не отменён


def test_only_printer(admin, editor, tree):
    room = tree["room"]
    printer = ok(editor.post("/api/printers", json={"location_id": room}))["id"]
    version = printer_row(editor, printer)["version"]

    created = ok(move(editor, room, parent_id=tree["surgery"], whole=False, printer_id=printer, version=version))["id"]
    assert printer_row(editor, printer)["location_id"] == created
    assert history(admin, "printers", printer)[0]["changes"]["location_id"]["new"] == "ул. Ленина, 1 / Хирургия / 201 Ординаторская"

    ok(editor.post("/api/history/undo-last"))
    assert printer_row(editor, printer)["location_id"] == room and created not in nodes(editor)


def test_refused(editor, tree):
    room = tree["room"]
    same = add_location(editor, "room", "Другой", tree["surgery"], code="201")

    response = move(editor, room, parent_id=tree["surgery"])
    assert response.status_code == 400 and response.json()["detail"] == "В «ул. Ленина, 1 / Хирургия» уже есть кабинет 201."
    # «Только ПК» в отделение, где такой уже есть, – в него, без нового
    pc = add_pc(editor, room, "pc-1")
    ok(move(editor, room, parent_id=tree["surgery"], whole=False, computer_id=pc))
    assert get_row(editor, pc)["location_id"] == same

    assert move(editor, room, parent_id=tree["department"]).json()["detail"] == "Кабинет уже здесь."
    assert move(editor, room, parent_id=tree["building"]).json()["detail"] == "Кабинет переносится только в отделение или на этаж."
    assert move(editor, tree["surgery"], parent_id=tree["clinic"]).status_code == 404
    assert move(editor, room, parent_id=999999).status_code == 400

    ok(editor.post(f"/api/locations/{tree['floor']}/archive"))
    assert "в архиве" in move(editor, room, parent_id=tree["floor"]).json()["detail"]


def test_structure_form(admin, editor, tree):
    room = tree["room"]

    # Название и место – одним сохранением, одной записью Истории
    ok(editor.patch(f"/api/locations/{room}", json={"name": "Процедурная", "code": "201", "parent_id": tree["floor"]}))
    found = nodes(editor)
    assert (found[room]["parent_id"], found[room]["name"]) == (tree["floor"], "Процедурная")
    assert set(history(admin, "locations", room)[0]["changes"]) == {"name", "parent_id"}

    undone = ok(editor.post("/api/history/undo-last"))
    assert undone["text"] == "Процедурная – Название, Расположение"
    found = nodes(editor)
    assert (found[room]["parent_id"], found[room]["name"]) == (tree["department"], "Ординаторская")

    # То же место – не перенос; повтор на новом месте – ошибка; отделение не переносится
    ok(editor.patch(f"/api/locations/{room}", json={"name": "Ординаторская", "code": "201", "parent_id": tree["department"]}))
    assert len(history(admin, "locations", room)) == 2  # создан, правило имён (отменённое скрыто)
    add_location(editor, "room", None, tree["surgery"], code="201")
    response = editor.patch(f"/api/locations/{room}", json={"parent_id": tree["surgery"]})
    assert response.status_code == 400 and "уже есть кабинет 201" in response.json()["detail"]
    response = editor.patch(f"/api/locations/{tree['surgery']}", json={"parent_id": tree["clinic"]})
    assert response.json()["detail"] == "Перенести можно только кабинет."


@pytest.mark.parametrize("taken", ["new_place", "old_place"])
def test_structure_rename_and_move_undo(editor, tree, taken):
    """Номер и место одним сохранением – Ctrl+Z и Ctrl+Y целиком, когда по одному полю они мешали
    бы друг другу: на новом месте есть кабинет со старым номером или на старом – с новым."""
    room = tree["room"]
    if taken == "new_place":
        add_location(editor, "room", None, tree["surgery"], code="201")
    else:
        add_location(editor, "room", None, tree["department"], code="205")

    ok(editor.patch(f"/api/locations/{room}", json={"name": "Ординаторская", "code": "205", "parent_id": tree["surgery"]}))
    undone = ok(editor.post("/api/history/undo-last"))
    found = nodes(editor)[room]
    assert (found["parent_id"], found["code"]) == (tree["department"], "201")

    ok(editor.post("/api/history/cancel", json={"items": undone["items"], "cancel": False}))
    found = nodes(editor)[room]
    assert (found["parent_id"], found["code"]) == (tree["surgery"], "205")


def test_restore_keeps_archived_copy(admin, editor, tree):
    """Пустой такой же убрали в архив сами – восстановление переноса его не возвращает."""
    room = tree["room"]
    ok(move(editor, room, parent_id=tree["surgery"], keep_old=True))
    copy = next(node["id"] for node in nodes(editor).values() if node["parent_id"] == tree["department"] and node["code"] == "201")
    items = [{"id": history(admin, "locations", room)[0]["id"]}, {"id": history(admin, "locations", copy)[0]["id"]}]
    ok(editor.post(f"/api/locations/{copy}/archive"))

    ok(editor.post("/api/history/cancel", json={"items": items, "cancel": True}))
    assert nodes(editor)[room]["parent_id"] == tree["department"]
    ok(editor.post("/api/history/cancel", json={"items": items, "cancel": False}))
    found = nodes(editor)
    assert found[room]["parent_id"] == tree["surgery"] and copy not in found


def test_history_cancel_and_revert(admin, editor, tree):
    room = tree["room"]
    pc = add_pc(editor, room, "pc-1")
    ok(move(editor, room, parent_id=tree["surgery"], whole=False, computer_id=pc))
    created = get_row(editor, pc)["location_id"]
    record = history(admin, "locations", created)[0]

    # Созданный переносом кабинет с ПК в архив не уйдёт, запись не отменяется
    response = editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}]})
    assert response.status_code == 400
    assert response.json()["detail"] == "В кабинете «ул. Ленина, 1 / Хирургия / 201 Ординаторская» есть компьютеры или принтеры – он остаётся."
    assert created in nodes(editor) and history(admin, "locations", created)[0]["id"] == record["id"]

    # Обычное «Создан» по-прежнему не отменяется
    plain = history(admin, "locations", tree["t105"])[-1]
    assert editor.post("/api/history/cancel", json={"items": [{"id": plain["id"]}]}).status_code == 400

    # Место кабинета возвращается из Истории («Вернуть значение»)
    ok(move(editor, room, parent_id=tree["floor"]))
    moved = history(admin, "locations", room)[0]
    ok(editor.post("/api/history/revert", json={"id": moved["id"], "field": "parent_id", "initial": True}))
    assert nodes(editor)[room]["parent_id"] == tree["department"]
    value = ok(editor.get("/api/history/value", params={"entity": "locations", "entity_id": room, "field": "parent_id"}))
    assert value["label"] == "Расположение" and value["current"] == "ул. Ленина, 1 / Терапия"
