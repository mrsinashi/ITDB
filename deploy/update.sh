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

echo "== Миграции базы"
.venv/bin/alembic upgrade head

echo "== Перезапуск"
systemctl restart itdb
sleep 2
systemctl is-active --quiet itdb && echo "Готово: $(git log -1 --format='%h %s')"
