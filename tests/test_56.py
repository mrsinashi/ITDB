"""Этап 56 (рефакторинг 14.10 п. 10, 9): сохранение подключения по частям – История, порядок
проверок и сброс прошлой проверки как прежде; принтеры: «Записать» пропускает пропавший
принтер (как у ПК), блокировки по id, смена типа модели – № по кабинетам и номерам."""
from datetime import datetime, timezone

from conftest import add_pc, get_row, history, ok
from db import SessionLocal
from models import ScanSource
from test_28b import obs, save_hosts
from test_printers import add_printer, printer


def source(client, kind):
    return next(s for s in ok(client.get("/api/scan/sources"))["sources"] if s["kind"] == kind)


def last_changes(client):
    return history(client, "scan_sources")[0]["changes"]


def stamp_check(kind, **options):
    """Как будто подключение проверено (и у DHCP запомнен ключ сервера)."""
    with SessionLocal() as session:
        row = session.query(ScanSource).filter_by(kind=kind).one()
        row.checked_at, row.check_ok, row.check_message = datetime.now(timezone.utc), True, "ok"
        row.options = dict(row.options or {}, **options)
        session.commit()


# ---------- Подключения ----------


def test_glpi_history_and_check(admin):
    saved = ok(admin.patch("/api/scan/sources/glpi", json={
        "url": "https://glpi.lan/", "login": "itdb", "password": "p", "user_token": "u", "verify_tls": False,
        "fresh_days": 7,
        # чужие поля – отбрасываются
        "domain": "x.lan", "path": "/tmp/a", "configs": ["/etc/a.conf"], "names": False, "online_minutes": 5,
    }))
    assert (saved["url"], saved["domain"], saved["path"], saved["names"], saved["online_minutes"]) == (
        "https://glpi.lan", None, None, None, None)
    assert last_changes(admin) == {
        "url": {"old": None, "new": "https://glpi.lan"},
        "login": {"old": None, "new": "itdb"},
        "password": {"old": None, "new": "задан новый"},
        "user_token": {"old": None, "new": "задан новый"},
        "verify_tls": {"old": True, "new": False},
        "fresh_days": {"old": 3, "new": 7},
    }

    # Срок и «вкл» – не подключение: прошлая проверка остаётся
    stamp_check("glpi")
    saved = ok(admin.patch("/api/scan/sources/glpi", json={"fresh_days": 9, "enabled": True}))
    assert saved["check_ok"] is True and saved["enabled"] is True
    assert last_changes(admin) == {"fresh_days": {"old": 7, "new": 9}, "enabled": {"old": False, "new": True}}

    # То же значение – ни записи, ни сброса; другой логин – проверка сброшена
    total = len(history(admin, "scan_sources"))
    assert ok(admin.patch("/api/scan/sources/glpi", json={"login": "itdb"}))["check_ok"] is True
    assert len(history(admin, "scan_sources")) == total
    saved = ok(admin.patch("/api/scan/sources/glpi", json={"login": "other", "user_token": ""}))
    assert saved["check_ok"] is None and saved["checked_at"] is None and saved["secrets"]["user_token"] is False
    assert last_changes(admin) == {"login": {"old": "itdb", "new": "other"}, "user_token": {"old": None, "new": "удалён"}}


def test_errors_in_order_and_nothing_saved(admin):
    ok(admin.patch("/api/scan/sources/glpi", json={"url": "http://glpi", "fresh_days": 5}))
    total = len(history(admin, "scan_sources"))

    def error(kind, body):
        response = admin.patch(f"/api/scan/sources/{kind}", json=body)
        assert response.status_code == 400, response.text
        return response.json()["detail"]

    # Сначала адрес, потом срок, потом файлы, «в сети», «вкл»
    assert "http://" in error("glpi", {"url": "glpi.lan", "fresh_days": 0, "password": "x"})
    assert "Срок" in error("glpi", {"fresh_days": 0, "enabled": True, "login": "y"})
    assert error("jabber", {"url": "j.lan", "online_minutes": 0}).startswith("Адрес веб-админки")
    assert "1–60" in error("jabber", {"online_minutes": 0, "enabled": True})
    assert error("dhcp", {"fresh_days": 400, "path": "rel"}).startswith("Срок")
    assert error("dhcp", {"enabled": True}) == "Сначала укажи адрес."
    assert error("glpi", {"login": "x" * 501}) == "Слишком длинное значение."

    # Ошибка – ничего не сохранено (и пароль из того же запроса)
    saved = source(admin, "glpi")
    assert (saved["url"], saved["fresh_days"], saved["login"], saved["secrets"]["password"]) == ("http://glpi", 5, None, False)
    assert len(history(admin, "scan_sources")) == total


def test_jabber_domain_and_online(admin):
    saved = ok(admin.patch("/api/scan/sources/jabber", json={
        "url": "http://j.lan:5280/admin/server/xmpp.lan/users/", "online_watch": False, "online_minutes": 5,
        "user_token": "t", "names": False,
    }))
    assert (saved["url"], saved["domain"], saved["online_watch"], saved["online_minutes"]) == (
        "http://j.lan:5280", "xmpp.lan", False, 5)
    assert last_changes(admin) == {
        "url": {"old": None, "new": "http://j.lan:5280"},
        "domain": {"old": None, "new": "xmpp.lan"},
        "online_watch": {"old": True, "new": False},
        "online_minutes": {"old": 2, "new": 5},
    }

    # Домен уже есть – из адреса не берётся; свой домен в форме – главнее
    saved = ok(admin.patch("/api/scan/sources/jabber", json={"url": "http://j2.lan:5280/admin/server/other.lan/"}))
    assert (saved["url"], saved["domain"]) == ("http://j2.lan:5280", "xmpp.lan")
    saved = ok(admin.patch("/api/scan/sources/jabber", json={"url": "http://j.lan:5280/admin/server/a.lan/", "domain": "b.lan"}))
    assert saved["domain"] == "b.lan"
    # «В сети» – не подключение
    stamp_check("jabber")
    assert ok(admin.patch("/api/scan/sources/jabber", json={"online_minutes": 10}))["check_ok"] is True


def test_dhcp_files_and_host_key(admin):
    ok(admin.patch("/api/scan/sources/dhcp", json={"url": "10.0.0.5:22", "login": "root"}))
    saved = ok(admin.patch("/api/scan/sources/dhcp", json={"path": "/var/lib/dhcpd/dhcpd.leases /etc/dhcp/dhcpd.conf"}))
    assert saved["configs"] == ["/etc/dhcp/dhcpd.conf"]
    assert last_changes(admin) == {"configs": {"old": None, "new": "/etc/dhcp/dhcpd.conf"}}

    # Тот же адрес – ключ сервера помнится; другой – забыт, проверка сброшена
    stamp_check("dhcp", host_key="AAAA")
    saved = ok(admin.patch("/api/scan/sources/dhcp", json={"url": "10.0.0.5:22", "fresh_days": 40}))
    assert saved["host_key"] is not None and saved["check_ok"] is True
    saved = ok(admin.patch("/api/scan/sources/dhcp", json={"url": "10.0.0.6:22"}))
    assert saved["host_key"] is None and saved["check_ok"] is None
    assert last_changes(admin) == {
        "url": {"old": "10.0.0.5", "new": "10.0.0.6"},
        "host_key": {"old": None, "new": "забыт"},
    }

    # Забыть по просьбе
    stamp_check("dhcp", host_key="BBBB")
    assert ok(admin.patch("/api/scan/sources/dhcp", json={"forget_host": True}))["host_key"] is None
    assert last_changes(admin) == {"host_key": {"old": None, "new": "забыт"}}


def test_net_options(admin):
    saved = ok(admin.patch("/api/scan/sources/net", json={
        "names": False, "ports": True, "url": "http://x", "login": "u", "password": "p", "verify_tls": False,
    }))
    assert (saved["names"], saved["ports"], saved["url"], saved["login"], saved["secrets"]) == (False, True, None, None, {})
    assert last_changes(admin) == {"names": {"old": True, "new": False}, "ports": {"old": False, "new": True}}
    # У «Сети» адреса нет – включается без него
    assert ok(admin.patch("/api/scan/sources/net", json={"enabled": True}))["enabled"] is True


# ---------- Принтеры ----------


def test_printer_accept_skips_missing(admin, editor, reader, room):
    ok(admin.patch("/api/scan/sources/net", json={"enabled": True}))
    first = add_printer(editor, room["room"], name="prn-1", ip="10.0.9.41")
    second = add_printer(editor, room["room"], name="prn-2", ip="10.0.9.42")
    gone = add_printer(editor, room["room"], name="prn-3", ip="10.0.9.43")
    save_hosts(obs("10.0.9.41", "D8:00:00:00:00:41"), obs("10.0.9.42", "D8:00:00:00:00:42"), obs("10.0.9.43", "D8:00:00:00:00:43"))
    ok(editor.post("/api/printers/archive", json={"ids": [gone], "archived": True}))

    # Порядок в списке – не по id; пропавший и архивный – пропущены, остальные записаны
    item = lambda pid, mac: {"printer_id": pid, "field": "mac", "value": mac, "table": "", "source": "Сеть"}  # noqa: E731
    result = ok(editor.post("/api/scan/printer-diffs/accept", json={"items": [
        item(second, "D8:00:00:00:00:42"), item(999999, "D8:00:00:00:00:99"), item(gone, "D8:00:00:00:00:43"),
        item(first, "D8:00:00:00:00:41"),
    ]}))
    assert result == {"accepted": 2, "skipped": ["prn-3", "#999999"]}
    assert printer(reader, first)["mac"] == "D8:00:00:00:00:41" and printer(reader, second)["mac"] == "D8:00:00:00:00:42"
    assert printer(reader, gone)["mac"] in (None, "")
    assert history(reader, "printers", second)[0]["changes"]["mac"] == {
        "old": None, "new": "D8:00:00:00:00:42", "scan": "Сеть"}


def test_accept_same_field_twice(editor, reader, room):
    """Два пункта одного поля в одном «Записать» (запросом в обход страницы): одна запись
    Истории, «было» – первое; вернулось к прежнему – записи нет."""
    pid = add_printer(editor, room["room"], name="prn-1")
    mac_a, mac_b = "D8:00:00:00:00:41", "D8:00:00:00:00:42"
    item = lambda table, value: {"printer_id": pid, "field": "mac", "value": value, "table": table}  # noqa: E731
    total = len(history(reader, "printers", pid))
    version = printer(reader, pid)["version"]

    ok(editor.post("/api/scan/printer-diffs/accept", json={"items": [item("", mac_a), item(mac_a, mac_a + "\n" + mac_b)]}))
    records = history(reader, "printers", pid)
    assert len(records) == total + 1 and printer(reader, pid)["version"] == version + 1
    assert records[0]["changes"]["mac"] == {"old": None, "new": mac_a + "\n" + mac_b, "scan": "сканер"}

    ok(editor.post("/api/scan/printer-diffs/accept", json={"items": [
        item(mac_a + "\n" + mac_b, mac_a), item(mac_a, mac_a + "\n" + mac_b),
    ]}))
    assert len(history(reader, "printers", pid)) == total + 1 and printer(reader, pid)["version"] == version + 1

    # У ПК – так же
    computer = add_pc(editor, room["room"], "pc-1")
    before = get_row(reader, computer)
    ok(editor.post("/api/scan/diffs/accept", json={"items": [
        {"computer_id": computer, "field": "ram", "value": "8", "table": ""},
        {"computer_id": computer, "field": "ram", "value": "16", "table": "8"},
    ]}))
    after = get_row(reader, computer)
    assert after["ram"] == "16" and after["version"] == before["version"] + 1
    assert history(reader, "computers", computer)[0]["changes"]["ram"]["new"] == "16"
    assert not history(reader, "computers", computer)[0]["changes"]["ram"]["old"]


def test_model_kind_renumbers(editor, reader, room, models):
    loc = room["room"]
    mfu_1 = add_printer(editor, loc, name="mfu-1", model_id=models["mfu"]["id"], number=1)
    mfu_2 = add_printer(editor, loc, name="mfu-2", model_id=models["mfu"]["id"], number=2)
    # id меньше – № больше: обход по №, а не по id
    second = add_printer(editor, loc, name="prn-b", model_id=models["printer"]["id"], number=2)
    first = add_printer(editor, loc, name="prn-a", model_id=models["printer"]["id"], number=1)

    ok(editor.patch(f"/api/printer-models/{models['printer']['id']}", json={"kind": "mfu"}))
    numbers = {pid: printer(reader, pid)["number"] for pid in (mfu_1, mfu_2, first, second)}
    assert numbers == {mfu_1: 1, mfu_2: 2, first: 3, second: 4}
    assert history(reader, "printers", first)[0]["changes"]["number"] == {"old": 1, "new": 3}

    # Обратно – в пустой счёт принтеров: № свободны, ничего не меняется
    ok(editor.patch(f"/api/printer-models/{models['printer']['id']}", json={"kind": "printer"}))
    assert {pid: printer(reader, pid)["number"] for pid in (first, second)} == {first: 3, second: 4}
