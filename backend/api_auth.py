from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from sqlalchemy import func

from auth import SESSION_DAYS, create_session, get_current_user, verify_password
from db import SessionLocal
from models import User, UserSession

router = APIRouter(prefix="/api/auth", tags=["auth"])

login_attempts = defaultdict(list)

MAX_ATTEMPTS = 5
WINDOW_SECONDS = 300


def check_rate_limit(ip):
    now = datetime.now(timezone.utc)

    login_attempts[ip] = [
        attempt
        for attempt in login_attempts[ip]
        if (now - attempt).total_seconds() < WINDOW_SECONDS
    ]

    if len(login_attempts[ip]) >= MAX_ATTEMPTS:
        raise HTTPException(
            status_code=429,
            detail="Слишком много попыток входа. Попробуй позже.",
        )


def register_failed_attempt(ip):
    login_attempts[ip].append(datetime.now(timezone.utc))


def clear_attempts(ip):
    login_attempts.pop(ip, None)


@router.post("/login")
def login(
    request: Request,
    response: Response,
    payload: dict = Body(...),
):
    ip = request.client.host if request.client else "unknown"

    check_rate_limit(ip)

    login = (payload.get("login") or "").strip().lower()
    password = payload.get("password") or ""

    if not login or not password:
        raise HTTPException(
            status_code=400,
            detail="Нужно указать логин и пароль.",
        )

    session = SessionLocal()

    try:
        user = (
            session.query(User)
            .filter(func.lower(User.login) == login, User.archived == False)
            .first()
        )

        if not user or not verify_password(password, user.password_hash):
            register_failed_attempt(ip)
            raise HTTPException(
                status_code=401,
                detail="Неверный логин или пароль",
            )

        token, expires_at = create_session(session, user.id)

        session.commit()

        clear_attempts(ip)

        response.set_cookie(
            key="itdb_session",
            value=token,
            httponly=True,
            samesite="lax",
            max_age=SESSION_DAYS * 24 * 60 * 60,
        )

        return {
            "ok": True,
            "login": user.login,
            "role": user.role,
        }

    except HTTPException:
        session.rollback()
        raise

    except Exception as e:
        session.rollback()
        raise HTTPException(
            status_code=400,
            detail=f"Ошибка входа: {e}",
        )

    finally:
        session.close()


@router.get("/me")
def me(user=Depends(get_current_user)):
    return {
        "id": user["id"],
        "login": user["login"],
        "role": user["role"],
    }


@router.post("/logout")
def logout(
    response: Response,
    user=Depends(get_current_user),
):
    session = SessionLocal()

    try:
        session.query(UserSession).filter(
            UserSession.token == user["token"]
        ).delete()

        session.commit()
    finally:
        session.close()

    response.delete_cookie("itdb_session")

    return {"ok": True}