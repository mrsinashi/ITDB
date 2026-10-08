import os
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import func

from api_users import apply_profile, check_password, end_sessions
from auth import SESSION_DAYS, create_session, get_current_user, hash_password, verify_password
from db import get_db
from history_log import PASSWORD_SET, log_change
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
    session=Depends(get_db),
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
        # За Caddy по https – кука только для https (схему uvicorn берёт из
        # заголовков Caddy, см. deploy/itdb.service); dev по http – как раньше
        secure=request.url.scheme == "https",
        max_age=SESSION_DAYS * 24 * 60 * 60,
    )

    return {
        "ok": True,
        "login": user.login,
        "role": user.role,
    }


def me_out(db_user, user):
    return {
        "id": user["id"],
        "login": db_user.login if db_user else user["login"],
        "full_name": db_user.full_name if db_user else None,
        "position": db_user.position if db_user else None,
        "role": user["role"],
        "prefs": (db_user.prefs if db_user else None) or {},
        # Пометка копии рядом с «ITDB» (ITDB_LABEL=DEV в .env dev-копии)
        "label": (os.environ.get("ITDB_LABEL") or "").strip(),
    }


# Допустимые личные настройки интерфейса
THEMES = {"red", "green", "blue", "graphite", "teal"}
ACCENT_PAGES = {"tree", "history", "choices", "users", "scan", "vacuum"}


@router.get("/me")
def me(user=Depends(get_current_user), session=Depends(get_db)):
    return me_out(session.get(User, user["id"]), user)


class ProfileChange(BaseModel):
    login: Optional[str] = None
    full_name: Optional[str] = None
    position: Optional[str] = None


@router.patch("/me/profile")
def update_profile(
    payload: ProfileChange,
    user=Depends(get_current_user),
    session=Depends(get_db),
):
    """Свои логин, ФИО и должность (любая роль; роль и пароль – не здесь).
    Вход остаётся: сессия привязана к пользователю, а не к логину."""
    db_user = session.get(User, user["id"])

    if not db_user:
        raise HTTPException(status_code=404, detail="Пользователь не найден.")

    changes = apply_profile(session, db_user, payload)
    log_change(session, "users", db_user.id, db_user.login, changes, title=db_user.login)
    session.commit()

    return me_out(db_user, user)


@router.patch("/me/prefs")
def update_prefs(
    payload: dict = Body(...),
    user=Depends(get_current_user),
    session=Depends(get_db),
):
    """Личные настройки: доступны любой роли, меняют только свои."""
    db_user = session.get(User, user["id"])

    if not db_user:
        raise HTTPException(status_code=404, detail="Пользователь не найден.")

    prefs = dict(db_user.prefs or {})

    if "theme" in payload:
        theme = payload.get("theme")

        if theme not in THEMES:
            raise HTTPException(status_code=400, detail="Неизвестная цветовая схема.")

        prefs["theme"] = theme

    # Акцентные границы блоков (Дерево, История, Справочники, карточка)
    if "accent_borders" in payload:
        prefs["accent_borders"] = bool(payload.get("accent_borders"))

    # Без закруглений; счётчики на кнопках панели (этап 26з)
    for key in ("no_radius", "button_counts"):
        if key in payload:
            prefs[key] = bool(payload.get(key))

    # Акцентная шапка – отдельно для каждой страницы
    if "accent_headers" in payload:
        value = payload.get("accent_headers")

        if not isinstance(value, dict):
            raise HTTPException(status_code=400, detail="accent_headers: ожидается объект.")

        headers = dict(prefs.get("accent_headers") or {})

        for page, on in value.items():
            if page not in ACCENT_PAGES:
                raise HTTPException(status_code=400, detail=f"Неизвестная страница: {page}.")
            headers[page] = bool(on)

        prefs["accent_headers"] = headers

    db_user.prefs = prefs  # новый dict – иначе JSONB не заметит изменения
    session.commit()

    return {"ok": True, "prefs": prefs}


class PasswordChange(BaseModel):
    current: str = ""
    new: str = ""


@router.post("/me/password")
def change_password(
    request: Request,
    payload: PasswordChange,
    user=Depends(get_current_user),
    session=Depends(get_db),
):
    """Смена своего пароля (любая роль). Неверный текущий пароль считается
    неудачной попыткой входа – тот же лимит, что у входа."""
    ip = request.client.host if request.client else "unknown"

    check_rate_limit(ip)

    db_user = session.get(User, user["id"])

    if not db_user:
        raise HTTPException(status_code=404, detail="Пользователь не найден.")

    if not verify_password(payload.current, db_user.password_hash):
        register_failed_attempt(ip)
        raise HTTPException(status_code=400, detail="Текущий пароль указан неверно.")

    check_password(payload.new)

    if payload.new == payload.current:
        raise HTTPException(status_code=400, detail="Новый пароль совпадает с текущим.")

    db_user.password_hash = hash_password(payload.new)
    log_change(session, "users", db_user.id, db_user.login,
               {"password": {"old": None, "new": PASSWORD_SET}}, title=db_user.login)
    # Входы на других компьютерах завершаются, этот – остаётся
    end_sessions(session, db_user.id, keep_token=user["token"])
    session.commit()

    return {"ok": True}


@router.post("/logout")
def logout(
    response: Response,
    user=Depends(get_current_user),
    session=Depends(get_db),
):
    session.query(UserSession).filter(
        UserSession.token == user["token"]
    ).delete()

    session.commit()

    response.delete_cookie("itdb_session")

    return {"ok": True}
