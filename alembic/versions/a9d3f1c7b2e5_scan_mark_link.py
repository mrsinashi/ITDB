"""Пометка «Привязка записи» в Таблице (этап 38)

Revision ID: a9d3f1c7b2e5
Revises: f7a2c9d4e1b6
Create Date: 2026-10-08

Запись GLPI / GSIT, которую сопоставление только предлагает привязать к ПК
(«привязать?»), показывается в столбце GLPI / GSIT блочком с её номером – серым.
Вид, как у остальных пометок сканера, меняется в Справочниках.
"""
from alembic import op

revision = "a9d3f1c7b2e5"
down_revision = "f7a2c9d4e1b6"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "insert into scan_marks (kind, sort, color, bg_color, bold, italic, strike, frame, enabled, always) "
        "values ('link', 5, '#666666', '#e8e8e8', false, false, false, null, true, false) "
        "on conflict (kind) do nothing"
    )


def downgrade():
    op.execute("delete from scan_marks where kind = 'link'")
