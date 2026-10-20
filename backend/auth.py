import secrets

from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from db import get_db
from models import User, UserSession

ph = PasswordHasher()

SESSION_DAYS = 7


def hash_password(password):
    return ph.hash(password)


def verify_password(password, password_hash):
    try:
        ph.verify(password_hash, password)
        return True
    except VerifyMismatchError:
        return False


def create_session(session, user_id):
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=SESSION_DAYS)

    # Истёкшие входы всех пользователей (этап 51): с такой кукой больше не приходят –
    # без этого строка оставалась бы навсегда
    session.query(UserSession).filter(UserSession.expires_at < now).delete(synchronize_session=False)

    session.add(
        UserSession(
            token=token,
            user_id=user_id,
            expires_at=expires_at,
        )
    )

    session.flush()

    return token, expires_at


def get_current_user(request: Request, session=Depends(get_db)):
    token = request.cookies.get("itdb_session")

    if not token:
        raise HTTPException(status_code=401, detail="Требуется вход")

    row = (
        session.query(UserSession, User)
        .join(User, UserSession.user_id == User.id)
        .filter(UserSession.token == token, User.archived == False)
        .first()
    )

    if not row:
        raise HTTPException(status_code=401, detail="Требуется вход")

    user_session, user = row

    expires_at = user_session.expires_at

    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if expires_at < datetime.now(timezone.utc):
        session.delete(user_session)
        session.commit()
        raise HTTPException(status_code=401, detail="Сессия истекла")

    return {
        "id": user.id,
        "login": user.login,
        "role": user.role,
        "token": token,
        "perms": page_levels(user.role, user.perms),
    }


# Роли:
#   admin  – всё, включая импорт
#   editor – правка данных (ПК, дерево, справочники, поля)
#   reader – только просмотр
WRITE_ROLES = ("admin", "editor")

# ---------- Права по страницам (этап 69) ----------
#
# Роль даёт верхнюю границу (ROLE_PAGES); у пользователя – только ограничения ниже неё
# (users.perms): «нет доступа» или «просмотр» вместо «правки». Ключ – как адрес страницы
# (#scan/check). Проверка – здесь (require_page, check_page), фронт только прячет.
# Общие данные, которые нужны нескольким страницам (списки ПК, принтеров, Структура,
# справочники), читает любой вошедший – закрыты только запросы самой страницы.

# (ключ, раздел меню, название) – в порядке меню
PAGE_INFO = [
    ("table", None, "Компьютеры"),
    ("printers", None, "Принтеры"),
    ("tree", None, "Структура"),
    ("journals/moves", "Журналы", "Движение"),
    ("vacuum", None, "Vacuum"),
    ("scan/check", "Сканер", "GLPI / GSIT"),
    ("scan/net", "Сканер", "Сеть"),
    ("scan/names", "Сканер", "Названия"),
    ("scan/schedule", "Сканер", "Расписание"),
    ("scan/settings", "Сканер", "Подключения"),
    ("choices/styles", "Справочники", "Оформление"),
    ("choices/names", "Справочники", "Имена ПК"),
    ("choices/models", "Справочники", "Модели принтеров"),
    ("choices/cartridges", "Справочники", "Картриджи"),
    ("history", None, "История"),
    ("users", None, "Пользователи"),
]
PAGES = tuple(key for key, _, _ in PAGE_INFO)
PAGE_TITLES = {key: f"{group} → {label}" if group else label for key, group, label in PAGE_INFO}

LEVELS = ("none", "view", "edit")

# Как было до этапа 69: у редактора Vacuum и «Сеть» – только просмотр (сбор – у админа),
# «Названия», «Расписание», «Подключения» и «Пользователи» – только у админа
ROLE_PAGES = {
    "admin": dict.fromkeys(PAGES, "edit"),
    "editor": dict.fromkeys(PAGES, "edit") | {
        "vacuum": "view", "scan/net": "view",
        "scan/names": "none", "scan/schedule": "none", "scan/settings": "none", "users": "none",
    },
    "reader": dict.fromkeys(PAGES, "view") | dict.fromkeys(
        ("vacuum", "scan/check", "scan/net", "scan/names", "scan/schedule", "scan/settings", "users"), "none",
    ),
}

# У администратора «Пользователи» не ограничиваются: права всегда есть кому раздать
FIXED_PAGES = {"admin": ("users",)}


def page_levels(role, perms):
    """Права по всем страницам: граница роли, ниже – свои ограничения пользователя."""
    top = ROLE_PAGES.get(role, ROLE_PAGES["reader"])
    own = perms or {}
    levels = {}

    for page in PAGES:
        level = top[page]
        mine = own.get(page)

        if mine in LEVELS and page not in FIXED_PAGES.get(role, ()) and LEVELS.index(mine) < LEVELS.index(level):
            level = mine

        levels[page] = level

    return levels


def can(user, page, level="view"):
    return LEVELS.index(user["perms"].get(page, "none")) >= LEVELS.index(level)


def check_page(user, *rules):
    """rules – (страница, уровень); хватает любого из них. Нет – 403 по первому."""
    if any(can(user, page, level) for page, level in rules):
        return

    page, level = rules[0]
    title = PAGE_TITLES[page]

    if level == "edit" and can(user, page, "view"):
        raise HTTPException(status_code=403, detail=f"Недостаточно прав: «{title}» – только просмотр.")

    raise HTTPException(status_code=403, detail=f"Нет доступа: «{title}».")


def require_page(page, level="view", *more, admin=False):
    """Зависимость эндпоинта: require_page("table", "edit"); ещё пары (страница, уровень) –
    хватает любой: require_page("printers", "edit", ("choices/models", "edit")); admin=True –
    вдобавок только администратор (сбор, решения по записям GLPI / GSIT)."""
    def dependency(user=Depends(get_current_user)):
        if admin:
            require_admin(user)

        check_page(user, (page, level), *more)
        return user

    return dependency


def require_editor(user=Depends(get_current_user)):
    if user["role"] not in WRITE_ROLES:
        raise HTTPException(
            status_code=403,
            detail="Недостаточно прав: у тебя доступ только на чтение.",
        )

    return user


def require_admin(user=Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(
            status_code=403,
            detail="Это действие доступно только администратору.",
        )

    return user
