import os

from fastapi import FastAPI
from sqlalchemy import create_engine, text

from api_computers import router as computers_router
from api_import import router as import_router
from import_apply import router as import_apply_router

app = FastAPI(title="ITDB dev", docs_url="/docs")

app.include_router(computers_router)
app.include_router(import_router)
app.include_router(import_apply_router)


@app.get("/")
def index():
    return {"app": "ITDB", "env": "dev"}


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