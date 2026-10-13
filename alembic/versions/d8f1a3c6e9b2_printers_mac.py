"""MAC принтера (этап 46)

Revision ID: d8f1a3c6e9b2
Revises: c6e2b9f4a7d3
Create Date: 2026-10-13

printers.mac – MAC-адреса принтера строками, прописными, как у ПК.
"""
from alembic import op
import sqlalchemy as sa

revision = "d8f1a3c6e9b2"
down_revision = "c6e2b9f4a7d3"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("printers", sa.Column("mac", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("printers", "mac")
