"""data fixes: seed choices, split vacuum logins, roles

Revision ID: b41e7c2a9d53
Revises: 7565095a2679
Create Date: 2026-09-25

1. Засев справочников (метки, базовые статусы) — раньше метки засевались
   при каждом GET /api/choices. Засеваем, только если значений этого поля
   ещё нет, чтобы не вернуть удалённое пользователем.
2. Логины VACUUM, склеенные импортом через пробел ("ivanov petrov"),
   разбиваются на отдельные учётки со всеми связями.
3. Роли начали проверяться. Пользователи с ролью reader до сих пор могли
   править всё, поэтому, чтобы никто не потерял доступ, переводим их
   в editor. Сделать кого-то читателем:
       update users set role = 'reader' where login = '...';
"""
import re

from alembic import op
import sqlalchemy as sa

revision = "b41e7c2a9d53"
down_revision = "7565095a2679"
branch_labels = None
depends_on = None

LABEL_DEFAULTS = [
    "Адм", "Мед", "Мед П", "Мед С", "Мед ПС",
    "Апп", "Каф", "Прочие", "Эко", "ИТ", "Стат", "Хоз",
]

BASE_STATUSES = ["установлен", "склад", "ремонт", "списан"]


def seed_choices(conn, field, values):
    exists = conn.execute(
        sa.text("select 1 from choices where field = :field limit 1"),
        {"field": field},
    ).first()

    if exists:
        return

    for index, value in enumerate(values, start=1):
        conn.execute(
            sa.text(
                "insert into choices (field, value, sort) "
                "values (:field, :value, :sort) "
                "on conflict on constraint uq_choices_field_value do nothing"
            ),
            {"field": field, "value": value, "sort": index},
        )


def split_vacuum_accounts(conn):
    bad_accounts = conn.execute(
        sa.text(
            "select id, login from vacuum_accounts "
            "where login ~ '[[:space:],;]'"
        )
    ).fetchall()

    for old_id, old_login in bad_accounts:
        parts = []

        for part in re.split(r"[\s,;]+", old_login):
            part = part.strip().lower()

            if part and part not in parts:
                parts.append(part)

        for login in parts:
            new_id = conn.execute(
                sa.text("select id from vacuum_accounts where login = :login"),
                {"login": login},
            ).scalar()

            if new_id is None:
                new_id = conn.execute(
                    sa.text(
                        "insert into vacuum_accounts (login) "
                        "values (:login) returning id"
                    ),
                    {"login": login},
                ).scalar()

            conn.execute(
                sa.text(
                    "insert into vacuum_account_computers (account_id, computer_id) "
                    "select :new_id, computer_id from vacuum_account_computers "
                    "where account_id = :old_id "
                    "on conflict on constraint uq_vacuum_account_computers do nothing"
                ),
                {"new_id": new_id, "old_id": old_id},
            )

            conn.execute(
                sa.text(
                    "insert into vacuum_account_people (account_id, person_id) "
                    "select :new_id, person_id from vacuum_account_people "
                    "where account_id = :old_id "
                    "on conflict on constraint uq_vacuum_account_people do nothing"
                ),
                {"new_id": new_id, "old_id": old_id},
            )

        conn.execute(
            sa.text("delete from vacuum_account_computers where account_id = :id"),
            {"id": old_id},
        )
        conn.execute(
            sa.text("delete from vacuum_account_people where account_id = :id"),
            {"id": old_id},
        )
        conn.execute(
            sa.text("delete from vacuum_accounts where id = :id"),
            {"id": old_id},
        )


def upgrade() -> None:
    conn = op.get_bind()

    seed_choices(conn, "label", LABEL_DEFAULTS)
    seed_choices(conn, "status", BASE_STATUSES)

    split_vacuum_accounts(conn)

    conn.execute(sa.text("update users set role = 'editor' where role = 'reader'"))


def downgrade() -> None:
    # Данные назад не склеиваем и засеянное не удаляем.
    pass
