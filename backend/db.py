import os

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from env_file import read_env_file

read_env_file()

DATABASE_URL = os.environ.get("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError("Не задан DATABASE_URL: добавь его в файл .env в корне проекта (см. README).")

# pool_pre_ping: соединение из пула проверяется перед выдачей – после перезапуска
# PostgreSQL первый запрос не падает с ошибкой на оборванном соединении
engine = create_engine(DATABASE_URL, pool_pre_ping=True)

SessionLocal = sessionmaker(
    bind=engine,
    autocommit=False,
    autoflush=False,
)

Base = declarative_base()


def get_db():
    """Сессия БД на один запрос (FastAPI: session=Depends(get_db)).
    После ответа закрывается; что не закоммичено – откатывается."""
    session = SessionLocal()

    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
