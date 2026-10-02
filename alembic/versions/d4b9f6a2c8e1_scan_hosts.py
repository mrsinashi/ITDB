"""scan_hosts — что видно в сети: аренды DHCP и ответы адресов подсетей (этап 28)

Revision ID: d4b9f6a2c8e1
Revises: c5a8e2f7d4b9
Create Date: 2026-10-02
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "d4b9f6a2c8e1"
down_revision = "c5a8e2f7d4b9"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "scan_hosts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("ip", sa.Text(), nullable=False),
        sa.Column("mac", sa.Text(), nullable=True),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("data", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("run_id", sa.Integer(), nullable=True),
        sa.UniqueConstraint("source", "ip", name="uq_scan_hosts_source_ip"),
    )


def downgrade():
    op.drop_table("scan_hosts")
