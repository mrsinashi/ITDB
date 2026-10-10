"""Этап 35: правила имён ПК – часть имени и галочки у узлов дерева, «своё имя» у
ПК, переименование нескольких ПК по правилу одним действием."""
from conftest import add_computer, add_location, get_row, ok


def tree_nodes(client):
    nodes = {}

    def walk(items):
        for node in items:
            nodes[node["id"]] = node
            walk(node["children"])

    walk(ok(client.get("/api/locations/tree"))["roots"])
    return nodes


def history(client, entity, entity_id=None):
    params = {"entity": entity}
    if entity_id is not None:
        params["entity_id"] = entity_id
    return ok(client.get("/api/history", params=params))["items"]


def test_node_rules(editor, reader, room):
    node = tree_nodes(reader)[room["room"]]
    assert (node["name_part"], node["name_own"], node["name_single"]) == (None, False, False)

    saved = ok(editor.patch("/api/naming/nodes", json={"items": [
        {"id": room["department"], "part": " TER "},
        {"id": room["room"], "part": "proc", "single": True},
    ]}))
    assert saved["nodes"] == [
        {"id": room["department"], "name_part": "ter", "name_own": False, "name_single": False},
        {"id": room["room"], "name_part": "proc", "name_own": False, "name_single": True},
    ]
    nodes = tree_nodes(reader)
    assert nodes[room["department"]]["name_part"] == "ter"
    assert (nodes[room["room"]]["name_part"], nodes[room["room"]]["name_single"]) == ("proc", True)

    # Только переданные поля; пустая часть – None
    ok(editor.patch("/api/naming/nodes", json={"items": [{"id": room["room"], "own": True, "part": ""}]}))
    node = tree_nodes(reader)[room["room"]]
    assert (node["name_part"], node["name_own"], node["name_single"]) == (None, True, True)

    # В Истории узла – что поменялось
    records = history(reader, "locations", room["room"])
    assert records[0]["changes"] == {"name_part": {"old": "proc", "new": None}, "name_own": {"old": False, "new": True}}
    assert records[1]["changes"] == {"name_part": {"old": None, "new": "proc"}, "name_single": {"old": False, "new": True}}


def test_node_rules_checks(editor, reader, room):
    assert reader.patch("/api/naming/nodes", json={"items": [{"id": room["room"], "part": "x"}]}).status_code == 403
    for part in ("тер", "a b", "a--b", "a_b"):
        response = editor.patch("/api/naming/nodes", json={"items": [{"id": room["room"], "part": part}]})
        assert response.status_code == 400, part
    # Длина части не ограничена (этап 44)
    ok(editor.patch("/api/naming/nodes", json={"items": [{"id": room["room"], "part": "x" * 20}]}))
    assert tree_nodes(reader)[room["room"]]["name_part"] == "x" * 20
    assert editor.patch("/api/naming/nodes", json={"items": [{"id": 99999, "part": "x"}]}).status_code == 404
    assert editor.patch("/api/naming/nodes", json={"items": []}).status_code == 400
    same = [{"id": room["room"], "part": "a"}, {"id": room["room"], "part": "b"}]
    assert editor.patch("/api/naming/nodes", json={"items": same}).status_code == 400

    # Ошибка у одного узла – не меняется ни один
    bad = [{"id": room["department"], "part": "ter"}, {"id": room["room"], "part": "кабинет"}]
    assert editor.patch("/api/naming/nodes", json={"items": bad}).status_code == 400
    assert tree_nodes(reader)[room["department"]]["name_part"] is None

    # Из архива – нет
    other = add_location(editor, "room", "Склад", room["department"], code="299")
    ok(editor.post(f"/api/locations/{other}/archive"))
    assert editor.patch("/api/naming/nodes", json={"items": [{"id": other, "part": "x"}]}).status_code == 404


def test_node_rules_undo(editor, reader, room):
    # «Взять из таблицы» – одним действием: Ctrl+Z отменяет всё сразу
    ok(editor.patch("/api/naming/nodes", json={"items": [
        {"id": room["department"], "part": "ter"},
        {"id": room["room"], "part": "proc", "single": True},
    ]}))
    ok(editor.post("/api/history/undo-last"))
    nodes = tree_nodes(reader)
    assert nodes[room["department"]]["name_part"] is None
    assert (nodes[room["room"]]["name_part"], nodes[room["room"]]["name_single"]) == (None, False)

    # Вернуть значение из Истории – как у названия узла
    ok(editor.patch("/api/naming/nodes", json={"items": [{"id": room["room"], "part": "proc"}]}))
    ok(editor.patch("/api/naming/nodes", json={"items": [{"id": room["room"], "part": "k201"}]}))
    record = history(reader, "locations", room["room"])[0]
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"], "field": "name_part"}]}))
    assert tree_nodes(reader)[room["room"]]["name_part"] == "proc"


def test_keep(editor, reader, room):
    pc1 = add_computer(editor, room["room"], hostname="zam-popov", seat_no=1)
    pc2 = add_computer(editor, room["room"], hostname="srv-1", seat_no=2)
    assert ok(reader.get("/api/naming/keep"))["items"] == []
    assert reader.post("/api/naming/keep", json={"ids": [pc1], "keep": True}).status_code == 403

    items = ok(editor.post("/api/naming/keep", json={"ids": [pc1, pc2], "keep": True}))["items"]
    assert [(i["computer_id"], i["name"], i["location_id"], i["by"]) for i in items] == [
        (pc1, "zam-popov", room["room"], "editor"), (pc2, "srv-1", room["room"], "editor")]
    record = history(reader, "naming", pc1)[0]
    assert record["changes"] == {"name_keep": {"old": None, "new": "zam-popov"}}

    # Повторно – без новой записи
    ok(editor.post("/api/naming/keep", json={"ids": [pc1], "keep": True}))
    assert len(history(reader, "naming", pc1)) == 1

    # ПК переименовали – его «своё имя» больше не действует и при следующей правке списка уходит
    version = get_row(editor, pc2)["version"]
    ok(editor.patch(f"/api/computers/{pc2}", json={"hostname": "srv-2", "_version": version}))
    items = ok(editor.post("/api/naming/keep", json={"ids": [pc1], "keep": False}))["items"]
    assert items == []
    assert history(reader, "naming", pc1)[0]["changes"] == {"name_keep": {"old": "zam-popov", "new": None}}
    assert len(history(reader, "naming", pc2)) == 1

    nameless = add_computer(editor, room["room"])
    assert editor.post("/api/naming/keep", json={"ids": [nameless], "keep": True}).status_code == 400
    assert editor.post("/api/naming/keep", json={"ids": [99999], "keep": True}).status_code == 404


def test_rename(editor, reader, room):
    pc1 = add_computer(editor, room["room"], hostname="old-1", seat_no=1)
    pc2 = add_computer(editor, room["room"], hostname="old-2", seat_no=2)
    assert reader.post("/api/naming/rename", json={"items": [{"id": pc1, "hostname": "x"}]}).status_code == 403
    assert editor.post("/api/naming/rename", json={"items": [{"id": pc1, "hostname": " "}]}).status_code == 400

    result = ok(editor.post("/api/naming/rename", json={"items": [
        {"id": pc1, "hostname": "ter-proc-1"}, {"id": pc2, "hostname": "old-2"}]}))
    assert result["changed"] == [pc1]
    assert get_row(reader, pc1)["hostname"] == "ter-proc-1"
    assert history(reader, "computers", pc1)[0]["changes"] == {"hostname": {"old": "old-1", "new": "ter-proc-1"}}

    ok(editor.post("/api/naming/rename", json={"items": [
        {"id": pc1, "hostname": "ter-proc-3"}, {"id": pc2, "hostname": "ter-proc-4"}]}))
    ok(editor.post("/api/history/undo-last"))
    assert (get_row(reader, pc1)["hostname"], get_row(reader, pc2)["hostname"]) == ("ter-proc-1", "old-2")
