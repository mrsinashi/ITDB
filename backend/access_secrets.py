"""Столбец «Доступ» принтера – логин и пароль от веб-страницы (этап 45) – и «Пароль» у ПК
(этап 69; с этапа 70 – несколько записей: учётная запись и / или пароль).

Хранятся зашифрованными ключом ITDB_SECRET_KEY (secret_box.py) в JSONB: у принтера –
web_secrets {"login", "password"}, у ПК – secrets [{"login", "password"}, …]. В таблице –
только задан ли. Показать можно только по логину и паролю администратора ITDB – кто бы ни
смотрел; сам администратор вводит свой пароль. В Историю (web_login / web_password) – без
значений и без отмены; показ не пишется.
"""
from collections import Counter, defaultdict
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
# Учётная запись у ПК (этап 70); пароли поменялись местами между записями – «изменён»
ACCOUNT_SET = "задана новая"
ACCOUNT_REMOVED = "удалена"
PASSWORD_CHANGED = "изменён"
ENTRIES_MAX = 20
VALUE_MAX = 200


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


# ---------- Несколько записей у ПК (этап 70) ----------


class SecretEntry(BaseModel):
    login: str = ""
    password: str = ""


class EntriesUpdate(BaseModel):
    entries: list[SecretEntry]      # все записи целиком; пустые отбрасываются
    # Записи, которые пользователь видел, начиная правку (не показывал – пусто): с тех пор их
    # изменили – 409, иначе чужие записи пропали бы молча (ревью этапа 70). None – не сверять
    before: Optional[list[SecretEntry]] = None


def clean_entries(items):
    """[(учётная запись без пробелов по краям, пароль)] без пустых записей."""
    pairs = [(item.login.strip(), item.password) for item in items]
    return [(login, password) for login, password in pairs if login or password]


def has_entries(entries):
    return any(has_secrets(entry) for entry in entries or [])


def plain_entries(entries, strict=False):
    """Записи расшифрованными: [(учётная запись, пароль)]. Не расшифровать (сменился ключ) –
    strict: ошибка; иначе – значение, не равное никакому (при правке оно просто заменится)."""
    def plain(token, what):
        if not token:
            return ""

        if strict:
            return decrypt(token, what)

        try:
            return decrypt(token, what)
        except HTTPException:
            return object()

    return [(plain(entry.get("login"), "логин"), plain(entry.get("password"), "пароль")) for entry in entries or []]


def update_entries(entries, payload):
    """Записать записи целиком: (новый список, изменения для Истории). В Историю – только что
    задано или удалено: учётная запись, пароль; пары поменялись местами – «Пароль: изменён»;
    одна перестановка записей – без записи."""
    wanted = clean_entries(payload.entries)

    if len(wanted) > ENTRIES_MAX:
        raise HTTPException(status_code=400, detail=f"Не больше {ENTRIES_MAX} записей.")

    if any(len(login) > VALUE_MAX or len(password) > VALUE_MAX for login, password in wanted):
        raise HTTPException(status_code=400, detail=f"Учётная запись и пароль – до {VALUE_MAX} знаков.")

    before = plain_entries(entries)
    readable = all(isinstance(value, str) for entry in before for value in entry)

    # Не расшифровать (сменился ключ) – показать их нельзя, сверять не с чем: записать поверх
    if payload.before is not None and readable and clean_entries(payload.before) != before:
        raise HTTPException(status_code=409, detail="Пароли этого ПК уже изменили – таблица обновлена, покажи их заново.")

    if before == wanted:
        return entries, {}

    changes = {}

    for index, key, words in ((0, "web_login", (ACCOUNT_SET, ACCOUNT_REMOVED)), (1, "web_password", (PASSWORD_SET, SECRET_REMOVED))):
        old = Counter(entry[index] for entry in before if entry[index])
        new = Counter(entry[index] for entry in wanted if entry[index])

        if new - old:
            changes[key] = {"old": None, "new": words[0]}
        elif old - new:
            changes[key] = {"old": None, "new": words[1]}

    if not changes and Counter(before) != Counter(wanted):
        changes["web_password"] = {"old": None, "new": PASSWORD_CHANGED}

    stored = [
        {key: encrypt(value) for key, value in zip(SECRET_FIELDS, entry) if value}
        for entry in wanted
    ]
    return stored, changes


def shown_entries(entries):
    return [{"login": login or None, "password": password or None} for login, password in plain_entries(entries, strict=True)]
