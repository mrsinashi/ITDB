"""Картриджи и отклонённые значения сканера у принтеров (этап 47)

Revision ID: e1a7c4f2b9d5
Revises: d8f1a3c6e9b2
Create Date: 2026-10-13

cartridges – справочник картриджей (название без учёта регистра – одно);
printer_model_cartridges – какие картриджи подходят модели принтера;
scan_rejects.printer_id – «оставить как есть» у принтера (MAC из сети по IP):
у такой строки computer_id пуст.
"""
from alembic import op
import sqlalchemy as sa

revision = "e1a7c4f2b9d5"
down_revision = "d8f1a3c6e9b2"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "cartridges",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
    )
    op.create_index("uq_cartridges_name", "cartridges", [sa.text("lower(name)")], unique=True)
    op.create_table(
        "printer_model_cartridges",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("model_id", sa.Integer(), sa.ForeignKey("printer_models.id"), nullable=False),
        sa.Column("cartridge_id", sa.Integer(), sa.ForeignKey("cartridges.id"), nullable=False),
        sa.UniqueConstraint("model_id", "cartridge_id", name="uq_printer_model_cartridges"),
    )
    op.add_column("scan_rejects", sa.Column("printer_id", sa.Integer(), sa.ForeignKey("printers.id"), nullable=True))
    op.alter_column("scan_rejects", "computer_id", existing_type=sa.Integer(), nullable=True)
    op.create_unique_constraint("uq_scan_rejects_printer", "scan_rejects", ["printer_id", "field", "value_key"])


def downgrade():
    # Отклонения у принтеров до этапа 47 хранить негде – они просто забываются
    op.execute("DELETE FROM scan_rejects WHERE computer_id IS NULL")
    op.drop_constraint("uq_scan_rejects_printer", "scan_rejects", type_="unique")
    op.alter_column("scan_rejects", "computer_id", existing_type=sa.Integer(), nullable=False)
    op.drop_column("scan_rejects", "printer_id")
    op.drop_table("printer_model_cartridges")
    op.drop_index("uq_cartridges_name", table_name="cartridges")
    op.drop_table("cartridges")
