"""Этап 48: ПК и принтеры – одна запись изменений (версия, время, История) и одна
блокировка строк: по возрастанию id, чтобы два запроса с одними строками не ждали
друг друга вечно."""
from contextlib import contextmanager

from sqlalchemy import event

from conftest import add_computer, get_row, history, ok
from db import engine
from test_printers import add_printer, printer


@contextmanager
def locks():
    """Запросы SELECT … FOR UPDATE, выполненные внутри блока."""
    sql = []

    def collect(conn, cursor, statement, parameters, context, executemany):
        if "FOR UPDATE" in statement:
            sql.append(" ".join(statement.split()))

    event.listen(engine, "before_cursor_execute", collect)
    try:
        yield sql
    finally:
        event.remove(engine, "before_cursor_execute", collect)


def test_printers_locked_in_id_order(editor, room):
    ids = [add_printer(editor, room["room"], name=name) for name in ("PR-A", "PR-B", "PR-C")]
    versions = {i: printer(editor, i)["version"] for i in ids}

    with locks() as sql:
        result = ok(editor.post("/api/printers/archive", json={"ids": ids[::-1], "archived": True}))

    assert result["changed"] == sorted(ids)
    assert any("FROM printers" in s and "ORDER BY printers.id" in s for s in sql), sql

    for printer_id in ids:
        row = printer(editor, printer_id)
        assert row["archived"] is True
        assert row["version"] == versions[printer_id] + 1
        assert history(editor, "printers", printer_id)[0]["changes"]["archived"] == {"old": False, "new": True}

    with locks() as sql:
        result = ok(editor.post("/api/printers/bulk-update", json={"ids": ids[::-1], "field": "note", "value": "x"}))

    # Порядок ответа – как прислали
    assert result["ids"] == ids[::-1]
    assert any("FROM printers" in s and "ORDER BY printers.id" in s for s in sql), sql

    missing = editor.post("/api/printers/archive", json={"ids": [ids[0], 999999], "archived": False})
    assert missing.status_code == 404
    assert missing.json()["detail"] == "Часть принтеров не найдена. Обнови таблицу."


def test_computers_archive_locked_in_id_order(editor, room):
    ids = [add_computer(editor, room["room"], hostname=name) for name in ("PC-A", "PC-B")]
    versions = {i: get_row(editor, i)["version"] for i in ids}

    with locks() as sql:
        result = ok(editor.post("/api/computers/archive", json={"ids": ids[::-1], "archived": True}))

    assert result["changed"] == sorted(ids)
    assert any("FROM computers" in s and "ORDER BY computers.id" in s for s in sql), sql

    for computer_id in ids:
        assert get_row(editor, computer_id)["version"] == versions[computer_id] + 1
        assert history(editor, "computers", computer_id)[0]["changes"]["archived"] == {"old": False, "new": True}

    # Уже в архиве – без новой записи и без новой версии
    assert ok(editor.post("/api/computers/archive", json={"ids": ids, "archived": True}))["changed"] == []
    assert get_row(editor, ids[0])["version"] == versions[ids[0]] + 1

    missing = editor.post("/api/computers/archive", json={"ids": [ids[0], 999999], "archived": False})
    assert missing.status_code == 404


def test_rename_printers_by_rule(editor, room):
    a = add_printer(editor, room["room"], name="PR-1")
    b = add_printer(editor, room["room"], name="PR-2")
    versions = {i: printer(editor, i)["version"] for i in (a, b)}
    items = [{"id": b, "hostname": "PR-22"}, {"id": a, "hostname": "PR-1"}]

    assert ok(editor.post("/api/naming/rename", json={"kind": "printer", "items": items}))["changed"] == [b]
    # Имя без изменений – без новой версии и записи Истории
    assert printer(editor, a)["version"] == versions[a]
    assert printer(editor, b)["version"] == versions[b] + 1
    assert history(editor, "printers", b)[0]["changes"]["name"] == {"old": "PR-2", "new": "PR-22"}
