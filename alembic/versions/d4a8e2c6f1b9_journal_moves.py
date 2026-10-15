"""Журналы: «Движение» – получение и установка техники и компонентов (этап 66)

Revision ID: d4a8e2c6f1b9
Revises: c5e2a8f4d1b7
Create Date: 2026-10-15

item_types – типы техники и компонентов (название, tech / part, вид полей «Понятного
названия»); сразу – Компьютер, Монитор, Принтер, МФУ (техника), Диск, ОЗУ (компоненты).
moves – записи журнала: тип, название из 1С, поля названия или модель принтера, учёт, даты
(текстом «ГГГГ», «ГГГГ-ММ», «ГГГГ-ММ-ДД»), откуда, куда (узел или ПК), кто установил,
статус, примечание, архив.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "d4a8e2c6f1b9"
down_revision = "c5e2a8f4d1b7"
branch_labels = None
depends_on = None

# (название, tech / part, вид полей)
TYPES = [
    ("Компьютер", "tech", "computer"),
    ("Монитор", "tech", "monitor"),
    ("Принтер", "tech", "printer"),
    ("МФУ", "tech", "printer"),
    ("Диск", "part", "disk"),
    ("ОЗУ", "part", "ram"),
]


def upgrade():
    types = op.create_table(
        "item_types",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("form", sa.Text(), nullable=False, server_default="info"),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("uq_item_types_name_lower", "item_types", [sa.text("lower(name)")], unique=True)
    op.bulk_insert(types, [
        {"name": name, "kind": kind, "form": form, "sort": index + 1}
        for index, (name, kind, form) in enumerate(TYPES)
    ])

    op.create_table(
        "moves",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("type_id", sa.Integer(), sa.ForeignKey("item_types.id"), nullable=False),
        sa.Column("name_1c", sa.Text(), nullable=True),
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column("printer_model_id", sa.Integer(), sa.ForeignKey("printer_models.id"), nullable=True),
        sa.Column("specs", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("inv_no", sa.Text(), nullable=True),
        sa.Column("serial", sa.Text(), nullable=True),
        sa.Column("country", sa.Text(), nullable=True),
        sa.Column("made", sa.Text(), nullable=True),
        sa.Column("bought", sa.Text(), nullable=True),
        sa.Column("supplier", sa.Text(), nullable=True),
        sa.Column("source", sa.Text(), nullable=True),
        sa.Column("received", sa.Text(), nullable=True),
        sa.Column("dest_location_id", sa.Integer(), sa.ForeignKey("locations.id"), nullable=True),
        sa.Column("dest_computer_id", sa.Integer(), sa.ForeignKey("computers.id"), nullable=True),
        sa.Column("installed", sa.Text(), nullable=True),
        sa.Column("installer_user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("installer", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade():
    # Записи Истории о журнале и типах без самих объектов не нужны
    op.execute("delete from history where entity in ('moves', 'item_types')")
    op.drop_table("moves")
    op.drop_index("uq_item_types_name_lower", table_name="item_types")
    op.drop_table("item_types")
