"""Несколько паролей у ПК (этап 70)

Revision ID: c5e8a2f4d7b1
Revises: a7f3c1e9b5d2
Create Date: 2026-10-21

computers.secrets: было {"login", "password"} (этап 69), стало списком записей
[{"login", "password"}, …] – учётная запись и / или пароль, зашифрованные ключом
ITDB_SECRET_KEY (secret_box.py). Пустой словарь – пустой список.
"""
from alembic import op
import sqlalchemy as sa

revision = "c5e8a2f4d7b1"
down_revision = "a7f3c1e9b5d2"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "UPDATE computers SET secrets = CASE WHEN secrets = '{}'::jsonb THEN '[]'::jsonb "
        "ELSE jsonb_build_array(secrets) END WHERE jsonb_typeof(secrets) = 'object'"
    )
    op.alter_column("computers", "secrets", server_default=sa.text("'[]'::jsonb"))


def downgrade():
    many = op.get_bind().execute(sa.text(
        "SELECT count(*) FROM computers WHERE jsonb_typeof(secrets) = 'array' AND jsonb_array_length(secrets) > 1"
    )).scalar()

    if many:
        raise RuntimeError(
            f"У {many} ПК больше одного пароля – в прежний вид (один логин и пароль) без потерь не вернуть. "
            "Оставьте у них по одной записи и повторите."
        )

    op.execute(
        "UPDATE computers SET secrets = COALESCE(secrets -> 0, '{}'::jsonb) WHERE jsonb_typeof(secrets) = 'array'"
    )
    op.alter_column("computers", "secrets", server_default=sa.text("'{}'::jsonb"))
