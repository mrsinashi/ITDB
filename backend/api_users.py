"""Пользователи системы — раздел администратора: список, новый пользователь,
роль, новый пароль, отключение (архив, удаления нет).

Свою роль и отключение себя администратор менять не может — так в системе
всегда остаётся хотя бы один работающий администратор (он сам). Изменения
пользователей в Историю не пишутся (как и справочники)."""
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

# Логин: латиница, цифры, точка, дефис, подчёркивание; хранится строчными
LOGIN_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}$")

PASSWORD_MIN = 6
PASSWORD_MAX = 200


class UserOut(BaseModel):
    id: int
    login: str
    role: str
    archived: bool
    created_at: datetime
    is_self: bool


class UserCreate(BaseModel):
    login: str = ""
    role: str = "reader"
    password: str = ""


class UserUpdate(BaseModel):
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
        role=user.role,
        archived=user.archived,
        created_at=user.created_at,
        is_self=user.id == me["id"],
    )


@router.get("", response_model=list[UserOut])
def list_users(me=Depends(require_admin), session=Depends(get_db)):
    # Сначала работающие, потом отключённые; внутри — по логину
    users = session.query(User).order_by(User.archived, User.login).all()
    return [user_out(user, me) for user in users]


@router.post("", response_model=UserOut)
def create_user(payload: UserCreate, me=Depends(require_admin), session=Depends(get_db)):
    login = payload.login.strip().lower()

    if not login:
        raise HTTPException(status_code=400, detail="Нужно указать логин.")

    if not LOGIN_RE.match(login):
        raise HTTPException(
            status_code=400,
            detail="Логин — латинские буквы, цифры, точка, дефис или подчёркивание (до 40 символов).",
        )

    check_role(payload.role)
    check_password(payload.password)

    exists = session.query(User).filter(func.lower(User.login) == login).first()

    if exists:
        detail = "Такой логин уже есть"
        detail += " (пользователь отключён — его можно включить)." if exists.archived else "."
        raise HTTPException(status_code=409, detail=detail)

    user = User(login=login, role=payload.role, password_hash=hash_password(payload.password))
    session.add(user)
    session.flush()
    log_change(session, "users", user.id, me["login"], {
        "created": {"old": None, "new": login},
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
    changes = {}

    if payload.role is not None and payload.role != user.role:
        if is_self:
            raise HTTPException(
                status_code=400,
                detail="Свою роль изменить нельзя — это может сделать другой администратор.",
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
        # Старые входы с прежним паролем больше не действуют (свой текущий — остаётся)
        end_sessions(session, user.id, keep_token=me["token"] if is_self else None)

    for name, old in before.items():
        changes[name] = {"old": old, "new": getattr(user, name)}

    log_change(session, "users", user.id, me["login"], changes, title=user.login)
    session.commit()

    return user_out(user, me)
