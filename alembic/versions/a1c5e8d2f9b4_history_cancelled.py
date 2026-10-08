"""history.cancelled – запись истории отменена целиком

Revision ID: a1c5e8d2f9b4
Revises: f4c2a7d9b1e3
Create Date: 2026-09-29

Отменённое изменение не удаляется: у поля в changes появляется пометка
«cancelled» (кто и когда отменил). Если отменены все поля записи, запись
помечается целиком – по умолчанию такие записи не показываются и не
считаются (кнопка с глазом в шапке Истории).
"""
from alembic import op
import sqlalchemy as sa

revision = "a1c5e8d2f9b4"
down_revision = "f4c2a7d9b1e3"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "history",
        sa.Column("cancelled", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade():
    op.drop_column("history", "cancelled")
