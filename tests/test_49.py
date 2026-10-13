"""Этап 49 (рефакторинг, без изменения поведения): отклонить / вернуть у ПК и принтеров –
одна функция; импорт из Excel (анализ и запись) и названия в Истории – по частям."""
from io import BytesIO

import pytest
from openpyxl import Workbook

from conftest import add_computer, history, ok
from test_printers import add_printer

# ---------- Отклонить и вернуть ----------


@pytest.fixture(params=["computers", "printers"])
def owner(request, editor, room):
    """ПК или принтер: (адрес отклонений, ключ строки, поле, id строки)."""
    if request.param == "computers":
        return "/api/scan/diffs", "computer_id", "ram", add_computer(editor, room["room"], hostname="pc-1")
    return "/api/scan/printer-diffs", "printer_id", "mac", add_printer(editor, room["room"], name="prn-1")


def test_reject_and_return(owner, editor, reader):
    url, key, field, row_id = owner
    item = {key: row_id, "field": field, "raw": "D8:00:00:00:00:01"}
    same = dict(item, raw=" d8:00:00:00:00:01 ")   # тот же ключ значения
    other = dict(item, raw="D8:00:00:00:00:02")
    missing = dict(item, **{key: row_id + 100})

    assert reader.post(f"{url}/reject", json={"items": [item]}).status_code == 403
    assert reader.post(f"{url}/unreject", json={"items": [item]}).status_code == 403

    # Повтор и несуществующая строка пропускаются; в ответе – сколько добавлено
    assert ok(editor.post(f"{url}/reject", json={"items": [item, item, missing, other]})) == {"rejected": 2}
    assert ok(editor.post(f"{url}/reject", json={"items": [item]})) == {"rejected": 0}

    # Поле, которое сканер не предлагает, – 400, и ничего не сохраняется
    response = editor.post(f"{url}/reject", json={"items": [dict(item, raw="новое"), dict(item, field="note")]})
    assert response.status_code == 400 and "note" in response.json()["detail"]

    # Вернуть: ключ значения тот же – убирается; чего нет – 0
    assert ok(editor.post(f"{url}/unreject", json={"items": [same, missing]})) == {"returned": 1}
    assert ok(editor.post(f"{url}/unreject", json={"items": [item]})) == {"returned": 0}
    assert ok(editor.post(f"{url}/unreject", json={"items": [other]})) == {"returned": 1}

    # Без 400 выше «новое» было бы отклонено – проверка: снова отклоняется одно
    assert ok(editor.post(f"{url}/reject", json={"items": [dict(item, raw="новое")]})) == {"rejected": 1}


def test_rejects_kept_apart(editor, room):
    """Отклонение у ПК не задевает принтер с тем же id и наоборот."""
    computer_id = add_computer(editor, room["room"], hostname="pc-1")
    printer_id = add_printer(editor, room["room"], name="prn-1")
    assert computer_id == printer_id == 1

    pc_item = {"computer_id": 1, "field": "mac", "raw": "D8:00:00:00:00:01"}
    printer_item = {"printer_id": 1, "field": "mac", "raw": "D8:00:00:00:00:01"}
    assert ok(editor.post("/api/scan/diffs/reject", json={"items": [pc_item]})) == {"rejected": 1}
    assert ok(editor.post("/api/scan/printer-diffs/reject", json={"items": [printer_item]})) == {"rejected": 1}
    assert ok(editor.post("/api/scan/printer-diffs/unreject", json={"items": [printer_item]})) == {"returned": 1}
    assert ok(editor.post("/api/scan/diffs/unreject", json={"items": [pc_item]})) == {"returned": 1}


# ---------- Импорт из Excel ----------

HEAD = ["#", "ФИО", "Адрес", "Отделение", "Эт.", "Каб", "Кабинет", "№", "IP", "HOSTNAME",
        "VACUUM", "OS", "ТИП", "Модель", "CPU", "RAM", "DRIVE", "GPU", "MAC", "ИНВ",
        "GSIT", "Сост.", "Метка", "Принтер", "Пр", "#Примечание"]


def sheet(rows, head=HEAD, title="list"):
    wb = Workbook()
    ws = wb.active
    ws.title = title
    ws.append(head)

    for row in rows:
        ws.append([row.get(name) for name in head])

    data = BytesIO()
    wb.save(data)
    return data.getvalue()


ROWS = [
    {"#": 1, "ФИО": "Иванов Иван", "Адрес": "ул. Ленина, 1", "Отделение": "Терапия", "Эт.": 2.0, "Каб": "201",
     "Кабинет": "Ординаторская", "№": 1, "IP": "10.0.2.11", "HOSTNAME": "ter-201-1", "VACUUM": "ivanov\nivanov2",
     "OS": "Win 10", "ТИП": "ПК", "Модель": "Lenovo M70", "CPU": "i5-10400", "RAM": "8", "DRIVE": "SSD 250",
     "MAC": "D8:00:00:00:00:01", "ИНВ": "0001", "GSIT": "77", "Сост.": "ok", "Метка": "Мед",
     "Принтер": "HP 1102", "Пр": "да", "#Примечание": "у окна"},
    {"#": 2, "ФИО": "иванов иван", "Адрес": "ул. Ленина, 1", "Отделение": "Терапия", "Эт.": 2, "Каб": "201",
     "№": "два", "IP": "10.0.2.11\n10.0.2.999", "HOSTNAME": "TER-201-1", "VACUUM": "ivanov", "MAC": "zz",
     "DRIVE": "SSD 120\nHDD 1TB", "ИНВ": "0001"},
    {"#": 3, "Адрес": "ул. Ленина, 1", "HOSTNAME": "no-dep", "OS": "Win 11"},
    {"#": 4, "HOSTNAME": "no-address", "IP": "10.0.2.13"},
    {"#": 5, "Сост.": "стар"},   # без важных полей – пропуск
]


def upload(client, url, data, name="list.xlsx", **form):
    return client.post(url, files={"file": (name, data, "application/octet-stream")}, data=form)


def test_import_analyze(admin):
    data = ok(upload(admin, "/api/import/analyze", sheet(ROWS)))

    assert data["sheet"] == "list" and data["header_row"] == 1 and data["headers"][:3] == ["#", "ФИО", "Адрес"]
    assert data["total_rows"] == 4 and data["skipped_empty_rows"] == 1 and data["unknown_columns"] == []
    assert data["summary"] == {"users": 2, "vacuum_logins": 2, "locations": 3}
    assert data["locations_preview"] == [
        {"path": "ул. Ленина, 1", "count": 1},
        {"path": "ул. Ленина, 1 / Терапия / 2 / 201", "count": 1},
        {"path": "ул. Ленина, 1 / Терапия / 2 / 201 Ординаторская", "count": 1},
    ]
    assert set(data["users_preview"]) == {"Иванов Иван", "иванов иван"}   # анализ регистр не сводит
    assert data["vacuum_preview"] == ["ivanov", "ivanov2"]
    assert data["choices"]["os"] == ["Win 10", "Win 11"] and data["choices"]["drive"] == ["HDD 1TB", "SSD 120", "SSD 250"]
    assert data["extra_fields"] == {"GSIT": ["77"], "Сост.": ["ok"], "Метка": ["Мед"]}
    assert data["skipped_values"] == {"пр": ["да"], "принтер": ["HP 1102"]}
    assert data["duplicates"]["ip"] == {"10.0.2.11": ["строка 2, #1", "строка 3, #2"]}
    assert data["duplicates"]["hostname"] == {"ter-201-1": ["строка 2, #1", "строка 3, #2"]}
    assert data["duplicates"]["inv_no"] == {"0001": ["строка 2, #1", "строка 3, #2"]}
    assert data["duplicates"]["vacuum"] == {"ivanov": ["строка 2, #1", "строка 3, #2"]}
    assert data["duplicates"]["mac"] == {}
    assert [(a["row"], a["field"]) for a in data["anomalies"]] == [
        ("строка 2, #1", "Принтер"),
        ("строка 3, #2", "№"), ("строка 3, #2", "IP"), ("строка 3, #2", "MAC"),
        ("строка 4, #3", "Отделение"),
        ("строка 5, #4", "Адрес"), ("строка 5, #4", "Отделение"),
    ]
    assert data["anomalies_count"] == len(data["anomalies"])


def test_import_apply(admin, reader):
    data = ok(upload(admin, "/api/import/apply", sheet(ROWS), confirm="false"))
    assert data == {"message": "Для записи в базу отправьте запрос ещё раз с confirm=true.", "sheet": "list"}
    assert ok(reader.get("/api/computers"))["total"] == 0

    data = ok(upload(admin, "/api/import/apply", sheet(ROWS), confirm="true"))
    assert data["ok"] is True and data["stats"] == {"rows": 4, "computers": 4, "anomalies": 6}
    assert [(a["row"], a["field"]) for a in data["anomalies"]] == [
        ("строка 2, #1", "Принтер"),
        ("строка 3, #2", "№"), ("строка 3, #2", "IP"), ("строка 3, #2", "MAC"),
        ("строка 4, #3", "Отделение"),
        ("строка 5, #4", "Адрес"),
    ]

    rows = {row["hostname"]: row for row in ok(reader.get("/api/computers"))["rows"]}
    first = rows["ter-201-1"]
    assert first["ip"] == "10.0.2.11" and first["mac"] == "D8:00:00:00:00:01"
    assert (first["building"], first["department"], first["floor"], first["room_code"]) == ("ул. Ленина, 1", "Терапия", "2", "201")
    assert first["drive"] == "SSD 250" and first["seat_no"] == 1 and first["status"] == "установлен"
    assert first["note"] == "у окна\nПринтер: HP 1102"
    assert first["gsit"] == "77" and first["state"] == "ok" and first["label"] == "Мед"
    assert first["vacuum"] == "ivanov\nivanov2" and first["user"] == "Иванов Иван"
    second = rows["TER-201-1"]
    assert second["seat_no"] is None and second["ip"] == "10.0.2.11" and second["mac"] is None
    assert second["user"] == "Иванов Иван" and second["location_id"] == first["location_id"]
    assert rows["no-address"]["location_id"] is None
    assert rows["no-dep"]["location_id"] != first["location_id"]

    choices = {(c["field"], c["value"]) for c in ok(reader.get("/api/choices"))["items"]}
    assert {("os", "Win 10"), ("os", "Win 11"), ("gsit", "77"), ("state", "ok"), ("label", "Мед")} <= choices
    assert {("status", value) for value in ("установлен", "склад", "ремонт", "списан")} <= choices

    # Повторный импорт – отказ
    assert upload(admin, "/api/import/apply", sheet(ROWS), confirm="true").status_code == 409


def test_import_anomaly_limits(admin):
    """Замечания считаются все; хранятся первые 200 у анализа и первые 100 у записи."""
    rows = [{"Адрес": "ул. Ленина, 1", "Отделение": "Терапия", "HOSTNAME": f"pc-{i}", "MAC": "zz"} for i in range(250)]

    data = ok(upload(admin, "/api/import/analyze", sheet(rows)))
    assert data["anomalies_count"] == 250 and len(data["anomalies"]) == 200

    data = ok(upload(admin, "/api/import/apply", sheet(rows), confirm="true"))
    assert data["stats"] == {"rows": 250, "computers": 250, "anomalies": 250} and len(data["anomalies"]) == 100
    assert data["anomalies"][-1]["row"] == "строка 101"


def test_import_refusals(admin):
    unknown = upload(admin, "/api/import/apply", sheet([{"HOSTNAME": "pc"}], head=["HOSTNAME", "Лишний"]), confirm="true")
    assert unknown.status_code == 400 and unknown.json()["detail"]["unknown_columns"] == ["Лишний"]
    assert ok(upload(admin, "/api/import/analyze", sheet([{"HOSTNAME": "pc"}], head=["HOSTNAME", "Лишний"])))[
        "unknown_columns"] == ["Лишний"]

    for url in ("/api/import/preview", "/api/import/analyze", "/api/import/apply"):
        response = upload(admin, url, b"not excel", name="list.xls", confirm="true")
        assert response.status_code == 400 and ".xlsx" in response.json()["detail"]
        response = upload(admin, url, b"not excel", confirm="true")
        assert response.status_code == 400 and response.json()["detail"].startswith("Не удалось открыть файл")

    # Лист «@» не читается; лист без строк – пусто
    response = upload(admin, "/api/import/analyze", sheet([], head=[], title="@"))
    assert response.status_code == 400 and response.json()["detail"] == "В файле нет листа с данными."
    response = upload(admin, "/api/import/analyze", sheet([], head=[], title="Лист1"))
    assert response.status_code == 400 and response.json()["detail"] == "Лист с данными пуст."

    preview = ok(upload(admin, "/api/import/preview", sheet(ROWS)))
    assert preview["sheets"][0]["name"] == "list" and preview["sheets"][0]["rows"][0][:2] == ["#", "ФИО"]


# ---------- История: названия объектов ----------


def test_history_titles(editor, reader, room):
    computer_id = add_computer(editor, room["room"], hostname="pc-1")
    printer_id = add_printer(editor, room["room"])
    ok(editor.post("/api/choices", json={"field": "os", "value": "Win 10"}))

    titles = {(item["entity"], item["entity_id"]): item["title"] for item in history(reader, "computers")}
    assert titles == {("computers", computer_id): "pc-1"}
    assert history(reader, "printers", printer_id)[0]["title"] == f"#{printer_id}"
    assert history(reader, "locations", room["room"])[0]["title"] == "Ординаторская"
    assert history(reader, "choices")[0]["title"] == "Операционная система: Win 10"
