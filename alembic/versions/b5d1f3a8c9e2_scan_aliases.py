"""scan_aliases – соответствия названий источников и таблицы (этап 25б)

Revision ID: b5d1f3a8c9e2
Revises: a7c4e2f9b3d1
Create Date: 2026-09-30
"""
from alembic import op
import sqlalchemy as sa

revision = "b5d1f3a8c9e2"
down_revision = "a7c4e2f9b3d1"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "scan_aliases",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("field", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("source_key", sa.Text(), nullable=False),
        sa.Column("table_value", sa.Text(), nullable=False),
        sa.Column("table_key", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False, server_default="same"),
        sa.Column("user_name", sa.Text(), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("field", "source_key", "table_key", name="uq_scan_aliases"),
    )


def downgrade():
    op.drop_table("scan_aliases")
