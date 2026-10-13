"""Индексы Истории (этап 51)

Revision ID: c5e2a8f4d1b7
Revises: e1a7c4f2b9d5
Create Date: 2026-10-14

История не удаляется и растёт с каждой правкой. ix_history_entity – записи одного
объекта (карточка ПК и принтера, отмена и возврат, «История значения»);
ix_history_at – страница Истории: новые сверху порциями.
"""
from alembic import op

revision = "c5e2a8f4d1b7"
down_revision = "e1a7c4f2b9d5"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_history_entity", "history", ["entity", "entity_id"])
    op.create_index("ix_history_at", "history", ["at", "id"])


def downgrade():
    op.drop_index("ix_history_at", table_name="history")
    op.drop_index("ix_history_entity", table_name="history")
