"""Этап 28б: вкладка «Сеть» (что собрали DHCP и проход подсетей), выделение ПК,
проверенных и GLPI / GSIT, и сетью, одинаковые кнопки оформления у выделений и
антивирусов, Ctrl+Z (отмена своего последнего действия), VNC по умолчанию."""
from datetime import datetime, timedelta, timezone

from conftest import get_row, ok
from db import SessionLocal
from models import ScanHost
from scan_hostmatch import confirmed
from test_scan_collect import ETH, Glpi, add_pc, collect, glpi_url, pc, secret_key, setup_source  # noqa: F401

NOW = datetime.now(timezone.utc)


def obs(ip, mac=None, name=None, source="net", days=0, **data):
    return {"source": source, "ip": ip, "mac": mac, "name": name, "seen_at": NOW - timedelta(days=days), "data": data}


def save_hosts(*items):
    session = SessionLocal()

    try:
        for item in items:
            session.add(ScanHost(**item))

        session.commit()
    finally:
        session.close()


def test_confirmed():
    computers = {
        1: {"hostname": "pc-1", "ip": "10.0.5.11", "mac": ""},                    # по IP, имя то же
        2: {"hostname": "pc-2", "ip": "10.0.5.12", "mac": ""},                    # на адресе — другое имя
        3: {"hostname": "pc-3", "ip": "10.0.5.13", "mac": ""},                    # имя неизвестно
        4: {"hostname": "pc-4", "ip": "10.0.5.14", "mac": "D8:CB:8A:00:00:14"},   # по MAC, на другом адресе
        5: {"hostname": "pc-5", "ip": "10.0.5.15", "mac": ""},                    # на адресе — MAC ПК 4
    }
    seen = [
        obs("10.0.5.11", "D8:CB:8A:00:00:11", "PC-1.corp.lan"),
        obs("10.0.5.11", "D8:CB:8A:00:00:11", "pc-1", source="dhcp"),
        obs("10.0.5.12", None, "other"),
        obs("10.0.5.13", "D8:CB:8A:00:00:13"),
        obs("10.0.5.15", "D8:CB:8A:00:00:14", "pc-5"),
    ]
    assert confirmed(computers, seen) == {1: ["net", "dhcp"], 4: ["net"]}


def test_hosts_page(admin, editor, reader, room):
    loc = room["room"]
    first = add_pc(editor, loc, "pc-1", ip="10.0.5.11")
    second = add_pc(editor, loc, "pc-2", ip="10.0.5.99", mac="D8:CB:8A:00:00:12")
    save_hosts(
        obs("10.0.5.11", "D8:CB:8A:00:00:11", "PC-1", how=["ping", "netbios"], dns="pc-1.corp.lan", ports=[5900, 445], rfb="003.008"),
        obs("10.0.5.11", "D8:CB:8A:00:00:11", "pc-1", source="dhcp", state="active", active=True),
        obs("10.0.5.11", "D8:CB:8A:00:00:AA", None, source="dhcp_conf", fixed=True, host="buh-1", file="/etc/dhcp/a.conf"),
        obs("10.0.5.12", "D8:CB:8A:00:00:12", None, source="dhcp_conf", fixed=True, host="pc-2"),
        obs("10.0.5.13", "D8:CB:8A:00:00:11", None, source="dhcp", fixed=True, host="old"),   # привязка, собранная до 28в
        obs("10.0.5.2", None, None, how=["ping"]),
    )

    assert reader.get("/api/scan/hosts").status_code == 403
    data = ok(editor.get("/api/scan/hosts"))
    assert [h["ip"] for h in data["hosts"]] == ["10.0.5.2", "10.0.5.11", "10.0.5.12", "10.0.5.13"]   # по порядку адресов
    assert [s["kind"] for s in data["sources"]] == ["dhcp", "net"]
    hosts = {h["ip"]: h for h in data["hosts"]}

    # Источники говорят разное — оба значения, у каждого — откуда; привязка — последней
    both = hosts["10.0.5.11"]
    assert both["mac"] == [
        {"value": "D8:CB:8A:00:00:11", "sources": ["Сканер", "Leases"], "stale": False},
        {"value": "D8:CB:8A:00:00:AA", "sources": ["DHCP Config"], "stale": False},
    ]
    assert both["name"] == [
        {"value": "PC-1", "sources": ["Сканер", "Leases"], "stale": False},
        {"value": "buh-1", "sources": ["DHCP Config"], "stale": False},
    ]
    assert both["differ"] and both["seen_by"] in ("Сканер", "Leases") and not both["stale"]
    assert both["dhcp"]["text"] == "аренда" and both["net"]["text"] == "ping, NetBIOS" and both["conf"]["text"] == "привязка"
    assert both["conf"]["details"] == ["host buh-1", "файл: /etc/dhcp/a.conf"]
    assert "DNS: pc-1.corp.lan" in both["net"]["details"]
    assert both["ports"] == [445, 5900] and both["rfb"] == "003.008"
    assert [(c["computer_id"], c["by"]) for c in both["computers"]] == [(first, ["ip"])]

    # Привязка: ПК найден по MAC из настроек, хотя IP в таблице у него другой; «когда» — пусто
    fixed = hosts["10.0.5.12"]
    assert fixed["conf"]["text"] == "привязка" and fixed["dhcp"] is None and fixed["net"] is None
    assert fixed["seen_at"] is None and fixed["ports"] is None
    assert fixed["name"] == [{"value": "pc-2", "sources": ["DHCP Config"], "stale": False}]
    assert not fixed["stale"] and not fixed["differ"] and fixed["seen_by"] is None
    assert [(c["computer_id"], c["by"]) for c in fixed["computers"]] == [(second, ["conf"])]

    # MAC привязки на самом деле виден на другом адресе
    assert hosts["10.0.5.13"]["conf"]["details"] == ["host old", "MAC сейчас на 10.0.5.11"]

    alone = hosts["10.0.5.2"]
    assert alone["computers"] == [] and alone["mac"] == [] and alone["net"]["text"] == "ping"
    assert alone["ports"] is None and alone["seen_at"]


def test_verified(admin, editor, reader, room, glpi_url):
    """Проверен — и запись GLPI / GSIT сопоставлена, и сеть видит ПК наверняка."""
    loc = room["room"]
    both = add_pc(editor, loc, "pc-1", ip="10.0.5.11", mac="D8:BB:C1:00:00:01")
    only_glpi = add_pc(editor, loc, "pc-2", ip="10.0.5.12", mac="D8:BB:C1:00:00:02")
    only_net = add_pc(editor, loc, "pc-3", ip="10.0.5.13")
    Glpi.computers = {
        1: pc("pc-1", ports=[(ETH, "d8:bb:c1:00:00:01", [])]),
        2: pc("pc-2", ports=[(ETH, "d8:bb:c1:00:00:02", [])]),
    }
    setup_source(admin, glpi_url)
    assert collect(admin)["status"] == "ok"
    ok(admin.patch("/api/scan/sources/net", json={"enabled": True}))
    save_hosts(
        obs("10.0.5.11", "D8:BB:C1:00:00:01", "PC-1", how=["ping"]),
        obs("10.0.5.13", None, "pc-3", how=["ping"]),
    )

    verified = ok(reader.get("/api/scan/diffs"))["verified"]
    assert verified == {str(both): ["GLPI", "Сеть"]}
    assert str(only_glpi) not in verified and str(only_net) not in verified

    # Сеть выключена — проверенных нет
    ok(admin.patch("/api/scan/sources/net", json={"enabled": False}))
    assert ok(reader.get("/api/scan/diffs"))["verified"] == {}


def test_mark_and_antivirus_styles(editor, reader):
    """У выделений и антивирусов — те же кнопки, что у значений: Ч, З, фон блочком."""
    marks = {m["kind"]: m for m in ok(reader.get("/api/table-marks"))}
    assert marks["verified"]["label"] == "Проверен сетью и GLPI / GSIT"
    # «Проверен» сам ничего не выделяет, пока вид не задан
    assert not any(marks["verified"][f] for f in ("color", "bg_color", "bold", "italic", "underline", "strike"))
    assert marks["dup"]["chip"] is True and not marks["dup"]["changed"]

    saved = ok(editor.patch("/api/table-marks/verified", json={"color": "#1a7f37", "bold": True}))
    assert (saved["color"], saved["bold"], saved["changed"]) == ("#1a7f37", True, True)
    saved = ok(editor.patch("/api/table-marks/dup", json={"chip": False}))
    assert saved["chip"] is False and saved["changed"]
    saved = ok(editor.patch("/api/table-marks/dup", json={"reset": True}))
    assert saved["chip"] is True and not saved["changed"]
    assert reader.patch("/api/table-marks/verified", json={"bold": False}).status_code == 403

    settings = ok(reader.get("/api/scan/antivirus"))
    on = next(s for s in settings["statuses"] if s["kind"] == "on")
    assert (on["underline"], on["strike"], on["chip"]) == (False, False, True)
    settings = ok(editor.patch("/api/scan/antivirus", json={"kind": "on", "underline": True, "strike": True, "chip": False}))
    on = next(s for s in settings["statuses"] if s["kind"] == "on")
    assert (on["underline"], on["strike"], on["chip"]) == (True, True, False)
    history = ok(editor.get("/api/history", params={"entity": "scan_antivirus"}))["items"]
    assert set(history[0]["changes"]) == {"underline", "strike", "chip"}


def test_undo_last(admin, editor, reader, room):
    loc = room["room"]
    first = add_pc(editor, loc, "pc-1", ram="8")
    second = add_pc(editor, loc, "pc-2", ram="8")
    assert reader.post("/api/history/undo-last").status_code == 403
    # У администратора своих действий нет
    assert admin.post("/api/history/undo-last").status_code == 404

    ok(editor.patch(f"/api/computers/{first}", json={"ram": "16", "_version": get_row(editor, first)["version"]}))
    ok(editor.patch(f"/api/computers/{first}", json={"os": "Win 11", "_version": get_row(editor, first)["version"]}))

    # Последнее действие — ОС
    undone = ok(editor.post("/api/history/undo-last"))
    assert undone["text"] == "pc-1 — Операционная система" and undone["count"] == 1 and undone["entities"] == ["computers"]
    row = get_row(editor, first)
    assert (row["os"], row["ram"]) == (None, "16")

    # Следующее — ОЗУ; отменённое в счёт не идёт
    again = ok(editor.post("/api/history/undo-last"))
    assert again["text"] == "pc-1 — Оперативная память" and get_row(editor, first)["ram"] == "8"

    # Вернуть (Ctrl+Y) — обычным восстановлением отменённого
    ok(editor.post("/api/history/cancel", json={"items": again["items"], "cancel": False}))
    assert get_row(editor, first)["ram"] == "16"

    # Действие над несколькими ПК отменяется целиком
    ok(editor.post("/api/computers/bulk-update", json={"ids": [first, second], "field": "ram", "value": "32"}))
    assert (get_row(editor, first)["ram"], get_row(editor, second)["ram"]) == ("32", "32")
    bulk = ok(editor.post("/api/history/undo-last"))
    assert bulk["count"] == 2 and bulk["text"] == "изменений: 2, объектов: 2"
    assert (get_row(editor, first)["ram"], get_row(editor, second)["ram"]) == ("16", "8")


def test_undo_last_stops_at_creation(editor, room):
    add_pc(editor, room["room"], "pc-1")
    response = editor.post("/api/history/undo-last")
    assert response.status_code == 400 and "не отменяется" in response.json()["detail"]


def test_undo_last_stops_at_settings(editor, room):
    """Последним была настройка без отмены — Ctrl+Z не трогает то, что было раньше."""
    first = add_pc(editor, room["room"], "pc-1")
    ok(editor.patch(f"/api/computers/{first}", json={"ram": "16", "_version": get_row(editor, first)["version"]}))
    ok(editor.patch("/api/table-marks/verified", json={"bold": True}))
    response = editor.post("/api/history/undo-last")
    assert response.status_code == 400 and "настройка" in response.json()["detail"]
    assert get_row(editor, first)["ram"] == "16"


def test_undo_last_style(editor):
    """Оформление столбца из Справочников отменяется, как в Истории."""
    ok(editor.patch("/api/column-styles/os", json={"bold": True}))
    undone = ok(editor.post("/api/history/undo-last"))
    assert undone["entities"] == ["column_styles"] and undone["count"] == 1
    assert "os" not in {item["field"] for item in ok(editor.get("/api/column-styles"))["items"]}


def test_vnc_default(admin, editor, reader):
    assert ok(reader.get("/api/settings")) == {"vnc_default": "tight"}
    assert reader.patch("/api/settings", json={"vnc_default": "ultra"}).status_code == 403
    assert editor.patch("/api/settings", json={"vnc_default": "real"}).status_code == 422
    assert ok(editor.patch("/api/settings", json={"vnc_default": "ultra"})) == {"vnc_default": "ultra"}
    assert ok(reader.get("/api/settings")) == {"vnc_default": "ultra"}
    history = ok(editor.get("/api/history", params={"entity": "app_settings"}))["items"]
    assert history[0]["title"] == "VNC по умолчанию"
    assert history[0]["changes"] == {"vnc_default": {"old": "TightVNC", "new": "UltraVNC"}}
