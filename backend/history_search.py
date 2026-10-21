"""Поиск по Истории на сервере (этап 53; раньше страница догружала всю Историю в браузер).
Ищет то же, что искала страница: каждое слово – в названии объекта, пользователе, виде
объекта, времени («ДД.ММ.ГГГГ чч:мм:сс» по поясу браузера), ключе и подписи поля,
значениях «было» и «стало» (как displayValue). Слово, которого нет ни в одной записи, –
в другой раскладке, часть IP – с точками (как searchWordsIn в js/util.js)."""
import json
import re

from api_columns import (
    COLUMNS, HISTORY_LABELS, IP_COLUMNS, IP_HISTORY_LABELS, MOVE_COLUMNS, MOVE_HISTORY_LABELS, PRINTER_COLUMNS,
    PRINTER_HISTORY_LABELS,
)
from history_labels import ENTITY_LABELS, LOCATION_FIELD_LABELS, SIMPLE_FIELD_LABELS
from models import FieldDef

# Клавиши английской и русской раскладки (как в js/util.js)
LAYOUT_EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`"
LAYOUT_RU = "йцукенгшщзхъфывапролджэячсмитьбю.ё"
TO_RU = dict(zip(LAYOUT_EN, LAYOUT_RU))
TO_EN = dict(zip(LAYOUT_RU, LAYOUT_EN))


def norm(text):
    return str(text).lower().replace("ё", "е")


def search_words(query):
    return norm(query or "").split()


def other_layout(word):
    """Слово, набранное в другой раскладке; "" – если менять нечего."""
    mapping = TO_EN if re.search("[а-яё]", word) else (TO_RU if re.search("[a-z]", word) else None)

    if mapping is None:
        return ""

    out = "".join(mapping.get(ch, ch) for ch in word)
    return norm(out) if out != word else ""


def ip_dots(word):
    """Часть IP с «,», «/», «ю» или «б» вместо точки: «10,0/3» → «10.0.3»."""
    if re.fullmatch(r"[0-9.,/юб]*[0-9][0-9.,/юб]*", word) and re.search(r"[,/юб]", word):
        return re.sub(r"[,/юб]", ".", word)

    return ""


def pick_words(words, everything):
    """Слова поиска: которого нет нигде (everything – все тексты одной строкой), – в другой
    раскладке или с точками, если так оно где-то есть."""
    result = []

    for word in words:
        if word not in everything:
            alt, ip = other_layout(word), ip_dots(word)
            word = alt if alt and alt in everything else (ip if ip and ip in everything else word)

        result.append(word)

    return result


def js_text(value):
    """Значение так, как его пишет страница (displayValue): пусто, да / нет, JSON, текст."""
    if value is None:
        return ""

    if isinstance(value, bool):
        return "да" if value else "нет"

    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    if isinstance(value, float) and value.is_integer():
        return str(int(value))

    return str(value)


class FieldLabels:
    """Подписи полей – как fieldLabel в js/mixins/common.js."""

    def __init__(self, session):
        self.computers = {column.key: column.card for column in COLUMNS} | HISTORY_LABELS
        self.printers = {column.key: column.card for column in PRINTER_COLUMNS} | PRINTER_HISTORY_LABELS
        self.moves = {column.key: column.card for column in MOVE_COLUMNS} | MOVE_HISTORY_LABELS
        self.ips = {column.key: column.card for column in IP_COLUMNS} | IP_HISTORY_LABELS
        self.extra = {column.extra_key: column.key for column in COLUMNS if column.extra_key}
        self.defs = {fd.key: fd.label for fd in session.query(FieldDef).filter(FieldDef.archived == False)}  # noqa: E712
        self.known = {}

    def label(self, entity, field):
        key = (entity, field)

        if key not in self.known:
            self.known[key] = self.find(entity, field) or ""

        return self.known[key]

    def find(self, entity, field):
        if entity == "locations":
            return LOCATION_FIELD_LABELS.get(field) or field

        if entity == "printers":
            return self.printers.get(field) or field

        if entity == "moves":
            return self.moves.get(field) or field

        if entity in ("ip_entries", "ip_notes"):
            return self.ips.get(field) or field

        if entity == "printer_models" and field == "color":
            return "Печать"

        if entity != "computers":
            return SIMPLE_FIELD_LABELS.get(field) or field

        if field.startswith("extra."):
            field = field[6:]

            if field in self.extra:
                return self.computers.get(self.extra[field])

        return self.computers.get(field) or self.defs.get(field) or field


def record_text(row, title, labels):
    """Текст записи для поиска (row – строка Истории со временем local, как на странице)."""
    parts = [title or "", row.user_name or "", ENTITY_LABELS.get(row.entity) or row.entity, row.local]

    for field, change in (row.changes or {}).items():
        change = change or {}
        parts += [field, labels.label(row.entity, field), js_text(change.get("old")), js_text(change.get("new"))]

    return norm("\n".join(parts))


def search(session, rows, query, title_of):
    """Записи rows (в том же порядке), где есть все слова query."""
    labels = FieldLabels(session)
    texts = [record_text(row, title_of(row), labels) for row in rows]
    words = pick_words(search_words(query), "\n".join(texts))
    return [row for row, text in zip(rows, texts) if all(word in text for word in words)]
