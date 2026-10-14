"""Jabber (VACUUM, этап 26д): сбор пользователей из веб-админки ejabberd 14.12 и
вкладка «Vacuum». Веб-админка изображается маленьким HTTP-сервером в этом же
процессе (fakes.py): страницы – как у ejabberd 14.12 (прислал пользователь 30.09)."""
import scan_jabber as sj
from conftest import add_computer, get_row, ok
from fakes import DOMAIN, Ejabberd, collect, setup_jabber


def users_of(client):
    return {u["login"]: u for u in ok(client.get("/api/scan/jabber"))["users"]}


def test_parse_pages():
    html = ("<input type='checkbox' name='selected' value='Регистратура &amp; Приём'/>"
            "<input type='checkbox' name=\"selected\" value=\"ИТ\"/><input type='text' name='namenew' value=''/>")
    assert sj.roster_groups(html) == ["Регистратура & Приём", "ИТ"]
    title, members = sj.group_page("<input type='text' name='name' value='ИТ'/><textarea name='members'>a@x\nb@x\n\n</textarea>"
                                   "<textarea name='dispgroups'>ИТ</textarea>")
    assert (title, members) == ("ИТ", ["a@x", "b@x"])
    assert sj.login_of("ivanov@jabber.lan", "jabber.lan") == "ivanov"
    assert sj.login_of("Petrov@Jabber.LAN/Vacuum", "jabber.lan") == "Petrov"
    assert sj.login_of("guest@other.lan", "jabber.lan") == "guest@other.lan"
    assert sj.login_of("@all@", "jabber.lan") is None
    assert sj.user_resources(
        "<ul><li>Vacuum-IM (plain://192.168.99.231:10394#ejabberd@localhost)</li>"
        "<li>Psi+ (tls://::ffff:10.0.0.5:5222)</li><li>web (http_bind://[::1]:5280)</li></ul>"
    ) == [{"client": "Vacuum-IM", "ip": "192.168.99.231"}, {"client": "Psi+", "ip": "10.0.0.5"}, {"client": "web", "ip": None}]


def test_collect_and_tab(admin, editor, reader, room, jabber_url):
    loc = room["room"]
    pc1 = add_computer(editor, loc, hostname="ter-201-1", ip="10.0.2.11")
    ok(editor.patch(f"/api/computers/{pc1}", json={"vacuum": "ivanov", "_version": get_row(editor, pc1)["version"]}))
    add_computer(editor, loc, hostname="ter-201-2", ip="10.0.2.12")

    Ejabberd.groups = {"Терапия": [f"ivanov@{DOMAIN}", f"petrova@{DOMAIN}", "@all@"], "ИТ": [f"petrova@{DOMAIN}"]}
    Ejabberd.online = {"ivanov": [("Vacuum-IM", "10.0.2.11")], "petrova": [("Vacuum-IM", "10.0.2.12"), ("Vacuum-IM", "10.9.9.9")]}
    setup_jabber(admin, jabber_url)

    run = collect(admin, "jabber")
    assert run["status"] == "ok", run
    assert (run["stats"]["total"], run["stats"]["online"], run["stats"]["groups"]) == (2, 2, 2)

    users = users_of(editor)
    assert users["ivanov"]["groups"] == ["Терапия"] and users["ivanov"]["online"]
    assert users["petrova"]["groups"] == ["Терапия", "ИТ"]
    host = users["ivanov"]["addresses"][0]["hosts"][0]
    assert (host["hostname"], users["ivanov"]["addresses"][0]["client"]) == ("ter-201-1", "Vacuum-IM")
    addresses = users["petrova"]["addresses"]
    assert [a["ip"] for a in addresses] == ["10.0.2.12", "10.9.9.9"]
    assert addresses[0]["hosts"][0]["hostname"] == "ter-201-2" and addresses[1]["hosts"] == []
    # Списка пользователей у этой веб-админки нет – пометок нет, в итоге – предупреждение
    assert "Список пользователей не получен" in run["message"]
    assert not users["ivanov"]["gone"] and not users["ivanov"]["no_group"]

    # Ушёл из сети – остаются последний IP и время; пропал из групп – без групп
    seen = users["ivanov"]["last_seen_at"]
    Ejabberd.online = {"petrova": [("Vacuum-IM", "10.0.2.12")]}
    Ejabberd.groups = {"ИТ": [f"petrova@{DOMAIN}"]}
    assert collect(admin, "jabber")["status"] == "ok"
    users = users_of(admin)
    ivanov = users["ivanov"]
    assert not ivanov["online"] and ivanov["groups"] == [] and ivanov["last_seen_at"] == seen
    assert [a["ip"] for a in ivanov["addresses"]] == ["10.0.2.11"]
    assert users["petrova"]["groups"] == ["ИТ"]

    # Группы не получены – прежние остаются, в итоге сбора – предупреждение
    Ejabberd.roster_fails = True
    run = collect(admin, "jabber")
    assert run["status"] == "ok" and "Группы не получены" in run["message"]
    assert users_of(admin)["petrova"]["groups"] == ["ИТ"]

    # Смотреть – редактор и администратор; собирать – администратор
    assert reader.get("/api/scan/jabber").status_code == 403
    assert editor.post("/api/scan/sources/jabber/collect").status_code == 403
    data = ok(editor.get("/api/scan/jabber"))
    assert data["enabled"] and data["configured"] and data["last_run"]["source"] == "jabber"


def test_collect_errors(admin, jabber_url):
    ok(admin.patch("/api/scan/sources/jabber", json={
        "url": f"{jabber_url}/admin/server/{DOMAIN}/", "login": "admin", "password": "wrong", "enabled": True,
    }))
    run = collect(admin, "jabber")
    assert run["status"] == "error" and "не пустил" in run["message"]
    assert ok(admin.get("/api/scan/jabber"))["users"] == []
