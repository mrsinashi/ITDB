# ITDB

Учёт компьютеров IT-отдела — веб-приложение вместо большой Excel-таблицы.
Центр системы — компьютер: где стоит (адрес → отделение → этаж → кабинет), номер места,
пользователь, сеть, железо, отметки. Есть история изменений, вход с ролями и выгрузка
в Excel.

## Из чего состоит

| Часть | Что |
|---|---|
| Сервер | Debian, Python 3.13 (подходит 3.11+), PostgreSQL 17 |
| Backend | FastAPI + SQLAlchemy, миграции Alembic — папка `backend/` |
| Frontend | Vue 3 без сборки — папка `frontend/static/` (сервер отдаёт её сам) |
| Миграции | `alembic/versions/` |

Описание внешнего вида и правила оформления — `DESIGN.md`.

Все команды ниже выполняются **из корня проекта** (там, где лежит этот файл).

## Первая установка

1. Создать базу и пользователя PostgreSQL (имя, пароль — свои):
   ```
   su postgres -c "createuser -P itdb"
   su postgres -c "createdb -O itdb itdb"
   ```
2. Файл `.env` в корне проекта (в git не попадает):
   ```
   DATABASE_URL=postgresql+psycopg://itdb:ПАРОЛЬ@localhost/itdb
   ```
3. Виртуальное окружение и библиотеки:
   ```
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt
   ```
4. Создать таблицы в базе и первого администратора:
   ```
   set -a; . ./.env; set +a
   .venv/bin/alembic upgrade head
   .venv/bin/python backend/create_admin.py
   ```

## Запуск

```
set -a; . ./.env; set +a
.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8001 --app-dir backend
```

Открыть в браузере `http://СЕРВЕР:8001`. Остановить — Ctrl+C.
Первая строка загружает `DATABASE_URL` из `.env`; в новом окне терминала её нужно
выполнить заново.

Документация API — `http://СЕРВЕР:8001/docs`.

## Роли

- `admin` — всё, включая импорт;
- `editor` — просмотр и правка;
- `reader` — только просмотр.

Ещё одного администратора можно создать той же командой
`.venv/bin/python backend/create_admin.py`.

## Как применить патч этапа

Изменения приходят файлом `_patches/stageNN_….patch` (папка `_patches/` в git не
попадает).

1. Положить файл в `_patches/`.
2. Проверить, что патч ложится без ошибок (ничего не меняет):
   ```
   git apply --check _patches/stageNN_….patch
   ```
3. Применить:
   ```
   git apply _patches/stageNN_….patch
   ```
4. Если в описании этапа сказано «нужна миграция»:
   ```
   set -a; . ./.env; set +a
   .venv/bin/alembic upgrade head
   ```
5. Перезапустить сервер (Ctrl+C и снова команда из раздела «Запуск»).
6. Проверить в браузере и закоммитить.

## Обновление из GitHub

```
git pull
set -a; . ./.env; set +a
.venv/bin/pip install -r requirements.txt
.venv/bin/alembic upgrade head
```

Затем перезапустить сервер. Если библиотеки и миграции не менялись, лишние команды
ничего не делают — выполнять их можно всегда.

## Миграции

- Посмотреть, на какой версии база: `.venv/bin/alembic current`.
- Последняя версия в коде: `.venv/bin/alembic heads`.
- Откатить одну миграцию: `.venv/bin/alembic downgrade -1`.

Схему базы руками не править: новые поля для компьютеров добавляются в интерфейсе
(«пользовательские поля»), остальное — только миграциями.

## Импорт из Excel

Разовая загрузка старой таблицы (лист `list`) — только в пустую базу, под
администратором, через `/docs`: сначала `POST /api/import/analyze` (что будет загружено
и какие найдены ошибки в данных), затем `POST /api/import/apply` с `confirm=true`.
