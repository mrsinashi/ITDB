"""Этап 31: давние наблюдения сети и Vacuum не удаляются, а помечаются (stale);
у значений «Сети» – имя источника (Сканер, Leases, DHCP Config); VACUUM можно не
только дополнить, но и заменить теми, кто сейчас с адреса ПК."""
from datetime import datetime, timedelta, timezone

from conftest import get_row, ok
from db import SessionLocal
from models import ScanJabberUser
from test_28b import obs, save_hosts
from test_scan_26zh import ago, diffs_data, set_vacuum
from test_scan_collect import add_pc, secret_key  # noqa: F401
from test_scan_jabber import DOMAIN, Ejabberd, jabber_url, reset_jabber, setup_jabber, users_of  # noqa: F401
from test_scan_jabber import collect as jabber_collect


def test_hosts_stale(admin, editor, room):
    pc = add_pc(editor, room["room"], "pc-1", ip="10.0.5.99", mac="D8:CB:8A:00:00:21")
    save_hosts(
        # Сканер видел адрес давно (срок – 7 дней), аренда – сегодня и с другим MAC
        obs("10.0.5.11", "D8:CB:8A:00:00:11", "OLD", days=40, how=["ping"], ports=[445]),
        obs("10.0.5.11", "D8:CB:8A:00:00:12", "pc-new", source="dhcp", state="active", active=True),
        # Только давнее: ПК выключен, но по MAC он в таблице
        obs("10.0.5.21", "D8:CB:8A:00:00:21", "pc-1", days=60, how=["ping"]),
        # Давняя аренда (срок – 30 дней) и привязка
        obs("10.0.5.31", "D8:CB:8A:00:00:31", "pc-3", source="dhcp", days=45, state="free", active=False),
        obs("10.0.5.31", "D8:CB:8A:00:00:31", None, source="dhcp_conf", fixed=True, host="pc-3"),
        # Привязка: её MAC «сейчас» на другом адресе – давнее наблюдение не в счёт
        obs("10.0.5.41", "D8:CB:8A:00:00:21", None, source="dhcp_conf", fixed=True, host="x"),
    )
    hosts = {h["ip"]: h for h in ok(editor.get("/api/scan/hosts"))["hosts"]}

    mixed = hosts["10.0.5.11"]
    assert mixed["mac"] == [
        {"value": "D8:CB:8A:00:00:11", "sources": ["Сканер"], "stale": True},
        {"value": "D8:CB:8A:00:00:12", "sources": ["Leases"], "stale": False},
    ]
    assert [(n["value"], n["stale"]) for n in mixed["name"]] == [("OLD", True), ("pc-new", False)]
    # Давнее значение рядом с нынешним – не расхождение; адрес виден сейчас – не серый
    assert not mixed["differ"] and not mixed["stale"] and mixed["seen_by"] == "Leases"
    assert mixed["net"]["stale"] and not mixed["dhcp"]["stale"] and mixed["ports"] == [445]

    off = hosts["10.0.5.21"]
    assert off["stale"] and off["mac"][0]["stale"] and off["seen_by"] == "Сканер"
    assert [(c["computer_id"], c["by"]) for c in off["computers"]] == [(pc, ["mac"])]

    lease = hosts["10.0.5.31"]
    assert lease["stale"] and lease["dhcp"]["stale"] and lease["dhcp"]["text"] == "аренда кончилась"
    # MAC называет и привязка (она не устаревает) – значение не серое
    assert lease["mac"] == [{"value": "D8:CB:8A:00:00:31", "sources": ["Leases", "DHCP Config"], "stale": False}]

    assert hosts["10.0.5.41"]["conf"]["details"] == ["host x"] and not hosts["10.0.5.41"]["stale"]


def test_vacuum_page_stale(admin, editor, room, jabber_url):
    add_pc(editor, room["room"], "pc-1", ip="10.0.2.11")
    Ejabberd.users = {"ivanov": "Подключён", "old_user": ago(40), "never": "Никогда", "moved": ago(1), "ghost2": ago(50)}
    Ejabberd.online = {"ivanov": [("Vacuum-IM", "10.0.2.11")]}
    Ejabberd.groups = {"ИТ": [f"{u}@{DOMAIN}" for u in ("ivanov", "old_user", "never", "moved", "ghost2", "gone")]}
    setup_jabber(admin, jabber_url)
    assert jabber_collect(admin)["status"] == "ok"

    # «moved» подключался вчера, но ITDB видел его в сети (и его адрес) 20 дней назад
    session = SessionLocal()
    session.query(ScanJabberUser).filter(ScanJabberUser.login == "moved").update({
        "last_ip": "10.0.2.11", "last_seen_at": datetime.now(timezone.utc) - timedelta(days=20),
    })
    session.query(ScanJabberUser).filter(ScanJabberUser.login == "old_user").update({
        "last_ip": "10.0.2.50", "last_seen_at": datetime.now(timezone.utc) - timedelta(days=40),
    })
    session.commit()
    session.close()

    users = users_of(editor)
    marks = {login: (u["stale"], u["ip_stale"]) for login, u in users.items()}
    assert marks == {
        "ivanov": (False, False),      # в сети
        "old_user": (True, True),      # давно не подключался – строка остаётся, с последним IP
        "never": (False, False),       # не подключался никогда – устаревать нечему
        "moved": (False, True),        # сам недавний, а адрес – давний
        "ghost2": (True, False),
        "gone": (False, False),        # удалён – это другая пометка
    }
    assert users["old_user"]["addresses"][0]["ip"] == "10.0.2.50" and users["gone"]["gone"]
    assert users["moved"]["addresses"][0]["hosts"][0]["hostname"] == "pc-1"

    # Срок – «Актуальны» у подключения
    ok(admin.patch("/api/scan/sources/jabber", json={"fresh_days": 60}))
    assert not any(u["stale"] or u["ip_stale"] for u in users_of(editor).values())


def test_vacuum_replace(admin, editor, reader, room, jabber_url):
    loc = room["room"]
    first = add_pc(editor, loc, "pc-1", ip="10.0.2.11")
    set_vacuum(editor, first, "ivanov\nold_user")
    second = add_pc(editor, loc, "pc-2", ip="10.0.2.12")
    third = add_pc(editor, loc, "pc-3", ip="10.0.2.13")
    set_vacuum(editor, third, "sidorov")
    fourth = add_pc(editor, loc, "pc-4", ip="10.0.2.14")
    set_vacuum(editor, fourth, "kuzmin")

    Ejabberd.users = {login: "Подключён" for login in ("ivanov", "petrova", "smirnov", "sidorov", "orlova", "novikov")}
    Ejabberd.users["old_user"] = ago(40)
    Ejabberd.users["kuzmin"] = ago(1)
    Ejabberd.online = {
        "ivanov": [("Vacuum-IM", "10.0.2.11")], "petrova": [("Vacuum-IM", "10.0.2.11")],
        "smirnov": [("Vacuum-IM", "10.0.2.12")],
        "sidorov": [("Vacuum-IM", "10.0.2.13")], "orlova": [("Vacuum-IM", "10.0.2.13")],
        "novikov": [("Vacuum-IM", "10.0.2.14")],
    }
    setup_jabber(admin, jabber_url)
    assert jabber_collect(admin)["status"] == "ok"

    _, diffs = diffs_data(reader)
    # Дополнить – все прежние и новый; заменить – только те, кто сейчас с адреса ПК
    d = diffs[(first, "vacuum")]
    assert d["proposed"] == "ivanov\nold_user\npetrova" and d["replace"] == "ivanov\npetrova"
    # В таблице пусто – заменять нечего
    assert diffs[(second, "vacuum")]["kind"] == "fill" and diffs[(second, "vacuum")]["replace"] == ""
    # Все из ячейки и так с адреса ПК – «заменить» дало бы то же, что «добавить»
    assert diffs[(third, "vacuum")]["proposed"] == "orlova\nsidorov" and diffs[(third, "vacuum")]["replace"] == ""
    # За ПК сел другой человек
    assert diffs[(fourth, "vacuum")]["proposed"] == "kuzmin\nnovikov" and diffs[(fourth, "vacuum")]["replace"] == "novikov"

    ok(editor.post("/api/scan/diffs/accept", json={"items": [
        {"computer_id": fourth, "field": "vacuum", "value": diffs[(fourth, "vacuum")]["replace"], "table": "kuzmin", "source": "Jabber"},
    ]}))
    assert get_row(editor, fourth)["vacuum"] == "novikov"
    assert (fourth, "vacuum") not in diffs_data(editor)[1]
    # Обычная правка с пометкой «из Jabber» – отменяется, как любая другая
    history = ok(editor.get("/api/history", params={"entity": "computers", "entity_id": fourth}))["items"]
    assert history[0]["changes"]["vacuum"]["scan"] == "Jabber"
