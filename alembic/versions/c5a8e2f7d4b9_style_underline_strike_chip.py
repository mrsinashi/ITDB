"""Оформление значений и столбцов: подчёркнутый, зачёркнутый, фон блочком (этап 26и)

- choices / column_styles: underline, strike – как жирный и курсив;
- chip – фон не заливкой всей ячейки, а блочком у самого значения.

Revision ID: c5a8e2f7d4b9
Revises: b7e1d4a9c3f6
Create Date: 2026-10-02
"""
from alembic import op
import sqlalchemy as sa

revision = "c5a8e2f7d4b9"
down_revision = "b7e1d4a9c3f6"
branch_labels = None
depends_on = None

TABLES = ("choices", "column_styles")
FLAGS = ("underline", "strike", "chip")


def upgrade():
    for table in TABLES:
        for name in FLAGS:
            op.add_column(table, sa.Column(name, sa.Boolean(), nullable=False, server_default="false"))


def downgrade():
    for table in TABLES:
        for name in reversed(FLAGS):
            op.drop_column(table, name)
