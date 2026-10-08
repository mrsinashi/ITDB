"""scan_runs, scan_records, scan_links – сбор из GLPI и GSIT (этап 25)

Revision ID: a7c4e2f9b3d1
Revises: d8f2b6c4e1a9
Create Date: 2026-09-30
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "a7c4e2f9b3d1"
down_revision = "d8f2b6c4e1a9"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "scan_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="running"),
        sa.Column("user_name", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("stats", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.create_index("ix_scan_runs_source_id", "scan_runs", ["source", "id"])

    op.create_table(
        "scan_records",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("source_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("data", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("keys", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("dup_of", sa.Integer(), nullable=True),
        sa.Column("run_id", sa.Integer(), nullable=True),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("source", "source_id", name="uq_scan_records_source_id"),
    )

    op.create_table(
        "scan_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("source_id", sa.Integer(), nullable=False),
        sa.Column("computer_id", sa.Integer(), sa.ForeignKey("computers.id"), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("user_name", sa.Text(), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("source", "source_id", "computer_id", name="uq_scan_links"),
    )


def downgrade():
    op.drop_table("scan_links")
    op.drop_table("scan_records")
    op.drop_index("ix_scan_runs_source_id", table_name="scan_runs")
    op.drop_table("scan_runs")
