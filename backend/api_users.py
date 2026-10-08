"""Пользователи системы – раздел администратора: список, новый пользователь,
логин, ФИО, должность, роль, новый пароль, отключение (архив, удаления нет).
Свои логин, ФИО и должность любой пользователь меняет сам – api_auth.py.

Свою роль и отключение себя администратор менять не может – так в системе
всегда остаётся хотя бы один работающий администратор (он сам). Изменения
пишутся в Историю (видит только администратор); пароль – только «задан новый»."""
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func

from auth import hash_password, require_admin
from db import get_db
from history_log import PASSWORD_SET, log_change
from models import User, UserSession

router = APIRouter(prefix="/api/users", tags=["users"])

ROLES = ("admin", "editor", "reader")

# Логин: латиница (любой регистр), цифры, точка, дефис, подчёркивание. Хранится
# как ввели; вход и проверка занятости – без учёта регистра
LOGIN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$")
TEXT_MAX = 200

PASSWORD_MIN = 6
PASSWORD_MAX = 200


class UserOut(BaseModel):
    id: int
    login: str
    full_name: Optional[str]
    position: Optional[str]
    role: str
    archived: bool
    created_at: datetime
    is_self: bool


class UserCreate(BaseModel):
    login: str = ""
    full_name: Optional[str] = None
    position: Optional[str] = None
    role: str = "reader"
    password: str = ""


class UserUpdate(BaseModel):
    login: Optional[str] = None
    full_name: Optional[str] = None
    position: Optional[str] = None
    role: Optional[str] = None
    password: Optional[str] = None
    archived: Optional[bool] = None


def check_password(password):
    """Общие требования к паролю (и для смены своего пароля)."""
    if len(password) < PASSWORD_MIN:
        raise HTTPException(
            status_code=400,
            detail=f"Пароль слишком короткий: нужно не меньше {PASSWORD_MIN} символов.",
        )

    if len(password) > PASSWORD_MAX:
        raise HTTPException(status_code=400, detail="Пароль слишком длинный.")

    if not password.strip():
        raise HTTPException(status_code=400, detail="Пароль не может состоять из пробелов.")


def clean_login(value):
    login = (value or "").strip()

    if not login:
        raise HTTPException(status_code=400, detail="Нужно указать логин.")

    if not LOGIN_RE.match(login):
        raise HTTPException(
            status_code=400,
            detail="Логин – латинские буквы, цифры, точка, дефис или подчёркивание (до 40 символов).",
        )

    return login


def check_login_free(session, login, exclude_id=None):
    """Логин свободен без учёта регистра (ivanov и Ivanov – один логин)."""
    query = session.query(User).filter(func.lower(User.login) == login.lower())

    if exclude_id is not None:
        query = query.filter(User.id != exclude_id)

    exists = query.first()

    if exists:
        detail = "Такой логин уже есть"
        detail += " (пользователь отключён – его можно включить)." if exists.archived else "."
        raise HTTPException(status_code=409, detail=detail)


def clean_text(value, what):
    """ФИО, должность: лишние пробелы убираются, пусто – None."""
    text = " ".join((value or "").split())

    if len(text) > TEXT_MAX:
        raise HTTPException(status_code=400, detail=f"{what}: слишком длинно (до {TEXT_MAX} символов).")

    return text or None


# Логин, ФИО, должность – общее для правки администратором и своей правки
PROFILE_FIELDS = ("login", "full_name", "position")


def apply_profile(session, user, payload):
    """Записать в пользователя login / full_name / position из payload (None – не
    менять). Возвращает изменения для истории."""
    before = {name: getattr(user, name) for name in PROFILE_FIELDS}

    if payload.login is not None:
        login = clean_login(payload.login)

        if login != user.login:
            check_login_free(session, login, exclude_id=user.id)
            user.login = login

    if payload.full_name is not None:
        user.full_name = clean_text(payload.full_name, "ФИО")

    if payload.position is not None:
        user.position = clean_text(payload.position, "Должность")

    return {name: {"old": before[name], "new": getattr(user, name)} for name in PROFILE_FIELDS}


def check_role(role):
    if role not in ROLES:
        raise HTTPException(status_code=400, detail="Неизвестная роль.")


def end_sessions(session, user_id, keep_token=None):
    """Завершить входы пользователя (кроме текущего, если он указан)."""
    query = session.query(UserSession).filter(UserSession.user_id == user_id)

    if keep_token:
        query = query.filter(UserSession.token != keep_token)

    query.delete(synchronize_session=False)


def user_out(user, me):
    return UserOut(
        id=user.id,
        login=user.login,
        full_name=user.full_name,
        position=user.position,
        role=user.role,
        archived=user.archived,
        created_at=user.created_at,
        is_self=user.id == me["id"],
    )


@router.get("", response_model=list[UserOut])
def list_users(me=Depends(require_admin), session=Depends(get_db)):
    # Сначала работающие, потом отключённые; внутри – по логину
    users = session.query(User).order_by(User.archived, func.lower(User.login)).all()
    return [user_out(user, me) for user in users]


@router.post("", response_model=UserOut)
def create_user(payload: UserCreate, me=Depends(require_admin), session=Depends(get_db)):
    login = clean_login(payload.login)
    full_name = clean_text(payload.full_name, "ФИО")
    position = clean_text(payload.position, "Должность")
    check_role(payload.role)
    check_password(payload.password)
    check_login_free(session, login)

    user = User(
        login=login,
        full_name=full_name,
        position=position,
        role=payload.role,
        password_hash=hash_password(payload.password),
    )
    session.add(user)
    session.flush()
    log_change(session, "users", user.id, me["login"], {
        "created": {"old": None, "new": login},
        "full_name": {"old": None, "new": full_name},
        "position": {"old": None, "new": position},
        "role": {"old": None, "new": user.role},
    }, title=login)
    session.commit()

    return user_out(user, me)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    payload: UserUpdate,
    me=Depends(require_admin),
    session=Depends(get_db),
):
    user = session.get(User, user_id)

    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден.")

    is_self = user.id == me["id"]
    before = {"role": user.role, "archived": user.archived}
    changes = apply_profile(session, user, payload)

    if payload.role is not None and payload.role != user.role:
        if is_self:
            raise HTTPException(
                status_code=400,
                detail="Свою роль изменить нельзя – это может сделать другой администратор.",
            )

        check_role(payload.role)
        user.role = payload.role

    if payload.archived is not None and payload.archived != user.archived:
        if is_self:
            raise HTTPException(status_code=400, detail="Отключить самого себя нельзя.")

        user.archived = payload.archived

        if user.archived:
            end_sessions(session, user.id)

    if payload.password:
        check_password(payload.password)
        user.password_hash = hash_password(payload.password)
        changes["password"] = {"old": None, "new": PASSWORD_SET}
        # Старые входы с прежним паролем больше не действуют (свой текущий – остаётся)
        end_sessions(session, user.id, keep_token=me["token"] if is_self else None)

    for name, old in before.items():
        changes[name] = {"old": old, "new": getattr(user, name)}

    log_change(session, "users", user.id, me["login"], changes, title=user.login)
    session.commit()

    return user_out(user, me)
