"""Этап 40: несколько адресов ПК по MAC из сети, «Совпадает: N» у «привязать?»."""
from pathlib import Path

from conftest import ok
from scan_hostmatch import host_rows
from test_28b import obs, save_hosts
from test_scan_collect import ETH, Glpi, add_pc, collect, diffs_of, glpi_url, pc, secret_key, setup_source  # noqa: F401

STATIC = Path(__file__).resolve().parent.parent / "frontend" / "static"


def test_host_rows_all_addresses():
    """Адреса ПК – все, где его MAC виден в последнем сборе источника, а не один последний."""
    computers = {
        1: {"hostname": "pc-1", "ip": "10.0.5.11", "mac": "D8:CB:8A:00:01:01"},               # в таблице один из трёх
        2: {"hostname": "pc-2", "ip": "10.0.5.12", "mac": "D8:CB:8A:00:01:02"},               # переехал в две подсети
        3: {"hostname": "pc-3", "ip": "10.0.5.13", "mac": "D8:CB:8A:00:01:03"},               # аренда сменилась
        4: {"hostname": "pc-4", "ip": "10.0.5.14\n10.0.6.14", "mac": "D8:CB:8A:00:01:04"},    # все уже в таблице
        5: {"hostname": "pc-5", "ip": "10.0.5.15", "mac": "D8:CB:8A:00:01:05"},               # прежний проход – давнее
    }
    seen = [
        obs("10.0.7.11", "D8:CB:8A:00:01:01"),
        obs("10.0.5.11", "D8:CB:8A:00:01:01"),
        obs("10.0.6.11", "D8:CB:8A:00:01:01"),
        obs("10.0.6.12", "D8:CB:8A:00:01:02"),
        obs("10.0.7.12", "D8:CB:8A:00:01:02"),
        obs("10.0.5.13", "D8:CB:8A:00:01:03", source="dhcp", days=2),
        obs("10.0.5.33", "D8:CB:8A:00:01:03", source="dhcp"),
        obs("10.0.5.14", "D8:CB:8A:00:01:04"),
        obs("10.0.6.14", "D8:CB:8A:00:01:04"),
        obs("10.0.6.15", "D8:CB:8A:00:01:05", days=1),
        obs("10.0.5.15", "D8:CB:8A:00:01:05"),
    ]
    proposals, net = host_rows(computers, seen)
    got = {(p["computer_id"], p["field"]): p["value"] for p in proposals}
    assert got == {
        (1, "ip"): "10.0.5.11\n10.0.6.11\n10.0.7.11",
        (2, "ip"): "10.0.6.12\n10.0.7.12",
        (3, "ip"): "10.0.5.33",
    }
    assert sorted(net[1]["ip"]) == ["10.0.5.11", "10.0.6.11", "10.0.7.11"]


def test_net_adds_addresses(admin, editor, room):
    """Недостающие адреса – предложение «дописать» (а не «в таблице часть»)."""
    ok(admin.patch("/api/scan/sources/net", json={"enabled": True}))
    computer_id = add_pc(editor, room["room"], "pc-boss", ip="10.0.5.11", mac="D8:CB:8A:00:01:01")
    save_hosts(*(obs(ip, "D8:CB:8A:00:01:01") for ip in ("10.0.5.11", "10.0.6.11", "10.0.7.11")))

    items = {(d["computer_id"], d["field"]): d for d in diffs_of(editor)["items"]}
    offer = items[(computer_id, "ip")]
    assert (offer["kind"], offer["table"], offer["proposed"]) == ("diff", "10.0.5.11", "10.0.5.11\n10.0.6.11\n10.0.7.11")
    assert offer["sources"][0]["title"] == "Сеть"


def test_link_note_counts_matches(admin, editor, reader, room, glpi_url):
    """Найдено по IP, а совпадает больше – «Совпадает: N», а не «Совпадает только IP»."""
    loc = room["room"]
    first = add_pc(editor, loc, "pc-1", ip="10.0.5.11", os="Win 10", cpu="i5-10400", ram="8")
    second = add_pc(editor, loc, "pc-2", ip="10.0.5.12")
    Glpi.computers = {
        1: pc("DESKTOP-1", ports=[(ETH, "", ["10.0.5.11"])]),
        2: pc("DESKTOP-2", ports=[(ETH, "", ["10.0.5.12"])]),
    }
    setup_source(admin, glpi_url)
    assert collect(admin)["status"] == "ok"

    items = {(d["computer_id"], d["field"]): d for d in diffs_of(reader)["items"]}
    offer = items[(first, "glpi_id")]
    same = sum(1 for c in offer["compare"] if c["mark"] == "=")
    assert offer["kind"] == "link" and same > 1 and offer["note"] == f"Совпадает: {same}"
    # Совпал только IP – как раньше
    assert items[(second, "glpi_id")]["note"] == "Совпадает только IP"


def test_front_pieces():
    """Полоска строки – в липкой подписи таблицы; блочок в фильтре – без сдвига влево."""
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    css = (STATIC / "app.css").read_text(encoding="utf-8")
    assert '<caption class="row-mark-rail"><div ref="rowMark" class="row-mark"></div></caption>' in html
    assert "caption.row-mark-rail {\n    position: sticky;" in css
    block = css.split(".cf-menu .cf-value.val-chip,", 1)[1].split("}", 1)[0]
    assert "margin-left" not in block and "line-height: 17px" in block
