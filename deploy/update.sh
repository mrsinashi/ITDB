#!/bin/sh
# Обновить боевую копию до последнего коммита на GitHub (ветка main):
#   /opt/itdb/deploy/update.sh
# Код → библиотеки → миграции базы → перезапуск службы. Остановится на первой
# ошибке — служба тогда продолжит работать на старом коде.
set -e
cd "$(dirname "$0")/.."

echo "== Код"
git pull --ff-only

echo "== Библиотеки"
.venv/bin/pip install -q -r requirements.txt

# Ключ шифрования паролей подключений (этап 24) — создаётся один раз.
# Его нельзя терять и менять: без него сохранённые пароли не прочитать.
if ! grep -q '^ITDB_SECRET_KEY=' .env; then
    echo "== Ключ шифрования паролей → .env"
    echo "ITDB_SECRET_KEY=$(.venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')" >> .env
fi

echo "== Миграции базы"
.venv/bin/alembic upgrade head

echo "== Перезапуск"
systemctl restart itdb
sleep 2
systemctl is-active --quiet itdb && echo "Готово: $(git log -1 --format='%h %s')"
