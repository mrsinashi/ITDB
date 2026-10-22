"""Права по страницам: «Сканер → Названия» стали «Справочники → Значения» (этап 72)

Revision ID: a3d8e5c1b7f2
Revises: f2b7d4a9c3e6
Create Date: 2026-10-22

Страница переехала – ключ в users.perms меняется с «scan/names» на «choices/values», уровень
остаётся тот же (у кого не как у роли).
"""
from alembic import op

revision = "a3d8e5c1b7f2"
down_revision = "f2b7d4a9c3e6"
branch_labels = None
depends_on = None


def rename(old, new):
    op.execute(
        f"""
        update users
           set perms = (perms - '{old}') || jsonb_build_object('{new}', perms -> '{old}')
         where perms ? '{old}'
        """
    )


def upgrade():
    rename("scan/names", "choices/values")


def downgrade():
    rename("choices/values", "scan/names")
