from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    Text,
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