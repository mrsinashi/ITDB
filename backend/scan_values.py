"""Сравнение значений из GLPI / GSIT со значениями таблицы и «твои названия»
(этап 25б).

Одно и то же в разных системах называется по-разному: «Win 10» / «Windows 10»,
«Pentium J3710» / «Intel Pentium J3710», «Lenovo ThinkCentre M600» / «M600».
Главное — как записано в таблице ITDB. Поэтому:

1. Сравнение по смыслу (same_line): текст разбивается на слова, слова-шум
   (Intel, Microsoft, Pro, 22H2, CPU, частота…) отбрасываются, синонимы
   сводятся (win → windows); если слова одного значения все есть в другом —
   это одно и то же. У многострочных (IP, MAC, диски) — по строкам: в таблице
   записана часть того, что видит источник, — не отличие («≈»); у IP и MAC в
   таблице всё, что видит источник, и ещё что-то — тоже «=». ОЗУ — числом,
   объём диска — как на наклейке (с 26е: 240, 250 и 256 ГБ — разные диски).
2. Название для таблицы (Names.canonical): значение источника переводится в
   название из таблицы — по соответствию, заданному вручную («одно и то же»,
   scan_aliases), по тому, как это значение уже названо у сопоставленных ПК
   («выучено»), или по похожему значению столбца / Справочника. Не нашлось —
   остаётся как в источнике.
3. Вручную можно сказать и «это разное» — тогда похожие значения не
   считаются одинаковыми.
4. «В таблице своё» (этап 26, случай «ЕГИСЗ»): пара «значение источника —
   значение таблицы» — не расхождение, в таблице так и оставить. Но это не
   «одно и то же»: из такой пары ничего не учится, и ПК без значения в таблице
   получит значение источника, а не табличное.
5. «Это материнская плата» (этап 26ж): название, которое источник отдаёт как
   модель ПК, уходит в столбец «Мат. плата» — у всех ПК (route_values).
"""
import re
from collections import Counter, defaultdict
from functools import lru_cache

from scan_normalize import norm_mac

# Поля записи источника по видам сравнения
EXACT_FIELDS = ("hostname", "serial")          # без учёта регистра
SET_FIELDS = ("ip", "mac")                     # набор значений, точно
NAME_FIELDS = ("model", "motherboard", "os", "cpu", "gpu", "vnc", "drive")  # названия: по смыслу и словарю
MULTI_NAME_FIELDS = ("drive", "gpu", "vnc")
NUMBER_FIELDS = ("ram",)
COMPARE_FIELDS = ["hostname", "ip", "mac", "serial", "model", "motherboard", "os", "cpu", "ram", "drive", "gpu", "vnc"]

# Слова, которые не отличают одно значение от другого
NOISE = {
    # производители и служебное
    "intel", "amd", "microsoft", "майкрософт", "corporation", "corp", "inc", "ltd", "co",
    "computer", "technology", "cpu", "processor", "with", "gen", "the",
    # ОС: редакции, разрядность, выпуски
    "pro", "professional", "профессиональная", "home", "домашняя", "enterprise",
    "корпоративная", "education", "для", "образовательных", "учреждений", "ltsc", "ltsb",
    "x64", "x86", "64-bit", "32-bit", "edition", "sp1", "sp2", "n",
    # единицы
    "gb", "гб", "mb", "мб", "tb", "тб",
}
SYNONYMS = {
    "win": "windows",
    "hewlett-packard": "hp",
    "hewlett": "hp",
    "packard": "hp",
    "geforce": "",
    "nvidia": "",
}


def clean_text(text):
    return " ".join(str(text or "").split())


def key_of(text):
    """Ключ значения для соответствий: без регистра и лишних пробелов."""
    return clean_text(text).lower().replace("ё", "е")


@lru_cache(maxsize=20000)
def tokens(text):
    """Значимые слова значения (frozenset; повторы — из кэша)."""
    text = key_of(text)
    text = re.sub(r"\((r|tm|c)\)|®|™", " ", text)
    text = re.sub(r"@\s*[\d.,]+\s*[gm]hz|[\d.,]+\s*[gm]hz", " ", text)   # частота
    text = re.sub(r"\(\s*[\d.]+\s*\)", " ", text)                          # (10.0.19045)
    text = re.sub(r"\b\d{2}h\d\b", " ", text)                               # 22H2
    text = re.sub(r"\b\d+(st|nd|rd|th)\b", " ", text)                       # 12th gen
    text = re.sub(r"\b\d+-core\b", " ", text)
    text = re.sub(r"(?<=[a-z])vnc\b", " vnc", text)                         # tightvnc → tight vnc
    result = set()

    for word in re.split(r"[^\w.+-]+", text):
        word = word.strip(".-")

        if not word:
            continue

        word = SYNONYMS.get(word, word)

        if word and word not in NOISE:
            result.add(word)

    return frozenset(result)


def lines_of(value):
    return [clean_text(line) for line in str(value or "").splitlines() if clean_text(line)]


def number_of(text):
    found = re.search(r"\d+(?:[.,]\d+)?", str(text or ""))
    return float(found.group(0).replace(",", ".")) if found else None


DRIVE_RE = re.compile(r"^\s*(ssd|hdd|nvme)?\s*([\d.,]+)\s*(tb|тб|gb|гб)?\s*$", re.I)


def drive_parts(line):
    """«SSD 250» → ("ssd", 250.0); «HDD 1TB» → ("hdd", 1000.0); иначе None."""
    found = DRIVE_RE.match(line or "")

    if not found:
        return None

    size = float(found.group(2).replace(",", "."))

    if (found.group(3) or "").lower() in ("tb", "тб"):
        size *= 1000

    kind = (found.group(1) or "").lower() or None
    return ("ssd" if kind == "nvme" else kind), size


def model_marks(words):
    """«Номерные» слова — буквы с цифрами: g6, m600, j3710, i5-10400."""
    return {w for w in words if re.search(r"\d", w) and re.search(r"[a-zа-я]", w)}


def same_line(field, a, b, strict=False):
    """Одно ли это значение (без словаря). strict — для подстановки названия
    другим ПК: в более коротком должны быть все «номерные» слова длинного
    («HP ProDesk 400» не название для «HP ProDesk 400 G6 MT», а «M600» —
    для «Lenovo ThinkCentre M600» да)."""
    if key_of(a) == key_of(b):
        return True

    if field == "drive":
        pa, pb = drive_parts(a), drive_parts(b)

        if pa and pb:
            same_kind = not pa[0] or not pb[0] or pa[0] == pb[0]
            # Объём с наклейки (этап 26е: 240, 250 и 256 — разные диски); 1TB = 1000
            return same_kind and abs(pa[1] - pb[1]) <= max(pa[1], pb[1]) * 0.01

    if field in NUMBER_FIELDS:
        na, nb = number_of(a), number_of(b)
        return na is not None and nb is not None and abs(na - nb) < 0.3

    ta, tb = tokens(a), tokens(b)

    if not ta or not tb:
        return False

    if not (ta <= tb or tb <= ta):
        return False

    if strict:
        short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
        return model_marks(long_) <= short

    return True


def board_names(aliases):
    """{ключ названия модели в источнике: как писать в «Мат. плате»}."""
    return {key_of(a["source"]): a["table"] for a in aliases if a["kind"] == "board" and a["field"] == "model"}


def route_values(values, boards):
    """Значения записи источника по столбцам таблицы: «модель», помеченная как
    материнская плата, идёт в «Мат. плату», а модели у записи нет."""
    model = (values or {}).get("model")

    if not model or key_of(model) not in boards:
        return values or {}

    return dict(values, model=None, motherboard=boards[key_of(model)])


class Names:
    """Словарь названий: соответствия вручную, выученные по таблице, значения
    столбцов. aliases — [{"field", "source", "table", "kind"}] (kind same /
    differ); table_values — {поле: Counter(значение)}; choices — {поле: [значения]};
    pairs — [(поле, значение источника, значение таблицы)] у сопоставленных ПК."""

    def __init__(self, aliases=(), table_values=None, choices=None, pairs=()):
        self.same = {}
        self.differ = defaultdict(set)
        self.keep = defaultdict(set)
        aliases = list(aliases)
        self.boards = board_names(aliases)

        for alias in aliases:
            key = (alias["field"], key_of(alias["source"]))

            if alias["kind"] == "board":
                continue
            elif alias["kind"] == "same":
                self.same[key] = alias["table"]
            elif alias["kind"] == "keep":
                self.keep[key].add(key_of(alias["table"]))
            else:
                self.differ[key].add(key_of(alias["table"]))

        self.table_values = table_values or {}
        self.choices = choices or {}
        self.learned = defaultdict(Counter)
        self.learned_source = {}   # ключ → как значение записано в источнике
        self._canonical = {}

        for field, source, table in pairs:
            for s_line in lines_of(source) if field in MULTI_NAME_FIELDS else [source]:
                for t_line in lines_of(table) if field in MULTI_NAME_FIELDS else [table]:
                    if self.is_keep(field, s_line, t_line):
                        break   # «в таблице своё» — не учить

                    if self.equal(field, s_line, t_line):
                        # Считаются и совпадающие: побеждает, как записано у большинства
                        self.learned[(field, key_of(s_line))][t_line] += 1
                        self.learned_source.setdefault((field, key_of(s_line)), s_line)
                        break

        # Большинство пишет так же, как источник, — переименовывать нечего
        for key in list(self.learned):
            if key_of(self.learned[key].most_common(1)[0][0]) == key[1]:
                del self.learned[key]

    # ---------- одна строка ----------

    def is_keep(self, field, source, table):
        return key_of(table) in self.keep.get((field, key_of(source)), ())

    def manual(self, field, source, table):
        """Ручное решение по паре: same / differ / keep / None."""
        key = (field, key_of(source))

        if self.is_keep(field, source, table):
            return "keep"

        if key_of(table) in self.differ.get(key, ()):
            return "differ"

        if key in self.same and key_of(self.same[key]) == key_of(table):
            return "same"

        return None

    def equal(self, field, source, table, strict=False):
        """Одно ли и то же строка источника и строка таблицы (с учётом ручных)."""
        key = (field, key_of(source))

        if key_of(table) in self.differ.get(key, ()):
            return False

        if key in self.same and key_of(self.same[key]) == key_of(table):
            return True

        return same_line(field, source, table, strict)

    def canonical_line(self, field, source):
        """Название строки источника так, как его пишут в таблице.
        (название, откуда: manual / learned / table / "")."""
        key = (field, key_of(source))

        if key not in self._canonical:
            self._canonical[key] = self._find_canonical(field, source, key)

        return self._canonical[key]

    def _find_canonical(self, field, source, key):
        if key in self.same:
            return self.same[key], "manual"

        if self.learned.get(key):
            return self.learned[key].most_common(1)[0][0], "learned"

        # Похожее значение из Справочника или столбца: самое частое
        candidates = Counter()

        for value in self.choices.get(field, []):
            if self.equal(field, source, value, strict=True):
                candidates[value] += 1000   # Справочник — главнее

        for value, count in (self.table_values.get(field) or {}).items():
            if self.equal(field, source, value, strict=True):
                candidates[value] += count

        if candidates:
            best = candidates.most_common(1)[0][0]

            if key_of(best) != key_of(source):
                return best, "table"

        return clean_text(source), ""

    # ---------- поле целиком ----------

    def compare(self, field, source, table):
        """Сравнение поля записи и ПК: {"source" — значение источника в названиях
        таблицы, "raw" — как в источнике, "mark": "=" / "≈" / "≠" / "",
        "how": откуда название}."""
        raw = source or ""
        table = table or ""

        if field in SET_FIELDS:
            norm = norm_mac if field == "mac" else (lambda v: v.strip())
            src = {norm(v) or v.upper() for v in lines_of(raw)}
            tab = {norm(v) or v.upper() for v in lines_of(table)}
            # В таблице больше, чем видит источник (три MAC, а агент прислал два), —
            # не расхождение: лишнее в таблице сканер не убирает
            mark = "" if not src or not tab else ("=" if src <= tab else ("≈" if tab <= src else "≠"))
            proposed = raw

            # MAC: есть общие с таблицей — тот же ПК, предлагается дописать
            # недостающие, MAC таблицы не убираются (26е)
            if field == "mac" and mark == "≠" and src & tab:
                lines = lines_of(table)
                proposed = "\n".join(lines + [v for v in lines_of(raw) if (norm(v) or v.upper()) not in tab])

            return {"source": proposed, "raw": raw, "mark": mark, "how": ""}

        if field in EXACT_FIELDS:
            mark = "" if not raw or not table else ("=" if key_of(raw) == key_of(table) else "≠")
            return {"source": raw, "raw": raw, "mark": mark, "how": ""}

        if field in MULTI_NAME_FIELDS:
            src_lines, tab_lines = lines_of(raw), lines_of(table)

            # Многострочное значение: ручное решение по паре целиком (двойной клик
            # по отметке) — «две программы в источнике, одна в таблице — одно и то же»
            if len(src_lines) > 1 or len(tab_lines) > 1:
                whole = self.manual(field, raw, table) if src_lines and tab_lines else None

                if whole in ("same", "keep"):
                    return {"source": table, "raw": raw, "mark": "=", "how": whole,
                            "manual": whole, "auto_equal": False}

                result = self._compare_lines(field, raw, src_lines, tab_lines)
                auto_equal = result["mark"] == "="

                if whole == "differ":
                    result["mark"] = "≠"

                if src_lines and tab_lines:
                    result["manual"] = whole
                    result["auto_equal"] = auto_equal

                return result
        else:
            src_lines = [clean_text(raw)] if clean_text(raw) else []
            tab_lines = [clean_text(table)] if clean_text(table) else []

        result = self._compare_lines(field, raw, src_lines, tab_lines)

        # Ручное решение по паре (однострочные): его показывает и меняет отметка
        if len(src_lines) == 1 and len(tab_lines) == 1:
            result["manual"] = self.manual(field, src_lines[0], tab_lines[0])
            result["auto_equal"] = same_line(field, src_lines[0], tab_lines[0])

        return result

    def _compare_lines(self, field, raw, src_lines, tab_lines):
        """Строки источника против строк таблицы: что показать и отметка."""
        shown = []
        hows = set()
        matched_tab = set()
        unmatched_src = 0

        for line in src_lines:
            keep = next((i for i, t in enumerate(tab_lines) if i not in matched_tab and self.is_keep(field, line, t)), None)
            hit = keep if keep is not None else next(
                (i for i, t in enumerate(tab_lines) if i not in matched_tab and self.equal(field, line, t)), None
            )

            if hit is not None:
                matched_tab.add(hit)
                shown.append(tab_lines[hit])

                if keep is not None:
                    hows.add("keep")
                elif key_of(line) != key_of(tab_lines[hit]):
                    hows.add("same")
            else:
                unmatched_src += 1
                name, how = self.canonical_line(field, line)
                shown.append(name)

                if how:
                    hows.add(how)

        if not src_lines or not tab_lines:
            mark = ""
        elif len(matched_tab) == len(tab_lines) and not unmatched_src:
            mark = "="
        elif len(matched_tab) == len(tab_lines):
            mark = "≈"   # в таблице записана часть
        else:
            mark = "≠"

        return {"source": "\n".join(shown), "raw": raw, "mark": mark, "how": ",".join(sorted(hows))}
