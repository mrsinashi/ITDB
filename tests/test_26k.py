"""Этап 26к: флешки и внешние диски – не DRIVE (по названию и по интерфейсу из
GLPI); выделения значений в Таблице настраиваются (повтор, «нет в Jabber»,
«давно не подключался», «имя на ПК другое», «срок прошёл»)."""
import scan_normalize as sn
from conftest import ok
from test_scan_collect import Glpi, collect, glpi_url, pc, records, reset_glpi, secret_key, setup_source  # noqa: F401

SSD = ("Samsung SSD 870 EVO 250GB", 238475)


def test_usb_disks_by_name_and_interface():
    disks = [
        {"name": SSD[0], "mb": SSD[1]},
        {"name": "Kingston DataTraveler 3.0", "mb": 14764},
        {"name": "WD Elements 25A2", "mb": 953837},
        {"name": "JetFlash Transcend 16GB", "mb": 15000},
        {"name": "General UDisk", "mb": 7600},
        {"name": "Seagate Expansion Desk", "mb": 1907729},
    ]
    assert sn.drives_short(disks) == "SSD 250"
    # Название обычное, но интерфейс – USB (бокс с диском)
    assert sn.drives_short([disks[0], {"name": "ST1000LM035-1RK172", "mb": 953869, "interface": "USB"}]) == "SSD 250"
    assert sn.drives_short([disks[0], {"name": "ST1000LM035-1RK172", "mb": 953869, "interface": "SATA"}]) == "SSD 250\nHDD 1TB"


def test_collect_skips_usb_interface(admin, glpi_url):
    Glpi.computers = {
        1: pc("pc-1", disks=[SSD + ("SATA",), ("ST1000LM035-1RK172", 953869, "USB")]),
        2: pc("pc-2", disks=[SSD, ("ST2000DM008-2FR102", 1907729, "SATA")]),
    }
    setup_source(admin, glpi_url)
    assert collect(admin)["status"] == "ok"
    recs = records(admin)[1]
    assert recs[1]["values"]["drive"] == "SSD 250"
    assert recs[2]["values"]["drive"] == "SSD 250\nHDD 2TB"

    # Список моделей дисков не отдали (нет права) – сбор идёт, отсев только по названию
    Glpi.disk_models = False
    assert collect(admin)["status"] == "ok"
    assert records(admin)[1][1]["values"]["drive"] == "SSD 250\nHDD 1TB"


def test_table_marks(admin, editor, reader):
    marks = ok(reader.get("/api/table-marks"))
    assert [m["kind"] for m in marks] == ["dup", "hostname", "gone", "stale", "overdue", "verified"]
    by = {m["kind"]: m for m in marks}
    assert by["dup"]["bg_color"] == "#ffd6d6" and by["dup"]["bold"] is False
    assert by["hostname"]["color"] == "#cc0000" and by["hostname"]["bold"] is True
    assert not any(m["changed"] for m in marks)

    assert reader.patch("/api/table-marks/dup", json={"bold": True}).status_code == 403
    assert editor.patch("/api/table-marks/dup", json={"color": "red"}).status_code == 400
    assert editor.patch("/api/table-marks/nope", json={"bold": True}).status_code == 404

    saved = ok(editor.patch("/api/table-marks/hostname", json={"bg_color": "#FFEEAA", "bold": False, "underline": True}))
    assert saved["bg_color"] == "#ffeeaa" and saved["bold"] is False and saved["underline"] is True
    assert saved["color"] == "#cc0000" and saved["changed"] is True
    assert ok(editor.patch("/api/table-marks/hostname", json={"color": ""}))["color"] is None

    by = {m["kind"]: m for m in ok(reader.get("/api/table-marks"))}
    assert by["hostname"]["underline"] is True and by["dup"]["changed"] is False

    history = ok(admin.get("/api/history", params={"entity": "table_marks"}))["items"]
    assert history[0]["title"] == "Имя на ПК другое" and history[0]["changes"]["color"]["new"] is None

    back = ok(editor.patch("/api/table-marks/hostname", json={"reset": True}))
    assert back["color"] == "#cc0000" and back["bold"] is True and back["bg_color"] is None and back["changed"] is False
