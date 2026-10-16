"""Этап 66: журнал «Движение» – типы техники и компонентов, записи, даты без дня и месяца,
«Куда» (узел или ПК), «Установил», архив, массовая правка, История и отмена. Правки после
проверки: «Своё название», комплект, новые сверху, удаление насовсем из архива."""
import pytest

from conftest import add_computer, add_location, add_model, add_pc, get_row, history, ok, set_vacuum
from db import SessionLocal
from models import ItemType, User
from test_53 import add_record

# Типы из миграции (clean_data их стирает – перед каждым тестом заново)
TYPES = [
    ("Компьютер", "tech", "computer"),
    ("Монитор", "tech", "monitor"),
    ("Принтер", "tech", "printer"),
    ("МФУ", "tech", "printer"),
    ("Диск", "part", "disk"),
    ("ОЗУ", "part", "ram"),
]


@pytest.fixture
def types():
    """Тип по названию → id."""
    session = SessionLocal()
    try:
        for index, (name, kind, form) in enumerate(TYPES):
            session.add(ItemType(name=name, kind=kind, form=form, sort=index + 1))
        session.commit()
        return {item.name: item.id for item in session.query(ItemType).all()}
    finally:
        session.close()


def rows(client, archived="all"):
    return ok(client.get("/api/moves", params={"archived": archived}))["rows"]


def row_of(client, move_id):
    return next(row for row in rows(client) if row["id"] == move_id)


def add_move(client, type_id, **fields):
    return ok(client.post("/api/moves", json=dict(fields, type_id=type_id)))["id"]


def patch(client, move_id, **fields):
    return client.patch(f"/api/moves/{move_id}", json=dict(fields, _version=row_of(client, move_id)["version"]))


def user_id(login):
    session = SessionLocal()
    try:
        return session.query(User).filter(User.login == login).one().id
    finally:
        session.close()


def test_types(editor, reader, types):
    items = ok(reader.get("/api/item-types"))["items"]
    assert [item["name"] for item in items] == ["Компьютер", "Монитор", "Принтер", "МФУ", "Диск", "ОЗУ"]
    assert {item["name"]: item["form"] for item in items}["МФУ"] == "printer"

    # Новый тип – с полем «Информация», в конце своего вида
    created = ok(editor.post("/api/item-types", json={"name": " ИБП ", "kind": "tech"}))
    assert (created["name"], created["kind"], created["form"]) == ("ИБП", "tech", "info")
    names = [item["name"] for item in ok(reader.get("/api/item-types"))["items"]]
    assert names.index("ИБП") == names.index("МФУ") + 1

    # Без учёта регистра – повтор, и среди компонентов тоже
    response = editor.post("/api/item-types", json={"name": "диск", "kind": "tech"})
    assert response.status_code == 400 and "уже есть" in response.json()["detail"]
    assert editor.post("/api/item-types", json={"name": "Кабель", "kind": "other"}).status_code == 400
    assert editor.post("/api/item-types", json={"name": "  ", "kind": "part"}).status_code == 400
    assert reader.post("/api/item-types", json={"name": "Кабель", "kind": "part"}).status_code == 403

    assert history(editor, "item_types")[0]["changes"] == {"created": {"old": None, "new": "ИБП"}}


def test_titles(editor, types, models):
    pc = add_move(editor, types["Компьютер"], model="DEXP", pc_kind="ПК", cpu="Intel i3-10100", ram="8",
                  disk_kind="SSD", disk_size="240")
    assert row_of(editor, pc)["title"] == "DEXP (ПК; Intel i3-10100; 8 Гб; SSD 240)"
    ok(patch(editor, pc, gpu="GT 1030", ram="16 Гб"))
    assert row_of(editor, pc)["title"] == "DEXP (ПК; Intel i3-10100; 16 Гб; SSD 240; GT 1030)"

    nettop = add_move(editor, types["Компьютер"], model="Lenovo M720q", pc_kind="Неттоп")
    assert row_of(editor, nettop)["title"] == "Lenovo M720q (Неттоп)"

    monitor = add_move(editor, types["Монитор"], model="Монитор Asus VA249HG", diagonal="23.8", resolution="1920x1080")
    assert row_of(editor, monitor)["title"] == 'Монитор Asus VA249HG (23.8"; 1920x1080)'

    disk = add_move(editor, types["Диск"], model="ADATA SU650", disk_kind="SSD", interface="SATA", size="480")
    assert row_of(editor, disk)["title"] == "ADATA SU650 (SSD; SATA; 480 Гб)"

    ram = add_move(editor, types["ОЗУ"], model="ОЗУ Kingston FURY", ram_kind="DDR4/SO-DIMM", freq="3200", size="8")
    assert row_of(editor, ram)["title"] == "ОЗУ Kingston FURY (DDR4/SO-DIMM; 3200 Мгц; 8 Гб)"

    # Без своего названия – только поля; принтер – модель из справочника, своё название – перед
    # ней (правки этапа 66)
    bare = add_move(editor, types["Диск"], size="1000")
    assert row_of(editor, bare)["title"] == "1000 Гб"
    printer = add_move(editor, types["Принтер"], printer_model_id=models["printer"]["id"])
    row = row_of(editor, printer)
    assert (row["title"], row["form"], row["type_kind"]) == ("HP LaserJet M404", "printer", "tech")
    named = add_move(editor, types["Принтер"], model="Принтер бухгалтерии", printer_model_id=models["printer"]["id"])
    assert row_of(editor, named)["title"] == "Принтер бухгалтерии (HP LaserJet M404)"
    assert row_of(editor, add_move(editor, types["МФУ"], model="Samsung"))["title"] == "Samsung"

    other = ok(editor.post("/api/item-types", json={"name": "ИБП", "kind": "tech"}))
    ups = add_move(editor, other["id"], model="APC Back-UPS", info="650 ВА")
    assert row_of(editor, ups)["title"] == "APC Back-UPS (650 ВА)"

    # Поля чужого вида и модель справочника не принтеру – отказ
    response = editor.post("/api/moves", json={"type_id": types["Монитор"], "cpu": "i5"})
    assert response.status_code == 400 and "нет поля «Процессор»" in response.json()["detail"]
    assert editor.post("/api/moves", json={"type_id": types["Диск"], "printer_model_id": models["mfu"]["id"]}).status_code == 400
    assert editor.post("/api/moves", json={"name_1c": "Без типа"}).status_code == 400
    assert editor.post("/api/moves", json={"type_id": 999}).status_code == 400


def test_dates(editor, types):
    move = add_move(editor, types["Диск"], made="08.2025", bought="2026", received="2.8.2026", installed="2026-08-04")
    row = row_of(editor, move)
    assert (row["made"], row["bought"], row["received"], row["installed"]) == ("08.2025", "2026", "02.08.2026", "04.08.2026")

    for value, text in (("31.02.2026", "такого дня нет"), ("13.2026", "нужно"), ("1989", "с 1990"), ("2026.08", "нужно"),
                        ("1.2.3.2026", "нужно"), ("08.26", "нужно"), ("²." * 2 + "2026", "нужно"), ("２０２６", "нужно")):
        response = patch(editor, move, made=value)
        assert response.status_code == 400 and text in response.json()["detail"], value

    # 29 февраля – только в високосный год
    assert patch(editor, move, made="29.02.2025").status_code == 400
    ok(patch(editor, move, made="29.02.2024"))

    # Пустое – очистить; в Истории – как на экране
    ok(patch(editor, move, bought=""))
    assert row_of(editor, move)["bought"] is None
    assert history(editor, "moves", move)[0]["changes"] == {"bought": {"old": "2026", "new": None}}


def test_dest_and_installer(admin, editor, reader, room, types):
    floor = add_location(editor, "floor", "2", room["department"])
    pc = add_computer(editor, room["room"], hostname="ter-ord-1")
    monitor = add_move(editor, types["Монитор"], dest=f"l:{room['room']}")
    assert row_of(editor, monitor)["dest"] == "Терапия\n[201] Ординаторская"
    assert history(editor, "moves", monitor)[0]["changes"]["dest"] == {
        "old": None, "new": "ул. Ленина, 1 / Терапия / 201 Ординаторская", "old_id": None, "new_id": f"l:{room['room']}",
    }

    ok(patch(editor, monitor, dest=f"l:{room['department']}"))
    assert row_of(editor, monitor)["dest"] == "Терапия"
    ok(patch(editor, monitor, dest=f"l:{floor}"))
    assert row_of(editor, monitor)["dest"] == "Терапия\n2 этаж"
    ok(patch(editor, monitor, dest=f"l:{room['building']}"))
    assert row_of(editor, monitor)["dest"] == "ул. Ленина, 1"

    # Компонент – в ПК; техника – нет
    disk = add_move(editor, types["Диск"], dest=f"c:{pc}")
    row = row_of(editor, disk)
    assert (row["dest"], row["dest_ref"]) == ("Терапия\n[201] Ординаторская\nter-ord-1", f"c:{pc}")
    response = patch(editor, monitor, dest=f"c:{pc}")
    assert response.status_code == 400 and "Технику" in response.json()["detail"]
    # …и сменить тип компонента в ПК на технику нельзя
    assert patch(editor, disk, type_id=types["Монитор"]).status_code == 400
    assert patch(editor, disk, dest="x:1").status_code == 400
    assert patch(editor, disk, dest="l:999").status_code == 400

    # Установил: пользователь программы («Фамилия И.О.», без ФИО – логин) или вписанное имя
    editor_id = user_id("editor")
    ok(patch(editor, disk, installer_user_id=editor_id))
    assert row_of(editor, disk)["installer"] == "editor"
    ok(admin.patch(f"/api/users/{editor_id}", json={"full_name": "Сугаченко Евгений Евгеньевич"}))
    assert row_of(editor, disk)["installer"] == "Сугаченко Е.Е."
    ok(patch(editor, disk, installer="Солдатов Д.Э."))
    row = row_of(editor, disk)
    assert (row["installer"], row["installer_user_id"]) == ("Солдатов Д.Э.", None)
    assert history(editor, "moves", disk)[0]["changes"]["installer"] == {
        "old": "Сугаченко Е.Е.", "new": "Солдатов Д.Э.", "old_id": editor_id, "new_id": None,
    }
    assert patch(editor, disk, installer_user_id=99999).status_code == 400

    # Список для выбора – только редактору; читатель видит имя в строке
    names = [item["name"] for item in ok(editor.get("/api/moves/installers"))["items"]]
    assert "Сугаченко Е.Е." in names and "admin" in names
    assert reader.get("/api/moves/installers").status_code == 403
    ok(admin.patch(f"/api/users/{editor_id}", json={"full_name": ""}))


def test_type_change_and_undo(editor, types):
    pc = add_move(editor, types["Компьютер"], model="DEXP", cpu="i3", ram="8", name_1c="Системный блок")
    # Сменили тип на монитор – полей компьютера больше нет, остальное – на месте
    ok(patch(editor, pc, type_id=types["Монитор"], diagonal="24"))
    row = row_of(editor, pc)
    assert (row["item_type"], row["specs"], row["model"], row["name_1c"]) == ("Монитор", {"diagonal": "24"}, "DEXP", "Системный блок")
    record = history(editor, "moves", pc)[0]
    assert record["changes"]["item_type"]["new"] == "Монитор" and record["changes"]["cpu"] == {"old": "i3", "new": None}

    # Отмена смены типа целиком возвращает и поля компьютера (тип – первым)
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}], "cancel": True}))
    row = row_of(editor, pc)
    assert (row["item_type"], row["specs"]) == ("Компьютер", {"cpu": "i3", "ram": "8"})
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}], "cancel": False}))
    assert row_of(editor, pc)["specs"] == {"diagonal": "24"}

    # Принтер: своё название остаётся (правки этапа 66), у не-принтера стирается модель справочника
    model = add_model(editor, "LBP226", maker="Canon")
    ok(patch(editor, pc, type_id=types["Принтер"], printer_model_id=model["id"]))
    row = row_of(editor, pc)
    assert (row["model"], row["title"], row["specs"]) == ("DEXP", "DEXP (Canon LBP226)", {})
    # Модель с записями журнала из справочника не удалить
    response = editor.delete(f"/api/printer-models/{model['id']}")
    assert response.status_code == 400 and "журнале" in response.json()["detail"]
    ok(patch(editor, pc, type_id=types["Диск"], model="ADATA"))
    row = row_of(editor, pc)
    assert (row["printer_model_id"], row["title"]) == (None, "ADATA")

    # Ctrl+Z – последнее своё действие (текст – пока значения прежние); название записи в
    # Истории – «Понятное название» сейчас
    undone = ok(editor.post("/api/history/undo-last"))
    assert undone["text"].startswith("ADATA – ")
    assert row_of(editor, pc)["printer_model_id"] == model["id"]
    assert history(editor, "moves", pc)[0]["title"] == "DEXP (Canon LBP226)"


def test_same_labels_and_partial_undo(editor, room, types):
    # Два ПК с одним именем в одном кабинете: перенос компонента – по номеру, в Истории различимы
    first = add_computer(editor, room["room"], hostname="buh-3")
    second = add_computer(editor, room["room"], hostname="buh-3")
    disk = add_move(editor, types["Диск"], dest=f"c:{first}")
    ok(patch(editor, disk, dest=f"c:{second}"))
    assert row_of(editor, disk)["dest_ref"] == f"c:{second}"
    change = history(editor, "moves", disk)[0]["changes"]["dest"]
    assert change["old"] != change["new"] and change["new"].endswith(f"(ПК №{second})")
    # Отмена – по номеру
    ok(editor.post("/api/history/undo-last"))
    assert row_of(editor, disk)["dest_ref"] == f"c:{first}"

    # Пользователь без ФИО и вписанное то же имя – разные значения
    ok(patch(editor, disk, installer_user_id=user_id("editor")))
    ok(patch(editor, disk, installer="editor"))
    row = row_of(editor, disk)
    assert (row["installer"], row["installer_user_id"]) == ("editor", None)
    assert history(editor, "moves", disk)[0]["changes"]["installer"]["new"] == "editor (вписано)"

    # Отменили только «Тип»: поля монитора остаются у компьютера (не в названии), следующая
    # правка их не трогает и отменяется
    pc = add_move(editor, types["Компьютер"], cpu="i3")
    ok(patch(editor, pc, type_id=types["Монитор"], diagonal="24"))
    record = history(editor, "moves", pc)[0]
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"], "field": "item_type"}], "cancel": True}))
    row = row_of(editor, pc)
    assert (row["item_type"], row["specs"], row["title"]) == ("Компьютер", {"diagonal": "24"}, None)
    ok(patch(editor, pc, note="после отмены"))
    assert set(history(editor, "moves", pc)[0]["changes"]) == {"note"}
    ok(editor.post("/api/history/undo-last"))
    assert row_of(editor, pc)["note"] is None

    # Техника в кабинете → компонент в ПК одним действием: отмена и восстановление
    monitor = add_move(editor, types["Монитор"], dest=f"l:{room['room']}")
    ok(patch(editor, monitor, type_id=types["Диск"], dest=f"c:{first}"))
    undone = ok(editor.post("/api/history/undo-last"))
    row = row_of(editor, monitor)
    assert (row["item_type"], row["dest_ref"]) == ("Монитор", f"l:{room['room']}")
    ok(editor.post("/api/history/cancel", json={"items": undone["items"], "cancel": False}))
    row = row_of(editor, monitor)
    assert (row["item_type"], row["dest_ref"]) == ("Диск", f"c:{first}")

    # Ctrl+Z после нового типа – «создание», а не «настройка»
    ok(editor.post("/api/item-types", json={"name": "Сканер", "kind": "tech"}))
    response = editor.post("/api/history/undo-last")
    assert response.status_code == 400 and "создание" in response.json()["detail"]


def test_version_archive_bulk(editor, reader, types):
    first = add_move(editor, types["ОЗУ"], serial="A1")
    second = add_move(editor, types["ОЗУ"], serial="A2")
    version = row_of(editor, first)["version"]
    ok(editor.patch(f"/api/moves/{first}", json={"move_status": "Отдел ИТО", "_version": version}))
    assert editor.patch(f"/api/moves/{first}", json={"move_status": "Установлен", "_version": version}).status_code == 409
    assert reader.patch(f"/api/moves/{first}", json={"move_status": "x"}).status_code == 403
    assert reader.post("/api/moves", json={"type_id": types["ОЗУ"]}).status_code == 403
    assert editor.patch(f"/api/moves/{first}", json={"title": "x"}).status_code == 400
    assert editor.patch("/api/moves/999", json={"move_status": "x"}).status_code == 404

    # Одно значение – всем выбранным; уникальное (серийный) – нельзя
    result = ok(editor.post("/api/moves/bulk-update", json={"ids": [first, second], "field": "move_status", "value": "Установлен"}))
    assert sorted(result["changed"]) == [first, second]
    assert {row["move_status"] for row in rows(editor)} == {"Установлен"}
    assert editor.post("/api/moves/bulk-update", json={"ids": [first], "field": "serial", "value": "X"}).status_code == 400
    # Даты – блоками в окне записи, массово не меняются
    assert editor.post("/api/moves/bulk-update", json={"ids": [first], "field": "received", "value": "15.10.2026"}).status_code == 400

    # Архив – не удаление
    ok(editor.post("/api/moves/archive", json={"ids": [first], "archived": True}))
    assert [row["id"] for row in rows(editor, "no")] == [second]
    assert [row["id"] for row in rows(editor, "yes")] == [first]
    assert history(editor, "moves", first)[0]["changes"] == {"archived": {"old": False, "new": True}}
    assert editor.post("/api/moves/archive", json={"ids": [first, 999], "archived": False}).status_code == 404
    assert reader.post("/api/moves/archive", json={"ids": [first], "archived": False}).status_code == 403
    assert editor.get("/api/moves", params={"archived": "x"}).status_code == 400


def test_history_page(editor, types):
    move = add_move(editor, types["Диск"], model="ADATA SU650", disk_kind="SSD", size="480")
    items = ok(editor.get("/api/history", params={"q": "ADATA"}))["items"]
    assert [item["entity"] for item in items] == ["moves"]
    assert items[0]["title"] == "ADATA SU650 (SSD; 480 Гб)"
    assert items[0]["changes"]["created"] == {"old": None, "new": "ADATA SU650 (SSD; 480 Гб)"}
    # Поиск – и по подписи поля
    assert ok(editor.get("/api/history", params={"q": "объём"}))["items"][0]["entity_id"] == move
    # «История значения» у поля записи
    value = ok(editor.get("/api/history/value", params={"entity": "moves", "entity_id": move, "field": "size"}))
    assert (value["label"], value["current"], value["kind"]) == ("Объём", "480", "value")


def test_columns(reader):
    info = ok(reader.get("/api/columns"))
    assert [c["short"] for c in info["move_columns"]] == [
        "Тип", "Название по 1С", "Своё название", "Комплект", "Инвентарный", "Серийный номер",
        "Страна производства", "Дата производства", "Дата закупки", "Поставщик", "Откуда", "Дата получения", "Куда",
        "Дата установки", "Установил", "Статус", "Примечание",
    ]
    assert info["move_history_labels"]["cpu"] == "Процессор"
    assert info["move_history_labels"]["model"] == "Своё название"


# ---------- Правки после проверки (15.10) ----------


def test_kit_and_order(editor, types):
    """Комплект компьютера – своим столбцом, не в названии; новые записи – сверху."""
    pc = add_move(editor, types["Компьютер"], model="DEXP", cpu="i3", kit=" мышь,Клавиатура ; Мышь,, ")
    row = row_of(editor, pc)
    assert (row["kit"], row["specs"]["kit"], row["title"]) == ("мышь, Клавиатура", "мышь, Клавиатура", "DEXP (i3)")
    ok(patch(editor, pc, kit="Мышь\nКоврик"))
    assert row_of(editor, pc)["kit"] == "Мышь, Коврик"
    assert history(editor, "moves", pc)[0]["changes"] == {"kit": {"old": "мышь, Клавиатура", "new": "Мышь, Коврик"}}
    assert ok(editor.get("/api/columns"))["move_history_labels"]["kit"] == "Комплект"

    # У монитора комплекта нет; сменили тип – комплект очищается
    response = editor.post("/api/moves", json={"type_id": types["Монитор"], "kit": "Кабель"})
    assert response.status_code == 400 and "нет поля «Комплект»" in response.json()["detail"]
    monitor = add_move(editor, types["Монитор"], diagonal="24")
    assert [row["id"] for row in rows(editor)] == [monitor, pc]
    ok(patch(editor, pc, type_id=types["Монитор"]))
    assert row_of(editor, pc)["kit"] is None
    assert history(editor, "moves", pc)[0]["changes"]["kit"] == {"old": "Мышь, Коврик", "new": None}


def test_delete_computers(admin, editor, room, types, models):
    """Насовсем – только из архива и только администратор; связи уходят, у другой стороны – История."""
    pc = add_pc(editor, room["room"], "ter-ord-1", user="Иванов И.И.")
    other = add_pc(editor, room["room"], "ter-ord-2")
    set_vacuum(editor, pc, "u1")
    pid = ok(editor.post("/api/printers", json={"location_id": room["room"], "name": "pr-1", "model": "HP LaserJet M404"}))["id"]
    version = ok(editor.get("/api/printers", params={"archived": "all"}))["rows"][0]["version"]
    ok(editor.patch(f"/api/printers/{pid}", json={"computers": "ter-ord-1\nter-ord-2 [usb]", "_version": version}))
    disk = add_move(editor, types["Диск"], dest=f"c:{pc}")
    # Решение сканера о ПК, отменённое в Истории (восстановить после удаления – нельзя)
    add_record("glpi", 157, "DESKTOP-157")
    ok(admin.post("/api/scan/records/glpi/157/reject", json={"computer_id": pc}))
    decision = history(admin, "scan_records")[0]
    ok(admin.post("/api/history/cancel", json={"items": [{"id": decision["id"]}]}))

    ok(editor.post("/api/computers/archive", json={"ids": [pc], "archived": True}))
    assert editor.post("/api/computers/delete", json={"ids": [pc]}).status_code == 403
    response = admin.post("/api/computers/delete", json={"ids": [pc, other]})
    assert response.status_code == 400 and "из архива" in response.json()["detail"]
    assert admin.post("/api/computers/delete", json={"ids": [pc, 99999]}).status_code == 404
    assert admin.post("/api/computers/delete", json={"ids": []}).status_code == 400

    ok(admin.post("/api/computers/delete", json={"ids": [pc]}))
    assert get_row(admin, pc) is None and get_row(admin, other) is not None

    # Принтер остался подключённым к другому ПК; в его Истории – без удалённого
    rows_p = ok(editor.get("/api/printers", params={"archived": "all"}))["rows"]
    assert rows_p[0]["computers"] == "ter-ord-2 [usb]"
    change = history(editor, "printers", pid)[0]["changes"]["computers"]
    assert (change["old"], change["new"], change["new_ids"]) == ("ter-ord-1\nter-ord-2 [usb]", "ter-ord-2 [usb]", [[other, True]])

    # Диск, стоявший в ПК, – в его кабинете
    row = row_of(editor, disk)
    assert (row["dest_ref"], row["dest"]) == (f"l:{room['room']}", "Терапия\n[201] Ординаторская")
    assert history(editor, "moves", disk)[0]["changes"]["dest"]["new_id"] == f"l:{room['room']}"

    # История ПК осталась, с названием; «Удалено» не отменяется
    items = history(editor, "computers", pc)
    assert items[0]["changes"] == {"deleted": {"old": "ter-ord-1", "new": None}}
    assert {item["title"] for item in items} == {"ter-ord-1"}
    response = admin.post("/api/history/undo-last")
    assert response.status_code == 400 and "удаление" in response.json()["detail"]
    # Прежнюю правку удалённого ПК не вернуть; решение сканера о нём – тоже (400, а не 500)
    archived = next(item for item in items if "archived" in item["changes"])
    response = editor.post("/api/history/cancel", json={"items": [{"id": archived["id"]}], "cancel": True})
    assert response.status_code == 404
    response = admin.post("/api/history/cancel", json={"items": [{"id": decision["id"]}], "cancel": False})
    assert response.status_code == 400 and "удалён насовсем" in response.json()["detail"]
    # В поиске Истории удалённый – по имени
    assert any(item["entity_id"] == pc for item in ok(editor.get("/api/history", params={"q": "ter-ord-1"}))["items"])


def test_delete_printers_and_moves(admin, editor, reader, room, types, models):
    pc = add_computer(editor, room["room"], hostname="ter-ord-1")
    pid = ok(editor.post("/api/printers", json={"location_id": room["room"], "name": "pr-1", "model": "HP LaserJet M404"}))["id"]
    version = ok(editor.get("/api/printers", params={"archived": "all"}))["rows"][0]["version"]
    ok(editor.patch(f"/api/printers/{pid}", json={"computers": "ter-ord-1", "_version": version}))
    assert reader.post("/api/printers/delete", json={"ids": [pid]}).status_code == 403
    assert admin.post("/api/printers/delete", json={"ids": [pid]}).status_code == 400

    ok(editor.post("/api/printers/archive", json={"ids": [pid], "archived": True}))
    ok(admin.post("/api/printers/delete", json={"ids": [pid]}))
    assert ok(editor.get("/api/printers", params={"archived": "all"}))["rows"] == []
    assert get_row(editor, pc)["printers"] is None
    assert history(editor, "computers", pc)[0]["changes"]["printers"]["new"] is None
    assert history(editor, "printers", pid)[0]["title"] == "pr-1"

    # Запись журнала; модель из справочника теперь можно удалить
    move = add_move(editor, types["Принтер"], model="Старый", printer_model_id=models["printer"]["id"])
    keep = add_move(editor, types["Диск"], size="480")
    assert admin.post("/api/moves/delete", json={"ids": [move]}).status_code == 400
    ok(editor.post("/api/moves/archive", json={"ids": [move], "archived": True}))
    assert editor.post("/api/moves/delete", json={"ids": [move]}).status_code == 403
    ok(admin.post("/api/moves/delete", json={"ids": [move]}))
    assert [row["id"] for row in rows(editor)] == [keep]
    items = history(editor, "moves", move)
    assert items[0]["changes"] == {"deleted": {"old": "Старый (HP LaserJet M404)", "new": None}}
    assert {item["title"] for item in items} == {"Старый (HP LaserJet M404)"}
    ok(editor.delete(f"/api/printer-models/{models['printer']['id']}"))
