import logging
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from api_auth import router as auth_router
from api_computers import router as computers_router
from api_computer_actions import router as computer_actions_router
from api_export import router as export_router
from api_history import router as history_router
from api_import import router as import_router
from api_locations import router as locations_router
from auth import get_current_user
from db import engine
from import_apply import router as import_apply_router
from api_choices import router as choices_router
from api_field_defs import router as field_defs_router
from api_column_styles import router as column_styles_router
from api_columns import router as columns_router
from api_users import router as users_router
from api_scan import router as scan_router
from api_scan_jabber import router as scan_jabber_router
from api_scan_records import router as scan_records_router
from api_scan_diffs import av_router as scan_av_router
from api_scan_diffs import marks_router as scan_marks_router
from api_scan_diffs import router as scan_diffs_router

app = FastAPI(title="ITDB dev", docs_url="/docs")

logger = logging.getLogger("uvicorn.error")


@app.middleware("http")
async def unexpected_error(request: Request, call_next):
    """Непредвиденная ошибка (сбой базы, ошибка в коде): изменения запроса уже
    откатил get_db, пользователь видит короткий текст, полный след — в журнале
    uvicorn. Ожидаемые ошибки эндпоинты отдают сами через HTTPException.
    Не @app.exception_handler(Exception): он пробрасывает ошибку дальше, и
    uvicorn рвёт соединение — следующий запрос браузера может не дойти."""
    try:
        return await call_next(request)
    except Exception as exc:
        logger.exception("Ошибка при %s %s", request.method, request.url.path)

        lines = str(exc).strip().splitlines()
        message = lines[0] if lines else exc.__class__.__name__

        return JSONResponse(
            status_code=500,
            content={"detail": f"Ошибка на сервере: {message}"},
        )


# Только HTTPS (этап 22). Снаружи программу видно только через Caddy (https;
# с http Caddy перенаправляет на https и шлёт HSTS), сама она слушает 127.0.0.1.
# Эта проверка — страховка на случай, если её запустят на всех адресах
# (--host 0.0.0.0): любой запрос не по https, кроме как с самого сервера,
# получает отказ — и страница входа тоже, чтобы пароль не ушёл открытым текстом.
# Схему (https) uvicorn берёт из заголовков Caddy — им он верит только от
# 127.0.0.1 (--forwarded-allow-ips, по умолчанию так и есть).
LOCAL_HOSTS = {"127.0.0.1", "::1"}


@app.middleware("http")
async def https_only(request: Request, call_next):
    client = request.client.host if request.client else ""

    if request.url.scheme != "https" and client not in LOCAL_HOSTS:
        return PlainTextResponse(
            "ITDB открывается только по защищённому адресу https://…\n"
            "Обычный http отключён, чтобы пароли и данные не передавались открыто.",
            status_code=403,
        )

    return await call_next(request)


app.include_router(auth_router)

app.include_router(
    computers_router,
    dependencies=[Depends(get_current_user)],
)

app.include_router(
    computer_actions_router,
    dependencies=[Depends(get_current_user)],
)

app.include_router(
    locations_router,
    dependencies=[Depends(get_current_user)],
)

app.include_router(
    history_router,
    dependencies=[Depends(get_current_user)],
)

app.include_router(
    export_router,
    dependencies=[Depends(get_current_user)],
)

app.include_router(
    import_router,
    dependencies=[Depends(get_current_user)],
)

app.include_router(
    import_apply_router,
    dependencies=[Depends(get_current_user)],
)

app.include_router(
    choices_router,
    dependencies=[Depends(get_current_user)],
)

app.include_router(
    field_defs_router,
    dependencies=[Depends(get_current_user)],
)

app.include_router(
    column_styles_router,
    dependencies=[Depends(get_current_user)],
)

app.include_router(
    columns_router,
    dependencies=[Depends(get_current_user)],
)

# Пользователи — только администратор (require_admin в каждом эндпоинте)
app.include_router(users_router)

# Сканирование: подключения к источникам, подсети, сбор и сопоставление —
# только администратор
app.include_router(scan_router)
app.include_router(scan_records_router)
# Расхождения (этап 26), пометки сканера (этап 26б), вид столбца «Антивирусы»
# (этап 26д): смотреть — все, решать и настраивать вид — редактор и администратор
app.include_router(scan_diffs_router)
app.include_router(scan_marks_router)
app.include_router(scan_av_router)
# Пользователи Jabber (этап 26д): смотреть — редактор и администратор
app.include_router(scan_jabber_router)

@app.get("/api/health")
def health():
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
        return {"db": "ok"}
    except Exception as e:
        return {"db": "error", "error": str(e)}


STATIC_DIR = Path(__file__).resolve().parent.parent / "frontend" / "static"

if STATIC_DIR.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(STATIC_DIR), html=True),
        name="static",
    )
