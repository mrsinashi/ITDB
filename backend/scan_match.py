"""Сопоставление записей GLPI / GSIT с ПК ITDB (этап 25) — так, чтобы данные
одного ПК не достались другому.

Порядок:
1. Признаки, общие для многих записей источника (серийный платы на 17 ПК,
   одинаковый MAC виртуального адаптера), — не признаки: убираются.
2. Дубли: записи источника с общим признаком — одно железо (агент поставили
   заново). Остаётся самая свежая, остальные — «дубль».
3. Каждая запись и ПК ITDB (не из архива): признаки — GLPI ID (только для
   GLPI: столбец «GLPI» в ITDB), физический MAC, настоящий серийный.
   - решение администратора «это этот ПК» — главнее всего (link);
   - признаки указывают на один ПК и ничто не противоречит — сопоставлена (key);
   - признаки указывают на разные ПК, или у ПК другой MAC / серийный — конфликт:
     значения не предлагаются, решает администратор;
   - совпал только GLPI ID при разных именах — «привязать?» (name): номер мог
     остаться от другой системы;
   - признаков нет, совпало только имя — «привязать?» (name);
   - два сопоставления на один ПК — оба конфликт;
   - ничего — нет в ITDB (none).
UUID в ITDB не хранится: он только склеивает дубли внутри источника.
"""
from collections import defaultdict

from scan_normalize import clean_serial, norm_mac

# Признак на стольких записях и больше — общий, не признак
SHARED_LIMIT = 3

KEY_LABELS = {"id": "ID", "mac": "MAC", "serial": "серийному"}
# Номер записи источника в таблице: GLPI — столбец GLPI, GSIT — столбец GSIT (этап 26ж)
ID_FIELDS = {"glpi": "glpi_id", "gsit": "gsit_id"}
ID_TITLES = {"glpi": "GLPI ID", "gsit": "GSIT ID"}


def key_labels(keys, kind):
    return ", ".join(ID_TITLES.get(kind, "ID") if k == "id" else KEY_LABELS[k] for k in keys)


def key_values(keys):
    """(вид, значение) признаков записи."""
    result = [("mac", mac) for mac in keys.get("macs") or []]

    if keys.get("serial"):
        result.append(("serial", keys["serial"].upper()))

    if keys.get("uuid"):
        result.append(("uuid", keys["uuid"].upper()))

    return result


def drop_shared_keys(records):
    """Убрать признаки, которые есть у SHARED_LIMIT записей и больше.
    records — [{"source_id", "keys"}]; keys меняются на месте. Ответ — сколько
    значений убрано."""
    counts = defaultdict(set)

    for record in records:
        for kind, value in key_values(record["keys"]):
            counts[(kind, value)].add(record["source_id"])

    shared = {key for key, ids in counts.items() if len(ids) >= SHARED_LIMIT}

    for record in records:
        keys = record["keys"]
        keys["macs"] = [mac for mac in keys.get("macs") or [] if ("mac", mac) not in shared]

        if keys.get("serial") and ("serial", keys["serial"].upper()) in shared:
            keys["serial"] = None

        if keys.get("uuid") and ("uuid", keys["uuid"].upper()) in shared:
            keys["uuid"] = None

    return len(shared)


def find_duplicates(records):
    """Записи с общим признаком — одно железо. {source_id дубля: source_id
    оставленной}; оставляется самая свежая (при равенстве — с большим id)."""
    parent = {record["source_id"]: record["source_id"] for record in records}

    def root(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    owner = {}

    for record in records:
        for key in key_values(record["keys"]):
            if key in owner:
                parent[root(record["source_id"])] = root(owner[key])
            else:
                owner[key] = record["source_id"]

    groups = defaultdict(list)

    for record in records:
        groups[root(record["source_id"])].append(record)

    result = {}

    for group in groups.values():
        if len(group) < 2:
            continue

        keep = max(group, key=lambda r: (r["checked_at"].timestamp() if r.get("checked_at") else 0, r["source_id"]))

        for record in group:
            if record is not keep:
                result[record["source_id"]] = keep["source_id"]

    return result


def short_host(name):
    return (name or "").strip().lower().split(".")[0]


class Index:
    """ПК ITDB по признакам. computers — [{"id", "hostname", "mac", "serial",
    "glpi_id", "gsit_id", "archived"}]."""

    def __init__(self, computers):
        self.computers = {c["id"]: c for c in computers}
        self.by_mac = defaultdict(set)
        self.by_serial = defaultdict(set)
        self.by_id = {kind: defaultdict(set) for kind in ID_FIELDS}
        self.by_name = defaultdict(set)
        self.macs = {}
        self.serials = {}
        self.record_ids = set()     # номера записей источника (строками) — задаёт match_all

        for c in computers:
            macs = {norm_mac(line) for line in (c.get("mac") or "").splitlines()}
            macs.discard(None)
            serial = clean_serial(c.get("serial"))
            self.macs[c["id"]] = macs
            self.serials[c["id"]] = serial.upper() if serial else None

            if c.get("archived"):
                continue

            for mac in macs:
                self.by_mac[mac].add(c["id"])

            if serial:
                self.by_serial[serial.upper()].add(c["id"])

            for kind, field in ID_FIELDS.items():
                number = str(c.get(field) or "").strip()

                if number:
                    self.by_id[kind][number].add(c["id"])

            if short_host(c.get("hostname")):
                self.by_name[short_host(c.get("hostname"))].add(c["id"])

        # Архив — только для пояснения «есть в архиве»
        self.archived_by_key = defaultdict(set)

        for c in computers:
            if not c.get("archived"):
                continue

            for mac in self.macs[c["id"]]:
                self.archived_by_key[("mac", mac)].add(c["id"])

            if self.serials[c["id"]]:
                self.archived_by_key[("serial", self.serials[c["id"]])].add(c["id"])

            if short_host(c.get("hostname")):
                self.archived_by_key[("name", short_host(c.get("hostname")))].add(c["id"])

    def host(self, computer_id):
        c = self.computers.get(computer_id)
        return (c.get("hostname") or f"ПК {computer_id}") if c else f"ПК {computer_id}"

    def active(self, computer_id):
        c = self.computers.get(computer_id)
        return c is not None and not c.get("archived")


def contradictions(index, computer_id, record, kind, hits):
    """Что у ПК ITDB другое, хотя у обоих есть: MAC, серийный, ID записи."""
    result = []
    keys = record["keys"]
    macs = set(keys.get("macs") or [])
    serial = (keys.get("serial") or "").upper() or None

    if macs and index.macs.get(computer_id) and "mac" not in hits:
        result.append("MAC")

    if serial and index.serials.get(computer_id) and "serial" not in hits:
        result.append("серийный")

    number = str(index.computers[computer_id].get(ID_FIELDS.get(kind, "")) or "").strip()

    # Номер в таблице указывает на другую запись источника. Если такой записи уже нет
    # (агент поставили заново — у ПК новая запись), это не противоречие: номер устарел,
    # сканер предложит новый
    if number and number != str(record["source_id"]) and "id" not in hits and number in index.record_ids:
        result.append(ID_TITLES[kind])

    return result


def match_one(index, record, kind, links):
    """Итог одной записи: {state, computer_id, candidates, by, note}."""
    linked = [l["computer_id"] for l in links if l["action"] == "link" and index.active(l["computer_id"])]
    rejected = {l["computer_id"] for l in links if l["action"] == "reject"}

    if linked:
        return {"state": "link", "computer_id": linked[0], "candidates": [], "by": [], "note": None}

    keys = record["keys"]
    hits = defaultdict(set)

    for computer_id in index.by_id.get(kind, {}).get(str(record["source_id"]), ()):
        hits[computer_id].add("id")

    for mac in keys.get("macs") or []:
        for computer_id in index.by_mac.get(mac, ()):
            hits[computer_id].add("mac")

    if keys.get("serial"):
        for computer_id in index.by_serial.get(keys["serial"].upper(), ()):
            hits[computer_id].add("serial")

    for computer_id in rejected:
        hits.pop(computer_id, None)

    if len(hits) > 1:
        parts = [
            f"{index.host(cid)} (по {key_labels(sorted(by), kind)})"
            for cid, by in sorted(hits.items(), key=lambda item: index.host(item[0]))
        ]
        return {
            "state": "conflict", "computer_id": None, "candidates": sorted(hits, key=index.host), "by": [],
            "note": "Признаки указывают на разные ПК: " + "; ".join(parts),
        }

    name = short_host(record.get("name"))

    if hits:
        computer_id, by = next(iter(hits.items()))
        against = contradictions(index, computer_id, record, kind, by)
        by_list = [k for k in ("id", "mac", "serial") if k in by]

        if against:
            return {
                "state": "conflict", "computer_id": None, "candidates": [computer_id], "by": by_list,
                "note": f"Совпадает с {index.host(computer_id)} по {key_labels(by_list, kind)}, "
                        f"но {', '.join(against)} у ПК другой",
            }

        if by == {"id"} and name != short_host(index.computers[computer_id].get("hostname")):
            return {
                "state": "name", "computer_id": computer_id, "candidates": [computer_id], "by": by_list,
                "note": f"Совпадает только {ID_TITLES[kind]}, имя другое",
            }

        return {"state": "key", "computer_id": computer_id, "candidates": [], "by": by_list, "note": None}

    candidates = [cid for cid in index.by_name.get(name, ()) if cid not in rejected] if name else []

    if len(candidates) > 1:
        return {
            "state": "conflict", "computer_id": None, "candidates": sorted(candidates), "by": [],
            "note": "Такое имя у нескольких ПК: " + ", ".join(sorted(index.host(c) + f" (№{c})" for c in candidates)),
        }

    if candidates:
        computer_id = candidates[0]
        against = contradictions(index, computer_id, record, kind, set())

        if against:
            return {
                "state": "conflict", "computer_id": None, "candidates": [computer_id], "by": [],
                "note": f"Имя как у {index.host(computer_id)}, но {', '.join(against)} у ПК другой",
            }

        return {"state": "name", "computer_id": computer_id, "candidates": [computer_id], "by": [], "note": None}

    # Нет в ITDB; подсказать, если такой есть в архиве
    archived = set()

    for mac in keys.get("macs") or []:
        archived |= index.archived_by_key.get(("mac", mac), set())

    if keys.get("serial"):
        archived |= index.archived_by_key.get(("serial", keys["serial"].upper()), set())

    if name:
        archived |= index.archived_by_key.get(("name", name), set())

    note = ("Есть в архиве: " + ", ".join(sorted(index.host(c) for c in archived))) if archived else None
    return {"state": "none", "computer_id": None, "candidates": [], "by": [], "note": note}


def match_all(records, computers, links, kind):
    """{source_id: итог}. records — [{"source_id", "name", "keys", "dup_of"}]
    (уже без общих признаков), links — [{"source_id", "computer_id", "action"}]."""
    index = Index(computers)
    index.record_ids = {str(record["source_id"]) for record in records if not record.get("dup_of")}
    links_by = defaultdict(list)

    for link in links:
        links_by[link["source_id"]].append(link)

    result = {}

    for record in records:
        if record.get("dup_of"):
            result[record["source_id"]] = {
                "state": "dup", "computer_id": None, "candidates": [], "by": [],
                "note": None, "dup_of": record["dup_of"],
            }
            continue

        result[record["source_id"]] = match_one(index, record, kind, links_by[record["source_id"]])

    # Один ПК — у нескольких записей. По признаку или вручную — главнее, чем по
    # имени; два сопоставления по признаку (не вручную) — оба в конфликт
    taken = defaultdict(list)

    for source_id, item in result.items():
        if item["state"] in ("key", "link", "name"):
            taken[item["computer_id"]].append(source_id)

    def to_conflict(source_id, computer_id, note):
        item = result[source_id]
        result[source_id] = {
            "state": "conflict", "computer_id": None, "candidates": [computer_id], "by": item["by"], "note": note,
        }

    for computer_id, source_ids in taken.items():
        if len(source_ids) < 2:
            continue

        host = index.host(computer_id)
        strong = [s for s in source_ids if result[s]["state"] in ("key", "link")]
        weak = [s for s in source_ids if result[s]["state"] == "name"]

        if len(strong) > 1:
            for source_id in strong:
                if result[source_id]["state"] == "key":
                    others = ", ".join(f"№{s}" for s in strong if s != source_id)
                    to_conflict(source_id, computer_id, f"На {host} указывает и запись {others}")

        for source_id in weak:
            if strong:
                to_conflict(source_id, computer_id, f"Имя как у {host}, но он уже сопоставлен с записью №{strong[0]}")
            else:
                others = ", ".join(f"№{s}" for s in weak if s != source_id)
                to_conflict(source_id, computer_id, f"Имя как у {host}, как и у записи {others}")

    return result, index
