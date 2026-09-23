import os
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.staticfiles import StaticFiles
from sqlalchemy import create_engine, text

from api_auth import router as auth_router
from api_computers import router as computers_router
from api_export import router as export_router
from api_history import router as history_router
from api_import import router as import_router
from api_locations import router as locations_router
from auth import get_current_user
from import_apply import router as import_apply_router

app = FastAPI(title="ITDB dev", docs_url="/docs")

app.include_router(auth_router)

app.include_router(
    computers_router,
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


@app.get("/api/health")
def health():
    url = os.environ.get("DATABASE_URL")

    if not url:
        return {"db": "no DATABASE_URL"}

    try:
        engine = create_engine(url)
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