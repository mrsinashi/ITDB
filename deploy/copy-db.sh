#!/bin/sh
# Разовый перенос данных из dev-копии в боевую (пустую) базу:
#   /opt/itdb/deploy/copy-db.sh /opt/itdb-dev
# Адреса баз берутся из .env обеих копий. Если в боевой базе уже есть
# компьютеры – ничего не делает (чтобы не затереть рабочие данные).
set -e
cd "$(dirname "$0")/.."
DEV_DIR="${1:?Укажи папку dev-копии, например: $0 /opt/itdb-dev}"

url_of() {
	# DATABASE_URL из .env, в виде для pg_dump/psql (без +psycopg и кавычек)
	sed -n 's/^[[:space:]]*\(export[[:space:]]\+\)\?DATABASE_URL[[:space:]]*=[[:space:]]*//p' "$1/.env" \
		| head -n 1 | tr -d "\"'" | sed 's/^postgresql+psycopg:/postgresql:/'
}

DEV_URL=$(url_of "$DEV_DIR")
PROD_URL=$(url_of .)
[ -n "$DEV_URL" ] || { echo "Нет DATABASE_URL в $DEV_DIR/.env"; exit 1; }
[ -n "$PROD_URL" ] || { echo "Нет DATABASE_URL в $(pwd)/.env"; exit 1; }
[ "$DEV_URL" != "$PROD_URL" ] || { echo "У dev и боевой копии одна и та же база – копировать нечего"; exit 1; }

COUNT=$(psql "$PROD_URL" -tAc "select count(*) from computers" 2>/dev/null || echo 0)
if [ "$COUNT" != "0" ]; then
	echo "В боевой базе уже есть компьютеры ($COUNT) – копирование отменено."
	exit 1
fi

echo "== Очистка боевой базы и копирование из dev"
psql "$PROD_URL" -q -c "drop schema public cascade; create schema public;"
pg_dump --no-owner --no-privileges "$DEV_URL" | psql "$PROD_URL" -q -v ON_ERROR_STOP=1

echo "== Миграции (если dev-база старее кода боевой копии)"
.venv/bin/alembic upgrade head

echo "Готово: компьютеров – $(psql "$PROD_URL" -tAc 'select count(*) from computers')"
