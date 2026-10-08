"""computers.temp_note (текст) → computers.temp_until (дата)

Revision ID: f4c2a7d9b1e3
Revises: e3b8f41a6c07
Create Date: 2026-09-28

«Временно, до…» – простое поле с датой (решение пользователя 28.09):
просроченная дата подсвечивается в таблице и карточке. Старые текстовые
значения переводятся в дату; если какое-то не похоже на дату, миграция
останавливается и называет такие ПК – ничего не теряется молча.
"""
from datetime import date
import re

from alembic import op
import sqlalchemy as sa

revision = "f4c2a7d9b1e3"
down_revision = "e3b8f41a6c07"
branch_labels = None
depends_on = None


def parse_date(text):
    """«15.10.2026», «15.10.26», «2026-10-15» → date; иначе None."""
    text = (text or "").strip()

    m = re.fullmatch(r"(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})", text)
    if m:
        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if year < 100:
            year += 2000
    else:
        m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", text)
        if not m:
            return None
        year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))

    try:
        return date(year, month, day)
    except ValueError:
        return None


def upgrade():
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "select id, hostname, temp_note from computers "
            "where temp_note is not null and btrim(temp_note) <> ''"
        )
    ).fetchall()

    values = {}
    bad = []

    for computer_id, hostname, text in rows:
        parsed = parse_date(text)

        if parsed is None:
            bad.append(f"{hostname or 'id ' + str(computer_id)}: «{text}»")
        else:
            values[computer_id] = parsed

    if bad:
        raise RuntimeError(
            "«Временно, до…» не похоже на дату у ПК: "
            + "; ".join(bad)
            + ". Исправь значения на ДД.ММ.ГГГГ или очисти их и повтори миграцию."
        )

    op.add_column("computers", sa.Column("temp_until", sa.Date(), nullable=True))

    for computer_id, value in values.items():
        conn.execute(
            sa.text("update computers set temp_until = :value where id = :id"),
            {"value": value, "id": computer_id},
        )

    op.drop_column("computers", "temp_note")


def downgrade():
    op.add_column("computers", sa.Column("temp_note", sa.Text(), nullable=True))
    op.execute(
        "update computers set temp_note = to_char(temp_until, 'DD.MM.YYYY') "
        "where temp_until is not null"
    )
    op.drop_column("computers", "temp_until")
