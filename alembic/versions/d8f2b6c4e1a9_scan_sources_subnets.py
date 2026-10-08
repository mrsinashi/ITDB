"""scan_sources, scan_subnets – подключения к источникам и подсети (этап 24)

Revision ID: d8f2b6c4e1a9
Revises: c3e8f1a7d2b5
Create Date: 2026-09-30
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "d8f2b6c4e1a9"
down_revision = "c3e8f1a7d2b5"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "scan_sources",
        sa.Column("kind", sa.Text(), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("domain", sa.Text(), nullable=True),
        sa.Column("login", sa.Text(), nullable=True),
        sa.Column("secrets", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("verify_tls", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("options", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("check_ok", sa.Boolean(), nullable=True),
        sa.Column("check_message", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "scan_subnets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("cidr", sa.Text(), nullable=False),
        sa.Column("purpose", sa.Text(), nullable=False, server_default="mixed"),
        sa.Column("location_id", sa.Integer(), sa.ForeignKey("locations.id"), nullable=True),
        sa.Column("scan", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("cidr", name="uq_scan_subnets_cidr"),
    )


def downgrade():
    op.drop_table("scan_subnets")
    op.drop_table("scan_sources")
