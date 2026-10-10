"""Принтеры и МФУ, справочник моделей, подключение к ПК (этап 44)

Revision ID: c6e2b9f4a7d3
Revises: a9d3f1c7b2e5
Create Date: 2026-10-10

printer_models – модели: тип (mfu / printer), производитель, цветная ли печать,
дуплекс; printers – принтеры (расположение, № в кабинете, имя, IP, модель, веб-
страница, логин и пароль от неё – зашифрованными, ИНВ, серийный, примечание,
архив); printer_computers – к каким ПК подключён (по USB или по сети).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "c6e2b9f4a7d3"
down_revision = "a9d3f1c7b2e5"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "printer_models",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.Text(), nullable=False, server_default="printer"),
        sa.Column("maker", sa.Text(), nullable=True),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("color", sa.Boolean(), nullable=True),
        sa.Column("duplex", sa.Boolean(), nullable=True),
    )
    op.create_table(
        "printers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("location_id", sa.Integer(), sa.ForeignKey("locations.id"), nullable=True),
        sa.Column("number", sa.Integer(), nullable=True),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("ip", sa.Text(), nullable=True),
        sa.Column("model_id", sa.Integer(), sa.ForeignKey("printer_models.id"), nullable=True),
        sa.Column("web", sa.Boolean(), nullable=True),
        sa.Column("web_url", sa.Text(), nullable=True),
        sa.Column("web_secrets", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("inv_no", sa.Text(), nullable=True),
        sa.Column("serial", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "printer_computers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("printer_id", sa.Integer(), sa.ForeignKey("printers.id"), nullable=False),
        sa.Column("computer_id", sa.Integer(), sa.ForeignKey("computers.id"), nullable=False),
        sa.Column("usb", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.UniqueConstraint("printer_id", "computer_id", name="uq_printer_computers"),
    )


def downgrade():
    # Записи Истории о принтерах и моделях без самих объектов не нужны; «своё имя» принтеров – тоже
    op.execute("delete from history where entity in ('printers', 'printer_models')")
    op.execute("delete from history where entity = 'naming' and entity_key = 'printer'")
    op.execute("delete from app_settings where key = 'printer_name_keep'")
    op.drop_table("printer_computers")
    op.drop_table("printers")
    op.drop_table("printer_models")
