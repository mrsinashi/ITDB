"""Описание встроенных столбцов ПК — одно место для всего: таблица, карточка,
История, Справочники (фронт получает его через GET /api/columns), выгрузка
в Excel, правка полей и массовая правка на сервере.

Новый встроенный столбец — одна строка в COLUMNS (и, если нужно, в CARD_GROUPS).
Пользовательские поля сюда не входят: они в field_defs и добавляются к
встроенным перед «Статус»."""
import re
from typing import Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["columns"])

# Как поле хранится и правится:
#   text      — строка в computers (пробелы по краям убираются)
#   multiline — несколько строк в computers (пустые строки убираются)
#   ip, mac   — несколько значений через перенос строки (MAC прописными)
#   seat      — № места, целое число
#   date      — дата (в API — «ДД.ММ.ГГГГ»); просроченная подсвечивается
#   extra     — значение в computers.extra под ключом extra_key
#   user      — основной пользователь (связь с people)
#   vacuum    — логины VACUUM (связь с vacuum_accounts)
#   location  — часть пути расположения; меняется выбором узла (location_id)
#   scan      — только из сканера, в computers не хранится и не правится
#               (антивирусы — из записей GLPI / GSIT, этап 26д)
Kind = Literal["text", "multiline", "ip", "mac", "seat", "date", "extra", "user", "vacuum", "location", "scan"]


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
    # В карточке — без расшифровки в скобках: «Процессор (ЦП / CPU)» → «Процессор»
    card = flags.pop("card", None) or re.sub(r"\s*\(.*\)$", "", title)
    # Подсказки при вводе — у столбцов с повторяющимися значениями в одну строку
    # (статус, ТИП, OS, модель, CPU…); у уникальных (имя, ИНВ) и дат — нет
    flags.setdefault("suggest", flags.get("values", "yes") == "yes" and kind in ("text", "extra"))
    return Column(key=key, short=short, title=title, card=card, kind=kind, **flags)


# Порядок — как в таблице и в выгрузке
COLUMNS = [
    col("user", "ФИО", kind="user", values="no", export_width=25),
    col("building", "Адрес", kind="location", card_copy=True, export_width=16, card_always=True),
    col("department", "Отделение", kind="location", card_copy=True, export_width=14, card_always=True),
    col("floor", "Эт.", "Этаж", kind="location", center=True, export_width=6),
    col("room_code", "Каб", "№ Кабинета", kind="location", center=True, values="no", card_copy=True, export_width=8, card_always=True),
    col("room_name", "Кабинет", kind="location", export_width=18),
    col("seat_no", "№", "№ Места", kind="seat", center=True, values="no", bulk=False, export_width=6),
    col("hostname", "HOSTNAME", link=True, sticky=True, bold=True, values="no", dup=True, bulk=False, export_width=18),
    col("ip", "IP", "IP адрес", kind="ip", sticky=True, multiline=True, values="subnet", card_copy=True, dup=True, bulk=False, export_width=16, card_always=True),
    col("vacuum", "VACUUM", "Vacuum", kind="vacuum", multiline=True, values="no", dup=True, bulk=False, export_width=16),
    col("os", "OS", "Операционная система (ОС / OS)", center=True, card_copy=True, export_width=14, card_always=True),
    col("type", "ТИП", "Тип компьютера", center=True, export_width=10, card_always=True),
    col("model", "Модель", center=True, card_copy=True, export_width=16),
    col("cpu", "CPU", "Процессор (ЦП / CPU)", center=True, card_copy=True, export_width=20, card_always=True),
    col("ram", "RAM", "Оперативная память (ОЗУ / RAM)", center=True, export_width=7, card_always=True),
    col("drive", "DRIVE", "Дисковые накопители (DRIVE)", kind="multiline", center=True, multiline=True, card_copy=True, export_width=16),
    col("gpu", "GPU", "Видеокарта (ГП / GPU)", center=True, card_copy=True, export_width=16),
    col("mac", "MAC", "MAC адрес", kind="mac", multiline=True, values="no", card_copy=True, dup=True, bulk=False, export_width=20),
    col("vnc", "VNC", "Тип VNC", center=True, hidden=True, export_width=8),
    col("antivirus", "Антивирус", "Антивирусы", kind="scan", multiline=True, values="no", bulk=False, export_width=30),
    col("inv_no", "ИНВ", "Инвентарный номер", values="no", card_copy=True, dup=True, bulk=False, export_width=10),
    col("serial", "Серийный", "Серийный номер", values="no", card_copy=True, hidden=True, dup=True, bulk=False, export_width=16),
    col("glpi_id", "GLPI", "GLPI ID", center=True, values="no", card_copy=True, hidden=True, dup=True, bulk=False, export_width=8),
    col("gsit", "GSIT", kind="extra", extra_key="GSIT", center=True, export_width=8),
    col("state", "Сост.", kind="extra", extra_key="Сост.", center=True, export_width=8),
    col("label", "Метка", kind="extra", extra_key="Метка", center=True, export_width=10),
    col("status", "Статус", center=True, export_width=10),
    col("temp_until", "Временно до", "Временно, до…", kind="date", center=True, values="no", hidden=True, export_width=12),
    col("note", "Примечание", kind="multiline", multiline=True, note=True, max_width=200, values="no", export_width=30, card_always=True),
]

COLUMNS_BY_KEY = {column.key: column for column in COLUMNS}

# Карточка ПК: группы строк по порядку. room_code — строка «Кабинет»
# («[214] Процедурная», вместе с room_name); user_fields — пользовательские поля.
# ФИО и VACUUM в карточке показываются отдельным блоком, HOSTNAME — в заголовке.
CARD_GROUPS = [
    (None, ["status", "temp_until"]),
    ("Размещение", ["building", "department", "floor", "room_code", "seat_no"]),
    ("Сеть", ["ip", "mac", "vnc"]),
    ("Оборудование", ["type", "model", "os", "cpu", "ram", "drive", "gpu", "antivirus"]),
    ("Учёт", ["inv_no", "serial", "glpi_id", "gsit", "state", "label"]),
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
    "temp_note": "Временно, до…",  # до этапа 16 — текстовое поле
}


def keys_of(*kinds):
    return {column.key for column in COLUMNS if column.kind in kinds}


# Поля, которые правятся в PATCH (кроме location_id и пользовательских)
EDITABLE_KEYS = {column.key for column in COLUMNS if column.kind not in ("location", "scan")}

# Нельзя менять всем выбранным сразу: расположение и № места — через
# «Переместить», значения, которые у каждого ПК свои, — по одному
BULK_EXCLUDED = {"location_id"} | {column.key for column in COLUMNS if not column.bulk}

# Встроенные поля в computers.extra: ключ в API → ключ в extra
EXTRA_FIELDS = {column.key: column.extra_key for column in COLUMNS if column.kind == "extra"}


class CardGroup(BaseModel):
    title: Optional[str]
    fields: list[str]


class ColumnsInfo(BaseModel):
    columns: list[Column]
    card_groups: list[CardGroup]
    history_labels: dict[str, str]


@router.get("/columns", response_model=ColumnsInfo)
def list_columns():
    return ColumnsInfo(
        columns=COLUMNS,
        card_groups=[CardGroup(title=title, fields=fields) for title, fields in CARD_GROUPS],
        history_labels=HISTORY_LABELS,
    )
