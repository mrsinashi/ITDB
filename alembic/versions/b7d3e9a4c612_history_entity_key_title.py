"""history.entity_key, history.title – история справочников, полей, оформления, пользователей

Revision ID: b7d3e9a4c612
Revises: a1c5e8d2f9b4
Create Date: 2026-09-29

entity_key – ключ объекта, у которого нет числового id (оформление столбца –
по имени столбца; entity_id тогда 0). title – название объекта на момент
записи: показывается, если объекта уже нет (удалённое значение справочника).
"""
from alembic import op
import sqlalchemy as sa

revision = "b7d3e9a4c612"
down_revision = "a1c5e8d2f9b4"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("history", sa.Column("entity_key", sa.Text(), nullable=True))
    op.add_column("history", sa.Column("title", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("history", "title")
    op.drop_column("history", "entity_key")
