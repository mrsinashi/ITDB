"""Настройки из файла .env в корне проекта.

Программа читает .env сама: запуск uvicorn, alembic и тестов больше не требует
`set -a; . ./.env; set +a` (с ним тоже работает). Уже заданные переменные
окружения не перезаписываются – служба systemd передаёт их через
EnvironmentFile, и тогда .env может быть недоступен для чтения.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read_env_file(path=ROOT / ".env"):
    try:
        text = Path(path).read_text(encoding="utf-8-sig")
    except (FileNotFoundError, PermissionError):
        return

    for line in text.splitlines():
        line = line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()

        if key.startswith("export "):
            key = key[len("export "):].strip()

        value = value.strip()

        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]

        if key and key not in os.environ:
            os.environ[key] = value
