"""user prefs, column styles, archive duplicate field defs

Revision ID: d5a9e3c1f720
Revises: b41e7c2a9d53
Create Date: 2026-09-26

1. users.prefs — личные настройки интерфейса (цветовая схема).
2. column_styles — оформление столбца целиком (Справочники).
3. Пользовательские поля с ключами GSIT / Сост. / Метка (и любыми другими,
   совпадающими со встроенными без учёта регистра) архивируются: они читали
   те же значения, что и встроенные столбцы, и в таблице получались дубли.
   Значения в computers.extra не трогаются — их показывают встроенные столбцы.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "d5a9e3c1f720"
down_revision = "b41e7c2a9d53"
branch_labels = None
depends_on = None

# Копия на момент миграции (api_computers.RESERVED_FIELD_KEYS + ключи extra)
RESERVED = {
    "status", "hostname", "inv_no", "serial", "type", "model", "os", "cpu",
    "ram", "gpu", "vnc", "drive", "note", "gsit", "state", "label", "user",
    "vacuum", "id", "location_id", "building", "department", "floor",
    "room_code", "room_name", "seat_no", "seat_sort", "ip", "mac", "glpi_id",
    "temp_note", "extra", "version", "updated_at",
    "сост.", "метка",
}


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("prefs", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
    )

    op.create_table(
        "column_styles",
        sa.Column("field", sa.Text(), primary_key=True),
        sa.Column("color", sa.Text(), nullable=True),
        sa.Column("bg_color", sa.Text(), nullable=True),
        sa.Column("bold", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("italic", sa.Boolean(), nullable=False, server_default="false"),
    )

    conn = op.get_bind()
    rows = conn.execute(
        sa.text("select id, key from field_defs where archived = false")
    ).fetchall()
    for fd_id, key in rows:
        if (key or "").strip().lower() in RESERVED:
            conn.execute(
                sa.text("update field_defs set archived = true where id = :id"),
                {"id": fd_id},
            )


def downgrade() -> None:
    # Архивированные поля назад не возвращаем.
    op.drop_table("column_styles")
    op.drop_column("users", "prefs")
