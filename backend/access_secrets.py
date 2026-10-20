"""Столбец «Доступ» – логин и пароль у принтера (от веб-страницы, этап 45) и у ПК (этап 69).

Хранятся зашифрованными ключом ITDB_SECRET_KEY (secret_box.py) в JSONB {"login", "password"}:
у принтера – web_secrets, у ПК – secrets. В таблице – только задан ли. Показать можно только
по логину и паролю администратора ITDB – кто бы ни смотрел; сам администратор вводит свой
пароль. В Историю (web_login / web_password) – без значений и без отмены; показ не пишется.
"""
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy import func

from auth import verify_password
from history_log import PASSWORD_SET
from models import User
from secret_box import decrypt, encrypt

SECRET_FIELDS = ("login", "password")
SECRET_REMOVED = "удалён"


class SecretsUpdate(BaseModel):
    login: Optional[str] = None      # None – не менять, "" – удалить
    password: Optional[str] = None


class AdminCheck(BaseModel):
    login: Optional[str] = None     # пусто – свой пароль (этап 45: администратору логин не нужен)
    password: str


def has_secrets(secrets):
    return any((secrets or {}).get(key) for key in SECRET_FIELDS)


def update_secrets(secrets, payload):
    """Задать или удалить логин и пароль: (новый словарь, изменения для Истории)."""
    secrets = dict(secrets or {})
    changes = {}

    for key in SECRET_FIELDS:
        value = getattr(payload, key)

        if value is None:
            continue

        value = value.strip() if key == "login" else value

        if value:
            secrets[key] = encrypt(value)
            changes["web_" + key] = {"old": None, "new": PASSWORD_SET}
        elif key in secrets:
            del secrets[key]
            changes["web_" + key] = {"old": None, "new": SECRET_REMOVED}

    return secrets, changes


# Попытки показать логин и пароль с неверными данными администратора: как вход –
# не больше 5 за 5 минут с одного адреса (у ПК и принтеров – общие)
show_attempts = defaultdict(list)
SHOW_MAX_ATTEMPTS = 5
SHOW_WINDOW_SECONDS = 300


def check_admin(session, request, user, payload):
    """Логин и пароль администратора ITDB; сам администратор вводит только свой пароль."""
    ip = request.client.host if request.client else "unknown"
    now = datetime.now(timezone.utc)
    show_attempts[ip] = [at for at in show_attempts[ip] if (now - at).total_seconds() < SHOW_WINDOW_SECONDS]

    if len(show_attempts[ip]) >= SHOW_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Слишком много попыток. Попробуй позже.")

    login = (payload.login or "").strip()

    if login:
        admin = (
            session.query(User)
            .filter(func.lower(User.login) == login.lower(), User.archived == False)  # noqa: E712
            .first()
        )
    elif user["role"] == "admin":
        admin = session.get(User, user["id"])
    else:
        raise HTTPException(status_code=403, detail="Нужны логин и пароль администратора.")

    if not admin or admin.role != "admin" or not verify_password(payload.password, admin.password_hash):
        show_attempts[ip].append(now)
        raise HTTPException(status_code=403, detail="Неверный пароль." if not login else "Нужны логин и пароль администратора.")

    show_attempts.pop(ip, None)


def shown_secrets(secrets):
    secrets = secrets or {}
    return {
        "login": decrypt(secrets["login"], "логин") if secrets.get("login") else None,
        "password": decrypt(secrets["password"]) if secrets.get("password") else None,
    }
