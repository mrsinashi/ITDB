"""Этап 51: надёжность – файлы интерфейса без кеша, «кто в сети» не ждёт зависший ejabberd,
сбор не держит транзакцию во время сетевых запросов, истёкшие входы удаляются, индексы Истории."""
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

import api_scan_jabber
import db
import scan_collect
from conftest import login, ok
from db import SessionLocal, engine
from fakes import setup_jabber
from models import User, UserSession


def test_static_files_not_cached(anon):
    response = anon.get("/js/util.js")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-cache"

    # Файл не менялся – короткий ответ 304, и у него тоже «спрашивать каждый раз»
    again = anon.get("/js/util.js", headers={"If-None-Match": response.headers["etag"]})
    assert again.status_code == 304 and again.headers["cache-control"] == "no-cache"
    assert anon.get("/").headers["cache-control"] == "no-cache"


def test_online_check_does_not_wait(admin, editor, reader, jabber_url, monkeypatch):
    setup_jabber(admin, jabber_url)
    started, release = threading.Event(), threading.Event()

    def slow_online(params):
        started.set()
        release.wait(10)
        return {"ivanov"}

    monkeypatch.setattr(api_scan_jabber.scan_jabber, "online_now", slow_online)
    first = {}
    thread = threading.Thread(target=lambda: first.update(ok(reader.get("/api/scan/jabber/online"))))
    thread.start()

    try:
        assert started.wait(5)

        # Первый ждёт ejabberd – второй отвечает сразу: проверки ещё не было, спросить чуть позже
        moment = time.monotonic()
        second = ok(editor.get("/api/scan/jabber/online"))
        assert time.monotonic() - moment < 2
        assert second["enabled"] and second["online"] is None and second["next_in"] == api_scan_jabber.CLICK_SECONDS
    finally:
        release.set()
        thread.join(10)

    assert first["online"] == ["ivanov"] and first["next_in"] >= 110

    # Проверка 30 с назад, оба кликнули по строке: проверяет первый, второй сразу получает
    # прежний итог и спросит снова чуть позже (а не через плановые 2 минуты)
    started.clear()
    release.clear()
    api_scan_jabber._online["when"] -= 30
    thread = threading.Thread(target=lambda: ok(reader.get("/api/scan/jabber/online?click=1")))
    thread.start()

    try:
        assert started.wait(5)
        moment = time.monotonic()
        busy = ok(editor.get("/api/scan/jabber/online?click=1"))
        assert time.monotonic() - moment < 2
        assert busy["online"] == ["ivanov"] and busy["next_in"] == api_scan_jabber.CLICK_SECONDS
    finally:
        release.set()
        thread.join(10)

    # Проверять не пора – обычный ответ: следующая проверка по плану
    assert 80 <= ok(editor.get("/api/scan/jabber/online"))["next_in"] <= 120


def test_collect_holds_no_transaction(admin, jabber_url, monkeypatch):
    setup_jabber(admin, jabber_url)
    seen = {}
    gate = threading.Event()

    def fake_collect(params, fresh_days, progress):
        gate.wait(5)   # сессия теста уже закрыта
        # Транзакции, открытые до сетевой части и ждущие её конца
        with engine.connect() as conn:
            seen["idle"] = conn.execute(text(
                "select count(*) from pg_stat_activity where datname = current_database()"
                " and state like 'idle in transaction%' and pid <> pg_backend_pid()"
            )).scalar()
        progress(1, 1)
        return {"items": [], "stats": {}, "warnings": [], "groups_ok": True, "users_ok": False}

    monkeypatch.setitem(scan_collect.COLLECTORS, "jabber", fake_collect)
    session = SessionLocal()

    try:
        run_id = scan_collect.start(session, "jabber", "тест").id
    finally:
        session.close()

    gate.set()

    for thread in threading.enumerate():
        if thread.name == "scan-jabber":
            thread.join(10)

    assert seen["idle"] == 0
    assert ok(admin.get(f"/api/scan/runs/{run_id}"))["status"] == "ok"


def test_expired_sessions_removed_on_login(database):
    session = SessionLocal()

    try:
        user_id = session.query(User.id).filter(User.login == "reader").scalar()
        session.add(UserSession(token="old-51", user_id=user_id, expires_at=datetime.now(timezone.utc) - timedelta(days=1)))
        session.commit()

        login("reader")
        session.expire_all()
        assert session.query(UserSession).filter(UserSession.token == "old-51").count() == 0
        assert session.query(UserSession).filter(UserSession.user_id == user_id).count() >= 1
    finally:
        session.close()


def test_history_indexes_and_pool(database):
    with engine.connect() as conn:
        names = set(conn.execute(text("select indexname from pg_indexes where tablename = 'history'")).scalars())

    assert {"ix_history_entity", "ix_history_at"} <= names
    # Соединение из пула проверяется перед выдачей (после перезапуска PostgreSQL)
    assert db.engine.pool._pre_ping
