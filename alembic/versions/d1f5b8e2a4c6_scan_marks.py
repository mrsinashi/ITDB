"""scan_marks — как помечать в Таблице ячейки с другим значением у сканера (этап 26б)

Revision ID: d1f5b8e2a4c6
Revises: c8e4a1d6f2b7
Create Date: 2026-09-30
"""
from alembic import op
import sqlalchemy as sa

revision = "d1f5b8e2a4c6"
down_revision = "c8e4a1d6f2b7"
branch_labels = None
depends_on = None

# Начальный вид: мягкие фоны, «неточно» — курсивом; «в таблице часть» выключено
DEFAULTS = [
    # kind, sort, color, bg_color, bold, italic, strike, frame, enabled, always
    ("diff", 1, None, "#fde7a8", False, False, False, None, True, False),
    ("fill", 2, None, "#d6e8fb", False, False, False, None, True, False),
    ("unsure", 3, None, "#ece0f5", False, True, False, None, True, False),
    ("partial", 4, None, None, False, False, False, "#9db4cc", False, False),
]


def upgrade():
    table = op.create_table(
        "scan_marks",
        sa.Column("kind", sa.Text(), primary_key=True),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("color", sa.Text(), nullable=True),
        sa.Column("bg_color", sa.Text(), nullable=True),
        sa.Column("bold", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("italic", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("strike", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("frame", sa.Text(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("always", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.bulk_insert(table, [
        dict(zip(("kind", "sort", "color", "bg_color", "bold", "italic", "strike", "frame", "enabled", "always"), row))
        for row in DEFAULTS
    ])


def downgrade():
    op.drop_table("scan_marks")
