from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB

from db import Base


class Location(Base):
    __tablename__ = "locations"

    id = Column(Integer, primary_key=True)
    parent_id = Column(Integer, ForeignKey("locations.id"), nullable=True)

    kind = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    code = Column(Text, nullable=True)

    sort = Column(Integer, nullable=False, server_default="0")
    note = Column(Text, nullable=True)
    archived = Column(Boolean, nullable=False, server_default="false")


class Computer(Base):
    __tablename__ = "computers"

    id = Column(Integer, primary_key=True)

    status = Column(Text, nullable=False, server_default="установлен")
    location_id = Column(Integer, ForeignKey("locations.id"), nullable=True)

    seat_no = Column(Integer, nullable=True)
    seat_sort = Column(Numeric, nullable=True)

    temp_note = Column(Text, nullable=True)

    hostname = Column(Text, nullable=True)
    ip = Column(Text, nullable=True)
    mac = Column(Text, nullable=True)

    inv_no = Column(Text, nullable=True)
    serial = Column(Text, nullable=True)

    type = Column(Text, nullable=True)
    model = Column(Text, nullable=True)
    os = Column(Text, nullable=True)

    cpu = Column(Text, nullable=True)
    ram = Column(Text, nullable=True)
    drive = Column(Text, nullable=True)
    gpu = Column(Text, nullable=True)

    vnc = Column(Text, nullable=True)
    glpi_id = Column(Text, nullable=True)

    extra = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    note = Column(Text, nullable=True)

    version = Column(Integer, nullable=False, server_default="1")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class Choice(Base):
    __tablename__ = "choices"
    __table_args__ = (
        UniqueConstraint("field", "value", name="uq_choices_field_value"),
    )
    id = Column(Integer, primary_key=True)
    field = Column(Text, nullable=False)
    value = Column(Text, nullable=False)
    sort = Column(Integer, nullable=False, server_default="0")
    color = Column(Text, nullable=True)
    bg_color = Column(Text, nullable=True)
    bold = Column(Boolean, nullable=False, server_default="false")
    italic = Column(Boolean, nullable=False, server_default="false")


class Person(Base):
    __tablename__ = "people"
    __table_args__ = (
        UniqueConstraint("full_name", name="uq_people_full_name"),
    )

    id = Column(Integer, primary_key=True)
    full_name = Column(Text, nullable=False)
    position = Column(Text, nullable=True)
    note = Column(Text, nullable=True)
    archived = Column(Boolean, nullable=False, server_default="false")


class ComputerPerson(Base):
    __tablename__ = "computer_people"
    __table_args__ = (
        UniqueConstraint("computer_id", "person_id", name="uq_computer_people"),
    )

    id = Column(Integer, primary_key=True)
    computer_id = Column(Integer, ForeignKey("computers.id"), nullable=False)
    person_id = Column(Integer, ForeignKey("people.id"), nullable=False)
    is_main = Column(Boolean, nullable=False, server_default="false")
    sort = Column(Integer, nullable=False, server_default="0")


class VacuumAccount(Base):
    __tablename__ = "vacuum_accounts"
    __table_args__ = (
        UniqueConstraint("login", name="uq_vacuum_accounts_login"),
    )

    id = Column(Integer, primary_key=True)
    login = Column(Text, nullable=False)
    note = Column(Text, nullable=True)
    archived = Column(Boolean, nullable=False, server_default="false")


class VacuumAccountPerson(Base):
    __tablename__ = "vacuum_account_people"
    __table_args__ = (
        UniqueConstraint("account_id", "person_id", name="uq_vacuum_account_people"),
    )

    id = Column(Integer, primary_key=True)
    account_id = Column(Integer, ForeignKey("vacuum_accounts.id"), nullable=False)
    person_id = Column(Integer, ForeignKey("people.id"), nullable=False)


class VacuumAccountComputer(Base):
    __tablename__ = "vacuum_account_computers"
    __table_args__ = (
        UniqueConstraint("account_id", "computer_id", name="uq_vacuum_account_computers"),
    )

    id = Column(Integer, primary_key=True)
    account_id = Column(Integer, ForeignKey("vacuum_accounts.id"), nullable=False)
    computer_id = Column(Integer, ForeignKey("computers.id"), nullable=False)

class History(Base):
    __tablename__ = "history"

    id = Column(Integer, primary_key=True)
    entity = Column(Text, nullable=False)
    entity_id = Column(Integer, nullable=False)
    user_name = Column(Text, nullable=True)
    at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    changes = Column(JSONB, nullable=False)

class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("login", name="uq_users_login"),
    )

    id = Column(Integer, primary_key=True)
    login = Column(Text, nullable=False)
    password_hash = Column(Text, nullable=False)
    role = Column(Text, nullable=False, server_default="reader")
    archived = Column(Boolean, nullable=False, server_default="false")
    # Личные настройки интерфейса: {"theme": "blue"}
    prefs = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class UserSession(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        UniqueConstraint("token", name="uq_sessions_token"),
    )

    id = Column(Integer, primary_key=True)
    token = Column(Text, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=False)

class FieldDef(Base):
    __tablename__ = "field_defs"
    id = Column(Integer, primary_key=True)
    key = Column(Text, nullable=False, unique=True)
    label = Column(Text, nullable=False)
    field_type = Column(Text, nullable=False, server_default="text")
    sort = Column(Integer, nullable=False, server_default="0")
    archived = Column(Boolean, nullable=False, server_default="false")


class ColumnStyle(Base):
    """Оформление столбца таблицы целиком (значения могут его переопределить)."""
    __tablename__ = "column_styles"

    field = Column(Text, primary_key=True)
    color = Column(Text, nullable=True)
    bg_color = Column(Text, nullable=True)
    bold = Column(Boolean, nullable=False, server_default="false")
    italic = Column(Boolean, nullable=False, server_default="false")
