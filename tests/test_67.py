"""Этап 67: журнал «Движение» – IP у компьютера, принтера и МФУ; «Установить» (куда, когда, кто,
статус «Установлен» с несохранёнными правками окна; заменённый ПК или принтер и сама запись – в
архив; Ctrl+Z – всё разом); новый ПК и принтер с данными записи журнала."""
from datetime import date

from conftest import add_computer, add_location, get_row, history, ok
from test_66 import add_move, patch, row_of, types, user_id  # noqa: F401 – types – фикстура
from test_printers import add_printer, printer


def install(client, move_id, status=200, **fields):
    fields.setdefault("version", row_of(client, move_id)["version"])
    return ok(client.post(f"/api/moves/{move_id}/install", json=fields), status)


def test_ip(editor, reader, types, models):
    pc = add_move(editor, types["Компьютер"], model="DEXP", cpu="i3", move_ip=" 10.0.5.7, 10.0.5.8 ")
    row = row_of(editor, pc)
    # Несколько адресов – строками, как у ПК; в «Своё название» IP не входит
    assert (row["move_ip"], row["title"]) == ("10.0.5.7\n10.0.5.8", "DEXP (i3)")
    mfu = add_move(editor, types["МФУ"], printer_model_id=models["mfu"]["id"], move_ip="10.0.5.9")
    assert row_of(editor, mfu)["move_ip"] == "10.0.5.9"

    # У монитора и компонентов IP нет; сменили тип – IP очищается (в Историю)
    response = editor.post("/api/moves", json={"type_id": types["Монитор"], "move_ip": "10.0.0.1"})
    assert response.status_code == 400 and "IP" in response.json()["detail"]
    ok(patch(editor, pc, type_id=types["Монитор"]))
    assert row_of(editor, pc)["move_ip"] is None
    assert history(editor, "moves", pc)[0]["changes"]["move_ip"] == {"old": "10.0.5.7\n10.0.5.8", "new": None}

    # Столбец «IP» – свой ключ (оформление подсетей ПК не смешивается), подпись в Истории
    info = ok(reader.get("/api/columns"))
    keys = [column["key"] for column in info["move_columns"]]
    assert keys.index("move_ip") == keys.index("kit") + 1
    assert info["move_history_labels"]["move_ip"] == "IP"


def test_install(admin, editor, reader, room, types):
    monitor = add_move(editor, types["Монитор"], model="Asus", diagonal="24")
    editor_id = user_id("editor")

    # Кабинет обязателен; читателю нельзя
    assert install(editor, monitor, 400, dest=None)["detail"] == "Выбери кабинет."
    assert reader.post(f"/api/moves/{monitor}/install", json={"dest": f"l:{room['room']}"}).status_code == 403

    # Куда, когда, кто и статус – вместе с несохранёнными правками окна; одна запись Истории
    data = install(editor, monitor, dest=f"l:{room['room']}", installed="16.10.2026", installer_user_id=editor_id,
                   edits={"note": "По заявке", "diagonal": "27"})
    row = row_of(editor, monitor)
    assert (row["dest"], row["installed"], row["installer"], row["move_status"], row["note"], row["title"]) == (
        "Терапия\n[201] Ординаторская", "16.10.2026", "editor", "Установлен", "По заявке", 'Asus (27")')
    assert data["updated"]["move_status"] == "Установлен"
    changes = history(editor, "moves", monitor)[0]["changes"]
    assert set(changes) == {"dest", "installed", "installer", "move_status", "note", "diagonal"}

    # Окно открыто давно – 409; вписанное имя вместо пользователя; без даты – сегодня; запись в
    # архиве – нельзя
    assert install(editor, monitor, 409, version=1, dest=f"l:{room['room']}")["detail"].startswith("Эту запись уже изменил")
    install(editor, monitor, dest=f"l:{room['department']}", installer="Солдатов Д.Э.", archive=True)
    row = row_of(editor, monitor)
    assert (row["archived"], row["dest"], row["installer"], row["installed"]) == (
        True, "Терапия", "Солдатов Д.Э.", date.today().strftime("%d.%m.%Y"))
    assert history(editor, "moves", monitor)[0]["changes"]["archived"] == {"old": False, "new": True}
    assert install(editor, monitor, 400, dest=f"l:{room['room']}")["detail"] == "Запись в архиве."

    # Технику – не в ПК
    pc = add_computer(editor, room["room"], hostname="ter-ord-1")
    other = add_move(editor, types["Монитор"])
    assert "Технику" in install(editor, other, 400, dest=f"c:{pc}")["detail"]

    # «Установил» записи – пользователь, которого потом отключили: «Установить» с ним же проходит,
    # выбрать его заново – нет
    gone = ok(admin.post("/api/users", json={"login": "u67", "role": "editor", "password": "secret1"}))["id"]
    kept = add_move(editor, types["Монитор"], installer_user_id=gone)
    ok(admin.patch(f"/api/users/{gone}", json={"archived": True}))
    install(editor, kept, dest=f"l:{room['room']}", installer_user_id=gone)
    assert row_of(editor, kept)["installer_user_id"] == gone
    assert "отключён" in install(editor, other, 400, dest=f"l:{room['room']}", installer_user_id=gone)["detail"]


def test_install_replace_pc(editor, room, types):
    old = add_computer(editor, room["room"], seat_no="1", hostname="ter-ord-1")
    keep = add_computer(editor, room["room"], seat_no="2", hostname="ter-ord-2")
    new = add_move(editor, types["Компьютер"], model="DEXP", inv_no="780100")
    monitor = add_move(editor, types["Монитор"])

    # Заменить ПК – только компьютером; ПК из архива не заменить
    assert "компьютером" in install(editor, monitor, 400, dest=f"l:{room['room']}", replace_pc=old)["detail"]
    assert "принтером" in install(editor, new, 400, dest=f"l:{room['room']}", replace_printer=old)["detail"]
    ok(editor.post("/api/computers/archive", json={"ids": [keep], "archived": True}))
    assert "Обнови" in install(editor, new, 400, dest=f"l:{room['room']}", replace_pc=keep)["detail"]
    ok(editor.post("/api/computers/archive", json={"ids": [keep], "archived": False}))
    # ПК не в выбранном кабинете (список устарел) – не заменить
    far = add_computer(editor, add_location(editor, "room", "Процедурная", room["department"], code="202"), hostname="ter-pr-1")
    assert "нет в выбранном" in install(editor, new, 400, dest=f"l:{room['room']}", replace_pc=far)["detail"]
    assert get_row(editor, far)["archived"] is False
    assert row_of(editor, new)["move_status"] is None   # отказ – ничего не записано

    # Заменили: старый ПК – в архив (его История), запись – тоже по галочке; одно время у обеих
    install(editor, new, dest=f"l:{room['room']}", installed="16.10.2026", replace_pc=old, archive=True)
    assert get_row(editor, old)["archived"] is True
    assert get_row(editor, keep)["archived"] is False
    pc_record = history(editor, "computers", old)[0]
    move_record = history(editor, "moves", new)[0]
    assert pc_record["changes"] == {"archived": {"old": False, "new": True}}
    assert pc_record["at"] == move_record["at"]
    assert row_of(editor, new)["archived"] is True

    # Ctrl+Z – установка целиком: ПК и запись возвращаются
    ok(editor.post("/api/history/undo-last"))
    assert get_row(editor, old)["archived"] is False
    row = row_of(editor, new)
    assert (row["archived"], row["move_status"], row["dest"], row["installed"]) == (False, None, None, None)


def test_install_part_and_printer(editor, room, types, models):
    pc = add_computer(editor, room["room"], hostname="ter-ord-1")
    disk = add_move(editor, types["Диск"], size="480")
    # Компонент – в ПК, заменить им нечего
    assert "компьютером" in install(editor, disk, 400, dest=f"c:{pc}", replace_pc=pc)["detail"]
    install(editor, disk, dest=f"c:{pc}", installed="2026")
    row = row_of(editor, disk)
    assert (row["dest_ref"], row["installed"], row["move_status"]) == (f"c:{pc}", "2026", "Установлен")

    # МФУ заменяет принтер; компьютер принтер не заменяет
    old = add_printer(editor, room["room"], name="pr-1", model_id=models["printer"]["id"])
    mfu = add_move(editor, types["МФУ"], printer_model_id=models["mfu"]["id"])
    computer = add_move(editor, types["Компьютер"])
    assert "принтером" in install(editor, computer, 400, dest=f"l:{room['room']}", replace_printer=old)["detail"]
    install(editor, mfu, dest=f"l:{room['room']}", replace_printer=old)
    assert printer(editor, old)["archived"] is True
    assert history(editor, "printers", old)[0]["changes"] == {"archived": {"old": False, "new": True}}
    assert row_of(editor, mfu)["archived"] is False


def test_add_from_journal(editor, room, types, models):
    # Новый ПК из строки добавления с данными записи журнала – одной записью Истории «Создан»
    fields = {"inv_no": "780100", "serial": "SN-1", "type": "ПК", "model": "DEXP", "cpu": "i3-10100", "ram": "8",
              "drive": "SSD 240", "gpu": "GT 1030"}
    pc = add_computer(editor, room["room"], seat_no="1", hostname="ter-ord-1", ip="10.0.5.7", fields=fields)
    row = get_row(editor, pc)
    assert {key: row[key] for key in fields} == fields
    created = history(editor, "computers", pc)[0]["changes"]
    assert created["inv_no"] == {"old": None, "new": "780100"} and "created" in created
    response = editor.post("/api/computers", json={"location_id": room["room"], "fields": {"vacuum": "u1"}})
    assert response.status_code == 400

    # Принтер – ИНВ и серийный
    pid = add_printer(editor, room["room"], model_id=models["mfu"]["id"], fields={"inv_no": "780200", "serial": "SN-2"})
    row = printer(editor, pid)
    assert (row["inv_no"], row["serial"], row["number"]) == ("780200", "SN-2", 1)
    assert history(editor, "printers", pid)[0]["changes"]["serial"] == {"old": None, "new": "SN-2"}
    response = editor.post("/api/printers", json={"location_id": room["room"], "fields": {"web_url": "http://x"}})
    assert response.status_code == 400
