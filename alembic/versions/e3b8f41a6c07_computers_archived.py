"""computers.archived — архив компьютеров

Revision ID: e3b8f41a6c07
Revises: d5a9e3c1f720
Create Date: 2026-09-28

ПК не удаляются, а убираются в архив: из таблицы, дерева и выгрузки они
пропадают, их видно по кнопке «Архив» на панели Таблицы.
"""
from alembic import op
import sqlalchemy as sa

revision = "e3b8f41a6c07"
down_revision = "d5a9e3c1f720"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "computers",
        sa.Column("archived", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade():
    op.drop_column("computers", "archived")
