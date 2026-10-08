"""users.full_name, users.position; логин уникален без учёта регистра

Revision ID: c3e8f1a7d2b5
Revises: b7d3e9a4c612
Create Date: 2026-09-29

С этапа 22 логин хранится так, как его ввели (Ivanov.P), а вход и проверка
занятости – без учёта регистра. Уникальный индекс по lower(login) не даёт
завести «ivanov» и «Ivanov» рядом даже в обход программы.
"""
from alembic import op
import sqlalchemy as sa

revision = "c3e8f1a7d2b5"
down_revision = "b7d3e9a4c612"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("full_name", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("position", sa.Text(), nullable=True))

    conn = op.get_bind()
    same = conn.execute(sa.text(
        "select string_agg(login, ', ') from users group by lower(login) having count(*) > 1"
    )).scalars().all()

    if same:
        raise RuntimeError(
            "Есть логины, которые отличаются только регистром: " + "; ".join(same)
            + ". Переименуйте лишние (psql, таблица users) и повторите миграцию."
        )

    op.create_index("uq_users_login_lower", "users", [sa.text("lower(login)")], unique=True)


def downgrade():
    op.drop_index("uq_users_login_lower", table_name="users")
    op.drop_column("users", "position")
    op.drop_column("users", "full_name")
