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

# ---------- Права по страницам (этапы 69, 70) ----------
#
# У каждой учётки – уровень на каждой странице (users.perms; нет записи – как у роли,
# ROLE_PAGES). Роль – только граница (ROLE_MAX, решение пользователя этапа 70): читатель
# ничего не правит, но ему можно дать просмотр любой страницы и запуск; редактор не правит
# настройки (SETTINGS_PAGES); администратору можно запретить правку где угодно. Ключ – как
# адрес страницы (#scan/check). Проверка – здесь (require_page, check_page), фронт только
# прячет. Общие данные, которые нужны нескольким страницам (списки ПК, принтеров, Структура,
# справочники), читает любой вошедший – закрыты только запросы самой страницы.

# По возрастанию: «запуск» – просмотр и сбор сканера, «правка» – всё, вместе с запуском
LEVELS = ("none", "view", "run", "edit")

# Уровни страницы: где нечего запускать – без «запуска», где нечего править – без «правки»
VIEW_EDIT = ("none", "view", "edit")
VIEW_RUN = ("none", "view", "run")
VIEW_RUN_EDIT = ("none", "view", "run", "edit")

# (ключ, раздел меню, название, уровни) – в порядке меню
PAGE_INFO = [
    ("table", None, "Компьютеры", VIEW_EDIT),
    ("printers", None, "Принтеры", VIEW_EDIT),
    ("tree", None, "Структура", VIEW_EDIT),
    ("journals/moves", "Журналы", "Движение", VIEW_EDIT),
    # Журнал IP (этап 71): «Сканировать» на его панели – по запуску страниц источников
    ("journals/ips", "Журналы", "IP", VIEW_EDIT),
    ("vacuum", None, "Vacuum", VIEW_RUN),
    ("scan/check", "Сканер", "GLPI / GSIT", VIEW_RUN_EDIT),
    ("scan/net", "Сканер", "Сеть", VIEW_RUN),
    ("scan/names", "Сканер", "Названия", VIEW_EDIT),
    ("scan/schedule", "Сканер", "Расписание", VIEW_RUN_EDIT),
    ("scan/settings", "Сканер", "Подключения", VIEW_RUN_EDIT),
    ("choices/styles", "Справочники", "Оформление", VIEW_EDIT),
    ("choices/names", "Справочники", "Имена ПК", VIEW_EDIT),
    ("choices/models", "Справочники", "Модели принтеров", VIEW_EDIT),
    ("choices/cartridges", "Справочники", "Картриджи", VIEW_EDIT),
    ("history", None, "История", VIEW_EDIT),
    ("users", None, "Пользователи", VIEW_EDIT),
]
PAGES = tuple(key for key, _, _, _ in PAGE_INFO)
PAGE_TITLES = {key: f"{group} → {label}" if group else label for key, group, label, _ in PAGE_INFO}
PAGE_LEVELS = {key: levels for key, _, _, levels in PAGE_INFO}

# Настройки (ответ пользователя, этап 70): редактор там только смотрит и запускает
SETTINGS_PAGES = ("scan/schedule", "scan/settings", "users")


def no_edit(page):
    """Высший уровень страницы без правки: запуск или просмотр."""
    return [level for level in PAGE_LEVELS[page] if level != "edit"][-1]


ROLE_MAX = {
    "admin": {page: PAGE_LEVELS[page][-1] for page in PAGES},
    "editor": {page: no_edit(page) if page in SETTINGS_PAGES else PAGE_LEVELS[page][-1] for page in PAGES},
    "reader": {page: no_edit(page) for page in PAGES},
}

# Без своих настроек – как было до этапа 69: у редактора Vacuum и «Сеть» – просмотр,
# «Названий», «Расписания», «Подключений» и «Пользователей» нет; у читателя нет сканера
ROLE_PAGES = {
    "admin": dict(ROLE_MAX["admin"]),
    "editor": dict.fromkeys(PAGES, "edit") | {
        "vacuum": "view", "scan/net": "view",
        "scan/names": "none", "scan/schedule": "none", "scan/settings": "none", "users": "none",
    },
    "reader": dict.fromkeys(PAGES, "view") | dict.fromkeys(
        ("vacuum", "scan/check", "scan/net", "scan/names", "scan/schedule", "scan/settings", "users"), "none",
    ),
}


def level_allowed(role, page, level):
    """Уровень есть у страницы и не выше границы роли."""
    return (
        page in PAGE_LEVELS and level in PAGE_LEVELS[page]
        and LEVELS.index(level) <= LEVELS.index(ROLE_MAX[role][page])
    )


def fit_perms(role, perms, was=None):
    """Свои уровни учётки, которые что-то значат при этой роли: допустимые и не как у роли.
    Остальное не хранить – иначе при смене роли туда и обратно оно молча оживёт (этап 69).
    was – прежняя роль: ограничение остаётся, только если и при новой роли это ограничение,
    добавленное – если и при ней добавленное (читатель с «Пользователями», ставший
    администратором, получает всё, как у роли)."""
    def below(level, of_role, page):
        return LEVELS.index(level) < LEVELS.index(ROLE_PAGES[of_role][page])

    return {
        page: level for page, level in (perms or {}).items()
        if level_allowed(role, page, level) and level != ROLE_PAGES[role][page]
        and (was not in ROLE_PAGES or below(level, was, page) == below(level, role, page))
    }


def page_levels(role, perms):
    """Права по всем страницам: свой уровень учётки, если роль его допускает, иначе – как у роли."""
    role = role if role in ROLE_PAGES else "reader"
    own = perms or {}
    return {page: own[page] if level_allowed(role, page, own.get(page)) else ROLE_PAGES[role][page] for page in PAGES}


def can(user, page, level="view"):
    return LEVELS.index(user["perms"].get(page, "none")) >= LEVELS.index(level)


ONLY_WORDS = {"view": "только просмотр", "run": "только просмотр и запуск"}


def check_page(user, *rules):
    """rules – (страница, уровень); хватает любого из них. Нет – 403 по первому."""
    if any(can(user, page, level) for page, level in rules):
        return

    page, _ = rules[0]
    title = PAGE_TITLES[page]
    have = user["perms"].get(page, "none")

    if have in ONLY_WORDS:
        raise HTTPException(status_code=403, detail=f"Недостаточно прав: «{title}» – {ONLY_WORDS[have]}.")

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
