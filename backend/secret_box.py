"""Шифрование паролей и токенов подключений (этап 24).

Пароли от GLPI, GSIT, Jabber нужны программе в исходном виде (она сама входит
в эти системы), поэтому хеш, как у паролей пользователей, не годится – они
шифруются (Fernet: AES-128 + проверка подлинности). Ключ – ITDB_SECRET_KEY
в .env, не в базе: копия базы без .env паролей не раскрывает.

Ключ создаётся один раз (deploy/update.sh добавляет его сам, для dev – команда
в README). Если ключ потерян или заменён, сохранённые пароли не прочитать –
их нужно ввести заново; программа так и скажет.
"""
import os

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

KEY_ENV = "ITDB_SECRET_KEY"

KEY_COMMAND = (
    "echo \"ITDB_SECRET_KEY=$(.venv/bin/python -c 'from cryptography.fernet import Fernet; "
    "print(Fernet.generate_key().decode())')\" >> .env"
)


def key_ready():
    return bool(os.environ.get(KEY_ENV, "").strip())


def _fernet():
    key = os.environ.get(KEY_ENV, "").strip()

    if not key:
        raise HTTPException(
            status_code=400,
            detail=(
                "Пароли некуда сохранить: в файле .env нет ключа шифрования ITDB_SECRET_KEY. "
                "Из корня проекта выполни: " + KEY_COMMAND + " – и перезапусти программу."
            ),
        )

    try:
        return Fernet(key.encode())
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Ключ ITDB_SECRET_KEY в .env испорчен (нужна строка из 44 знаков). Создай новый и введи пароли заново.",
        )


def encrypt(value):
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt(token, what="пароль"):
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken:
        raise HTTPException(
            status_code=400,
            detail=f"Сохранённый {what} не расшифровать: ключ ITDB_SECRET_KEY в .env сменился. Введи его заново.",
        )
