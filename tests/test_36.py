"""Этап 36: новый кабинет из строки «Новый компьютер» — среди соседей по номеру:
перед узлом before_id (узлы с ним и дальше сдвигаются), без before_id — в конец."""
from conftest import add_location, ok


def children(client, parent_id):
    def find(items):
        for node in items:
            if node["id"] == parent_id:
                return node["children"]
            found = find(node["children"])
            if found is not None:
                return found
        return None

    return [node["code"] for node in find(ok(client.get("/api/locations/tree"))["roots"])]


def add_room(client, parent_id, code, before_id=None):
    payload = {"kind": "room", "parent_id": parent_id, "code": code, "name": None, "before_id": before_id}
    return client.post("/api/locations", json=payload)


def test_room_before(editor, reader, room):
    department = room["department"]
    r203 = add_location(editor, "room", "Склад", department, code="203")
    r205 = ok(add_room(editor, department, "205"))["id"]
    assert children(reader, department) == ["201", "203", "205"]

    ok(add_room(editor, department, "202", before_id=r203))
    ok(add_room(editor, department, "204", before_id=r205))
    assert children(reader, department) == ["201", "202", "203", "204", "205"]

    # Без before_id — в конец, как раньше
    ok(add_room(editor, department, "100"))
    assert children(reader, department) == ["201", "202", "203", "204", "205", "100"]

    # Перед первым
    ok(add_room(editor, department, "101", before_id=room["room"]))
    assert children(reader, department)[:2] == ["101", "201"]


def test_room_before_errors(editor, reader, room):
    other = add_location(editor, "department", "Хирургия", room["building"])

    # Узел не из этого места, не число, нет такого
    for before_id in (room["room"], "abc", 999999):
        response = add_room(editor, other, "301", before_id=before_id)
        assert response.status_code == 400, before_id
        assert response.json()["detail"] == "Узел, перед которым добавить, не найден."

    assert add_room(reader, other, "301").status_code == 403
    assert children(reader, other) == []
