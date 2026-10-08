"""Этап 38: «привязать?» по одному IP, привязка записи из Таблицы со сравнением,
«проверен одним способом» – по актуальным данным."""
from datetime import datetime, timedelta, timezone

from conftest import get_row, ok
from db import SessionLocal
from models import ScanRecord
from scan_match import match_all
from test_28b import obs, save_hosts
from test_scan_collect import ETH, Glpi, add_pc, collect, diffs_of, glpi_url, pc, records, secret_key, setup_source  # noqa: F401


def rec(source_id, name, ip, macs=(), serial=None):
    return {
        "source_id": source_id, "name": name, "keys": {"macs": list(macs), "serial": serial}, "dup_of": None,
        "data": {"values": {"ip": ip}},
    }


def comp(computer_id, hostname, ip, mac=None, glpi_id=None):
    return {"id": computer_id, "hostname": hostname, "ip": ip, "mac": mac, "serial": None, "glpi_id": glpi_id,
            "gsit_id": None, "archived": False}


def test_match_by_ip():
    computers = [
        comp(1, "pc-1", "10.0.5.11"),                              # только IP – «привязать?»
        comp(2, "pc-2", "10.0.5.12", glpi_id="7"),                 # номер другой записи – нет
        comp(3, "pc-3", "10.0.5.13"),                              # IP у двух записей – нет
        comp(4, "pc-4", "10.0.5.14", mac="D8:BB:C1:00:00:04"),     # MAC другой – нет
        comp(5, "pc-5", "10.0.5.15\n10.0.6.15", mac="D8:BB:C1:00:00:05"),   # уже по MAC у №9
        comp(6, "pc-6", "10.0.5.16", glpi_id="999"),               # номер устарел (записи нет) – можно
        comp(8, "pc-8", "10.0.5.18"),
        comp(18, "pc-18", "10.0.5.18"),                            # IP у двух ПК – нет
    ]
    records = [
        rec(1, "DESKTOP-1", "10.0.5.11"),
        rec(2, "DESKTOP-2", "10.0.5.12"),
        rec(3, "DESKTOP-3", "10.0.5.13"),
        rec(33, "DESKTOP-33", "10.0.5.13"),
        rec(4, "DESKTOP-4", "10.0.5.14", macs=["D8:BB:C1:00:00:44"]),
        rec(5, "DESKTOP-5", "10.0.6.15"),
        rec(9, "pc-5-new", None, macs=["D8:BB:C1:00:00:05"]),
        rec(6, "DESKTOP-6", "10.0.5.16"),
        rec(7, "pc-7", None),
        rec(8, "DESKTOP-8", "10.0.5.18"),
    ]
    result, _ = match_all(records, computers, [], "glpi")
    assert (result[1]["state"], result[1]["computer_id"], result[1]["by"], result[1]["note"]) == ("name", 1, ["ip"], "Совпадает только IP")
    assert result[2]["state"] == "none"
    assert result[3]["state"] == "none" and result[33]["state"] == "none"
    assert result[4]["state"] == "none"
    assert result[9]["state"] == "key"
    assert result[5]["state"] == "none" and "IP как у pc-5" in result[5]["note"]
    assert (result[6]["state"], result[6]["computer_id"]) == ("name", 6)
    assert result[8]["state"] == "none"

    # «Не этот ПК» – не предлагается
    result, _ = match_all(records, computers, [{"source_id": 1, "computer_id": 1, "action": "reject"}], "glpi")
    assert result[1]["state"] == "none"


def test_link_from_table(admin, editor, reader, room, glpi_url):
    """«Привязать?» в Таблице: номер записи серым, сравнение; «Привязать» – дальше всё остальное."""
    loc = room["room"]
    first = add_pc(editor, loc, "pc-1", ip="10.0.5.11")
    second = add_pc(editor, loc, "pc-2", ip="10.0.5.12")
    Glpi.computers = {
        1: pc("DESKTOP-1", ports=[(ETH, "d8:bb:c1:00:00:01", ["10.0.5.11"])]),
        2: pc("DESKTOP-2", ports=[(ETH, "d8:bb:c1:00:00:02", ["10.0.5.12"])]),
    }
    setup_source(admin, glpi_url)
    assert collect(admin)["status"] == "ok"
    assert records(admin)[1][1]["state"] == "name" and records(admin)[1][1]["by"] == ["ip"]

    items = {(d["computer_id"], d["field"]): d for d in diffs_of(reader)["items"]}
    offer = items[(first, "glpi_id")]
    assert (offer["kind"], offer["table"], offer["proposed"], offer["note"]) == ("link", "", "1", "Совпадает только IP")
    assert offer["sources"][0]["state"] == "name" and offer["sources"][0]["by"] == ["ip"]
    compare = {c["field"]: c for c in offer["compare"]}
    assert (compare["hostname"]["table"], compare["hostname"]["source"], compare["hostname"]["mark"]) == ("pc-1", "DESKTOP-1", "≠")
    assert compare["ip"]["mark"] == "=" and compare["mac"]["table"] == "" and compare["mac"]["mark"] == ""
    # Пока не привязана – остального не предлагает
    assert (first, "mac") not in items

    body = {"computer_id": first, "source": "glpi", "source_id": 1, "table": ""}
    assert reader.post("/api/scan/diffs/link", json=body).status_code == 403
    assert editor.post("/api/scan/diffs/link", json=dict(body, source="jabber")).status_code == 404
    ok(editor.post("/api/scan/diffs/link", json=body))
    assert get_row(editor, first)["glpi_id"] == "1"
    r = records(admin)[1][1]
    assert (r["state"], r["computer_id"]) == ("link", first)
    items = {(d["computer_id"], d["field"]): d for d in diffs_of(reader)["items"]}
    assert (first, "glpi_id") not in items
    assert items[(first, "mac")]["kind"] == "fill" and items[(first, "mac")]["proposed"] == "D8:BB:C1:00:00:01"

    # Номер – обычной правкой с пометкой источника (отменяется в Истории)
    history = ok(editor.get("/api/history", params={"entity": "computers", "entity_id": first}))["items"]
    assert history[0]["changes"]["glpi_id"]["new"] == "1" and history[0]["changes"]["glpi_id"]["scan"] == "GLPI №1"

    # «Не этот ПК» – больше не предлагается ни в Таблице, ни на «Проверке»
    ok(editor.post("/api/scan/diffs/not-this", json={"computer_id": second, "source": "glpi", "source_id": 2}))
    assert (second, "glpi_id") not in {(d["computer_id"], d["field"]) for d in diffs_of(reader)["items"]}
    assert records(admin)[1][2]["state"] == "none"


def test_checked(admin, editor, reader, room, glpi_url):
    """Проверен одним способом – запись GLPI / GSIT или сеть; давняя запись не в счёт."""
    loc = room["room"]
    both = add_pc(editor, loc, "pc-1", ip="10.0.5.11", mac="D8:BB:C1:00:00:01")
    only_glpi = add_pc(editor, loc, "pc-2", ip="10.0.5.12", mac="D8:BB:C1:00:00:02")
    only_net = add_pc(editor, loc, "pc-3", ip="10.0.5.13")
    old = add_pc(editor, loc, "pc-4", ip="10.0.5.14", mac="D8:BB:C1:00:00:04")
    Glpi.computers = {
        1: pc("pc-1", ports=[(ETH, "d8:bb:c1:00:00:01", [])]),
        2: pc("pc-2", ports=[(ETH, "d8:bb:c1:00:00:02", [])]),
        4: pc("pc-4", ports=[(ETH, "d8:bb:c1:00:00:04", [])]),
    }
    setup_source(admin, glpi_url)
    assert collect(admin)["status"] == "ok"
    ok(admin.patch("/api/scan/sources/net", json={"enabled": True}))
    save_hosts(
        obs("10.0.5.11", "D8:BB:C1:00:00:01", "PC-1", how=["ping"]),
        obs("10.0.5.13", None, "pc-3", how=["ping"]),
    )
    # Запись pc-4 проверена в GLPI давно (срок «Актуальны» – 3 дня)
    session = SessionLocal()
    try:
        session.query(ScanRecord).filter(ScanRecord.source_id == 4).update(
            {"checked_at": datetime.now(timezone.utc) - timedelta(days=10)},
        )
        session.commit()
    finally:
        session.close()

    data = diffs_of(reader)
    assert data["verified"] == {str(both): ["GLPI", "Сеть"]}
    assert data["checked"] == {str(only_glpi): ["GLPI"], str(only_net): ["Сеть"]}
    assert str(old) not in data["checked"]

    marks = {m["kind"]: m for m in ok(reader.get("/api/table-marks"))}
    assert marks["checked"]["label"] == "Проверен одним способом" and marks["checked"]["bg_color"]
