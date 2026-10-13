"""Этап 47: Ctrl+Z – только 5 минут (старше минуты – с подтверждением), MAC принтеров из сети
по IP, картриджи (справочник, у модели), принтер у ПК – моделью, Vacuum – кто в сети по
быстрой проверке."""
from datetime import datetime, timedelta, timezone

import api_scan_jabber
from conftest import add_computer, get_row, history, ok
from db import SessionLocal
from models import History, ScanJabberUser, ScanSource
from scan_hostmatch import printer_rows
from test_28b import obs, save_hosts
from test_printers import add_model, add_printer, models, patch, printer  # noqa: F401


def age_history(minutes):
    """Последние записи Истории – будто сделаны minutes минут назад."""
    session = SessionLocal()

    try:
        session.query(History).update({History.at: History.at - timedelta(minutes=minutes)})
        session.commit()
    finally:
        session.close()


def test_undo_window(editor, reader, room):
    pc = add_computer(editor, room["room"], hostname="pc-1")
    version = get_row(reader, pc)["version"]
    ok(editor.patch(f"/api/computers/{pc}", json={"os": "Win 10", "_version": version}))

    # Больше минуты назад – сначала спросить, ничего не отменив
    age_history(2)
    data = ok(editor.post("/api/history/undo-last"))
    assert data["confirm"] and not data["ok"] and data["text"] == "pc-1 – Операционная система" and 120 <= data["age"] < 130
    assert get_row(reader, pc)["os"] == "Win 10"

    # Подтвердили другое действие – снова вопрос; то же – отменено
    assert ok(editor.post("/api/history/undo-last", json={"confirm_id": data["last_id"] + 100}))["confirm"]
    done = ok(editor.post("/api/history/undo-last", json={"confirm_id": data["last_id"]}))
    assert done["ok"] and done["count"] == 1
    assert get_row(reader, pc)["os"] is None

    # Старше 5 минут – не отменяется
    version = get_row(reader, pc)["version"]
    ok(editor.patch(f"/api/computers/{pc}", json={"os": "Win 11", "_version": version}))
    age_history(6)
    response = editor.post("/api/history/undo-last")
    assert response.status_code == 404 and "5 минут" in response.json()["detail"]

    # Свежее – сразу, без вопроса
    version = get_row(reader, pc)["version"]
    ok(editor.patch(f"/api/computers/{pc}", json={"os": "Win 7", "_version": version}))
    assert ok(editor.post("/api/history/undo-last"))["ok"]
    assert get_row(reader, pc)["os"] == "Win 11"


def test_printer_rows_rule():
    printers = {
        1: {"ip": "10.0.9.41", "mac": ""},                    # MAC на адресе – предложить
        2: {"ip": "10.0.9.42", "mac": "D8:00:00:00:00:42"},   # записан другой – дописать
        3: {"ip": "10.0.9.43", "mac": "D8:00:00:00:00:43"},   # уже записан
        4: {"ip": "10.0.9.44", "mac": ""},                    # на адресе MAC ПК
        5: {"ip": "10.0.9.45", "mac": ""},                    # адрес и у ПК
        6: {"ip": "10.0.9.46", "mac": ""},                    # только привязка DHCP
        7: {"ip": "10.0.9.47", "mac": ""},                    # привязка, а MAC виден в другом месте
        8: {"ip": "10.0.9.48", "mac": ""},                    # виртуальный MAC
    }
    computers = {
        1: {"ip": "10.0.5.10", "mac": "D8:00:00:00:00:44"},
        2: {"ip": "10.0.9.45", "mac": ""},
    }
    hosts = [
        obs("10.0.9.41", "D8:00:00:00:00:41", "NPI41"),
        obs("10.0.9.42", "D8:00:00:00:01:42"),
        obs("10.0.9.43", "D8:00:00:00:00:43"),
        obs("10.0.9.44", "D8:00:00:00:00:44"),
        obs("10.0.9.45", "D8:00:00:00:00:45"),
        obs("10.0.9.46", "D8:00:00:00:00:46", source="dhcp_conf", fixed=True, host="prn"),
        obs("10.0.9.47", "D8:00:00:00:00:47", source="dhcp_conf", fixed=True),
        obs("10.0.9.99", "D8:00:00:00:00:47"),
        obs("10.0.9.48", "00:15:5D:00:00:48"),
    ]
    found = {p["printer_id"]: (p["value"], p["source"]["by"]) for p in printer_rows(printers, computers, hosts)}
    assert found == {
        1: ("D8:00:00:00:00:41", ["ip"]),
        2: ("D8:00:00:00:01:42", ["ip"]),
        6: ("D8:00:00:00:00:46", ["ip", "reserve"]),
    }


def test_printer_mac_from_network(admin, editor, reader, room):
    ok(admin.patch("/api/scan/sources/net", json={"enabled": True}))
    empty = add_printer(editor, room["room"], name="prn-1", ip="10.0.9.41")
    known = add_printer(editor, room["room"], name="prn-2", ip="10.0.9.42")
    patch(editor, known, mac="d8:00:00:00:00:42")
    save_hosts(obs("10.0.9.41", "D8:00:00:00:00:41", "NPI41"), obs("10.0.9.42", "D8:00:00:00:01:42"))

    items = {d["printer_id"]: d for d in ok(reader.get("/api/scan/printer-diffs"))["items"]}
    assert (items[empty]["kind"], items[empty]["proposed"], items[empty]["table"]) == ("fill", "D8:00:00:00:00:41", "")
    assert items[known]["kind"] == "diff" and items[known]["proposed"] == "D8:00:00:00:00:42\nD8:00:00:00:01:42"
    assert items[empty]["sources"][0]["title"] == "Сеть" and items[empty]["sources"][0]["by"] == ["ip"]

    # Взять: обычная правка принтера, в Истории – откуда
    assert reader.post("/api/scan/printer-diffs/accept", json={"items": []}).status_code == 403
    result = ok(editor.post("/api/scan/printer-diffs/accept", json={"items": [
        {"printer_id": empty, "field": "mac", "value": items[empty]["proposed"], "table": "", "source": "Сеть"},
        {"printer_id": known, "field": "mac", "value": items[known]["proposed"], "table": "уже не то", "source": "Сеть"},
    ]}))
    assert result == {"accepted": 1, "skipped": ["prn-2"]}
    assert printer(reader, empty)["mac"] == "D8:00:00:00:00:41"
    assert history(reader, "printers", empty)[0]["changes"]["mac"]["scan"] == "Сеть"
    assert {d["printer_id"] for d in ok(reader.get("/api/scan/printer-diffs"))["items"]} == {known}

    # Оставить как есть – не предлагать, пока сеть видит тот же MAC; вернуть – снова
    reject = {"items": [{"printer_id": known, "field": "mac", "raw": "D8:00:00:00:01:42"}]}
    assert ok(editor.post("/api/scan/printer-diffs/reject", json=reject)) == {"rejected": 1}
    data = ok(reader.get("/api/scan/printer-diffs"))
    assert data["items"] == [] and data["rejected"] == 1
    assert ok(reader.get("/api/scan/printer-diffs", params={"rejected": True}))["items"][0]["rejected_by"] == "editor"
    assert ok(editor.post("/api/scan/printer-diffs/unreject", json=reject)) == {"returned": 1}
    assert len(ok(reader.get("/api/scan/printer-diffs"))["items"]) == 1

    # Отклонения принтеров не мешают предложениям ПК
    ok(editor.post("/api/scan/printer-diffs/reject", json=reject))
    assert ok(reader.get("/api/scan/diffs"))["rejected"] == 0


def test_pc_printers_by_model(editor, reader, room, models):
    pc = add_computer(editor, room["room"], hostname="pc-1")
    named = add_printer(editor, room["room"], name="prn-hp", model="HP LaserJet M404")
    bare = add_printer(editor, room["room"], name="prn-bare")
    patch(editor, named, computers=[[pc, True]])
    patch(editor, bare, computers=[[pc, False]])
    row = get_row(reader, pc)
    assert row["printers"] == "HP LaserJet M404 [usb]\nprn-bare"
    assert row["printer_refs"] == [
        {"id": named, "title": "HP LaserJet M404", "name": "prn-hp", "usb": True},
        {"id": bare, "title": "prn-bare", "name": "prn-bare", "usb": False},
    ]
    # В Истории ПК – по-прежнему имена
    assert history(reader, "printers", named)[0]["changes"]["computers"]["new"] == "pc-1 [usb]"


def test_cartridges(editor, reader, room, models):
    hp = models["printer"]["id"]
    first = add_printer(editor, room["room"], name="prn-1", model="HP LaserJet M404")
    second = add_printer(editor, room["room"], name="prn-2", model="HP LaserJet M404")
    bare = add_printer(editor, room["room"], name="prn-3")

    # Столбец, карточка
    info = ok(reader.get("/api/columns"))
    column = next(c for c in info["printer_columns"] if c["key"] == "cartridges")
    assert (column["kind"], column["multiline"], column["bulk"]) == ("cartridges", True, False)
    assert "cartridges" in next(g for g in info["printer_card_groups"] if g["title"] == "Модель")["fields"]

    # Без модели – нельзя; с моделью – у модели, у всех её принтеров; справочник пополняется сам
    assert "нет модели" in patch(editor, bare, 400, cartridges="CF259A")["detail"]
    data = patch(editor, first, cartridges="CF259A, cf259x;CF259A")
    assert data["model_changed"] and data["changes"] == {}
    assert data["updated"]["cartridges"] == "CF259A\ncf259x"
    assert printer(reader, second)["cartridges"] == "CF259A\ncf259x"
    items = ok(reader.get("/api/cartridges"))["items"]
    assert [(c["name"], [m["title"] for m in c["models"]], c["printers"]) for c in items] == [
        ("CF259A", ["HP LaserJet M404"], 2), ("cf259x", ["HP LaserJet M404"], 2)]
    model = next(m for m in ok(reader.get("/api/printer-models"))["items"] if m["id"] == hp)
    assert model["cartridges"] == ["CF259A", "cf259x"]

    # История – у модели, Ctrl+Z возвращает прежние картриджи
    change = history(reader, "printer_models", hp)[0]["changes"]["cartridges"]
    assert change == {"old": None, "new": "CF259A\ncf259x"}
    patch(editor, second, cartridges="CF259X")      # то же название – из справочника, регистр как там
    assert printer(reader, first)["cartridges"] == "cf259x"
    ok(editor.post("/api/history/undo-last"))
    assert printer(reader, first)["cartridges"] == "CF259A\ncf259x"
    assert patch(editor, first, cartridges="CF259A\ncf259x")["model_changed"] is False

    # Переименовать – у всех моделей; повтор названия – нет
    cid = next(c["id"] for c in ok(reader.get("/api/cartridges"))["items"] if c["name"] == "cf259x")
    assert reader.patch(f"/api/cartridges/{cid}", json={"name": "CF259X"}).status_code == 403
    assert editor.patch(f"/api/cartridges/{cid}", json={"name": "cf259a"}).status_code == 400
    ok(editor.patch(f"/api/cartridges/{cid}", json={"name": "CF259X"}))
    assert printer(reader, second)["cartridges"] == "CF259A\nCF259X"
    assert history(reader, "cartridges", cid)[0]["changes"]["name"] == {"old": "cf259x", "new": "CF259X"}

    # Новый – с моделями; модели картриджа меняются – в Истории каждой модели
    kyo = models["mfu"]["id"]
    new = ok(editor.post("/api/cartridges", json={"name": "TK-1170", "model_ids": [kyo]}))
    assert next(m for m in ok(reader.get("/api/printer-models"))["items"] if m["id"] == kyo)["cartridges"] == ["TK-1170"]
    ok(editor.patch(f"/api/cartridges/{cid}", json={"model_ids": [kyo]}))
    assert printer(reader, first)["cartridges"] == "CF259A"
    assert next(m for m in ok(reader.get("/api/printer-models"))["items"] if m["id"] == kyo)["cartridges"] == ["TK-1170", "CF259X"]
    assert history(reader, "printer_models", hp)[0]["changes"]["cartridges"] == {"old": "CF259A\nCF259X", "new": "CF259A"}

    # Удалить – только картридж без моделей
    assert editor.delete(f"/api/cartridges/{new['id']}").status_code == 400
    ok(editor.patch(f"/api/cartridges/{new['id']}", json={"model_ids": []}))
    ok(editor.delete(f"/api/cartridges/{new['id']}"))
    assert "TK-1170" not in [c["name"] for c in ok(reader.get("/api/cartridges"))["items"]]

    # Модель в справочнике – с картриджами; удалить модель без принтеров – картриджи остаются
    other = ok(editor.post("/api/printer-models", json={"kind": "printer", "maker": "Pantum", "model": "P2500W", "cartridges": "PC-211EV"}))
    assert other["cartridges"] == ["PC-211EV"]
    ok(editor.patch(f"/api/printer-models/{other['id']}", json={"cartridges": "PC-211EV, PC-211RB"}))
    ok(editor.delete(f"/api/printer-models/{other['id']}"))
    assert {"PC-211EV", "PC-211RB"} <= {c["name"] for c in ok(reader.get("/api/cartridges"))["items"]}


def test_vacuum_live_online(editor, room):
    session = SessionLocal()

    try:
        session.add(ScanSource(kind="jabber", enabled=True, url="http://jabber.test:5280/admin", options={}))
        session.add(ScanJabberUser(login="ivanov", online=True, groups=["Отдел"], registered=True, last_ip="10.0.5.11"))
        session.add(ScanJabberUser(login="petrov", online=False, groups=["Отдел"], registered=True, last_ip="10.0.5.12"))
        session.commit()
    finally:
        session.close()

    def online():
        return {u["login"]: u["online"] for u in ok(editor.get("/api/scan/jabber"))["users"]}

    saved = dict(api_scan_jabber._online)

    try:
        api_scan_jabber._online.update(logins=None, at=None)
        assert online() == {"ivanov": True, "petrov": False}
        # Быстрая проверка свежее сбора – в сети по ней («Обновить» на странице «Vacuum»)
        api_scan_jabber._online.update(logins=["petrov"], at=datetime.now(timezone.utc))
        assert online() == {"ivanov": False, "petrov": True}
    finally:
        api_scan_jabber._online.update(saved)
