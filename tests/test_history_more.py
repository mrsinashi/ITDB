"""История справочников, польз. полей, оформления столбцов, пользователей (этап 19б)."""
import itertools

from conftest import https_client, ok

_numbers = itertools.count(1)


def latest(client, entity, **params):
    return ok(client.get("/api/history", params={"entity": entity, **params}))["items"][0]


def value_of(client, entity, entity_id, field, entity_key=None):
    params = {"entity": entity, "entity_id": entity_id, "field": field}
    if entity_key:
        params["entity_key"] = entity_key
    return ok(client.get("/api/history/value", params=params))


def choice(client, choice_id):
    return next(c for c in ok(client.get("/api/choices"))["items"] if c["id"] == choice_id)


def test_choice_history_and_undo(editor):
    choice_id = ok(editor.post("/api/choices", json={"field": "os", "value": "Win 10"}))["id"]
    created = latest(editor, "choices")
    assert created["changes"]["created"]["new"] == "Win 10"
    assert created["title"] == "Операционная система: Win 10"

    ok(editor.patch(f"/api/choices/{choice_id}", json={"color": "#aa0000", "bold": True}))
    record = latest(editor, "choices")
    assert set(record["changes"]) == {"color", "bold"}

    # Порядок (стрелки) в историю не пишется
    ok(editor.patch(f"/api/choices/{choice_id}", json={"sort": 5}))
    assert latest(editor, "choices")["id"] == record["id"]

    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}]}))
    item = choice(editor, choice_id)
    assert item["color"] is None and item["bold"] is False

    ok(editor.patch(f"/api/choices/{choice_id}", json={"value": "Windows 10"}))
    rename = value_of(editor, "choices", choice_id, "value")
    assert rename["title"] == "Операционная система: Windows 10"
    ok(editor.post("/api/history/revert", json={"id": rename["items"][0]["id"], "field": "value", "initial": True}))
    assert choice(editor, choice_id)["value"] == "Win 10"

    # Создание не отменяется
    response = editor.post("/api/history/cancel", json={"items": [{"id": created["id"]}]})
    assert response.status_code == 400


def test_deleted_choice_keeps_title(editor):
    choice_id = ok(editor.post("/api/choices", json={"field": "cpu", "value": "i9"}))["id"]
    ok(editor.patch(f"/api/choices/{choice_id}", json={"italic": True}))
    ok(editor.delete(f"/api/choices/{choice_id}"))

    record = latest(editor, "choices")
    assert record["changes"]["deleted"]["old"] == "i9"
    assert record["title"] == "Процессор: i9"

    # Истории удалённого — только просмотр
    data = value_of(editor, "choices", choice_id, "italic")
    assert data["kind"] == "gone" and data["title"] == "Процессор: i9"

    italic = next(i for i in ok(editor.get("/api/history", params={"entity": "choices"}))["items"]
                  if "italic" in i["changes"])
    response = editor.post("/api/history/cancel", json={"items": [{"id": italic["id"]}]})
    assert response.status_code == 404


def test_field_def_history_and_restore_from_archive(editor):
    fd_id = ok(editor.post("/api/field-defs", json={"key": "phone", "label": "Телефон"}))["id"]
    ok(editor.patch(f"/api/field-defs/{fd_id}", json={"label": "Тел. кабинета"}))
    ok(editor.post(f"/api/field-defs/{fd_id}/archive"))

    archived = latest(editor, "field_defs")
    assert archived["changes"] == {"archived": {"old": False, "new": True}}
    assert archived["title"] == "Тел. кабинета"

    # Отмена архивации — поле снова в списке
    ok(editor.post("/api/history/cancel", json={"items": [{"id": archived["id"]}]}))
    labels = [f["label"] for f in ok(editor.get("/api/field-defs"))["items"]]
    assert "Тел. кабинета" in labels


def test_column_style_history_by_key(editor):
    ok(editor.patch("/api/column-styles/os", json={"bold": True, "color": "#112233"}))
    ok(editor.patch("/api/column-styles/cpu", json={"italic": True}))

    record = latest(editor, "column_styles", entity_key="os")
    assert record["entity_key"] == "os" and record["title"] == "Операционная система"
    assert set(record["changes"]) == {"bold", "color"}

    data = value_of(editor, "column_styles", 0, "bold", entity_key="os")
    assert len(data["items"]) == 1 and data["current"] is True

    # Отмена — стиль стал пустым и удалился; у CPU не тронуто
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}]}))
    styles = {s["field"]: s for s in ok(editor.get("/api/column-styles"))["items"]}
    assert "os" not in styles and styles["cpu"]["italic"] is True

    # Восстановить — стиль снова создан
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}], "cancel": False}))
    styles = {s["field"]: s for s in ok(editor.get("/api/column-styles"))["items"]}
    assert styles["os"]["bold"] is True and styles["os"]["color"] == "#112233"


def test_users_history_admin_only(admin, editor, reader):
    login = f"hist{next(_numbers)}"
    user = ok(admin.post("/api/users", json={"login": login, "role": "reader", "password": "secret1"}))
    ok(admin.patch(f"/api/users/{user['id']}", json={"role": "editor", "password": "newpass1"}))

    record = latest(admin, "users")
    assert record["title"] == login
    assert record["changes"]["role"] == {"old": "reader", "new": "editor"}
    assert record["changes"]["password"]["new"] == "задан новый"

    # Не админ записей о пользователях не видит и не отменяет
    assert "users" not in {i["entity"] for i in ok(editor.get("/api/history", params={"limit": 5000}))["items"]}
    assert editor.post("/api/history/cancel", json={"items": [{"id": record["id"], "field": "role"}]}).status_code == 403
    assert reader.get("/api/history/value", params={"entity": "users", "entity_id": user["id"], "field": "role"}).status_code == 403

    # Смена пароля не отменяется, роль — отменяется
    assert admin.post("/api/history/cancel", json={"items": [{"id": record["id"]}]}).status_code == 400
    ok(admin.post("/api/history/cancel", json={"items": [{"id": record["id"], "field": "role"}]}))
    row = next(u for u in ok(admin.get("/api/users")) if u["id"] == user["id"])
    assert row["role"] == "reader"


def test_admin_cannot_undo_own_role(admin):
    login = f"hist{next(_numbers)}"
    other = ok(admin.post("/api/users", json={"login": login, "role": "admin", "password": "secret1"}))
    me = ok(admin.get("/api/auth/me"))

    # Другой админ понизил нашего — запись о нас; отменить её сами мы не можем
    second = https_client()
    ok(second.post("/api/auth/login", json={"login": login, "password": "secret1"}))
    ok(second.patch(f"/api/users/{me['id']}", json={"role": "editor"}))
    record = latest(second, "users")

    response = admin.post("/api/history/cancel", json={"items": [{"id": record["id"]}]})
    assert response.status_code == 403   # мы уже не админ

    ok(second.post("/api/history/cancel", json={"items": [{"id": record["id"]}]}))
    assert ok(admin.get("/api/auth/me"))["role"] == "admin"
    assert other["role"] == "admin"


def test_own_password_change_logged(admin):
    login = f"hist{next(_numbers)}"
    ok(admin.post("/api/users", json={"login": login, "role": "reader", "password": "secret1"}))

    client = https_client()
    ok(client.post("/api/auth/login", json={"login": login, "password": "secret1"}))
    ok(client.post("/api/auth/me/password", json={"current": "secret1", "new": "newpass1"}))

    record = latest(admin, "users")
    assert record["user_name"] == login and record["title"] == login
    assert set(record["changes"]) == {"password"}
