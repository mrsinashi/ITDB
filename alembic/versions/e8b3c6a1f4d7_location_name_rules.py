"""Правила имён ПК в узлах дерева (этап 35)

Revision ID: e8b3c6a1f4d7
Revises: d4b9f6a2c8e1
Create Date: 2026-10-08

Имя ПК по правилу – части имени узлов по пути (адрес, отделение, этаж, кабинет)
через «-» и номер: ter-proc-1. У узла: name_part – его часть имени, name_own –
«только своя» (части узлов выше не добавляются), name_single – одно место (имя
без номера). Исключения «своё имя» у отдельных ПК – в app_settings («name_keep»).
"""
from alembic import op
import sqlalchemy as sa

revision = "e8b3c6a1f4d7"
down_revision = "d4b9f6a2c8e1"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("locations", sa.Column("name_part", sa.Text(), nullable=True))
    op.add_column("locations", sa.Column("name_own", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("locations", sa.Column("name_single", sa.Boolean(), nullable=False, server_default=sa.text("false")))


def downgrade():
    op.drop_column("locations", "name_single")
    op.drop_column("locations", "name_own")
    op.drop_column("locations", "name_part")
    op.execute("delete from app_settings where key = 'name_keep'")
