"""Журналы: «IP» – занятые и свободные адреса (этап 71)

Revision ID: f2b7d4a9c3e6
Revises: c5e8a2f4d7b1
Create Date: 2026-10-21

ip_entries – записи журнала IP (источник «IP»): адрес, тип, имя, кто добавил; у рабочего
адреса – одна запись (уникальный индекс по ip без архива); checked_at – «Актуальность» записи.
ip_notes – описание адреса (одно на адрес, у любого: и у записи журнала, и у адреса из других
источников). Остальное в строках журнала – из Компьютеров, Принтеров, Движения и сканера, на лету.
"""
from alembic import op
import sqlalchemy as sa

revision = "f2b7d4a9c3e6"
down_revision = "c5e8a2f4d7b1"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "ip_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("ip", sa.Text(), nullable=False),
        sa.Column("ip_type", sa.Text(), nullable=True),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("added_user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("added_by", sa.Text(), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "uq_ip_entries_ip", "ip_entries", ["ip"], unique=True, postgresql_where=sa.text("NOT archived"),
    )
    op.create_table(
        "ip_notes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("ip", sa.Text(), nullable=False, unique=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade():
    bind = op.get_bind()
    entries = bind.execute(sa.text("SELECT count(*) FROM ip_entries")).scalar()
    notes = bind.execute(sa.text("SELECT count(*) FROM ip_notes WHERE note IS NOT NULL")).scalar()

    if entries or notes:
        raise RuntimeError(
            f"В журнале IP записей: {entries}, описаний: {notes} – откат их удалил бы, он остановлен."
        )

    op.execute("DELETE FROM history WHERE entity IN ('ip_entries', 'ip_notes')")
    op.drop_table("ip_notes")
    op.drop_index("uq_ip_entries_ip", table_name="ip_entries")
    op.drop_table("ip_entries")
