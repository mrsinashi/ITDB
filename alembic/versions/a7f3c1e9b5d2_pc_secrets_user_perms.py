"""Логин и пароль у ПК, права пользователей по страницам (этап 69)

Revision ID: a7f3c1e9b5d2
Revises: d4a8e2c6f1b9
Create Date: 2026-10-20

computers.secrets – логин и пароль от компьютера (столбец «Доступ», как у принтеров),
зашифрованные ключом ITDB_SECRET_KEY (secret_box.py): {"login", "password"}.
users.perms – права по страницам: только то, что меньше, чем даёт роль
({"table": "view", "scan/check": "none"}; auth.py, PAGES).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "a7f3c1e9b5d2"
down_revision = "d4a8e2c6f1b9"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("computers", sa.Column("secrets", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")))
    op.add_column("users", sa.Column("perms", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")))


def downgrade():
    op.drop_column("users", "perms")
    op.drop_column("computers", "secrets")
