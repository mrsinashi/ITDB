"""Общая подготовка API-тестов.

Тесты работают с ОТДЕЛЬНОЙ базой из TEST_DATABASE_URL: перед запуском все таблицы
в ней удаляются и создаются заново миграциями, перед каждым тестом – очищаются.
Рабочую базу (DATABASE_URL) тесты не трогают и отказываются запускаться, если
адреса совпадают или в имени тестовой базы нет «test».
"""
import os
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parent.parent


def read_env_file():
    """Переменные из .env в корне проекта: тестам не нужен `set -a; . ./.env`.
    Уже заданные в окружении не перезаписываются."""
    path = ROOT / ".env"

    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()

        if key.startswith("export "):
            key = key[len("export "):].strip()

        value = value.strip().strip("\"'")

        if key and key not in os.environ:
            os.environ[key] = value


read_env_file()

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

if not TEST_DATABASE_URL:
    pytest.exit(
        "Не задан TEST_DATABASE_URL. Добавь в файл .env в корне проекта отдельной строкой:\n"
        "TEST_DATABASE_URL=postgresql+psycopg://itdb:ПАРОЛЬ@localhost/itdb_test\n"
        "(см. README, «Тесты»).",
        returncode=4,
    )

if TEST_DATABASE_URL == os.environ.get("DATABASE_URL"):
    pytest.exit("TEST_DATABASE_URL совпадает с рабочей DATABASE_URL.", returncode=4)

if "test" not in (make_url(TEST_DATABASE_URL).database or ""):
    pytest.exit(
        "В имени тестовой базы должно быть «test» (например, itdb_test): "
        "тесты стирают в ней все данные.",
        returncode=4,
    )

# Бэкенд читает DATABASE_URL при импорте – подменяем до импорта приложения
os.environ["DATABASE_URL"] = TEST_DATABASE_URL

from fastapi.testclient import TestClient  # noqa: E402

import api_auth  # noqa: E402
from auth import hash_password  # noqa: E402
from db import SessionLocal, engine  # noqa: E402
from main import app  # noqa: E402
from models import User  # noqa: E402

PASSWORDS = {"admin": "admin-pass", "editor": "editor-pass", "reader": "reader-pass"}

# Эти таблицы между тестами не чистятся: пользователи и их сессии живут всю сессию
KEEP_TABLES = {"alembic_version", "users", "sessions", "scan_marks"}


def create_schema():
    """Пустая база → все миграции → пользователи трёх ролей."""
    from alembic import command
    from alembic.config import Config

    admin_engine = create_engine(TEST_DATABASE_URL)

    with admin_engine.begin() as conn:
        tables = conn.execute(
            text("select tablename from pg_tables where schemaname = 'public'")
        ).scalars().all()

        for table in tables:
            conn.execute(text(f'drop table if exists "{table}" cascade'))

    admin_engine.dispose()

    config = Config(str(ROOT / "alembic.ini"))
    command.upgrade(config, "head")

    session = SessionLocal()

    try:
        for role, password in PASSWORDS.items():
            session.add(User(login=role, password_hash=hash_password(password), role=role))

        session.commit()
    finally:
        session.close()


@pytest.fixture(scope="session", autouse=True)
def database():
    create_schema()
    yield
    engine.dispose()


@pytest.fixture(autouse=True)
def clean_data(database):
    """Перед каждым тестом – пустые данные (узлы, ПК, история, справочники…)."""
    with engine.begin() as conn:
        tables = conn.execute(
            text("select tablename from pg_tables where schemaname = 'public'")
        ).scalars().all()

        tables = [f'"{table}"' for table in tables if table not in KEEP_TABLES]

        if tables:
            conn.execute(text(f"truncate {', '.join(tables)} restart identity cascade"))

    api_auth.login_attempts.clear()
    yield


def https_client(**kwargs):
    """Клиент по https: программа (с этапа 22) отвечает только по https,
    кроме запросов с самого сервера."""
    return TestClient(app, base_url="https://testserver", **kwargs)


def login(role):
    client = https_client()
    response = client.post(
        "/api/auth/login",
        json={"login": role, "password": PASSWORDS[role]},
    )
    assert response.status_code == 200, response.text
    return client


@pytest.fixture(scope="session")
def admin(database):
    return login("admin")


@pytest.fixture(scope="session")
def editor(database):
    return login("editor")


@pytest.fixture(scope="session")
def reader(database):
    return login("reader")


@pytest.fixture
def anon(database):
    return https_client()


# ---------- Помощники: создать узлы и ПК через API ----------


def ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def add_location(client, kind, name=None, parent_id=None, code=None):
    payload = {"kind": kind, "name": name, "parent_id": parent_id, "code": code}
    return ok(client.post("/api/locations", json=payload))["id"]


@pytest.fixture
def room(editor):
    """Адрес → отделение → кабинет 201 «Ординаторская». Возвращает id узлов."""
    building = add_location(editor, "building", "ул. Ленина, 1")
    department = add_location(editor, "department", "Терапия", building)
    room_id = add_location(editor, "room", "Ординаторская", department, code="201")
    return {"building": building, "department": department, "room": room_id}


def add_computer(client, location_id, **fields):
    payload = {"location_id": location_id}
    payload.update(fields)
    return ok(client.post("/api/computers", json=payload))["id"]


def get_row(client, computer_id, archived="all"):
    rows = ok(client.get("/api/computers", params={"archived": archived}))["rows"]
    return next((row for row in rows if row["id"] == computer_id), None)
