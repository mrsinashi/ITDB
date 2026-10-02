"""Этап 26з: логин с латинскими буквами заменяется, а не дописывается; драйверы
удалённого доступа — не видеокарты; личные настройки «без закруглений» и
«счётчики на кнопках»; столбец «Антивирус» по центру."""
import scan_normalize as sn
from conftest import ok
from test_scan_26zh import diffs_data, set_vacuum
from test_scan_collect import add_pc, secret_key  # noqa: F401
from test_scan_jabber import DOMAIN, Ejabberd, jabber_url, reset_jabber, setup_jabber  # noqa: F401
from test_scan_jabber import collect as jabber_collect


def test_lookalike_login_is_replaced(admin, editor, room, jabber_url):
    loc = room["room"]
    first = add_pc(editor, loc, "pc-1", ip="10.0.2.11")
    # «c» — латинская: такого логина в Jabber нет, а с адреса ПК пришла «сумкина_и.а.»
    set_vacuum(editor, first, "cумкина_и.а.\nivanov")
    second = add_pc(editor, loc, "pc-2", ip="10.0.2.12")
    set_vacuum(editor, second, "typo")

    Ejabberd.users = {"сумкина_и.а.": "Подключён", "ivanov": "Подключён", "petrova": "Подключён"}
    Ejabberd.online = {
        "сумкина_и.а.": [("Vacuum-IM", "10.0.2.11")], "ivanov": [("Vacuum-IM", "10.0.2.11")],
        "petrova": [("Vacuum-IM", "10.0.2.12")],
    }
    Ejabberd.groups = {"ИТ": [f"{u}@{DOMAIN}" for u in Ejabberd.users]}
    setup_jabber(admin, jabber_url)
    assert jabber_collect(admin)["status"] == "ok"

    data, diffs = diffs_data(editor)
    d = diffs[(first, "vacuum")]
    assert d["table"] == "cумкина_и.а.\nivanov" and d["proposed"] == "ivanov\nсумкина_и.а."
    assert "латинские" in d["note"]
    # Просто чужой логин, которого нет в Jabber, остаётся: его только помечают
    assert diffs[(second, "vacuum")]["proposed"] == "petrova\ntypo"
    assert data["vacuum_missing"] == ["cумкина_и.а.", "typo"]


def test_remote_drivers_are_not_gpus():
    assert sn.gpu_short(["mv video hook driver2"]) is None
    assert sn.gpu_short(["NVIDIA GeForce GT 1030", "mv video hook driver2", "DameWare Development Mirror Driver 64-bit"]) == "GT 1030"
    assert sn.gpu_list(["Radeon RX 550", "RDP Encoder Mirror Driver", "DisplayLink USB Device"]) == ["Radeon RX 550"]


def test_personal_view_prefs(reader):
    prefs = ok(reader.patch("/api/auth/me/prefs", json={"no_radius": True, "button_counts": False}))["prefs"]
    assert prefs["no_radius"] is True and prefs["button_counts"] is False
    assert ok(reader.get("/api/auth/me"))["prefs"]["no_radius"] is True


def test_antivirus_column_centered(reader):
    columns = {c["key"]: c for c in ok(reader.get("/api/columns"))["columns"]}
    assert columns["antivirus"]["center"] is True
