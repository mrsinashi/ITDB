"""Описание встроенных столбцов ПК – одно место для всего: таблица, карточка,
История, Справочники (фронт получает его через GET /api/columns), выгрузка
в Excel, правка полей и массовая правка на сервере.

Новый встроенный столбец – одна строка в COLUMNS (и, если нужно, в CARD_GROUPS).
Пользовательские поля сюда не входят: они в field_defs и добавляются к
встроенным перед «Статус». Столбцы таблицы принтеров (этап 44) – здесь же,
PRINTER_COLUMNS и PRINTER_CARD_GROUPS; журнала «Движение» (этап 66) – MOVE_COLUMNS."""
import re
from typing import Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["columns"])

# Как поле хранится и правится:
#   text      – строка в computers (пробелы по краям убираются)
#   multiline – несколько строк в computers (пустые строки убираются)
#   ip, mac   – несколько значений через перенос строки (MAC прописными)
#   seat      – № места, целое число
#   date      – дата (в API – «ДД.ММ.ГГГГ»); просроченная подсвечивается
#   extra     – значение в computers.extra под ключом extra_key
#   user      – основной пользователь (связь с people)
#   vacuum    – логины VACUUM (связь с vacuum_accounts)
#   location  – часть пути расположения; меняется выбором узла (location_id)
#   scan      – только из сканера, в computers не хранится и не правится
#               (антивирусы – из записей GLPI / GSIT, этап 26д)
# Принтеры (этап 44):
#   printers  – у ПК: подключённые принтеры (связь printer_computers), строками
#               «имя» или «имя [usb]»
#   computers – у принтера: ПК, к которым он подключён, так же
#   pmodel    – модель принтера из справочника (выбор модели)
#   pattr     – значение модели (тип, производитель, печать, дуплекс): у принтера
#               не правится – меняется модель или сама модель в справочнике
#   flag      – «есть» / «нет» (веб-страница)
#   secret    – логин и пароль от веб-страницы: в таблице – только задан ли
#               (точками; показ – по паролю, этап 45)
#   cartridges – картриджи модели принтера (этап 47): строками; правка ячейки
#               меняет модель (cartridges.py)
# Журнал «Движение» (этап 66, api_moves.py) – правятся в окне записи, не в ячейке:
#   mtype     – тип техники или компонента (справочник item_types)
#   mtitle    – столбец «Своё название» (до правок 2 этапа 66 – «Понятное название»): поле
#               «Своё название» и в скобках поля типа, у принтера – модель из справочника
#   mkit      – комплект компьютера («Мышь, Клавиатура»; правки этапа 66)
#   pdate     – дата, где день и месяц можно не знать: «02.08.2026», «08.2026», «2026»
#   mdest     – куда: узел дерева или ПК, строками («Терапия», «[326] Ординаторская», имя ПК)
#   muser     – кто установил: пользователь программы («Фамилия И.О.») или вписанное имя
Kind = Literal[
    "text", "multiline", "ip", "mac", "seat", "date", "extra", "user", "vacuum", "location", "scan",
    "printers", "computers", "pmodel", "pattr", "flag", "secret", "cartridges",
    "mtype", "mtitle", "mkit", "pdate", "mdest", "muser",
]


class Column(BaseModel):
    key: str
    short: str                      # в шапке таблицы и в выгрузке
    title: str                      # в меню «Столбцы», Истории, Справочниках
    card: str                       # в карточке ПК
    kind: Kind
    extra_key: Optional[str] = None
    multiline: bool = False         # значения через перенос строки
    center: bool = False
    sticky: bool = False            # не уезжает при прокрутке вбок
    bold: bool = False
    link: bool = False              # клик открывает карточку
    note: bool = False              # длинный текст: подсказка при наведении
    max_width: Optional[int] = None
    values: Literal["yes", "no", "subnet"] = "yes"  # оформление значений в Справочниках
    card_copy: bool = False         # значок копирования в карточке
    card_always: bool = False       # в карточке всегда, даже пустое
    hidden: bool = False            # скрыт в таблице по умолчанию
    dup: bool = False               # дубли подсвечиваются красным
    bulk: bool = True               # можно менять сразу у нескольких ПК
    export_width: int = 12          # ширина в выгрузке Excel
    suggest: bool = False           # подсказки при вводе (значения справочника и столбца)


def col(key, short, title=None, kind="text", **flags):
    title = title or short
    # В карточке – без расшифровки в скобках: «Процессор (ЦП / CPU)» → «Процессор»
    card = flags.pop("card", None) or re.sub(r"\s*\(.*\)$", "", title)
    # Подсказки при вводе – у столбцов с повторяющимися значениями в одну строку
    # (статус, тип, OS, модель, CPU…); у уникальных (имя, ИНВ) и дат – нет
    flags.setdefault("suggest", flags.get("values", "yes") == "yes" and kind in ("text", "extra"))
    return Column(key=key, short=short, title=title, card=card, kind=kind, **flags)


# Порядок – как в таблице и в выгрузке
COLUMNS = [
    col("user", "ФИО", kind="user", values="no", export_width=25),
    col("building", "Адрес", kind="location", card_copy=True, export_width=16, card_always=True),
    col("department", "Отделение", kind="location", card_copy=True, export_width=14, card_always=True),
    col("floor", "Эт.", "Этаж", kind="location", center=True, export_width=6),
    col("room_code", "Каб", "№ кабинета", kind="location", center=True, values="no", card_copy=True, export_width=8, card_always=True),
    col("room_name", "Кабинет", kind="location", export_width=18),
    col("seat_no", "№", "№ места", kind="seat", center=True, values="no", bulk=False, export_width=6),
    col("hostname", "HOSTNAME", link=True, sticky=True, values="no", dup=True, bulk=False, export_width=18),
    col("ip", "IP", "IP адрес", kind="ip", sticky=True, multiline=True, values="subnet", card_copy=True, dup=True, bulk=False, export_width=16, card_always=True),
    col("vacuum", "VACUUM", kind="vacuum", multiline=True, values="no", dup=True, bulk=False, export_width=16),
    col("os", "OS", "Операционная система (ОС / OS)", center=True, card_copy=True, export_width=14, card_always=True),
    col("type", "Тип", "Тип компьютера", center=True, export_width=10, card_always=True),
    col("model", "Модель", center=True, card_copy=True, export_width=16),
    col("motherboard", "Мат. плата", "Материнская плата", center=True, card_copy=True, export_width=18),
    col("cpu", "CPU", "Процессор (ЦП / CPU)", center=True, card_copy=True, export_width=20, card_always=True),
    col("ram", "RAM", "Оперативная память (ОЗУ / RAM)", center=True, export_width=7, card_always=True),
    col("drive", "DRIVE", "Дисковые накопители (DRIVE)", kind="multiline", center=True, multiline=True, card_copy=True, export_width=16),
    col("gpu", "GPU", "Видеокарта (ГП / GPU)", center=True, card_copy=True, export_width=16),
    col("mac", "MAC", "MAC адрес", kind="mac", multiline=True, values="no", card_copy=True, dup=True, bulk=False, export_width=20),
    col("vnc", "VNC", "Тип VNC", center=True, hidden=True, export_width=8),
    col("printers", "Принтеры", kind="printers", multiline=True, values="no", bulk=False, export_width=22),
    col("antivirus", "Антивирус", "Антивирусы", kind="scan", center=True, multiline=True, values="no", bulk=False, export_width=30),
    col("inv_no", "ИНВ", "Инвентарный номер", values="no", card_copy=True, dup=True, bulk=False, export_width=10),
    col("serial", "Серийный", "Серийный номер", values="no", card_copy=True, hidden=True, dup=True, bulk=False, export_width=16),
    col("glpi_id", "GLPI", "GLPI ID", center=True, values="no", card_copy=True, hidden=True, dup=True, bulk=False, export_width=8),
    col("gsit_id", "GSIT", "GSIT ID", center=True, values="no", card_copy=True, dup=True, bulk=False, export_width=8),
    # «Агент» – есть ли на ПК агент GLPI / GSIT (до 26ж столбец назывался «GSIT»; ключ в extra прежний)
    col("gsit", "Агент", kind="extra", extra_key="GSIT", center=True, export_width=8),
    col("state", "Сост.", kind="extra", extra_key="Сост.", center=True, export_width=8),
    col("label", "Метка", kind="extra", extra_key="Метка", center=True, export_width=10),
    col("status", "Статус", center=True, export_width=10),
    col("temp_until", "Временно до", kind="date", center=True, values="no", hidden=True, export_width=12),
    col("note", "Примечание", kind="multiline", multiline=True, note=True, max_width=200, values="no", export_width=30, card_always=True),
]

COLUMNS_BY_KEY = {column.key: column for column in COLUMNS}

# Карточка ПК: группы строк по порядку. room_code – строка «Кабинет»
# («[214] Процедурная», вместе с room_name); user_fields – пользовательские поля.
# ФИО и VACUUM в карточке показываются отдельным блоком, HOSTNAME – в заголовке.
CARD_GROUPS = [
    (None, ["status", "temp_until"]),
    ("Размещение", ["building", "department", "floor", "room_code", "seat_no"]),
    ("Сеть", ["ip", "mac", "vnc", "printers"]),
    ("Оборудование", ["type", "model", "motherboard", "os", "cpu", "ram", "drive", "gpu", "antivirus"]),
    ("Учёт", ["inv_no", "serial", "glpi_id", "gsit_id", "gsit", "state", "label"]),
    ("Прочее", ["user_fields", "note"]),
]

# Подписи в Истории для записей, которые не столбцы
HISTORY_LABELS = {
    "location_id": "Расположение",
    "seat_sort": "Порядок строки",
    "archived": "Архив",
    "replaced": "Заменил",
    "replaced_by": "Заменён на",
    "created": "Создан",
    "deleted": "Удалено",
    "temp_note": "Временно до",  # до этапа 16 – текстовое поле
}


def keys_of(*kinds):
    return {column.key for column in COLUMNS if column.kind in kinds}


# Поля, которые правятся в PATCH (кроме location_id и пользовательских)
EDITABLE_KEYS = {column.key for column in COLUMNS if column.kind not in ("location", "scan")}


# ---------- Принтеры (этап 44) ----------

# Порядок – как в таблице принтеров и в выгрузке
PRINTER_COLUMNS = [
    col("building", "Адрес", kind="location", card_copy=True, export_width=16, card_always=True),
    col("department", "Отделение", kind="location", card_copy=True, export_width=14, card_always=True),
    col("floor", "Эт.", "Этаж", kind="location", center=True, export_width=6),
    col("room_code", "Каб", "№ кабинета", kind="location", center=True, values="no", card_copy=True, export_width=8, card_always=True),
    col("room_name", "Кабинет", kind="location", export_width=18),
    col("number", "№", "№ в кабинете", kind="seat", center=True, values="no", bulk=False, export_width=6, card_always=True),
    col("name", "Имя", link=True, sticky=True, values="no", card_copy=True, dup=True, bulk=False, export_width=22),
    col("ip", "IP", "IP адрес", kind="ip", sticky=True, multiline=True, values="subnet", card_copy=True, dup=True, bulk=False, export_width=16, card_always=True),
    col("computers", "Компьютеры", kind="computers", multiline=True, values="no", bulk=False, export_width=24, card_always=True),
    col("kind", "Тип", kind="pattr", center=True, export_width=9, card_always=True),
    col("maker", "Производитель", kind="pattr", center=True, export_width=14, card_always=True),
    col("model", "Модель", kind="pmodel", center=True, card_copy=True, suggest=True, export_width=20, card_always=True),
    col("color", "Печать", kind="pattr", center=True, export_width=9),
    col("duplex", "Дуплекс", kind="pattr", center=True, export_width=9),
    col("cartridges", "Картриджи", kind="cartridges", multiline=True, values="no", bulk=False, export_width=18),
    col("web", "Web", "Веб-страница", kind="flag", center=True, suggest=True, export_width=6),
    col("web_auth", "Доступ", "Доступ (логин и пароль Web)", kind="secret", center=True, values="no", bulk=False, export_width=8),
    col("mac", "MAC", "MAC адрес", kind="mac", multiline=True, values="no", card_copy=True, dup=True, bulk=False, export_width=20),
    col("inv_no", "ИНВ", "Инвентарный номер", values="no", card_copy=True, dup=True, bulk=False, export_width=10),
    col("serial", "Серийный", "Серийный номер", values="no", card_copy=True, dup=True, bulk=False, export_width=16),
    col("note", "Примечание", kind="multiline", multiline=True, note=True, max_width=200, values="no", export_width=30, card_always=True),
]

PRINTER_COLUMNS_BY_KEY = {column.key: column for column in PRINTER_COLUMNS}

# Карточка принтера: группы строк, как у ПК; имя – в заголовке; ссылка Web и вход –
# своими строками (в таблице ссылки нет)
PRINTER_CARD_GROUPS = [
    ("Размещение", ["building", "department", "floor", "room_code", "number"]),
    ("Сеть", ["ip", "mac", "web", "web_url", "web_auth", "computers"]),
    ("Модель", ["kind", "maker", "model", "color", "duplex", "cartridges"]),
    ("Учёт", ["inv_no", "serial"]),
    ("Прочее", ["note"]),
]

# Подписи в Истории принтера для записей, которые не столбцы
PRINTER_HISTORY_LABELS = {
    "location_id": "Расположение",
    "web_url": "Ссылка Web",
    "web_login": "Логин Web",
    "web_password": "Пароль Web",
    "archived": "Архив",
    "created": "Создан",
    "deleted": "Удалено",
}

# Поля принтера, которые правятся в PATCH (кроме location_id): значения модели – нет
PRINTER_EDITABLE_KEYS = {
    column.key for column in PRINTER_COLUMNS if column.kind not in ("location", "pattr", "secret")
} | {"web_url"}

PRINTER_BULK_EXCLUDED = {"location_id"} | {column.key for column in PRINTER_COLUMNS if not column.bulk}

# Нельзя менять всем выбранным сразу: расположение и № места – через
# «Переместить», значения, которые у каждого ПК свои, – по одному
BULK_EXCLUDED = {"location_id"} | {column.key for column in COLUMNS if not column.bulk}

# Встроенные поля в computers.extra: ключ в API → ключ в extra
EXTRA_FIELDS = {column.key: column.extra_key for column in COLUMNS if column.kind == "extra"}


# ---------- Журнал «Движение» (этап 66) ----------

# Порядок и названия – как в журнале пользователя (Excel); закреплены, как там, «Тип» и
# «Название по 1С». Ключи тип и статус – свои (item_type, move_status): у ПК есть свои
# «Тип» и «Статус» со справочниками и оформлением, общий ключ смешал бы их значения.
# «Комплект» (мышь, клавиатура…) – у компьютера, перед инвентарным (правки этапа 66)
MOVE_COLUMNS = [
    col("item_type", "Тип", kind="mtype", sticky=True, center=True, bulk=False, export_width=12),
    col("name_1c", "Название по 1С", sticky=True, export_width=36),
    col("title", "Своё название", kind="mtitle", link=True, values="no", bulk=False, export_width=55),
    col("kit", "Комплект", kind="mkit", max_width=150, values="no", bulk=False, export_width=18),
    # IP компьютера, принтера и МФУ (этап 67): свой ключ – оформление подсетей ПК не смешивается
    col("move_ip", "IP", multiline=True, values="no", bulk=False, export_width=16),
    col("inv_no", "Инвентарный", values="no", bulk=False, export_width=12),
    col("serial", "Серийный номер", values="no", dup=True, bulk=False, export_width=16),
    col("country", "Страна производства", export_width=18),
    col("made", "Дата производства", kind="pdate", center=True, values="no", bulk=False, export_width=12),
    col("bought", "Дата закупки", kind="pdate", center=True, values="no", bulk=False, export_width=12),
    col("supplier", "Поставщик", export_width=18),
    col("source", "Откуда", export_width=12),
    col("received", "Дата получения", kind="pdate", center=True, values="no", bulk=False, export_width=12),
    col("dest", "Куда", kind="mdest", multiline=True, values="no", bulk=False, export_width=24),
    col("installed", "Дата установки", kind="pdate", center=True, values="no", bulk=False, export_width=12),
    col("installer", "Установил", kind="muser", values="no", bulk=False, export_width=16),
    col("move_status", "Статус", center=True, export_width=12),
    col("note", "Примечание", kind="multiline", multiline=True, note=True, max_width=200, values="no", export_width=30),
]

MOVE_COLUMNS_BY_KEY = {column.key: column for column in MOVE_COLUMNS}

# Поля типа (в specs записи; в «Понятном названии» – все, кроме комплекта и IP) – подписи для
# окна записи и Истории
MOVE_SPEC_LABELS = {
    "pc_kind": "Тип компьютера",
    "cpu": "Процессор",
    "ram": "ОЗУ",
    "disk_kind": "Тип диска",
    "disk_size": "Объём диска",
    "gpu": "Видеокарта",
    "diagonal": "Диагональ",
    "resolution": "Разрешение",
    "interface": "Интерфейс",
    "ram_kind": "Тип памяти",
    "freq": "Частота",
    "size": "Объём",
    "info": "Информация",
    "kit": "Комплект",
    "move_ip": "IP",
}

# Подписи в Истории записи журнала для полей, которые не столбцы. model – «Своё название»
# (до правок этапа 66 – «Модель»): у любого типа, в «Понятном названии» – перед скобками
MOVE_HISTORY_LABELS = dict(
    MOVE_SPEC_LABELS,
    model="Своё название",
    printer_model="Модель принтера",
    archived="Архив",
    created="Создан",
    deleted="Удалено",
)


class CardGroup(BaseModel):
    title: Optional[str]
    fields: list[str]


class ColumnsInfo(BaseModel):
    columns: list[Column]
    card_groups: list[CardGroup]
    history_labels: dict[str, str]
    # Таблица принтеров (этап 44)
    printer_columns: list[Column]
    printer_card_groups: list[CardGroup]
    printer_history_labels: dict[str, str]
    # Журнал «Движение» (этап 66)
    move_columns: list[Column]
    move_history_labels: dict[str, str]


@router.get("/columns", response_model=ColumnsInfo)
def list_columns():
    return ColumnsInfo(
        columns=COLUMNS,
        card_groups=[CardGroup(title=title, fields=fields) for title, fields in CARD_GROUPS],
        history_labels=HISTORY_LABELS,
        printer_columns=PRINTER_COLUMNS,
        printer_card_groups=[CardGroup(title=title, fields=fields) for title, fields in PRINTER_CARD_GROUPS],
        printer_history_labels=PRINTER_HISTORY_LABELS,
        move_columns=MOVE_COLUMNS,
        move_history_labels=MOVE_HISTORY_LABELS,
    )
