"""Этап 70: у ПК «Пароль» вместо «Доступа» – несколько записей (учётная запись и / или пароль);
права: на любой странице любой роли – свой уровень в границах роли, уровень «Запуск» (сбор
сканера без правки); редактор не правит настройки (Подключения, Расписание, Пользователи),
читатель – ничего; администратору можно снять и правку «Пользователей»."""
import pytest

from api_users import keep_users_admin
from auth import PAGE_LEVELS, PAGES, ROLE_MAX, ROLE_PAGES, SETTINGS_PAGES, fit_perms
from conftest import PASSWORDS, add_computer, get_row, history, ok
from db import SessionLocal
from fakes import collect, setup_source
from models import User
from test_66 import user_id
from test_69 import admin2, own_perms, set_perms  # noqa: F401 – фикстуры


def put_entries(client, pc, entries, status=200):
    return ok(client.put(f"/api/computers/{pc}/web-auth", json={"entries": entries}), status)


def shown(client, pc):
    return ok(client.post(f"/api/computers/{pc}/web-auth/show", json={"password": PASSWORDS["admin"]}))["entries"]


# ---------- «Пароль» у ПК ----------


def test_pc_password_entries(admin, editor, reader, room):
    columns = ok(reader.get("/api/columns"))
    assert columns["history_labels"]["web_login"] == "Учётная запись"
    pc = add_computer(editor, room["room"], hostname="pc-1")

    # Несколько записей: учётная запись и пароль, только пароль, только учётная запись; пустые
    # отбрасываются, учётная запись – без пробелов по краям
    entries = [
        {"login": " Администратор ", "password": "p1"},
        {"login": "", "password": ""},
        {"login": "", "password": "bios"},
        {"login": "user", "password": ""},
    ]
    assert put_entries(editor, pc, entries)["updated"]["web_auth"] == "есть"
    assert shown(admin, pc) == [
        {"login": "Администратор", "password": "p1"},
        {"login": None, "password": "bios"},
        {"login": "user", "password": None},
    ]
    assert history(editor, "computers", pc)[0]["changes"] == {
        "web_login": {"old": None, "new": "задана новая"},
        "web_password": {"old": None, "new": "задан новый"},
    }
    count = len(history(editor, "computers", pc))

    # То же самое ещё раз – в Историю ничего
    put_entries(editor, pc, [{"login": "Администратор", "password": "p1"}, {"password": "bios"}, {"login": "user"}])
    assert len(history(editor, "computers", pc)) == count

    # Убрали запись – «удалён»; добавили – «задан новый»
    put_entries(editor, pc, [{"login": "Администратор", "password": "p1"}, {"login": "user"}])
    assert history(editor, "computers", pc)[0]["changes"] == {"web_password": {"old": None, "new": "удалён"}}
    put_entries(editor, pc, [{"login": "Администратор", "password": "p1"}, {"login": "user", "password": "u2"}])
    assert history(editor, "computers", pc)[0]["changes"] == {"web_password": {"old": None, "new": "задан новый"}}
    put_entries(editor, pc, [{"login": "Администратор", "password": "p1"}, {"password": "u2"}])
    assert history(editor, "computers", pc)[0]["changes"] == {"web_login": {"old": None, "new": "удалена"}}

    # Не больше 20 записей, значения – до 200 знаков; читателю – нельзя
    assert "20" in put_entries(editor, pc, [{"password": str(n)} for n in range(21)], 400)["detail"]
    put_entries(editor, pc, [{"password": "x" * 201}], 400)
    put_entries(reader, pc, [{"password": "x"}], 403)
    assert len(shown(admin, pc)) == 2

    # Все пустые – паролей нет
    put_entries(editor, pc, [])
    assert get_row(reader, pc)["web_auth"] is None
    assert shown(admin, pc) == []


def test_pc_passwords_changed_meanwhile(admin, editor, reader, room):
    """Ревью этапа 70: правка сверяет, что видел пользователь, – чужие записи не пропадают."""
    pc = add_computer(editor, room["room"], hostname="pc-1")
    put_entries(editor, pc, [{"login": "a", "password": "1"}, {"login": "b", "password": "2"}])
    # Ячейка у другого ещё пустая: «не видел ничего» – 409, записи на месте
    body = {"entries": [{"password": "x"}], "before": []}
    response = editor.put(f"/api/computers/{pc}/web-auth", json=body)
    assert response.status_code == 409 and "изменили" in response.json()["detail"]
    assert len(shown(admin, pc)) == 2
    # Видел то же, что сейчас, – можно
    before = [{"login": "a", "password": "1"}, {"login": "b", "password": "2"}]
    ok(editor.put(f"/api/computers/{pc}/web-auth", json={"entries": before + [{"password": "3"}], "before": before}))
    assert len(shown(admin, pc)) == 3

    # Пароли поменялись местами между записями – в Историю «изменён», версия растёт
    version = get_row(reader, pc)["version"]
    put_entries(editor, pc, [{"login": "a", "password": "2"}, {"login": "b", "password": "1"}, {"password": "3"}])
    assert history(editor, "computers", pc)[0]["changes"] == {"web_password": {"old": None, "new": "изменён"}}
    assert get_row(reader, pc)["version"] == version + 1


def test_printer_access_unchanged(admin, editor, room):
    """У принтера «Доступ» – по-прежнему один логин и пароль Web."""
    from test_printers import add_printer

    printer = add_printer(editor, room["room"])
    ok(editor.put(f"/api/printers/{printer}/web-auth", json={"login": "admin", "password": "pw"}))
    url = f"/api/printers/{printer}/web-auth/show"
    assert ok(admin.post(url, json={"password": PASSWORDS["admin"]})) == {"login": "admin", "password": "pw"}


# ---------- Границы ролей ----------


def test_role_bounds():
    # Читатель – ничего не правит; редактор – настройки; запуск – где есть что запускать
    assert "edit" not in ROLE_MAX["reader"].values()
    assert [page for page in PAGES if ROLE_MAX["editor"][page] != PAGE_LEVELS[page][-1]] == list(SETTINGS_PAGES)
    assert SETTINGS_PAGES == ("scan/schedule", "scan/settings", "users")
    assert [page for page in PAGES if "run" in PAGE_LEVELS[page]] == [
        "vacuum", "scan/check", "scan/net", "scan/schedule", "scan/settings"]
    assert ROLE_MAX["editor"]["scan/settings"] == "run" and ROLE_MAX["editor"]["users"] == "view"
    assert ROLE_MAX["editor"]["choices/values"] == "edit"
    # Без своих настроек – как было
    assert ROLE_PAGES["editor"]["choices/values"] == "none" and ROLE_PAGES["reader"]["vacuum"] == "none"


def test_fit_perms_on_role_change():
    # Ограничение остаётся ограничением, добавленное – добавленным
    perms = {"users": "view", "vacuum": "run", "history": "none"}
    assert fit_perms("admin", perms, "reader") == {"history": "none"}
    assert fit_perms("editor", perms, "reader") == {"users": "view", "vacuum": "run", "history": "none"}
    assert fit_perms("reader", {"table": "view", "scan/settings": "run"}, "editor") == {"scan/settings": "run"}


def test_reader_can_view_and_run(admin, reader, room, glpi_url):
    everything = {page: ROLE_MAX["reader"][page] for page in PAGES}
    perms = set_perms(admin, "reader", everything)["perms"]
    assert perms == everything and "edit" not in perms.values()
    assert "не даёт" in set_perms(admin, "reader", {"scan/schedule": "edit"}, 400)["detail"]

    # Запуск: собрать, смотреть источники и ход сбора; проверить подключение – только сохранённое
    setup_source(admin, glpi_url)
    assert collect(reader, "glpi")["status"] == "ok"
    ok(reader.get("/api/scan/sources"))
    ok(reader.get("/api/scan/subnets"))
    ok(reader.post("/api/scan/sources/glpi/check"))
    response = reader.post("/api/scan/sources/glpi/check", json={"url": "http://other.test/"})
    assert response.status_code == 403 and "просмотр и запуск" in response.json()["detail"]
    assert reader.patch("/api/scan/sources/glpi", json={"enabled": False}).status_code == 403

    # «Пользователи» – смотреть, но не менять
    ok(reader.get("/api/users"))
    ok(reader.get("/api/users/pages"))
    assert reader.patch(f"/api/users/{user_id('editor')}", json={"full_name": "x"}).status_code == 403

    # Только просмотр – собрать нельзя
    set_perms(admin, "reader", {"scan/check": "view", "scan/schedule": "view", "scan/settings": "view"})
    response = reader.post("/api/scan/sources/glpi/collect")
    assert response.status_code == 403 and response.json()["detail"] == "Недостаточно прав: «Сканер → GLPI / GSIT» – только просмотр."
    # Без запуска и без «Подключений» – источников не видно
    set_perms(admin, "reader", {"scan/check": "none", "scan/net": "none", "vacuum": "none", "scan/schedule": "none", "scan/settings": "none"})
    assert reader.get("/api/scan/sources").status_code == 403
    assert reader.get("/api/scan/runs").status_code == 403
    # «Расписание: просмотр» – журнал запусков, но не настройки источников
    set_perms(admin, "reader", {"scan/schedule": "view"})
    ok(reader.get("/api/scan/runs"))
    assert reader.get("/api/scan/sources").status_code == 403


def test_editor_settings_pages(admin, editor):
    # Настройки – не выше запуска и просмотра; «Значения» (до этапа 72 – «Названия») – можно и правку
    assert "не даёт" in set_perms(admin, "editor", {"scan/settings": "edit"}, 400)["detail"]
    assert "не даёт" in set_perms(admin, "editor", {"users": "edit"}, 400)["detail"]
    set_perms(admin, "editor", {"scan/settings": "run", "users": "view", "choices/values": "edit", "vacuum": "run"})
    assert editor.patch("/api/scan/sources/glpi", json={"enabled": False}).status_code == 403
    ok(editor.get("/api/scan/sources"))
    ok(editor.get("/api/users"))
    assert editor.post("/api/users", json={"login": "x1", "password": "secret1"}).status_code == 403
    ok(editor.get("/api/scan/names"))

    # Без своих настроек – как было: сбор GLPI / GSIT – с правкой страницы (правка включает запуск)
    set_perms(admin, "editor", {"scan/settings": "none", "users": "none", "choices/values": "none", "vacuum": "view"})
    assert ok(editor.get("/api/auth/me"))["perms"] == ROLE_PAGES["editor"]
    response = editor.post("/api/scan/sources/jabber/collect")
    assert response.status_code == 403 and "Vacuum" in response.json()["detail"]
    assert editor.post("/api/scan/sources/glpi/collect").status_code != 403


def test_admin_users_page_limited(admin, admin2):
    # Администратору можно снять правку и «Пользователей»
    assert set_perms(admin, "admin2", {"users": "view", "table": "view"})["perms"]["users"] == "view"
    ok(admin2.get("/api/users"))
    response = admin2.patch(f"/api/users/{user_id('editor')}", json={"full_name": "x"})
    assert response.status_code == 403 and "только просмотр" in response.json()["detail"]
    set_perms(admin, "admin2", {"users": "none"})
    assert admin2.get("/api/users").status_code == 403


def test_role_change_in_history(admin, editor):
    """Смена роли убирает свои уровни – в Историю «Права» (ревью этапа 70); Ctrl+Z роли это не мешает."""
    uid = user_id("editor")
    set_perms(admin, "editor", {"table": "view"})
    ok(admin.patch(f"/api/users/{uid}", json={"role": "reader"}))
    record = history(admin, "users", uid)[0]
    assert record["changes"]["perms"] == {"old": "Компьютеры: просмотр", "new": "Компьютеры: как у роли"}
    assert record["changes"]["role"]["new"] == "reader"
    assert ok(admin.post("/api/history/undo-last", json={}))["ok"]
    assert ok(editor.get("/api/auth/me"))["role"] == "editor"
    # Запись отменена целиком (видна только с отменёнными), «Права» в ней – не отменяются
    items = ok(admin.get("/api/history", params={"entity": "users", "entity_id": uid, "cancelled": True}))["items"]
    cancelled = next(item for item in items if item["id"] == record["id"])
    assert cancelled["cancelled"] and "cancelled" not in cancelled["changes"]["perms"]
    assert record["id"] not in [item["id"] for item in history(admin, "users", uid)]


def test_perm_level_errors(admin, admin2):
    assert "уровня «запуск» нет" in set_perms(admin, "admin2", {"table": "run"}, 400)["detail"]
    # Импорт – и с правкой «Компьютеров» (ревью этапа 70)
    set_perms(admin, "admin2", {"table": "view"})
    response = admin2.post("/api/import/apply", files={"file": ("x.xlsx", b"x")}, data={"confirm": "false"})
    assert response.status_code == 403 and "Компьютеры" in response.json()["detail"]


def test_two_admins_at_once(admin, admin2, monkeypatch):
    """Два администратора снимают друг другу правку «Пользователей» одновременно: без взаимной
    блокировки базы, один – успешно, второй – отказ «должен остаться» (ревью этапа 70)."""
    import threading
    import time

    import api_users

    original = api_users.keep_users_admin

    def slow(session):
        time.sleep(0.5)
        return original(session)

    monkeypatch.setattr(api_users, "keep_users_admin", slow)
    results = {}

    def run(name, client, target):
        response = client.patch(f"/api/users/{user_id(target)}", json={"perms": {"users": "view"}})
        results[name] = response.status_code

    threads = [
        threading.Thread(target=run, args=("first", admin, "admin2")),
        threading.Thread(target=run, args=("second", admin2, "admin")),
    ]
    for thread in threads:
        thread.start()
        time.sleep(0.1)
    for thread in threads:
        thread.join()
    assert sorted(results.values()) == [200, 400]


def test_users_keeper(admin, admin2):
    """Правка «Пользователей» остаётся хотя бы у одного администратора (по очереди – одновременно
    проверяет test_two_admins_at_once)."""
    session = SessionLocal()
    try:
        session.query(User).filter(User.role == "admin").update({User.perms: {"users": "view"}})
        with pytest.raises(Exception) as err:
            keep_users_admin(session)
        assert "Пользователей" in str(err.value.detail)
        session.rollback()
        session.query(User).filter(User.login == "admin2").update({User.perms: {"users": "view"}})
        keep_users_admin(session)
    finally:
        session.rollback()
        session.close()
