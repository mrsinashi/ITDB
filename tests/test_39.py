"""Этап 39: сравнение записи с ПК – у любого предложения номера записи GLPI / GSIT;
шаблон страницы не виден до запуска Vue."""
import re
from pathlib import Path

from test_scan_collect import ETH, Glpi, add_pc, collect, diffs_of, glpi_url, pc, secret_key, setup_source  # noqa: F401

STATIC = Path(__file__).resolve().parent.parent / "frontend" / "static"


def test_id_compare_always(admin, editor, reader, room, glpi_url):
    """Номер записи предлагается ПК, найденному по MAC, – к нему тоже сравнение по полям."""
    loc = room["room"]
    computer_id = add_pc(editor, loc, "pc-1", ip="10.0.5.11", mac="D8:BB:C1:00:00:01")
    Glpi.computers = {
        1: pc("DESKTOP-1", ports=[(ETH, "d8:bb:c1:00:00:01", ["10.0.5.11"])]),
    }
    setup_source(admin, glpi_url)
    assert collect(admin)["status"] == "ok"

    items = {d["field"]: d for d in diffs_of(reader)["items"] if d["computer_id"] == computer_id}
    offer = items["glpi_id"]
    assert (offer["kind"], offer["proposed"]) == ("fill", "1")
    compare = {c["field"]: c for c in offer["compare"]}
    assert (compare["hostname"]["table"], compare["hostname"]["source"], compare["hostname"]["mark"]) == ("pc-1", "DESKTOP-1", "≠")
    assert compare["ip"]["mark"] == "=" and compare["mac"]["mark"] == "="
    # У остальных полей сравнения нет
    assert all(not d["compare"] for field, d in items.items() if field != "glpi_id")


def test_cloak_hides_app():
    """#app { display: flex } сильнее [v-cloak] – правило скрытия должно быть с #app."""
    css = (STATIC / "app.css").read_text(encoding="utf-8")
    assert re.search(r"#app\[v-cloak\][^{}]*\{\s*display:\s*none;", css)
    assert '<div id="app" v-cloak>' in (STATIC / "index.html").read_text(encoding="utf-8")
