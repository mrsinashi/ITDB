"""Этап 71: журнал «IP» – строка на адрес со всеми источниками (Компьютеры, Принтеры, Движение,
сам журнал, сканер, Vacuum), запись журнала и описание у любого адреса, архив, массовая правка,
отмена из Истории, права вкладки и «Сканировать» с неё."""
from datetime import datetime, timedelta, timezone

from auth import PAGE_LEVELS, ROLE_PAGES
from conftest import add_pc, history, ok
from db import SessionLocal
from models import ScanHost, ScanJabberUser, ScanRecord
from test_66 import add_move, types, user_id  # noqa: F401 – types – фикстура
from test_69 import own_perms, set_perms  # noqa: F401 – own_perms – фикстура
from test_printers import add_printer

NOW = datetime.now(timezone.utc)


def rows(client, archived="all"):
    return ok(client.get("/api/ips", params={"archived": archived}))["rows"]


def row_of(client, ip):
    return next((row for row in rows(client, "no") if row["ip_addr"] == ip), None)


def keys(row):
    return [source["key"] for source in row["sources"]]


def seed(*items):
    session = SessionLocal()

    try:
        for item in items:
            session.add(item)

        session.commit()
    finally:
        session.close()


def create(client, status=200, **fields):
    return ok(client.post("/api/ips", json=fields), status)


def patch(client, ip, status=200, **fields):
    entry = row_of(client, ip)["entry"]
    return ok(client.patch(f"/api/ips/{entry['id']}", json=dict(fields, _version=entry["version"])), status)


def test_sources_in_one_row(editor, room, types, models):
    pc = add_pc(editor, room["room"], "ter-201-1", ip="10.0.5.11", type="Моноблок")
    printer = add_printer(editor, room["room"], name="ter-mfu-1", model="ecosys m2040dn", ip="10.0.5.20")
    move = add_move(editor, types["МФУ"], printer_model_id=models["mfu"]["id"], model="Kyocera", move_ip="10.0.5.30",
                    installer="Сидоров С.С.")
    seed(
        ScanHost(source="net", ip="10.0.5.11", mac="D8:CB:8A:00:00:11", name="TER-201-1", seen_at=NOW, data={"how": ["ping"]}),
        ScanHost(source="dhcp", ip="10.0.5.11", mac="D8:CB:8A:00:00:11", name="ter-201-1", seen_at=NOW - timedelta(days=90),
                 data={"active": False}),
        ScanHost(source="dhcp_conf", ip="10.0.5.40", mac="D8:CB:8A:00:00:40", name=None, seen_at=NOW, data={"host": "wikijs"}),
        ScanRecord(source="glpi", source_id=157, name="ter-201-1.corp.lan", checked_at=NOW, seen_at=NOW,
                   data={"values": {"ip": "10.0.5.11\n127.0.0.1"}}, keys={}),
        ScanJabberUser(login="ivanov_i.i.", online=False, groups=[], registered=True, last_ip="10.0.5.11",
                       last_seen_at=NOW - timedelta(hours=1)),
    )
    found = {row["ip_addr"]: row for row in rows(editor, "no")}
    assert set(found) == {"10.0.5.11", "10.0.5.20", "10.0.5.30", "10.0.5.40"}

    # Один адрес – одна строка: источники по порядку, короткие названия – строками для фильтра
    row = found["10.0.5.11"]
    assert keys(row) == ["pc", "net", "dhcp", "rec", "jabber"]
    assert row["ip_sources"] == "Компьютеры\nСканер\nDHCP Leases\nGSIT / GLPI\nVacuum"
    assert row["id"] == 10 * 2 ** 24 + 5 * 256 + 11
    # Одно имя у ПК, сканера, аренды и GLPI – одной строкой (ссылка – на ПК); логин Vacuum – свой
    assert [(n["value"], n["from"], n.get("obj")) for n in row["names"]] == [
        ("ter-201-1", ["pc", "net", "dhcp", "rec"], {"kind": "pc", "id": pc}),
        ("ivanov_i.i.", ["jabber"], None),
    ]
    assert row["ip_type"] == "Моноблок"
    # Давнее (аренда старше срока «Актуальны») – помечено; «Актуальность» – самая свежая проверка
    by_key = {source["key"]: source for source in row["sources"]}
    assert by_key["dhcp"].get("stale") and not by_key["net"].get("stale")
    assert by_key["rec"]["details"] == ["GLPI №157"]
    assert row["checked_at"] == max(source["at"] for source in row["sources"])

    # Принтер: тип – у модели; Движение: тип записи, «Своё название», «Установил» – в «Добавил»
    assert (found["10.0.5.20"]["ip_type"], found["10.0.5.20"]["names"][0]["obj"]) == ("МФУ", {"kind": "printer", "id": printer})
    moved = found["10.0.5.30"]
    assert (moved["ip_sources"], moved["ip_type"], moved["ip_added"]) == ("Движение", "МФУ", "Сидоров С.С.")
    assert moved["names"][0]["obj"] == {"kind": "move", "id": move}
    assert (found["10.0.5.40"]["ip_sources"], found["10.0.5.40"]["ip_name"]) == ("DHCP Config", "wikijs")

    # Архивный ПК – не источник
    ok(editor.post("/api/computers/archive", json={"ids": [pc], "archived": True}))
    assert "pc" not in keys(row_of(editor, "10.0.5.11"))


def note(client, ip, text, status=200, version=None):
    row = row_of(client, ip)
    current = row["note_version"] if row else 0
    return ok(client.put("/api/ips/note", json={"ip": ip, "ip_note": text, "_version": current if version is None else version}), status)


def test_record(admin, editor, reader):
    # Запись журнала: источник «IP», «Добавил» – кто добавил, «Актуальность» – сейчас; описание –
    # у адреса, вместе с записью
    data = create(editor, ip_addr=" 192.168.0.47 ", ip_type="Сервер", ip_name="Zabbix", ip_note="Инвентаризация PVE")
    row = data["rows"][0]
    assert (row["ip_addr"], row["ip_sources"], row["ip_type"], row["ip_name"], row["ip_note"], row["ip_added"]) == (
        "192.168.0.47", "IP", "Сервер", "Zabbix", "Инвентаризация PVE", "editor")
    assert (row["entry"]["added_user_id"], row["entry"]["added"]) == (user_id("editor"), "editor")
    record = history(editor, "ip_entries", row["entry"]["id"])[0]
    assert record["title"] == "192.168.0.47" and record["changes"]["created"]["new"] == "192.168.0.47"

    # Тот же адрес ещё раз – нельзя; не адрес – нельзя; читателю – нельзя
    assert "уже есть запись" in create(editor, 400, ip_addr="192.168.0.47")["detail"]
    assert create(editor, 400, ip_addr="192.168.0")["detail"].startswith("IP:")
    assert reader.post("/api/ips", json={"ip_addr": "192.168.0.48"}).status_code == 403
    assert reader.put("/api/ips/note", json={"ip": "192.168.0.47", "ip_note": "x"}).status_code == 403

    # «Добавил» – вписанное имя или пользователь программы по имени
    patch(editor, "192.168.0.47", ip_added="Сидоров С.С.")
    entry = row_of(editor, "192.168.0.47")["entry"]
    assert (entry["added_user_id"], entry["added_by"]) == (None, "Сидоров С.С.")
    patch(editor, "192.168.0.47", ip_added="admin")
    assert row_of(editor, "192.168.0.47")["entry"]["added_user_id"] == user_id("admin")

    # Описание «Актуальность» не меняет, тип – меняет
    checked = row_of(editor, "192.168.0.47")["checked_at"]
    note(editor, "192.168.0.47", "Другое")
    assert row_of(editor, "192.168.0.47")["checked_at"] == checked
    patch(editor, "192.168.0.47", ip_type="ВМ")
    assert row_of(editor, "192.168.0.47")["checked_at"] > checked

    # Адрес записи сменили – запись переехала, описание осталось у адреса; на чужую запись – нельзя
    create(editor, ip_addr="192.168.0.50", ip_name="srv-2")
    data = patch(editor, "192.168.0.47", ip_addr="192.168.0.49")
    assert [(r["ip_addr"], r["ip_sources"], r["ip_note"]) for r in data["rows"]] == [
        ("192.168.0.47", None, "Другое"), ("192.168.0.49", "IP", None)]
    assert "уже есть" in patch(editor, "192.168.0.49", 400, ip_addr="192.168.0.50")["detail"]

    # Устаревшая версия записи и описания – 409
    entry = row_of(editor, "192.168.0.49")["entry"]
    response = editor.patch(f"/api/ips/{entry['id']}", json={"ip_type": "x", "_version": entry["version"] - 1})
    assert response.status_code == 409
    assert note(editor, "192.168.0.47", "x", 409, version=0)["detail"].startswith("Эту строку уже изменил")
    assert note(editor, "10.0.0.9", "y", 409, version=3)


def test_notes(editor, room):
    add_pc(editor, room["room"], "buh-1", ip="10.0.5.12")
    # Описание адреса из другого источника – без записи журнала (источник не «IP»); первое описание –
    # обычная правка «– → текст» и отменяется Ctrl+Z (ревью этапа 71)
    row = note(editor, "10.0.5.12", "кабинет главврача")["rows"][0]
    assert (row["ip_sources"], row["ip_note"], row["entry"], row["ip_added"]) == ("Компьютеры", "кабинет главврача", None, None)
    note_id = history(editor, "ip_notes")[0]["entity_id"]
    assert history(editor, "ip_notes", note_id)[0]["changes"] == {"ip_note": {"old": None, "new": "кабинет главврача"}}
    undone = ok(editor.post("/api/history/undo-last"))
    assert undone["text"].startswith("10.0.5.12 – ")
    assert row_of(editor, "10.0.5.12")["ip_note"] is None

    # Описание без источников – строка с одним адресом; стёрли – строки нет
    note(editor, "10.250.0.3", "резерв")
    assert row_of(editor, "10.250.0.3")["ip_sources"] is None
    note(editor, "10.250.0.3", "")
    assert row_of(editor, "10.250.0.3") is None

    # Запись на адрес с описанием – описание остаётся у адреса
    note(editor, "10.0.5.12", "кабинет")
    row = create(editor, ip_addr="10.0.5.12", ip_type="Сервер")["rows"][0]
    assert (row["ip_sources"], row["ip_type"], row["ip_note"], row["ip_added"]) == ("Компьютеры\nIP", "Сервер", "кабинет", "editor")


def test_archive_and_delete(admin, editor):
    first = create(editor, ip_addr="10.0.9.5", ip_name="cam-1")["rows"][0]["entry"]["id"]
    ok(editor.post("/api/ips/archive", json={"ids": [first], "archived": True}))
    assert row_of(editor, "10.0.9.5") is None
    archived = rows(editor, "yes")
    assert [(r["id"], r["ip_addr"], r["ip_name"], r["archived"]) for r in archived] == [(-first, "10.0.9.5", "cam-1", True)]
    # Описание адреса возврату не мешает (ревью этапа 71: адрес был занят навсегда)
    note(editor, "10.0.9.5", "камера у входа")
    ok(editor.post("/api/ips/archive", json={"ids": [first], "archived": False}))
    assert (row_of(editor, "10.0.9.5")["ip_name"], row_of(editor, "10.0.9.5")["ip_note"]) == ("cam-1", "камера у входа")
    # Пока запись в архиве, адрес свободен: новая запись; вернуть старую – нельзя, пока есть новая
    ok(editor.post("/api/ips/archive", json={"ids": [first], "archived": True}))
    second = create(editor, ip_addr="10.0.9.5", ip_name="cam-2")["rows"][0]["entry"]["id"]
    assert "уже есть" in editor.post("/api/ips/archive", json={"ids": [first], "archived": False}).json()["detail"]
    # Отмена в Истории – тоже
    record = history(editor, "ip_entries", first)[0]
    assert editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}], "cancel": True}).status_code == 400
    ok(editor.post("/api/ips/archive", json={"ids": [second], "archived": True}))
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}], "cancel": True}))
    assert row_of(editor, "10.0.9.5")["ip_name"] == "cam-1"
    # Удалить насовсем – из архива и только администратору
    assert editor.post("/api/ips/delete", json={"ids": [second]}).status_code == 403
    assert admin.post("/api/ips/delete", json={"ids": [first]}).status_code == 400
    ok(admin.post("/api/ips/delete", json={"ids": [second]}))
    assert [r["entry"]["id"] for r in rows(editor, "yes")] == []
    assert history(editor, "ip_entries", second)[0]["changes"] == {"deleted": {"old": "10.0.9.5", "new": None}}


def test_bulk(editor, room):
    add_pc(editor, room["room"], "buh-2", ip="10.0.6.1")
    create(editor, ip_addr="10.0.6.2", ip_name="srv")
    # Описание – у любых адресов (без записи журнала); тип – только у записей
    data = ok(editor.post("/api/ips/bulk-update", json={"ips": ["10.0.6.2", "10.0.6.1"], "field": "ip_note", "value": "склад"}))
    assert data["changed"] == ["10.0.6.1", "10.0.6.2"]
    assert (row_of(editor, "10.0.6.1")["ip_note"], row_of(editor, "10.0.6.1")["entry"]) == ("склад", None)
    # …и отменяется одним Ctrl+Z
    ok(editor.post("/api/history/undo-last"))
    assert (row_of(editor, "10.0.6.1")["ip_note"], row_of(editor, "10.0.6.2")["ip_note"]) == (None, None)
    data = ok(editor.post("/api/ips/bulk-update", json={"ips": ["10.0.6.1", "10.0.6.2"], "field": "ip_type", "value": "Сервер"}))
    assert (data["changed"], data["skipped"]) == (["10.0.6.2"], 1)
    # «Свободные» (own): у адресов без записи – записи, «Добавил» – кто менял (ревью этапа 71)
    data = ok(editor.post("/api/ips/bulk-update", json={"ips": ["10.0.6.3", "10.0.6.4"], "field": "ip_note", "value": "камеры", "own": True}))
    assert data["changed"] == ["10.0.6.3", "10.0.6.4"]
    row = row_of(editor, "10.0.6.3")
    assert (row["ip_sources"], row["ip_note"], row["ip_added"]) == ("IP", "камеры", "editor")
    data = ok(editor.post("/api/ips/bulk-update", json={"ips": ["10.0.6.5"], "field": "ip_type", "value": "Камера", "own": True}))
    assert (row_of(editor, "10.0.6.5")["ip_type"], row_of(editor, "10.0.6.5")["ip_added"]) == ("Камера", "editor")
    assert editor.post("/api/ips/bulk-update", json={"ips": ["10.0.6.1"], "field": "ip_name", "value": "x"}).status_code == 400


def test_undo(editor):
    create(editor, ip_addr="10.0.7.1", ip_type="Сервер")
    patch(editor, "10.0.7.1", ip_type="ВМ")
    entry_id = row_of(editor, "10.0.7.1")["entry"]["id"]
    record = history(editor, "ip_entries", entry_id)[0]
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}], "cancel": True}))
    assert row_of(editor, "10.0.7.1")["ip_type"] == "Сервер"
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}], "cancel": False}))
    assert row_of(editor, "10.0.7.1")["ip_type"] == "ВМ"

    # «Добавил» – вписанное имя и обратно пользователь (по номеру)
    patch(editor, "10.0.7.1", ip_added="Сидоров С.С.")
    undone = ok(editor.post("/api/history/undo-last"))
    assert undone["text"].startswith("10.0.7.1 – ")
    assert row_of(editor, "10.0.7.1")["entry"]["added_user_id"] == user_id("editor")

    # Адрес записи – тоже отменяется
    patch(editor, "10.0.7.1", ip_addr="10.0.7.2")
    ok(editor.post("/api/history/undo-last"))
    assert row_of(editor, "10.0.7.1")["ip_type"] == "ВМ" and row_of(editor, "10.0.7.2") is None

    # Своё значение записи – отдельно, даже если в ячейке слилось с чужим
    patch(editor, "10.0.7.1", ip_name="REG-1.corp.lan")
    assert row_of(editor, "10.0.7.1")["entry"]["name"] == "REG-1.corp.lan"


def test_rights(admin, editor, reader, room):
    # Вкладка «IP» – своя строка прав: редактор правит, читатель смотрит. «Сканировать» на ней –
    # по запуску страниц источников (как в Сканере), своего «запуска» у вкладки нет
    assert (ROLE_PAGES["editor"]["journals/ips"], ROLE_PAGES["reader"]["journals/ips"]) == ("edit", "view")
    assert PAGE_LEVELS["journals/ips"] == ("none", "view", "edit")
    ok(reader.get("/api/ips"))
    assert reader.post("/api/scan/sources/net/collect").status_code == 403
    assert editor.post("/api/scan/sources/jabber/collect").status_code == 403
    set_perms(admin, "editor", {"journals/ips": "view"})
    assert editor.post("/api/ips", json={"ip_addr": "10.0.8.1"}).status_code == 403
    set_perms(admin, "editor", {"journals/ips": "none"})
    assert editor.get("/api/ips").status_code == 403

    # Данные страниц, закрытых правами, в журнал не попадают (ревью этапа 71): читателю не видны
    # сканер, GLPI / GSIT и Vacuum
    add_pc(admin, room["room"], "ter-1", ip="10.0.8.5")
    seed(
        ScanHost(source="net", ip="10.0.8.5", mac=None, name="TER-1", seen_at=NOW, data={}),
        ScanHost(source="dhcp", ip="10.0.8.6", mac=None, name="phone-1", seen_at=NOW, data={"active": True}),
        ScanJabberUser(login="ivanov", online=True, groups=[], registered=True, last_ip="10.0.8.5", last_seen_at=NOW),
    )
    assert keys(row_of(admin, "10.0.8.5")) == ["pc", "net", "jabber"]
    assert keys(row_of(reader, "10.0.8.5")) == ["pc"] and row_of(reader, "10.0.8.6") is None
    assert [n["value"] for n in row_of(reader, "10.0.8.5")["names"]] == ["ter-1"]

    # Подсети – для «Свободных» всем; примечание – тем, кому видны подсети в Сканере
    ok(admin.post("/api/scan/subnets", json={"cidr": "10.0.8.0/28", "scan": True, "note": "склад"}))
    assert ok(admin.get("/api/ips"))["subnets"] == [{"cidr": "10.0.8.0/28", "scan": True, "note": "склад", "size": 16}]
    assert ok(reader.get("/api/ips"))["subnets"] == [{"cidr": "10.0.8.0/28", "scan": True, "note": None, "size": 16}]


def test_columns(reader):
    info = ok(reader.get("/api/columns"))
    assert [c["key"] for c in info["ip_columns"]] == ["ip_sources", "ip_type", "ip_addr", "ip_name", "ip_note", "ip_checked", "ip_added"]
    assert [c["short"] for c in info["ip_columns"]] == ["Источники", "Тип", "IP", "Имя", "Описание", "Актуальность", "Добавил"]
    assert info["ip_history_labels"]["archived"] == "Архив" and "own" not in info["ip_history_labels"]
