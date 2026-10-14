"""Этап 53: поиск по Истории на сервере, Ctrl+Z и отмена в Истории для решений сканера
(привязка GLPI / GSIT, «не этот ПК», «забыть решения», названия)."""
import re
from pathlib import Path

from conftest import add_pc, get_row, ok
from db import SessionLocal
from history_labels import ENTITY_LABELS, LOCATION_FIELD_LABELS, SIMPLE_FIELD_LABELS
from history_search import LAYOUT_EN, LAYOUT_RU
from models import History, ScanAlias, ScanLink, ScanRecord

JS = Path(__file__).resolve().parent.parent / "frontend" / "static" / "js"


def js_dict(source, name):
    block = re.search(r"export const " + name + r" = \{(.*?)\n\};", source, re.S).group(1)
    return dict(re.findall(r'^\s*([a-z_]+): "([^"]*)"', block, re.M))


def test_labels_same_as_page():
    """Подписи поиска на сервере – те же, что на странице (columns.js, util.js)."""
    columns = (JS / "columns.js").read_text(encoding="utf-8")
    assert js_dict(columns, "ENTITY_LABELS") == ENTITY_LABELS
    assert js_dict(columns, "SIMPLE_FIELD_LABELS") == SIMPLE_FIELD_LABELS
    assert js_dict(columns, "LOCATION_FIELD_LABELS") == LOCATION_FIELD_LABELS
    util = (JS / "util.js").read_text(encoding="utf-8")
    assert f'const LAYOUT_EN = "{LAYOUT_EN}";' in util.replace("\\'", "'")
    assert f'const LAYOUT_RU = "{LAYOUT_RU}";' in util


# ---------- Поиск ----------


def search(client, q, **params):
    return ok(client.get("/api/history", params=dict(params, q=q, tz="Asia/Irkutsk")))


def titles(data):
    return [(item["title"], sorted(item["changes"])) for item in data["items"]]


def test_search(admin, editor, reader, room):
    loc = room["room"]
    first = add_pc(editor, loc, "pc-101", ram="8")
    second = add_pc(admin, loc, "pc-202", ip="10.0.5.17")
    ok(editor.patch(f"/api/computers/{first}", json={"os": "Windows 11 Pro", "_version": get_row(editor, first)["version"]}))
    ok(admin.patch(f"/api/users/{ok(admin.get('/api/users'))[0]['id']}", json={"position": "Инженер"}))
    everything = ok(admin.get("/api/history", params={"limit": 5000}))

    # Без поиска – как было: total_all = total
    assert everything["total"] == everything["total_all"] == len(everything["items"])

    # Объект (имя сейчас), значение, подпись поля, пользователь, вид объекта
    data = search(editor, "pc-101 windows")
    assert titles(data) == [("pc-101", ["os"])] and data["total"] == 1
    assert data["total_all"] == everything["total"] - 1    # запись о пользователе системы – не редактору
    assert [t for t, _ in titles(search(editor, "операционная"))] == ["pc-101"]
    assert {t for t, _ in titles(search(editor, "admin"))} == {"pc-202"}
    assert len(search(editor, "пк")["items"]) == len([i for i in everything["items"] if i["entity"] == "computers"])

    # Регистр и «ё», другая раскладка, IP с запятыми
    assert titles(search(editor, "PC-101 WINDOWS")) == titles(data)
    assert [t for t, _ in titles(search(editor, "jgthfwbjyyfz"))] == ["pc-101"]          # «операционная»
    assert [t for t, _ in titles(search(editor, "10,0ю5"))] == ["pc-202"]
    assert search(editor, "нет-такого-слова")["total"] == 0

    # Время – как на странице (пояс браузера): дата в тексте, счётчики по дням – найденных
    day = next(iter(everything["days"]))
    data = search(editor, day + " pc-101")
    assert data["total"] == len(data["items"]) == sum(data["days"].values()) and data["total"] > 0

    # Записи пользователей системы находит только администратор
    assert search(reader, "инженер")["total"] == 0
    assert [i["entity"] for i in search(admin, "инженер")["items"]] == ["users"]

    # Порциями: offset / limit по найденным, фильтры – как без поиска
    page = search(editor, "pc", limit=1, offset=1)
    assert len(page["items"]) == 1 and page["items"][0]["id"] == search(editor, "pc")["items"][1]["id"]
    assert {i["entity_id"] for i in search(editor, "pc", entity="computers", entity_id=second)["items"]} == {second}
    assert search(editor, "pc", user="editor")["total"] == len([i for i in everything["items"] if i["user_name"] == "editor"
                                                                  and i["entity"] == "computers"])


# ---------- Решения сканера: Ctrl+Z и История ----------


def add_record(source, source_id, name):
    session = SessionLocal()
    try:
        session.add(ScanRecord(source=source, source_id=source_id, name=name, data={"values": {}}, keys={}))
        session.commit()
    finally:
        session.close()


def links():
    session = SessionLocal()
    try:
        return sorted((link.source, link.source_id, link.computer_id, link.action) for link in session.query(ScanLink))
    finally:
        session.close()


def aliases():
    session = SessionLocal()
    try:
        return sorted((a.field, a.source, a.table_value, a.kind) for a in session.query(ScanAlias))
    finally:
        session.close()


def test_undo_link_from_table(admin, editor, room):
    """«Привязать» в Таблице: Ctrl+Z отменяет и номер в столбце, и «это этот ПК»; Ctrl+Y – возвращает."""
    first = add_pc(editor, room["room"], "pc-1")
    add_record("gsit", 7, "DESKTOP-7")
    ok(editor.post("/api/scan/diffs/link", json={"computer_id": first, "source": "gsit", "source_id": 7, "table": ""}))
    assert get_row(editor, first)["gsit_id"] == "7" and links() == [("gsit", 7, first, "link")]

    undone = ok(editor.post("/api/history/undo-last"))
    assert undone["text"] == "pc-1 – GSIT ID, Это ПК" and undone["count"] == 2
    assert undone["entities"] == ["computers", "scan_records"]
    assert get_row(editor, first)["gsit_id"] is None and links() == []

    ok(editor.post("/api/history/cancel", json={"items": undone["items"], "cancel": False}))
    assert get_row(editor, first)["gsit_id"] == "7" and links() == [("gsit", 7, first, "link")]


def test_undo_relink_and_not_this(admin, editor, room):
    """Перепривязка к другому ПК отменяется к прежнему; «Не этот ПК» – отдельным действием."""
    first = add_pc(editor, room["room"], "pc-1")
    second = add_pc(editor, room["room"], "pc-2")
    add_record("glpi", 5, "DESKTOP-5")
    ok(admin.post("/api/scan/records/glpi/5/link", json={"computer_id": first}))
    ok(admin.post("/api/scan/records/glpi/5/link", json={"computer_id": second}))
    assert links() == [("glpi", 5, second, "link")]
    ok(admin.post("/api/history/undo-last"))
    assert links() == [("glpi", 5, first, "link")]

    ok(editor.post("/api/scan/diffs/not-this", json={"computer_id": second, "source": "glpi", "source_id": 5}))
    assert links() == [("glpi", 5, first, "link"), ("glpi", 5, second, "reject")]
    assert ok(editor.post("/api/history/undo-last"))["text"] == "GLPI №5 DESKTOP-5 – Не этот ПК"
    assert links() == [("glpi", 5, first, "link")]


def test_same_name_and_repeated_decision(admin, editor, room):
    """Перепривязка к другому ПК с тем же именем – в Истории с номерами ПК, Ctrl+Z отменяет её;
    то же решение ещё раз (двойной клик) в Историю не пишется – Ctrl+Z отменяет первое."""
    old_pc = add_pc(editor, room["room"], "buh-3")
    new_pc = add_pc(editor, room["room"], "buh-3")
    add_record("glpi", 9, "BUH-3")
    ok(admin.post("/api/scan/records/glpi/9/link", json={"computer_id": old_pc}))
    ok(admin.post("/api/scan/records/glpi/9/link", json={"computer_id": new_pc}))
    change = ok(admin.get("/api/history", params={"entity": "scan_records"}))["items"][0]["changes"]["link"]
    assert (change["old"], change["new"]) == (f"buh-3 (ПК №{old_pc})", f"buh-3 (ПК №{new_pc})")
    ok(admin.post("/api/history/undo-last"))
    assert links() == [("glpi", 9, old_pc, "link")]

    count = len(ok(admin.get("/api/history", params={"entity": "scan_records"}))["items"])
    ok(admin.post("/api/scan/records/glpi/9/link", json={"computer_id": old_pc}))
    assert len(ok(admin.get("/api/history", params={"entity": "scan_records"}))["items"]) == count
    ok(admin.post("/api/history/undo-last"))
    assert links() == []

    ok(editor.post("/api/scan/names", json={"field": "os", "source": "Win 7", "table": "Windows 7", "kind": "same"}))
    ok(editor.post("/api/scan/names", json={"field": "os", "source": "Win 7", "table": "Windows 7", "kind": "same"}))
    assert len(ok(admin.get("/api/history", params={"entity": "scan_aliases"}))["items"]) == 1


def test_cancel_decisions_in_history(admin, editor, room):
    """В Истории решения отменяет администратор; позднее решение – сначала его; старые без снимка – нет."""
    first = add_pc(editor, room["room"], "pc-1")
    second = add_pc(editor, room["room"], "pc-2")
    add_record("glpi", 5, "DESKTOP-5")
    ok(admin.post("/api/scan/records/glpi/5/link", json={"computer_id": first}))
    ok(admin.post("/api/scan/records/glpi/5/reject", json={"computer_id": second}))
    ok(admin.delete("/api/scan/records/glpi/5/decisions"))
    assert links() == []
    records = ok(admin.get("/api/history", params={"entity": "scan_records"}))["items"]
    reset, reject, link = records
    assert set(reset["changes"]) == {"reset"} and "undo" in reset["changes"]["reset"]

    # Раннее решение при позднем – 409, ничего не меняется
    response = admin.post("/api/history/cancel", json={"items": [{"id": link["id"]}]})
    assert response.status_code == 409 and "с тех пор меняли" in response.json()["detail"]
    assert links() == []

    # «Забыть решения» отменяется – решения вернулись; все три разом – как до первого
    ok(admin.post("/api/history/cancel", json={"items": [{"id": reset["id"]}]}))
    assert links() == [("glpi", 5, first, "link"), ("glpi", 5, second, "reject")]
    ok(admin.post("/api/history/cancel", json={"items": [{"id": reject["id"]}, {"id": link["id"]}]}))
    assert links() == []
    # Восстановить – по порядку, с первого
    ok(admin.post("/api/history/cancel", json={"items": [{"id": i["id"]} for i in records], "cancel": False}))
    assert links() == []
    assert all(not i["cancelled"] for i in ok(admin.get("/api/history", params={"entity": "scan_records"}))["items"])

    # Чужое решение редактор не отменяет
    response = editor.post("/api/history/cancel", json={"items": [{"id": reset["id"]}]})
    assert response.status_code == 403

    # Запись до этапа 53 (без снимка) – не отменяется
    session = SessionLocal()
    try:
        session.add(History(entity="scan_records", entity_id=0, entity_key="glpi:5", title="GLPI №5", user_name="admin",
                            changes={"link": {"old": None, "new": "pc-1"}}))
        session.commit()
        old_id = session.query(History).order_by(History.id.desc()).first().id
    finally:
        session.close()
    response = admin.post("/api/history/cancel", json={"items": [{"id": old_id}]})
    assert response.status_code == 400 and "до того" in response.json()["detail"]


def test_undo_names(admin, editor, room):
    """Названия: «одно и то же» («Своё» в карточке блочка), плата, удаление – отменяются."""
    first = add_pc(editor, room["room"], "pc-1", model="Z590")
    ok(editor.post("/api/scan/names", json={"field": "os", "source": "Win 10 Pro", "table": "Windows 10", "kind": "same"}))
    ok(editor.post("/api/scan/names", json={"field": "os", "source": "Win 10 Pro", "table": "Windows 10 Pro", "kind": "same"}))
    assert aliases() == [("os", "Win 10 Pro", "Windows 10 Pro", "same")]
    assert ok(editor.post("/api/history/undo-last"))["text"] == "OS: Win 10 Pro – Одно и то же"
    assert aliases() == [("os", "Win 10 Pro", "Windows 10", "same")]
    ok(editor.post("/api/history/undo-last"))
    assert aliases() == []

    # «Это материнская плата»: и плата в ПК, и соответствие – одним Ctrl+Z
    ok(editor.post("/api/scan/diffs/board", json={"computer_id": first, "raw": "Z590", "value": "Z590", "source": "GLPI №1"}))
    row = get_row(editor, first)
    assert (row["model"], row["motherboard"]) == (None, "Z590") and aliases() == [("model", "Z590", "Z590", "board")]
    ok(editor.post("/api/history/undo-last"))
    row = get_row(editor, first)
    assert (row["model"], row["motherboard"]) == ("Z590", None) and aliases() == []

    # Удаление на «Названиях» – отменяется (админ)
    ok(admin.post("/api/scan/names", json={"field": "cpu", "source": "i5", "table": "Core i5", "kind": "differ"}))
    alias_id = ok(admin.get("/api/scan/names"))[0]["id"]
    ok(admin.delete(f"/api/scan/names/{alias_id}"))
    assert aliases() == []
    ok(admin.post("/api/history/undo-last"))
    assert aliases() == [("cpu", "i5", "Core i5", "differ")]


def test_settings_still_not_undone(editor, room):
    """Настройки (вид выделений) по-прежнему не отменяются – Ctrl+Z говорит об этом."""
    ok(editor.patch("/api/table-marks/verified", json={"bold": True}))
    response = editor.post("/api/history/undo-last")
    assert response.status_code == 400 and "настройка" in response.json()["detail"]
