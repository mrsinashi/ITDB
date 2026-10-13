#!/bin/sh
# Обновить боевую копию до последнего коммита на GitHub (ветка main):
#   /opt/itdb/deploy/update.sh
# Код → библиотеки → миграции базы → перезапуск службы → проверка, что программа
# отвечает. Сбой библиотек или миграции – код возвращается на прежний коммит (миграции
# идут одной транзакцией – база остаётся прежней), служба работает на старом коде.
set -e
cd "$(dirname "$0")/.."

OLD=$(git rev-parse HEAD)

echo "== Код"
git pull --ff-only

# Страницы берутся с диска сразу, программа – после перезапуска: при сбое дальше
# вернуть прежний код, чтобы страницы и программа остались одной версии
rollback() {
    if git reset -q --keep "$OLD"; then
        echo "!! Ошибка – код возвращён на $(git log -1 --format='%h %s'), служба работает на прежнем коде."
    else
        echo "!! Ошибка, и вернуть код на $OLD не удалось – службу не перезапускать, пока не разберёмся."
    fi
    exit 1
}

echo "== Библиотеки"
.venv/bin/pip install -q -r requirements.txt || rollback

# Ключ шифрования паролей подключений (этап 24) – создаётся один раз.
# Его нельзя терять и менять: без него сохранённые пароли не прочитать.
if ! grep -q '^ITDB_SECRET_KEY=' .env; then
    echo "== Ключ шифрования паролей → .env"
    echo "ITDB_SECRET_KEY=$(.venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')" >> .env
fi

echo "== Миграции базы"
.venv/bin/alembic upgrade head || rollback

echo "== Перезапуск"
systemctl restart itdb

# Программа отвечает и видит базу (порт – как в deploy/itdb.service); ждать до 30 с
tries=0
until .venv/bin/python -c "import urllib.request as u; r = u.build_opener(u.ProxyHandler({})).open('http://127.0.0.1:8000/api/health', timeout=3).read(); raise SystemExit(0 if b'\"ok\"' in r else 1)" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 15 ]; then
        echo "!! Программа не отвечает после перезапуска. Журнал службы:"
        journalctl -u itdb -n 30 --no-pager
        exit 1
    fi
    sleep 2
done

echo "Готово: $(git log -1 --format='%h %s')"
