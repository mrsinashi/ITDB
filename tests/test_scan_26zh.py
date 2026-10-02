"""Этап 26ж: список пользователей Jabber (кто удалён, кто давно не подключался),
VACUUM только по IP, номера записей в столбцы GLPI / GSIT, «это материнская
плата», столбцы «Агент», «GSIT», «Мат. плата»."""
from datetime import datetime, timedelta

import scan_jabber as sj
from conftest import get_row, ok
from scan_values import Names, route_values
from test_scan_collect import ETH, Glpi, add_pc, glpi_url, pc, reset_glpi, secret_key, setup_source  # noqa: F401
from test_scan_collect import collect as glpi_collect
from test_scan_jabber import DOMAIN, Ejabberd, jabber_url, reset_jabber, setup_jabber, users_of  # noqa: F401
from test_scan_jabber import collect as jabber_collect

NOW = datetime.now()


def ago(days):
    return (NOW - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")


def diffs_data(client):
    data = ok(client.get("/api/scan/diffs"))
    return data, {(d["computer_id"], d["field"]): d for d in data["items"]}


def set_vacuum(client, computer_id, logins):
    ok(client.patch(f"/api/computers/{computer_id}", json={"vacuum": logins, "_version": get_row(client, computer_id)["version"]}))


# ---------- Список пользователей ejabberd ----------


def test_users_page():
    # Страница users/1-1000/ ejabberd 14.12 (прислал пользователь 02.10)
    html = ("<table><thead><tr><td>Пользователь</td><td>Офлайновые сообщения</td><td>Последнее подключение</td></tr></thead><tbody>"
            "<tr><td><a href='../../user/%D0%B5%D1%80%D0%BC%D0%BE%D0%BB%D0%B0%D0%B5%D0%B2_%D1%81.%D0%B0./'>ермолаев_с.а.@jabber.lan</a></td>"
            "<td><a href='../../user/ермолаев_с.а./queue/'>0</a></td><td>Подключён</td></tr>"
            "<tr><td><a href='../../user/%D0%BA113_%D1%83%D0%B7%D0%B8/'>к113_узи@jabber.lan</a></td>"
            "<td><a href='../../user/к113_узи/queue/'>59</a></td><td>2023-01-20 15:45:48</td></tr>"
            "<tr><td><a href='../../user/ivanov/'>ivanov@jabber.lan</a></td><td><a href='../../user/ivanov/queue/'>13</a></td><td>Никогда</td></tr>"
            "</tbody></table>")
    users = sj.users_page(html)
    assert list(users) == ["ермолаев_с.а.", "к113_узи", "ivanov"]
    assert users["ермолаев_с.а."] == (True, None)
    online, last = users["к113_узи"]
    assert not online and (last.year, last.month, last.day, last.hour, last.second) == (2023, 1, 20, 15, 48) and last.tzinfo
    assert users["ivanov"] == (False, None)
    assert sj.last_login("Online") == (True, None) and sj.last_login("Never") == (False, None)


def test_users_list_grows(admin, jabber_url, monkeypatch):
    """Спрашиваем N, потом на шаг больше — пока пользователей прибавляется."""
    monkeypatch.setattr(sj, "USERS_FIRST", 2)
    monkeypatch.setattr(sj, "USERS_STEP", 2)
    Ejabberd.users = {f"user{i}": "Никогда" for i in range(5)}
    setup_jabber(admin, jabber_url)
    run = jabber_collect(admin)
    assert run["status"] == "ok" and run["stats"]["total"] == 5
    assert Ejabberd.asked == ["users/1-2/", "users/1-4/", "users/1-6/", "users/1-8/"]


def test_users_marks_and_stale(admin, editor, reader, room, jabber_url):
    loc = room["room"]
    first = add_pc(editor, loc, "pc-1", ip="10.0.2.11")
    set_vacuum(editor, first, "ivanov\nold_user\nnever\nfresh\nghost\ntypo")
    second = add_pc(editor, loc, "pc-2", ip="10.0.2.12")
    set_vacuum(editor, second, "stale2")

    Ejabberd.users = {
        "ivanov": "Подключён", "old_user": ago(40), "never": "Никогда", "fresh": ago(2), "stale2": ago(8),
        "petrova": "Подключён", "lonely": ago(1),
    }
    Ejabberd.online = {"ivanov": [("Vacuum-IM", "10.0.2.11")], "petrova": [("Vacuum-IM", "10.0.2.11")]}
    Ejabberd.groups = {"ИТ": [f"{u}@{DOMAIN}" for u in ("ivanov", "old_user", "never", "fresh", "stale2", "petrova", "ghost")]}
    setup_jabber(admin, jabber_url)
    run = jabber_collect(admin)
    assert run["status"] == "ok" and run["message"] is None
    assert (run["stats"]["total"], run["stats"]["online"], run["stats"]["gone"], run["stats"]["no_group"]) == (7, 2, 1, 1)

    # Страница «Vacuum»: удалённый, но в группе — убрать из группы; без группы — пометка
    data = ok(editor.get("/api/scan/jabber"))
    users = {u["login"]: u for u in data["users"]}
    assert data["listed"] and set(users) == {"ivanov", "old_user", "never", "fresh", "stale2", "petrova", "lonely", "ghost"}
    assert users["ghost"]["gone"] and not users["ghost"]["no_group"] and not users["ghost"]["online"]
    assert users["lonely"]["no_group"] and not users["lonely"]["gone"]
    assert users["never"]["last_login_at"] is None and users["old_user"]["last_login_at"].startswith(ago(40)[:10])
    assert users["ivanov"]["online"] and users["ivanov"]["addresses"][0]["hosts"][0]["hostname"] == "pc-1"

    # Таблица: из ячейки сканер никого не убирает (этап 26з) — кто давно не подключался
    # и кого нет, только помечаются; новый с IP ПК — добавить
    data, diffs = diffs_data(reader)
    d = diffs[(first, "vacuum")]
    assert d["table"] == "fresh\nghost\nivanov\nnever\nold_user\ntypo"
    assert d["proposed"] == "fresh\nghost\nivanov\nnever\nold_user\npetrova\ntypo"
    assert "petrova" in d["note"] and "old_user" not in d["note"]
    assert (second, "vacuum") not in diffs
    assert data["vacuum_missing"] == ["ghost", "typo"]
    # Сколько дней не подключался; None — никогда
    assert data["vacuum_stale"] == {"never": None, "old_user": 40, "stale2": 8}

    # Срок — в настройках подключения («Актуальны»)
    ok(admin.patch("/api/scan/sources/jabber", json={"fresh_days": 30}))
    assert diffs_data(reader)[0]["vacuum_stale"] == {"never": None, "old_user": 40}
    ok(admin.patch("/api/scan/sources/jabber", json={"fresh_days": 7}))

    # Отклонить — не предлагается
    ok(editor.post("/api/scan/diffs/reject", json={"items": [{"computer_id": first, "field": "vacuum", "raw": diffs[(first, "vacuum")]["raw"]}]}))
    assert (first, "vacuum") not in diffs_data(editor)[1]

    # Пользователя удалили из ejabberd и из групп — на странице его больше нет, в таблице — «нет в Jabber»
    del Ejabberd.users["fresh"]
    Ejabberd.groups = {"ИТ": [f"ivanov@{DOMAIN}"]}
    assert jabber_collect(admin)["status"] == "ok"
    assert "fresh" not in users_of(editor) and "ghost" not in users_of(editor)
    assert "fresh" in diffs_data(editor)[0]["vacuum_missing"]

    # Список не получен — прежние пометки остаются
    Ejabberd.users = None
    run = jabber_collect(admin)
    assert run["status"] == "ok" and "Список пользователей не получен" in run["message"]
    assert "fresh" in diffs_data(editor)[0]["vacuum_missing"]


# ---------- Номера записей GLPI / GSIT ----------


def test_record_ids(admin, editor, room, glpi_url):
    loc = room["room"]
    first = add_pc(editor, loc, "pc-1", mac="D8:BB:C1:00:00:01")
    by_id = add_pc(editor, loc, "pc-2", gsit_id="22")
    Glpi.computers = {
        11: pc("pc-1", ports=[(ETH, "d8:bb:c1:00:00:01", [])]),
        22: pc("pc-2", ports=[(ETH, "d8:bb:c1:00:00:02", [])]),
    }
    setup_source(admin, glpi_url, "glpi")
    setup_source(admin, glpi_url, "gsit")
    assert glpi_collect(admin, "glpi")["status"] == "ok"
    assert glpi_collect(admin, "gsit")["status"] == "ok"

    data, diffs = diffs_data(editor)
    assert data["links"] == {
        "glpi_id": f"{glpi_url}/front/computer.form.php?id=", "gsit_id": f"{glpi_url}/front/computer.form.php?id=",
    }
    # Сопоставлен по MAC — номера записей предлагаются в столбцы GLPI и GSIT
    d = diffs[(first, "glpi_id")]
    assert (d["kind"], d["table"], d["proposed"], d["sources"][0]["source"]) == ("fill", "", "11", "glpi")
    assert diffs[(first, "gsit_id")]["proposed"] == "11" and diffs[(first, "gsit_id")]["sources"][0]["source"] == "gsit"
    # Номер GSIT в таблице — запись GSIT сопоставлена по нему (а GLPI с таким же номером — нет)
    records = {r["source_id"]: r for r in ok(admin.get("/api/scan/records", params={"source": "gsit"}))["records"]}
    assert (records[22]["state"], records[22]["by"], records[22]["computer_id"]) == ("key", ["id"], by_id)
    records = {r["source_id"]: r for r in ok(admin.get("/api/scan/records", params={"source": "glpi"}))["records"]}
    assert records[22]["state"] == "name"
    assert (by_id, "gsit_id") not in diffs

    result = ok(editor.post("/api/scan/diffs/accept", json={"items": [
        {"computer_id": first, "field": "glpi_id", "value": "11", "table": "", "source": "GLPI №11"},
        {"computer_id": first, "field": "gsit_id", "value": "11", "table": "", "source": "GSIT №11"},
    ]}))
    assert result["accepted"] == 2
    row = get_row(editor, first)
    assert (row["glpi_id"], row["gsit_id"]) == ("11", "11")
    _, diffs = diffs_data(editor)
    assert (first, "glpi_id") not in diffs and (first, "gsit_id") not in diffs


def test_stale_record_id(admin, editor, room, glpi_url):
    """Номер в таблице указывает на запись, которой в источнике уже нет (агент
    поставили заново) — не конфликт: предлагается новый номер."""
    loc = room["room"]
    moved = add_pc(editor, loc, "pc-1", mac="D8:BB:C1:00:00:01", glpi_id="999")
    other = add_pc(editor, loc, "pc-2", mac="D8:BB:C1:00:00:02", glpi_id="33")
    Glpi.computers = {
        11: pc("pc-1", ports=[(ETH, "d8:bb:c1:00:00:01", [])]),
        22: pc("pc-2", ports=[(ETH, "d8:bb:c1:00:00:02", [])]),
        33: pc("pc-3", ports=[(ETH, "d8:bb:c1:00:00:03", [])]),
    }
    setup_source(admin, glpi_url)
    assert glpi_collect(admin)["status"] == "ok"
    records = {r["source_id"]: r for r in ok(admin.get("/api/scan/records", params={"source": "glpi"}))["records"]}
    assert (records[11]["state"], records[11]["computer_id"]) == ("key", moved)
    d = diffs_data(editor)[1][(moved, "glpi_id")]
    assert (d["kind"], d["table"], d["proposed"]) == ("diff", "999", "11")
    # Номер указывает на другую запись, которая есть, — противоречие
    assert records[22]["state"] == "conflict" and "GLPI ID" in records[22]["note"]
    assert (other, "glpi_id") not in diffs_data(editor)[1]


def test_columns_agent_and_ids(reader):
    columns = {c["key"]: c for c in ok(reader.get("/api/columns"))["columns"]}
    assert (columns["gsit"]["short"], columns["gsit"]["extra_key"]) == ("Агент", "GSIT")
    assert (columns["gsit_id"]["short"], columns["gsit_id"]["title"], columns["gsit_id"]["dup"]) == ("GSIT", "GSIT ID", True)
    assert columns["glpi_id"]["short"] == "GLPI" and not columns["gsit_id"]["card_always"]
    assert columns["motherboard"]["title"] == "Материнская плата"
    keys = list(columns)
    assert keys.index("motherboard") == keys.index("model") + 1 and keys.index("gsit_id") == keys.index("glpi_id") + 1


# ---------- «Это материнская плата» ----------


def test_route_values():
    names = Names([{"field": "model", "source": "ASUS PRIME H310M-K", "table": "H310M-K", "kind": "board"}])
    assert route_values({"model": "Asus  Prime H310M-K", "os": "Win 10"}, names.boards) == {
        "model": None, "motherboard": "H310M-K", "os": "Win 10",
    }
    assert route_values({"model": "HP ProDesk 400"}, names.boards) == {"model": "HP ProDesk 400"}
    # «Плата» — не «разное» и не «одно и то же» для модели
    assert names.compare("model", "ASUS PRIME H310M-K", "ЕГИСЗ")["mark"] == "≠"


def test_board(admin, editor, reader, room, glpi_url):
    loc = room["room"]
    first = add_pc(editor, loc, "pc-1", mac="D8:BB:C1:00:00:01", model="ASUS PRIME H310M-K")
    second = add_pc(editor, loc, "pc-2", mac="D8:BB:C1:00:00:02", model="ЕГИСЗ")
    Glpi.computers = {
        1: pc("pc-1", maker="ASUSTeK COMPUTER INC.", model="PRIME H310M-K", ports=[(ETH, "d8:bb:c1:00:00:01", [])]),
        2: pc("pc-2", maker="ASUSTeK COMPUTER INC.", model="PRIME H310M-K", ports=[(ETH, "d8:bb:c1:00:00:02", [])]),
    }
    setup_source(admin, glpi_url)
    assert glpi_collect(admin)["status"] == "ok"
    _, diffs = diffs_data(editor)
    d = diffs[(second, "model")]
    assert (d["proposed"], d["raw"]) == ("ASUS PRIME H310M-K", "ASUS PRIME H310M-K")

    body = {"computer_id": second, "raw": d["raw"], "value": d["proposed"], "source": "GLPI №2"}
    assert reader.post("/api/scan/diffs/board", json=body).status_code == 403
    assert editor.post("/api/scan/diffs/board", json=dict(body, value=" ")).status_code == 400
    ok(editor.post("/api/scan/diffs/board", json=body))

    # Этому ПК — в «Мат. плату» (модель «ЕГИСЗ» остаётся), в Истории — пометка источника
    row = get_row(editor, second)
    assert (row["motherboard"], row["model"]) == ("ASUS PRIME H310M-K", "ЕГИСЗ")
    history = ok(editor.get("/api/history", params={"entity": "computers", "entity_id": second}))["items"]
    assert history[0]["changes"]["motherboard"]["scan"] == "GLPI №2"
    # Закреплено за названием: у других ПК оно предлагается в «Мат. плату», а не в «Модель»
    _, diffs = diffs_data(editor)
    assert (second, "model") not in diffs and (first, "model") not in diffs
    d = diffs[(first, "motherboard")]
    assert (d["kind"], d["proposed"], d["name_field"]) == ("fill", "ASUS PRIME H310M-K", True)
    names = ok(admin.get("/api/scan/names"))
    assert [(n["field"], n["source"], n["table"], n["kind"]) for n in names if n["origin"] == "manual"] == [
        ("model", "ASUS PRIME H310M-K", "ASUS PRIME H310M-K", "board"),
    ]
    compare = {c["field"]: c for c in ok(admin.get("/api/scan/records", params={"source": "glpi"}))["records"][0]["compare"]}
    assert compare["motherboard"]["source"] == "ASUS PRIME H310M-K" and not compare["model"]["raw"]

    # В «Модели» записана эта же плата — переносится
    ok(editor.post("/api/scan/diffs/board", json=dict(body, computer_id=first)))
    row = get_row(editor, first)
    assert (row["motherboard"], row["model"]) == ("ASUS PRIME H310M-K", None)

    # Плата — только у модели; удалить соответствие — снова предлагается как модель
    assert editor.post("/api/scan/names", json={"field": "os", "source": "a", "table": "b", "kind": "board"}).status_code == 400
    alias = [n for n in ok(admin.get("/api/scan/names")) if n["kind"] == "board"][0]
    ok(admin.delete(f"/api/scan/names/{alias['id']}"))
    assert diffs_data(editor)[1][(first, "model")]["proposed"] == "ASUS PRIME H310M-K"


def test_own_value_is_same(admin, editor, room, glpi_url):
    """«Своё» в карточке блочка: название — соответствие «одно и то же» для всех ПК."""
    loc = room["room"]
    first = add_pc(editor, loc, "pc-1", mac="D8:BB:C1:00:00:01", os="Astra")
    second = add_pc(editor, loc, "pc-2", mac="D8:BB:C1:00:00:02")
    Glpi.computers = {
        1: pc("pc-1", os_name="Microsoft Windows 11 Pro", ports=[(ETH, "d8:bb:c1:00:00:01", [])]),
        2: pc("pc-2", os_name="Microsoft Windows 11 Pro", ports=[(ETH, "d8:bb:c1:00:00:02", [])]),
    }
    setup_source(admin, glpi_url)
    assert glpi_collect(admin)["status"] == "ok"
    d = diffs_data(editor)[1][(first, "os")]
    ok(editor.patch(f"/api/computers/{first}", json={"os": "W11", "_version": get_row(editor, first)["version"]}))
    ok(editor.post("/api/scan/names", json={"field": "os", "source": d["raw"], "table": "W11", "kind": "same"}))
    _, diffs = diffs_data(editor)
    assert (first, "os") not in diffs and diffs[(second, "os")]["proposed"] == "W11"


def test_accent_header_vacuum(editor):
    prefs = ok(editor.patch("/api/auth/me/prefs", json={"accent_headers": {"vacuum": False}}))["prefs"]
    assert prefs["accent_headers"]["vacuum"] is False
