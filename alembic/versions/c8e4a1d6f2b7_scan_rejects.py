"""scan_rejects — отклонённые значения сканера (этап 26)

Revision ID: c8e4a1d6f2b7
Revises: b5d1f3a8c9e2
Create Date: 2026-09-30
"""
from alembic import op
import sqlalchemy as sa

revision = "c8e4a1d6f2b7"
down_revision = "b5d1f3a8c9e2"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "scan_rejects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("computer_id", sa.Integer(), sa.ForeignKey("computers.id"), nullable=False),
        sa.Column("field", sa.Text(), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("value_key", sa.Text(), nullable=False),
        sa.Column("user_name", sa.Text(), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("computer_id", "field", "value_key", name="uq_scan_rejects"),
    )


def downgrade():
    op.drop_table("scan_rejects")
