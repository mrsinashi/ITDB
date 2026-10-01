"""Столбец «Антивирусы»: состояние — блочком с фоном, как значения в
Справочниках (этап 26е)

Если вид состояния сохранён и не менялся с начального вида этапа 26д (цветной
текст без фона), он переводится на новый начальный вид — фон по состоянию.
Изменённый пользователем вид не трогается.

Revision ID: a3d7c1e5f9b2
Revises: e6c2a9f4d8b1
Create Date: 2026-10-01
"""
import json

from alembic import op
import sqlalchemy as sa

revision = "a3d7c1e5f9b2"
down_revision = "e6c2a9f4d8b1"
branch_labels = None
depends_on = None

# kind: (вид 26д, вид 26е) — (цвет текста, фон)
LOOKS = {
    "on": (("#2e7d32", None), (None, "#cdebd0")),
    "old": (("#b35c00", None), (None, "#fde0b8")),
    "off": (("#cc0000", None), (None, "#f7c6c6")),
}


def convert(forward):
    bind = op.get_bind()
    row = bind.execute(sa.text("SELECT value FROM app_settings WHERE key = 'antivirus'")).first()

    if row is None or not isinstance(row[0], dict):
        return

    value = dict(row[0])
    statuses = dict(value.get("statuses") or {})
    changed = False

    for kind, (old, new) in LOOKS.items():
        status = statuses.get(kind)
        before, after = (old, new) if forward else (new, old)

        if not isinstance(status, dict):
            continue

        if (status.get("color"), status.get("bg_color")) == before:
            statuses[kind] = dict(status, color=after[0], bg_color=after[1])
            changed = True

    if changed:
        value["statuses"] = statuses
        bind.execute(
            sa.text("UPDATE app_settings SET value = CAST(:value AS jsonb) WHERE key = 'antivirus'"),
            {"value": json.dumps(value)},
        )


def upgrade():
    convert(True)


def downgrade():
    convert(False)
