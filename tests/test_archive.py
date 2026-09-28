"""Архив ПК (этап 14): убрать, вернуть, фильтры списка, дерево, история."""
import pytest

from conftest import add_computer, add_location, get_row, ok


def archive(client, ids, archived=True):
    return client.post("/api/computers/archive", json={"ids": ids, "archived": archived})


def test_archive_and_restore(editor, room):
    first = add_computer(editor, room["room"], hostname="a")
    second = add_computer(editor, room["room"], hostname="b")
    version = get_row(editor, first)["version"]

    assert ok(archive(editor, [first]))["changed"] == [first]

    active = ok(editor.get("/api/computers"))["rows"]
    assert [row["id"] for row in active] == [second]

    archived = ok(editor.get("/api/computers", params={"archived": "yes"}))["rows"]
    assert [row["id"] for row in archived] == [first]
    assert archived[0]["archived"] is True
    assert archived[0]["version"] == version + 1

    everything = ok(editor.get("/api/computers", params={"archived": "all"}))
    assert everything["total"] == 2

    assert ok(archive(editor, [first], False))["changed"] == [first]
    assert get_row(editor, first)["archived"] is False


def test_archive_skips_unchanged(editor, room):
    computer_id = add_computer(editor, room["room"])
    ok(archive(editor, [computer_id]))

    assert ok(archive(editor, [computer_id]))["changed"] == []

    history = ok(editor.get(f"/api/computers/{computer_id}"))["history"]
    archive_records = [item for item in history if "archived" in item["changes"]]
    assert len(archive_records) == 1
    assert archive_records[0]["changes"]["archived"] == {"old": False, "new": True}


@pytest.mark.parametrize(
    "payload, status",
    [
        ({"ids": [], "archived": True}, 400),
        ({"ids": ["x"], "archived": True}, 400),
        ({"ids": [1], "archived": "yes"}, 400),
        ({"ids": [999], "archived": True}, 404),
    ],
)
def test_archive_bad_requests(editor, payload, status):
    assert editor.post("/api/computers/archive", json=payload).status_code == status


def test_list_bad_filter(editor):
    assert editor.get("/api/computers", params={"archived": "maybe"}).status_code == 400


def test_archived_can_be_edited(editor, room):
    computer_id = add_computer(editor, room["room"])
    ok(archive(editor, [computer_id]))

    ok(editor.patch(f"/api/computers/{computer_id}", json={"note": "списан по акту"}))
    assert get_row(editor, computer_id)["note"] == "списан по акту"


def test_tree_counts_without_archive(editor, room):
    add_computer(editor, room["room"])
    computer_id = add_computer(editor, room["room"])
    ok(archive(editor, [computer_id]))

    root = ok(editor.get("/api/locations/tree"))["roots"][0]
    assert root["total_count"] == 1


def test_location_with_only_archived_can_be_archived(editor, room):
    node = add_location(editor, "room", "Склад", room["department"], code="299")
    computer_id = add_computer(editor, node)

    assert editor.post(f"/api/locations/{node}/archive").status_code == 400

    ok(archive(editor, [computer_id]))
    ok(editor.post(f"/api/locations/{node}/archive"))

    # ПК из архива сохраняет прежнее расположение
    assert get_row(editor, computer_id)["room_code"] == "299"
