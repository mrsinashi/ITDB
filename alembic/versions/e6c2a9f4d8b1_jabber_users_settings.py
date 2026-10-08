"""scan_jabber_users – пользователи Jabber (VACUUM) из веб-админки; app_settings –
общие настройки (вид столбца «Антивирусы») (этап 26д)

Revision ID: e6c2a9f4d8b1
Revises: d1f5b8e2a4c6
Create Date: 2026-10-01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "e6c2a9f4d8b1"
down_revision = "d1f5b8e2a4c6"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "scan_jabber_users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("login", sa.Text(), nullable=False),
        sa.Column("groups", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("online", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("resources", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("last_ip", sa.Text(), nullable=True),
        sa.Column("last_client", sa.Text(), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("run_id", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("login", name="uq_scan_jabber_users_login"),
    )
    op.create_table(
        "app_settings",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("value", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade():
    op.drop_table("app_settings")
    op.drop_table("scan_jabber_users")
