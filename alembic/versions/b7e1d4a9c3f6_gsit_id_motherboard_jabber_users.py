"""Столбцы «GSIT ID» и «Материнская плата», список пользователей Jabber (этап 26ж)

- computers.gsit_id – номер записи ПК в GSIT (как glpi_id – в GLPI);
- computers.motherboard – материнская плата. Если уже есть пользовательское
  поле с таким названием («Материнская плата», «Мат. плата», «Motherboard»), его
  значения переносятся в новый столбец, оформление (Справочники) – тоже, а само
  поле уходит в архив (значения в extra остаются);
- scan_jabber_users.registered – есть ли пользователь в списке ejabberd (NULL –
  список ещё не получали), last_login_at – «Последнее подключение» из списка.

Revision ID: b7e1d4a9c3f6
Revises: a3d7c1e5f9b2
Create Date: 2026-10-02
"""
import re

from alembic import op
import sqlalchemy as sa

revision = "b7e1d4a9c3f6"
down_revision = "a3d7c1e5f9b2"
branch_labels = None
depends_on = None

BOARD_LABEL = re.compile(r"^(материнская\s+плата|материнка|мат\.?\s*плата|motherboard|mainboard)$", re.I)


def adopt_user_field(bind):
    """Пользовательское поле «Материнская плата» → встроенный столбец."""
    fields = bind.execute(sa.text("SELECT id, key, label FROM field_defs WHERE NOT archived ORDER BY sort, id")).fetchall()
    found = [f for f in fields if BOARD_LABEL.match(" ".join((f.label or "").split()))]

    if len(found) != 1:
        return

    field = found[0]
    bind.execute(
        sa.text("UPDATE computers SET motherboard = NULLIF(btrim(extra ->> :key), '') WHERE extra ? :key"),
        {"key": field.key},
    )
    bind.execute(sa.text("UPDATE field_defs SET archived = true WHERE id = :id"), {"id": field.id})

    if field.key != "motherboard":
        for table in ("choices", "column_styles"):
            taken = bind.execute(sa.text(f"SELECT 1 FROM {table} WHERE field = 'motherboard' LIMIT 1")).first()

            if not taken:
                bind.execute(sa.text(f"UPDATE {table} SET field = 'motherboard' WHERE field = :key"), {"key": field.key})


def upgrade():
    op.add_column("computers", sa.Column("gsit_id", sa.Text(), nullable=True))
    op.add_column("computers", sa.Column("motherboard", sa.Text(), nullable=True))
    op.add_column("scan_jabber_users", sa.Column("registered", sa.Boolean(), nullable=True))
    op.add_column("scan_jabber_users", sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True))
    adopt_user_field(op.get_bind())


def downgrade():
    # Пользовательское поле, перенесённое в столбец, остаётся в архиве (значения в extra целы)
    op.execute("DELETE FROM scan_aliases WHERE kind = 'board'")
    op.execute("DELETE FROM scan_rejects WHERE field IN ('gsit_id', 'motherboard')")
    op.drop_column("scan_jabber_users", "last_login_at")
    op.drop_column("scan_jabber_users", "registered")
    op.drop_column("computers", "motherboard")
    op.drop_column("computers", "gsit_id")
