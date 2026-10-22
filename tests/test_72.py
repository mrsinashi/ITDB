"""Этап 72: короткая запись IP («24.46» – 192.168.24.46) везде, где IP вводят (ПК, принтер,
«Движение», журнал «IP»); «Сканер → Названия» стали «Справочники → Значения» (права страницы),
«Модели принтеров» – «Принтеры»."""
from api_computers import full_ip, normalize_ip
from auth import PAGE_TITLES, PAGES, ROLE_PAGES
from conftest import add_pc, get_row, ok
from test_66 import add_move, row_of, types  # noqa: F401 – types – фикстура
from test_69 import own_perms, set_perms  # noqa: F401 – own_perms – фикстура
from test_53 import aliases
from test_71 import create, note, patch as patch_ip, row_of as ip_row
from test_printers import add_printer, patch as patch_printer, printer


def test_full_ip():
    assert full_ip("24.46") == "192.168.24.46"
    assert full_ip("024.046") == "192.168.24.46"
    assert full_ip("0.5") == "192.168.0.5"
    # Не короткий адрес – как есть
    for text in ("10.0.5.1", "300.1", "24.460", "24", "24.46.1", "pc-24.46", "abc"):
        assert full_ip(text) == text
    assert normalize_ip(" 24.46, 10.0.0.1;0.5 ") == "192.168.24.46\n10.0.0.1\n192.168.0.5"


def test_short_ip_saved_full(editor, room, types, models):
    pc = add_pc(editor, room["room"], "ter-1", ip="24.46\n10.0.5.1")
    assert get_row(editor, pc)["ip"] == "192.168.24.46\n10.0.5.1"
    # Новый ПК – тоже
    pc2 = ok(editor.post("/api/computers", json={"location_id": room["room"], "hostname": "ter-2", "ip": "24.47"}))["id"]
    assert get_row(editor, pc2)["ip"] == "192.168.24.47"

    pr = add_printer(editor, room["room"], name="ter-mfu-1", model="ecosys m2040dn", ip="24.48")
    assert printer(editor, pr)["ip"] == "192.168.24.48"
    patch_printer(editor, pr, ip="24.49")
    assert printer(editor, pr)["ip"] == "192.168.24.49"

    move = add_move(editor, types["МФУ"], printer_model_id=models["mfu"]["id"], move_ip="24.50, 10.0.5.2")
    assert row_of(editor, move)["move_ip"] == "192.168.24.50\n10.0.5.2"

    create(editor, ip_addr="24.51", ip_name="сервер")
    assert ip_row(editor, "192.168.24.51")["entry"]["name"] == "сервер"
    # Уже занятый адрес коротко – тот же отказ, что и полностью
    response = editor.post("/api/ips", json={"ip_addr": "24.51"})
    assert response.status_code in (400, 409) and "192.168.24.51" in response.json()["detail"]
    # Правка адреса записи и описание адреса – тоже коротко
    patch_ip(editor, "192.168.24.51", ip_addr="24.52")
    assert ip_row(editor, "192.168.24.51") is None and ip_row(editor, "192.168.24.52")["entry"]["name"] == "сервер"
    note(editor, "24.53", "резерв")
    assert ip_row(editor, "192.168.24.53")["ip_note"] == "резерв"


def test_values_page(admin, editor, reader, own_perms):
    assert PAGE_TITLES["choices/values"] == "Справочники → Значения"
    assert PAGE_TITLES["choices/models"] == "Справочники → Принтеры"
    assert "scan/names" not in PAGES
    # Как было у «Названий»: у редактора и читателя без своих настроек страницы нет
    assert ROLE_PAGES["editor"]["choices/values"] == "none" and ROLE_PAGES["reader"]["choices/values"] == "none"
    ok(admin.get("/api/scan/names"))
    assert editor.get("/api/scan/names").status_code == 403
    set_perms(admin, "reader", {"choices/values": "view"})
    ok(reader.get("/api/scan/names"))
    set_perms(admin, "editor", {"choices/values": "edit"})
    body = {"field": "os", "source": "Win 7", "table": "Windows 7", "kind": "same"}
    ok(editor.post("/api/scan/names", json=body))
    alias_id = next(n for n in ok(editor.get("/api/scan/names")) if n["source"] == "Win 7")["id"]
    ok(editor.delete(f"/api/scan/names/{alias_id}"))
    # «Это разное» – и с «Просмотра» нельзя
    assert reader.post("/api/scan/names", json=dict(body, kind="differ")).status_code == 403


def test_values_decision_undo(admin, editor, own_perms):
    """Решение по названию отменяет и тот, у кого из страниц решений правка только «Значений»."""
    set_perms(admin, "editor", {"table": "none", "scan/check": "none"})
    body = {"field": "cpu", "source": "i3-2100", "table": "Core i3", "kind": "same"}
    assert editor.post("/api/scan/names", json=body).status_code == 403
    set_perms(admin, "editor", {"choices/values": "edit"})
    ok(editor.post("/api/scan/names", json=body))
    assert aliases() == [("cpu", "i3-2100", "Core i3", "same")]
    ok(editor.post("/api/history/undo-last"))
    assert aliases() == []
