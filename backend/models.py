from sqlalchemy import (
    Boolean,
    Column,
    Date,
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

    # «Временно, до…»: дата, после которой временное размещение просрочено
    temp_until = Column(Date, nullable=True)

    hostname = Column(Text, nullable=True)
    ip = Column(Text, nullable=True)
    mac = Column(Text, nullable=True)

    inv_no = Column(Text, nullable=True)
    serial = Column(Text, nullable=True)

    type = Column(Text, nullable=True)
    model = Column(Text, nullable=True)
    motherboard = Column(Text, nullable=True)
    os = Column(Text, nullable=True)

    cpu = Column(Text, nullable=True)
    ram = Column(Text, nullable=True)
    drive = Column(Text, nullable=True)
    gpu = Column(Text, nullable=True)

    vnc = Column(Text, nullable=True)
    glpi_id = Column(Text, nullable=True)
    gsit_id = Column(Text, nullable=True)

    extra = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    note = Column(Text, nullable=True)

    # Удаления нет: ПК убирается в архив (скрыт из таблицы, дерева, выгрузки)
    archived = Column(Boolean, nullable=False, server_default="false")

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
    # Ключ объекта без числового id (оформление столбца — имя столбца; entity_id = 0)
    entity_key = Column(Text, nullable=True)
    # Название объекта на момент записи — если объекта уже нет (удалённое значение)
    title = Column(Text, nullable=True)
    user_name = Column(Text, nullable=True)
    at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    # {поле: {"old", "new"}}; у поля могут быть пометки: "cancelled" — изменение
    # отменено ({"by", "at"}), "revert" — это возврат значения из истории,
    # "old_id"/"new_id" — id узлов у расположения (в old/new — путь текстом)
    changes = Column(JSONB, nullable=False)
    # Отменены все поля записи: по умолчанию запись не показывается и не считается
    cancelled = Column(Boolean, nullable=False, server_default="false")

class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("login", name="uq_users_login"),
    )

    id = Column(Integer, primary_key=True)
    # Как ввели (Ivanov.P); вход и занятость — без учёта регистра (индекс
    # uq_users_login_lower по lower(login), миграция c3e8f1a7d2b5)
    login = Column(Text, nullable=False)
    full_name = Column(Text)   # ФИО: «Иванов Иван Иванович»; на панели — «Иванов И.И.»
    position = Column(Text)    # должность
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


class ScanSource(Base):
    """Подключение к источнику данных для сканирования (этап 24): GLPI, GSIT,
    Jabber. Строка появляется при первом сохранении настроек (до этого —
    значения по умолчанию из api_scan.SOURCES). Пароли и токены — в secrets,
    зашифрованными ключом ITDB_SECRET_KEY из .env (secret_box.py)."""
    __tablename__ = "scan_sources"

    kind = Column(Text, primary_key=True)
    enabled = Column(Boolean, nullable=False, server_default="false")
    url = Column(Text, nullable=True)
    domain = Column(Text, nullable=True)
    login = Column(Text, nullable=True)
    secrets = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    verify_tls = Column(Boolean, nullable=False, server_default="true")
    options = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))

    # Последняя проверка подключения
    checked_at = Column(DateTime(timezone=True), nullable=True)
    check_ok = Column(Boolean, nullable=True)
    check_message = Column(Text, nullable=True)

    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ScanSubnet(Base):
    """Подсеть для сетевого сканирования и её назначение (этап 24)."""
    __tablename__ = "scan_subnets"
    __table_args__ = (
        UniqueConstraint("cidr", name="uq_scan_subnets_cidr"),
    )

    id = Column(Integer, primary_key=True)
    cidr = Column(Text, nullable=False)
    purpose = Column(Text, nullable=False, server_default="mixed")
    location_id = Column(Integer, ForeignKey("locations.id"), nullable=True)
    scan = Column(Boolean, nullable=False, server_default="true")
    note = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ScanRun(Base):
    """Запуск сбора из источника (этап 25): кто, когда, итог и счётчики отчёта
    (stats: total, fresh, stale, no_date, dups, key, link, name, conflict, none;
    пока идёт — progress {done, total})."""
    __tablename__ = "scan_runs"

    id = Column(Integer, primary_key=True)
    source = Column(Text, nullable=False)
    status = Column(Text, nullable=False, server_default="running")  # running / ok / error
    user_name = Column(Text, nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    finished_at = Column(DateTime(timezone=True), nullable=True)
    message = Column(Text, nullable=True)
    stats = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))


class ScanRecord(Base):
    """Запись о ПК из источника (GLPI, GSIT) с последнего сбора — только
    свежие (проверенные источником не раньше N дней назад). В таблицу ПК
    ничего не пишется: data — значения в формате ITDB (values), антивирусы,
    полные названия; keys — признаки для сопоставления (физические MAC,
    настоящий серийный, UUID); dup_of — запись того же источника, дублем
    которой эта считается (то же железо). С каким ПК ITDB сопоставлена
    запись, не хранится — считается на лету (scan_match.py), чтобы правка
    MAC или серийного в таблице сразу меняла сопоставление."""
    __tablename__ = "scan_records"
    __table_args__ = (
        UniqueConstraint("source", "source_id", name="uq_scan_records_source_id"),
    )

    id = Column(Integer, primary_key=True)
    source = Column(Text, nullable=False)
    source_id = Column(Integer, nullable=False)
    name = Column(Text, nullable=True)
    checked_at = Column(DateTime(timezone=True), nullable=True)
    data = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    keys = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    dup_of = Column(Integer, nullable=True)
    run_id = Column(Integer, nullable=True)
    seen_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ScanLink(Base):
    """Решение администратора о записи источника (этап 25): link — это этот ПК
    (сопоставлять с ним, что бы ни говорили признаки), reject — это не этот ПК
    (не предлагать его). Переживает повторные сборы: запись может пропасть
    (устарела) и вернуться."""
    __tablename__ = "scan_links"
    __table_args__ = (
        UniqueConstraint("source", "source_id", "computer_id", name="uq_scan_links"),
    )

    id = Column(Integer, primary_key=True)
    source = Column(Text, nullable=False)
    source_id = Column(Integer, nullable=False)
    computer_id = Column(Integer, ForeignKey("computers.id"), nullable=False)
    action = Column(Text, nullable=False)  # link / reject
    title = Column(Text, nullable=True)    # имя записи на момент решения
    user_name = Column(Text, nullable=True)
    at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ScanAlias(Base):
    """Соответствие названий (этап 25б): значение источника source в поле field —
    то же, что table_value в таблице (kind same), или точно не то же (differ),
    или «в таблице своё» (keep). kind board (field model): это название — не
    модель ПК, а материнская плата: идёт в столбец «Мат. плата» как table_value.
    Ключи — без регистра и лишних пробелов (scan_values.key_of)."""
    __tablename__ = "scan_aliases"
    __table_args__ = (
        UniqueConstraint("field", "source_key", "table_key", name="uq_scan_aliases"),
    )

    id = Column(Integer, primary_key=True)
    field = Column(Text, nullable=False)
    source = Column(Text, nullable=False)
    source_key = Column(Text, nullable=False)
    table_value = Column(Text, nullable=False)
    table_key = Column(Text, nullable=False)
    kind = Column(Text, nullable=False, server_default="same")  # same / differ / keep / board
    user_name = Column(Text, nullable=True)
    at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ScanReject(Base):
    """Отклонённое значение сканера (этап 26): этому ПК в этом поле значение
    value не предлагать, пока источник отдаёт то же самое (value_key — ключ
    значения как в источнике; изменилось — снова расхождение)."""
    __tablename__ = "scan_rejects"
    __table_args__ = (
        UniqueConstraint("computer_id", "field", "value_key", name="uq_scan_rejects"),
    )

    id = Column(Integer, primary_key=True)
    computer_id = Column(Integer, ForeignKey("computers.id"), nullable=False)
    field = Column(Text, nullable=False)
    value = Column(Text, nullable=False)
    value_key = Column(Text, nullable=False)
    user_name = Column(Text, nullable=True)
    at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ScanMark(Base):
    """Как помечать в Таблице ячейку, у которой сканер предлагает другое (этап 26б):
    diff — отличается, fill — в таблице пусто, unsure — неточно, partial — в
    таблице часть. enabled — помечать вообще; always — и без кнопки на панели
    (в обычном просмотре). Вид — как оформление в Справочниках + зачёркивание и
    рамка. Строки заводит миграция d1f5b8e2a4c6."""
    __tablename__ = "scan_marks"

    kind = Column(Text, primary_key=True)
    sort = Column(Integer, nullable=False, server_default="0")
    color = Column(Text, nullable=True)
    bg_color = Column(Text, nullable=True)
    bold = Column(Boolean, nullable=False, server_default="false")
    italic = Column(Boolean, nullable=False, server_default="false")
    strike = Column(Boolean, nullable=False, server_default="false")
    frame = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, server_default="true")
    always = Column(Boolean, nullable=False, server_default="false")


class ScanJabberUser(Base):
    """Пользователь Jabber (VACUUM) из веб-админки ejabberd (этап 26д): группы
    общего ростера, в сети ли при последнем сборе и с каких адресов (ресурсы —
    клиент и IP). Строка не удаляется при пересборе: last_ip / last_seen_at —
    последний адрес и когда пользователь был в сети (по сборам ITDB).
    registered — есть ли в списке пользователей ejabberd (None — список не
    получали; False — удалён или его там нет), last_login_at — «Последнее
    подключение» из этого списка."""
    __tablename__ = "scan_jabber_users"
    __table_args__ = (
        UniqueConstraint("login", name="uq_scan_jabber_users_login"),
    )

    id = Column(Integer, primary_key=True)
    login = Column(Text, nullable=False)
    groups = Column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    online = Column(Boolean, nullable=False, server_default="false")
    resources = Column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    last_ip = Column(Text, nullable=True)
    last_client = Column(Text, nullable=True)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    registered = Column(Boolean, nullable=True)
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    run_id = Column(Integer, nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AppSetting(Base):
    """Общая настройка программы (этап 26д): key → value (JSON). Сейчас —
    «antivirus»: вид столбца «Антивирусы». Нет строки — значения по умолчанию."""
    __tablename__ = "app_settings"

    key = Column(Text, primary_key=True)
    value = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
