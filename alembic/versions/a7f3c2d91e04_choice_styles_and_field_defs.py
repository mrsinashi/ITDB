"""choice styles and field defs

Revision ID: a7f3c2d91e04
Revises: eb09153456ae
Create Date: 2026-09-25
"""
from alembic import op
import sqlalchemy as sa

revision = "a7f3c2d91e04"
down_revision = "eb09153456ae"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("choices", sa.Column("bg_color", sa.Text(), nullable=True))
    op.add_column("choices", sa.Column("bold", sa.Boolean(), server_default="false", nullable=False))
    op.add_column("choices", sa.Column("italic", sa.Boolean(), server_default="false", nullable=False))

    op.create_table(
        "field_defs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("key", sa.Text(), nullable=False, unique=True),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("field_type", sa.Text(), nullable=False, server_default="text"),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_table("field_defs")
    op.drop_column("choices", "italic")
    op.drop_column("choices", "bold")
    op.drop_column("choices", "bg_color")