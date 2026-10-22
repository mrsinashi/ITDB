"""Этап 73: Router – адрес-лист Mikrotik (RouterOS 6.49, API по api-ssl, не REST): подключение,
сбор в scan_hosts, столбец «Router» и комментарий в «Сети», источник журнала «IP», кружки у IP.

API RouterOS изображает сервер в этом же процессе (fakes.py: TLS, самоподписанный сертификат)."""
from datetime import timedelta

import pytest

import scan_router
from conftest import add_pc, history, ok
from db import SessionLocal
from fakes import Router, collect, setup_router, source
from models import ScanHost, ScanSource
from scan_http import SourceError
from test_69 import own_perms, set_perms  # noqa: F401 – own_perms – фикстура
from test_71 import NOW, keys, row_of, seed

LONG = "Отдел кадров, второй этаж, кабинет 214, рядом с окном – компьютер начальника отдела Петровой"


def allowed(*rows):
    Router.lists = {"allowed": list(rows)}


def router_rows():
    session = SessionLocal()

    try:
        return {row.ip: (row.name, row.data) for row in session.query(ScanHost).filter(ScanHost.source == "router")}
    finally:
        session.close()


def check(client, **form):
    return ok(client.post("/api/scan/sources/router/check", json=form or None))


# ---------- Разбор ----------


class Buffer:
    """Сокет, из которого читается заданное."""

    def __init__(self, data):
        self.data = data

    def recv(self, n):
        chunk, self.data = self.data[:n], self.data[n:]
        return chunk


@pytest.mark.parametrize("n, head", [
    (0x7F, b"\x7f"), (0x80, b"\x80\x80"), (0x3FFF, b"\xbf\xff"), (0x4000, b"\xc0\x40\x00"),
    (0x1FFFFF, b"\xdf\xff\xff"), (0x200000, b"\xe0\x20\x00\x00"), (0x10000000, b"\xf0\x10\x00\x00\x00"),
])
def test_length(n, head):
    assert scan_router.encode_length(n) == head
    api = scan_router.Api({"url": "router.test"})
    api.sock = Buffer(head)
    assert api.read_length() == n


def test_sentence_and_text():
    api = scan_router.Api({"url": "router.test"})
    comment = "Бухгалтерия".encode("cp1251")
    api.sock = Buffer(
        b"\x03!re" + bytes([len(b"=comment=") + len(comment)]) + b"=comment=" + comment + b"\x10=address=1.2.3.4\x00"
        + b"\x06!fatal\x0dnot logged in\x00"
    )
    # Комментарий из Winbox – в кодировке Windows: читается как cp1251
    assert api.sentence() == ("!re", {"comment": "Бухгалтерия", "address": "1.2.3.4"})
    assert api.sentence() == ("!fatal", {"message": "not logged in"})
    assert scan_router.text("Ёлка".encode("utf-8")) == "Ёлка"
    # Пустые предложения пропускаются – и тысячи подряд не роняют разбор
    api.sock = Buffer(b"\x00" * 5000 + b"\x05!done\x00")
    assert api.sentence() == ("!done", {})


def test_version_errors(monkeypatch):
    api = scan_router.Api({"url": "router.test"})

    def talk(error):
        def fail(*words):
            raise error
        return fail

    # Нет прав на /system/resource – версии нет, сбор идёт дальше
    monkeypatch.setattr(api, "talk", talk(scan_router.Trap("Router: not enough permissions")))
    assert api.version() is None
    # Таймаут – ошибка: поздний ответ иначе сочли бы строками адрес-листа и стёрли бы список
    monkeypatch.setattr(api, "talk", talk(SourceError("router.test не ответил за 15 с.")))
    with pytest.raises(SourceError, match="не ответил"):
        api.version()


def test_entries():
    items, skipped = scan_router.entries([
        {"address": "10.0.0.5", "comment": " pc-5 ", "disabled": "false", "dynamic": "false"},
        {"address": "10.0.0.6/32", "disabled": "true", "dynamic": "true", "timeout": "1d"},
        {"address": "10.0.1.0/24"},
        {"address": "10.0.2.1-10.0.2.9"},
        {"address": "ya.ru"},
        # Адрес дважды – включённая главнее
        {"address": "10.0.0.7", "disabled": "true"},
        {"address": "10.0.0.7", "disabled": "false", "comment": "on"},
    ])
    assert skipped == 3
    assert items == [
        {"ip": "10.0.0.5", "name": "pc-5", "data": {"disabled": False, "dynamic": False}},
        {"ip": "10.0.0.6", "name": None, "data": {"disabled": True, "dynamic": True, "timeout": "1d"}},
        {"ip": "10.0.0.7", "name": "on", "data": {"disabled": False, "dynamic": False}},
    ]
    with pytest.raises(SourceError, match="Укажи адрес-лист"):
        scan_router.read_list({"url": "router.test", "address_list": " "})


# ---------- Подключение ----------


def test_settings_and_check(admin, router_port):
    allowed({"address": "10.0.0.5", "comment": "pc-5"}, {"address": "10.0.0.6", "disabled": True}, {"address": "10.0.3.0/24"})
    setup_router(admin, router_port)
    s = source(admin, "router")
    assert (s["title"], s["form"], s["url"], s["address_list"], s["verify_tls"]) == (
        "Router", "router", f"127.0.0.1:{router_port}", "allowed", False,
    )
    assert s["secrets"] == {"password": True} and s["fresh_days"] == 7
    # В Истории – адрес-лист; у других источников его нет, чужое поле отбрасывается
    assert history(admin, "scan_sources")[0]["changes"]["address_list"] == {"old": None, "new": "allowed"}
    assert ok(admin.patch("/api/scan/sources/glpi", json={"url": "https://glpi.lan", "address_list": "x"}))["address_list"] is None
    assert "address_list" not in history(admin, "scan_sources")[0]["changes"]

    result = check(admin)
    assert result["ok"] and result["saved"], result
    assert result["message"] == "Подключено: RouterOS 6.49.17 (long-term), «allowed» – адресов: 2, Enabled: 1, пропущено (подсети, диапазоны): 1"

    # Порт api-ssl по умолчанию не пишется
    ok(admin.patch("/api/scan/sources/router", json={"url": "10.0.0.1:8729"}))
    assert source(admin, "router")["url"] == "10.0.0.1"
    ok(admin.patch("/api/scan/sources/router", json={"url": f"127.0.0.1:{router_port}"}))

    # Ошибки – понятным текстом
    Router.password = "other"
    assert check(admin)["message"] == "Router не пустил: неверный логин или пароль."
    Router.bad_login = "close"
    assert check(admin)["message"].startswith("Router закрыл соединение при входе: неверный логин или пароль")
    Router.password = "pw"
    result = check(admin, address_list="Allowed")
    assert not result["ok"] and not result["saved"] and "В адрес-листе «Allowed» нет записей" in result["message"]
    result = check(admin, verify_tls=True)
    assert not result["ok"] and "не прошёл проверку" in result["message"]
    assert "не принимает подключения" in check(admin, url="127.0.0.1:1")["message"]

    # Список заведён в Winbox на русской Windows: имя в cp1251 – второй запрос в этой кодировке
    name = "Разрешённые"
    Router.lists = {name.encode("cp1251").decode("utf-8", "surrogateescape"): [{"address": "10.0.0.5"}]}
    Router.asked = []
    result = check(admin, address_list=name)
    assert result["ok"] and "«Разрешённые» – адресов: 1, Enabled: 1" in result["message"], result
    assert Router.asked.count("/ip/firewall/address-list/print") == 2

    # Адрес-лист сменили – прошлая проверка ничего не говорит
    ok(admin.patch("/api/scan/sources/router", json={"address_list": "other"}))
    assert source(admin, "router")["checked_at"] is None
    assert admin.patch("/api/scan/sources/router", json={"address_list": "x" * 101}).status_code == 400


# ---------- Сбор ----------


def test_collect(admin, router_port):
    allowed(
        {"address": "10.0.0.5", "comment": "Бухгалтерия".encode("cp1251")},
        {"address": "10.0.0.6", "disabled": True, "comment": LONG},
        {"address": "10.0.0.7", "dynamic": True, "timeout": "23:59:00"},
        {"address": "10.0.1.0/24"},
    )
    setup_router(admin, router_port)
    run = collect(admin, "router")
    assert run["status"] == "ok", run
    assert run["message"] == "Пропущено (подсети, диапазоны, имена): 1"
    stats = run["stats"]
    assert (stats["total"], stats["enabled"], stats["disabled"], stats["dynamic"], stats["skipped"], stats["list"]) == (3, 2, 1, 1, 1, "allowed")
    rows = router_rows()
    assert rows["10.0.0.5"][0] == "Бухгалтерия" and rows["10.0.0.6"] == (LONG, {
        "disabled": True, "dynamic": False, "created": "oct/22/2026 10:00:00",
    })
    assert rows["10.0.0.7"][1]["timeout"] == "23:59:00"

    # Список – настройка роутера: заменяется целиком
    allowed({"address": "10.0.0.8"})
    assert collect(admin, "router")["status"] == "ok"
    assert set(router_rows()) == {"10.0.0.8"}

    # Пустой (опечатка в названии) – ошибка, прежний список остаётся
    allowed()
    run = collect(admin, "router")
    assert run["status"] == "error" and "нет записей" in run["message"]
    assert set(router_rows()) == {"10.0.0.8"}
    # Одни подсети – тоже ошибка: пустой список не заменяет прежний
    allowed({"address": "10.0.1.0/24"})
    run = collect(admin, "router")
    assert run["status"] == "error" and "нет отдельных адресов" in run["message"]
    assert set(router_rows()) == {"10.0.0.8"}

    # Расписание знает Router
    assert "router" in [item["kind"] for item in ok(admin.get("/api/scan/schedule"))["items"]]


def test_collect_rights(admin, editor, reader, router_port):
    allowed({"address": "10.0.0.5"})
    setup_router(admin, router_port)
    # Сбор – с «запуском» «Сети» (редактор – просмотр «Сети», как у DHCP и прохода подсетей)
    assert reader.post("/api/scan/sources/router/collect").status_code == 403
    assert editor.post("/api/scan/sources/router/collect").status_code == 403
    assert editor.patch("/api/scan/sources/router", json={"address_list": "x"}).status_code == 403


# ---------- «Сеть», журнал «IP», кружки ----------


def test_net_tab(admin, room, router_port):
    pc = add_pc(admin, room["room"], "buh-1", ip="10.0.0.5")
    seed(ScanHost(source="net", ip="10.0.0.5", mac=None, name="BUH-1", seen_at=NOW, data={"how": ["ping"]}))
    allowed({"address": "10.0.0.5", "comment": "Бухгалтерия"}, {"address": "10.0.0.6", "disabled": True})
    setup_router(admin, router_port)
    collect(admin, "router")
    data = ok(admin.get("/api/scan/hosts"))
    hosts = {h["ip"]: h for h in data["hosts"]}
    host = hosts["10.0.0.5"]
    assert host["router"]["text"] == "Enabled" and host["router"]["name"] == "Бухгалтерия"
    # Комментарий – в «Имени» последним, с источником Router; это подпись, а не имя машины –
    # не «Расхождение»
    assert [(n["value"], n["sources"]) for n in host["name"]] == [("BUH-1", ["Сканер"]), ("Бухгалтерия", ["Router"])]
    assert not host["differ"] and [c["computer_id"] for c in host["computers"]] == [pc]
    # Адрес только из списка: строка есть, «Когда» – не про него (не наблюдение)
    assert hosts["10.0.0.6"]["router"]["text"] == "Disabled" and hosts["10.0.0.6"]["seen_at"] is None
    assert not hosts["10.0.0.6"]["stale"]
    assert "router" in [s["kind"] for s in data["sources"]]

    # Давно не собирали – серым
    session = SessionLocal()
    session.query(ScanHost).filter(ScanHost.source == "router").update({"seen_at": NOW - timedelta(days=8)})
    session.commit()
    session.close()
    hosts = {h["ip"]: h for h in ok(admin.get("/api/scan/hosts"))["hosts"]}
    host = hosts["10.0.0.5"]
    assert host["router"]["stale"] and host["name"][1]["stale"] and not host["stale"]
    # Адрес только из давнего списка – в «Неактуальных»
    assert hosts["10.0.0.6"]["stale"]


def test_router_ips(admin, reader, room, router_port, own_perms):
    add_pc(admin, room["room"], "buh-1", ip="10.0.0.5")
    allowed({"address": "10.0.0.9"}, {"address": "10.0.0.5"}, {"address": "10.0.0.6", "disabled": True})
    setup_router(admin, router_port)
    collect(admin, "router")
    # Кружки – только включённые адреса; список целиком – с правом на «Сеть»
    assert ok(admin.get("/api/scan/hosts/router")) == {"enabled": True, "ips": ["10.0.0.5", "10.0.0.9"]}
    # Без него – только адреса из таблиц, которые он видит (иначе «свободный» адрес журнала «IP»
    # был бы с кружком, а список – виден без права)
    assert ok(reader.get("/api/scan/hosts/router")) == {"enabled": True, "ips": ["10.0.0.5"]}
    set_perms(admin, "reader", {"table": "none"})
    assert ok(reader.get("/api/scan/hosts/router"))["ips"] == []
    set_perms(admin, "reader", {"scan/net": "view"})
    assert ok(reader.get("/api/scan/hosts/router"))["ips"] == ["10.0.0.5", "10.0.0.9"]

    session = SessionLocal()
    session.query(ScanHost).filter(ScanHost.source == "router").update({"seen_at": NOW - timedelta(days=8)})
    session.commit()
    session.close()
    assert ok(admin.get("/api/scan/hosts/router"))["ips"] == []

    ok(admin.patch("/api/scan/sources/router", json={"enabled": False}))
    assert ok(reader.get("/api/scan/hosts/router")) == {"enabled": False, "ips": []}

    session = SessionLocal()
    session.query(ScanSource).filter(ScanSource.kind == "router").delete()
    session.commit()
    session.close()
    assert ok(reader.get("/api/scan/hosts/router")) == {"enabled": False, "ips": []}


def test_ips_journal(admin, reader, room, router_port):
    add_pc(admin, room["room"], "buh-1", ip="10.0.0.5")
    allowed({"address": "10.0.0.5", "comment": "Бухгалтерия"}, {"address": "10.0.0.6", "disabled": True})
    setup_router(admin, router_port)
    collect(admin, "router")
    row = row_of(admin, "10.0.0.5")
    assert keys(row) == ["pc", "router"]
    assert next(s for s in row["sources"] if s["key"] == "router")["details"] == ["Enabled"]
    assert [(n["value"], n["from"]) for n in row["names"]] == [("buh-1", ["pc"]), ("Бухгалтерия", ["router"])]
    assert keys(row_of(admin, "10.0.0.6")) == ["router"]
    # Читателю «Сеть» закрыта – и Router в журнале не виден
    assert keys(row_of(reader, "10.0.0.5")) == ["pc"] and row_of(reader, "10.0.0.6") is None
