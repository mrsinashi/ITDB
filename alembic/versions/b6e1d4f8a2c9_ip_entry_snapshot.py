"""Журнал «IP»: строка адреса целиком у записи в архиве (этап 74)

Revision ID: b6e1d4f8a2c9
Revises: a3d8e5c1b7f2
Create Date: 2026-10-23

ip_entries.snapshot – что было в строке адреса от других источников (Компьютеры, сканер…) и
описание, когда запись убрали в архив (просьба пользователя: в архив – строка целиком, из
журнала уходят только значения «IP»). Пусто – у записей, у которых не было в архиве ничего, кроме
своих значений, и у убранных до этапа 74; у возвращённых из архива – остаётся (для отмены).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "b6e1d4f8a2c9"
down_revision = "a3d8e5c1b7f2"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ip_entries", sa.Column("snapshot", JSONB(), nullable=True))


def downgrade():
    bind = op.get_bind()
    count = bind.execute(
        sa.text("SELECT count(*) FROM ip_entries WHERE archived AND jsonb_typeof(snapshot) = 'object'")
    ).scalar()

    if count:
        raise RuntimeError(
            f"В архиве журнала IP строк целиком: {count} – откат оставил бы от них только значения «IP», он остановлен."
        )

    op.drop_column("ip_entries", "snapshot")
