"""История: порции с точными счётчиками — всего и по дням."""
from datetime import datetime, timedelta, timezone

from conftest import add_computer, ok
from db import SessionLocal
from models import History


def add_history(count, at):
    session = SessionLocal()
    for number in range(count):
        session.add(History(entity="computers", entity_id=0, user_name="t", at=at, changes={"note": {"old": None, "new": str(number)}}))
    session.commit()
    session.close()


def test_history_pages_with_exact_counts(reader):
    today = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
    add_history(150, today)
    add_history(100, today - timedelta(days=1))

    first = ok(reader.get("/api/history", params={"tz": "UTC"}))
    assert len(first["items"]) == 200
    assert first["total"] == 250
    assert first["days"] == {
        today.strftime("%d.%m.%Y"): 150,
        (today - timedelta(days=1)).strftime("%d.%m.%Y"): 100,
    }

    rest = ok(reader.get("/api/history", params={"offset": 200, "limit": 200}))
    assert len(rest["items"]) == 50
    ids = {item["id"] for item in first["items"]} | {item["id"] for item in rest["items"]}
    assert len(ids) == 250


def test_history_days_by_time_zone(reader):
    # 20:00 UTC — в Иркутске (UTC+8) уже следующий день
    at = datetime(2026, 9, 27, 20, 0, tzinfo=timezone.utc)
    add_history(3, at)

    assert ok(reader.get("/api/history", params={"tz": "UTC"}))["days"] == {"27.09.2026": 3}
    assert ok(reader.get("/api/history", params={"tz": "Asia/Irkutsk"}))["days"] == {"28.09.2026": 3}
    # Неизвестный пояс — как UTC, без ошибки
    assert ok(reader.get("/api/history", params={"tz": "Нет/Такого"}))["days"] == {"27.09.2026": 3}


def test_history_real_changes_counted(editor, room):
    computer_id = add_computer(editor, room["room"], hostname="pc-1")
    ok(editor.patch(f"/api/computers/{computer_id}", json={"note": "x"}))

    data = ok(editor.get("/api/history"))
    # узлы дерева (адрес, отделение, кабинет) + «Создан» + правка
    assert data["total"] == len(data["items"]) == sum(data["days"].values())
