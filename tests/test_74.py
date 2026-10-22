"""Этап 74: журнал «IP» – в архив строка адреса целиком (снимок других источников и описания),
из журнала уходят только значения «IP»; серые кружки Router (Disabled) для журнала «IP»."""
from datetime import timedelta

from sqlalchemy import text

from conftest import add_pc, get_row, history, ok
from db import SessionLocal
from fakes import collect, setup_router
from models import IpEntry, ScanHost, ScanJabberUser
from test_66 import add_move, types  # noqa: F401 – types – фикстура
from test_69 import own_perms, set_perms  # noqa: F401 – own_perms – фикстура
from test_71 import NOW, create, keys, note, row_of, rows, seed
from test_73 import allowed


def archived_row(client, entry_id):
    return next(row for row in rows(client, "yes") if row["id"] == -entry_id)


def snapshot(entry_id):
    """Снимок записи как в базе: SQL NULL – None (JSON null был бы 'null', ревью этапа 74)."""
    session = SessionLocal()

    try:
        return session.execute(text("SELECT snapshot::text FROM ip_entries WHERE id = :id"), {"id": entry_id}).scalar()
    finally:
        session.close()


def archive(client, entry_id, archived=True):
    return ok(client.post("/api/ips/archive", json={"ids": [entry_id], "archived": archived}))


def test_archive_whole_row(admin, editor, reader, room):
    pc = add_pc(editor, room["room"], "cam-pc", ip="10.0.9.5", type="Моноблок")
    seed(
        ScanHost(source="net", ip="10.0.9.5", mac=None, name="CAM-PC", seen_at=NOW, data={}),
        ScanJabberUser(login="petrov", online=False, groups=[], registered=True, last_ip="10.0.9.5", last_seen_at=NOW),
    )
    entry = create(editor, ip_addr="10.0.9.5", ip_type="Камера", ip_name="cam-1")["rows"][0]["entry"]["id"]
    note(editor, "10.0.9.5", "у входа")
    assert keys(row_of(editor, "10.0.9.5")) == ["pc", "own", "net", "jabber"]

    # В архив: из журнала уходят только значения «IP», описание остаётся у адреса
    assert archive(editor, entry)["changed"] == [entry]
    row = row_of(editor, "10.0.9.5")
    assert (keys(row), row["entry"], row["ip_type"], row["ip_note"]) == (["pc", "net", "jabber"], None, "Моноблок", "у входа")
    assert [n["value"] for n in row["names"]] == ["cam-pc", "petrov"]

    # …а в архиве – строка целиком: источники, значения (ссылка на ПК), описание
    old = archived_row(editor, entry)
    assert (old["ip_addr"], old["archived"], old["entry"]["id"], old["ip_note"]) == ("10.0.9.5", True, entry, "у входа")
    assert keys(old) == ["pc", "own", "net", "jabber"]
    assert old["ip_sources"] == "Компьютеры\nIP\nСканер\nVacuum"
    assert [(t["value"], t["from"]) for t in old["types"]] == [("Моноблок", ["pc"]), ("Камера", ["own"])]
    assert [(n["value"], n["from"], n.get("obj")) for n in old["names"]] == [
        ("cam-pc", ["pc", "net"], {"kind": "pc", "id": pc}), ("cam-1", ["own"], None), ("petrov", ["jabber"], None)]
    assert old["ip_added"] == "editor" and old["checked_at"]

    # Источники, закрытые правами, не видны и в архиве (сканер и Vacuum – у читателя)
    seen = archived_row(reader, entry)
    assert keys(seen) == ["pc", "own"] and [n["value"] for n in seen["names"]] == ["cam-pc", "cam-1"]

    # Снимок не меняется вслед за таблицей
    ok(editor.patch(f"/api/computers/{pc}", json={"ip": "10.0.9.6", "_version": get_row(editor, pc)["version"]}))
    assert keys(archived_row(editor, entry)) == ["pc", "own", "net", "jabber"]

    # Из архива – строка снова живая; снова в архив кнопкой – снимок сегодняшний
    archive(editor, entry, False)
    assert keys(row_of(editor, "10.0.9.5")) == ["own", "net", "jabber"]
    archive(editor, entry)
    assert keys(archived_row(editor, entry)) == ["own", "net", "jabber"]

    # Отмена в Истории: вернули из архива и снова убрали – с тем снимком, что был (ревью этапа 74)
    record = history(editor, "ip_entries", entry)[0]
    assert record["changes"] == {"archived": {"old": False, "new": True}}
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}], "cancel": True}))
    assert row_of(editor, "10.0.9.5")["entry"]["id"] == entry
    seed(ScanJabberUser(login="sidorov", online=False, groups=[], registered=True, last_ip="10.0.9.5", last_seen_at=NOW))
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}], "cancel": False}))
    assert [n["value"] for n in archived_row(editor, entry)["names"]] == ["cam-1", "CAM-PC", "petrov"]

    # Удалить насовсем – как раньше (только администратор)
    ok(admin.post("/api/ips/delete", json={"ids": [entry]}))
    assert [r for r in rows(editor, "yes") if r["id"] == -entry] == []


def test_empty_snapshot(editor):
    # У адреса ничего, кроме записи, – снимка нет (SQL NULL: откат миграции им не мешает)
    entry = create(editor, ip_addr="10.0.9.21", ip_name="srv")["rows"][0]["entry"]["id"]
    archive(editor, entry)
    assert snapshot(entry) is None
    assert keys(archived_row(editor, entry)) == ["own"]


def test_move_link_rights(admin, editor, types, models, own_perms):
    # Ссылка на запись «Движения» в архиве – только тем, кому оно открыто (ревью этапа 74)
    move = add_move(editor, types["МФУ"], printer_model_id=models["mfu"]["id"], model="Kyocera", move_ip="10.0.9.30")
    title = row_of(editor, "10.0.9.30")["names"][0]["value"]
    seed(ScanHost(source="net", ip="10.0.9.30", mac=None, name=title, seen_at=NOW, data={}))
    entry = create(editor, ip_addr="10.0.9.30")["rows"][0]["entry"]["id"]
    archive(editor, entry)
    assert [(n["from"], n.get("obj")) for n in archived_row(editor, entry)["names"]] == [(["move", "net"], {"kind": "move", "id": move})]
    set_perms(admin, "editor", {"journals/moves": "none"})
    assert [(n["from"], n.get("obj")) for n in archived_row(editor, entry)["names"]] == [(["net"], None)]


def test_archived_before(editor):
    # Убранные в архив до этапа 74 (снимка нет) – как раньше: только значения «IP»
    entry = create(editor, ip_addr="10.0.9.20", ip_name="srv")["rows"][0]["entry"]["id"]
    note(editor, "10.0.9.20", "стойка")
    archive(editor, entry)
    session = SessionLocal()
    session.get(IpEntry, entry).snapshot = None
    session.commit()
    session.close()
    old = archived_row(editor, entry)
    assert (keys(old), old["ip_name"], old["ip_note"], old["ip_added"]) == (["own"], "srv", None, "editor")


def test_router_disabled(admin, reader, room, router_port, own_perms):
    add_pc(admin, room["room"], "buh-1", ip="10.0.0.5")
    create(admin, ip_addr="10.0.0.7")
    allowed({"address": "10.0.0.5"}, {"address": "10.0.0.6", "disabled": True}, {"address": "10.0.0.7", "disabled": True})
    setup_router(admin, router_port)
    collect(admin, "router")
    # Выключенные адреса – отдельно (серые кружки журнала «IP»); без права на «Сеть» – только свои
    assert ok(admin.get("/api/scan/hosts/router")) == {"enabled": True, "ips": ["10.0.0.5"], "disabled": ["10.0.0.6", "10.0.0.7"]}
    assert ok(reader.get("/api/scan/hosts/router")) == {"enabled": True, "ips": ["10.0.0.5"], "disabled": ["10.0.0.7"]}
    set_perms(admin, "reader", {"journals/ips": "none"})
    assert ok(reader.get("/api/scan/hosts/router"))["disabled"] == []

    # Давний список – кружков нет никаких
    session = SessionLocal()
    session.query(ScanHost).filter(ScanHost.source == "router").update({"seen_at": NOW - timedelta(days=8)})
    session.commit()
    session.close()
    assert ok(admin.get("/api/scan/hosts/router")) == {"enabled": True, "ips": [], "disabled": []}
