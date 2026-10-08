"""Короткое тире вместо длинного (этап 37)

Revision ID: f7a2c9d4e1b6
Revises: e8b3c6a1f4d7
Create Date: 2026-10-08

Предложение сканера «убрать всех из ячейки VACUUM» отклонялось с ключом-тире; тире
теперь короткое «–». Отклонённые раньше переписываются, иначе предложение появилось
бы снова.
"""
from alembic import op

revision = "f7a2c9d4e1b6"
down_revision = "e8b3c6a1f4d7"
branch_labels = None
depends_on = None

LONG = chr(0x2014)   # длинное тире
SHORT = chr(0x2013)  # короткое


def upgrade():
    op.execute(f"update scan_rejects set value = '{SHORT}', value_key = '{SHORT}' where value_key = '{LONG}'")


def downgrade():
    op.execute(f"update scan_rejects set value = '{LONG}', value_key = '{LONG}' where value_key = '{SHORT}'")
