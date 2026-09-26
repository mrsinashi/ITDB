import secrets

from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from db import SessionLocal
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
    expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)

    session.add(
        UserSession(
            token=token,
            user_id=user_id,
            expires_at=expires_at,
        )
    )

    session.flush()

    return token, expires_at


def get_current_user(request: Request):
    token = request.cookies.get("itdb_session")

    if not token:
        raise HTTPException(status_code=401, detail="Требуется вход")

    session = SessionLocal()

    try:
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
        }

    finally:
        session.close()


# Роли:
#   admin  — всё, включая импорт
#   editor — правка данных (ПК, дерево, справочники, поля)
#   reader — только просмотр
WRITE_ROLES = ("admin", "editor")


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
