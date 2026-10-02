"""Режим «Расхождения» (этап 26): где данные сканера отличаются от таблицы.

Расхождение — поле ПК, сопоставленного с записью включённого источника по
признаку или вручную (state key / link), у которого значение сканера (в
названиях таблицы, scan_values) отличается («≠») или в таблице пусто, а у
сканера есть. «≈» (в таблице записана часть, например один MAC из двух) —
не расхождение. Считается на лету, ничего не хранится, кроме решений:

- «Принять» — значение пишется в ПК обычной правкой (История, пометка
  источника «scan»); если значение в таблице за это время изменилось — не
  пишется;
- «Отклонить» — этому ПК это значение не предлагать, пока источник отдаёт то же
  (scan_rejects); отклонённые можно показать и вернуть;
- «В таблице своё» — пара «значение источника — значение таблицы» не
  расхождение ни у одного ПК, но и не «одно и то же» (scan_aliases kind keep,
  через /api/scan/names).

Смотреть (пометки в Таблице) — все; решения — editor и admin (как правка таблицы).
Этап 26е: HOSTNAME в таблице — каким имя должно быть, поэтому другое имя у
источника только сообщается (can_take = False: взять нельзя, можно «оставить»;
в таблице пусто — взять можно). Jabber предлагает VACUUM — см. jabber_rows
(этап 26ж: ПК — только по IP; этап 26з: из ячейки сканер никого не убирает — кто
давно не подключался, отдаётся отдельно, vacuum_stale, и только выделяется).
Этап 26ж: номера записей — в столбцы GLPI и GSIT (ID_FIELDS); «это материнская
плата» — название модели из источника уходит в столбец «Мат. плата» (/board).
Этап 28: сеть (аренды DHCP и проход подсетей, scan_hosts) предлагает MAC, IP и
имя — scan_hostmatch.py; о поле, про которое уже говорит запись GLPI / GSIT,
сеть молчит (записи главнее).
Этап 26б: «неточно» (unsure) — источники предлагают разное или VNC-серверов
несколько; «в таблице часть» (partial, «≈») — отдаётся для пометок, но не
расхождение (не в счётчике); у источника — как сопоставлен (state, by) и что
предлагает (value) — признаки, можно ли верить.
"""
import ipaddress
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import scan_collect
from api_columns import COLUMNS_BY_KEY
from api_computers import (
    ChangeBatch, apply_fields, get_vacuum_logins, load_locations, location_path, save_changes,
    user_field_keys_of, vacuum_text,
)
from api_scan import SOURCES, fresh_days_of, load_source
from api_scan_records import save_alias, web_url_of
from auth import get_current_user, require_editor
from db import get_db
from history_log import log_change
from models import (
    AppSetting, Computer, ScanHost, ScanJabberUser, ScanMark, ScanRecord, ScanReject, ScanSource, VacuumAccount,
    VacuumAccountComputer,
)
from scan_hostmatch import TITLES as HOST_TITLES, confirmed, host_rows
from scan_match import ID_FIELDS
from scan_values import COMPARE_FIELDS, NAME_FIELDS, clean_text, key_of, lines_of

router = APIRouter(prefix="/api/scan/diffs", tags=["scan"])

MAX_ITEMS = 5000
# Поля, которые сканер может предложить: из GLPI / GSIT, VACUUM из Jabber и
# номера записей GLPI / GSIT
DIFF_FIELDS = COMPARE_FIELDS + ["vacuum"] + list(ID_FIELDS.values())
# Только сообщить, не брать: HOSTNAME в таблице — каким имя должно быть (26е)
INFO_FIELDS = ("hostname",)
# Jabber: последний адрес годится столько дней, сколько задано у подключения
# («Актуальны», по умолчанию 7); кто не подключался дольше — «давно не в сети»:
# в ячейке VACUUM выделяется, но сканер его не убирает (просьба 02.10)
# Больше людей с одного адреса — сервер или терминал: VACUUM по нему не предлагать
JABBER_MAX_LOGINS = 3


class DiffSource(BaseModel):
    source: str
    title: str
    source_id: Optional[int] = None   # у Jabber номера записи нет
    checked_at: Optional[datetime]
    state: str = "key"          # key — по признаку, link — вручную
    by: list[str] = []          # признаки: id, mac, serial; у Jabber — ip
    value: str = ""             # что предлагает этот источник (в названиях таблицы)


class DiffOut(BaseModel):
    id: str
    computer_id: int
    hostname: Optional[str]
    place: Optional[str]
    field: str
    table: str            # как в таблице
    proposed: str         # как предлагает сканер (в названиях таблицы)
    raw: str              # как в источнике
    kind: str             # diff — отличается, fill — в таблице пусто, unsure — неточно
                          # (источники расходятся или VNC-серверов несколько),
                          # partial — в таблице записана часть («≈», не расхождение)
    unsure: str = ""      # почему неточно — для подсказки
    note: str = ""        # коротко, что меняется (VACUUM: кого добавить, кого убрать)
    name_field: bool      # поле-название: можно «в таблице своё»
    can_take: bool = True  # можно «взять из сканера» (HOSTNAME — только сообщить)
    sources: list[DiffSource]
    same_pair: int        # ещё у скольких ПК такая же пара «таблица — сканер»
    rejected_by: Optional[str] = None
    rejected_at: Optional[datetime] = None


class AntivirusOut(BaseModel):
    name: str
    status: str           # on — работает, old — базы устарели, off — выключен
    version: Optional[str] = None
    source: str           # «GLPI №12»


class DiffsOut(BaseModel):
    items: list[DiffOut]
    computers: int
    rejected: int
    sources: list[str]    # включённые источники, из которых считались
    antivirus: dict[int, list[AntivirusOut]] = {}   # столбец «Антивирусы» (этап 26д)
    links: dict[str, str] = {}      # столбец с номером записи → начало ссылки на неё (GLPI, GSIT)
    vacuum_missing: list[str] = []  # логины из таблицы, которых в Jabber нет (строчными)
    # логины из таблицы, давно не подключавшиеся: логин → сколько дней (None — никогда)
    vacuum_stale: dict[str, Optional[int]] = {}
    jabber: dict[int, list[str]] = {}   # кого Jabber видит с адреса ПК: id ПК → логины
    # что о ПК видно в сети (DHCP, проход подсетей): id ПК → {ip, mac, hostname: [значения]}
    net: dict[int, dict[str, list[str]]] = {}
    # ПК, проверенные и GLPI / GSIT, и сетью: id ПК → чем («GLPI», «Сеть»; этап 28б)
    verified: dict[int, list[str]] = {}


def enabled_kinds(session):
    """Включённые источники записей о ПК — в порядке главенства (GLPI, потом GSIT)."""
    enabled = {s.kind for s in session.query(ScanSource).filter(ScanSource.enabled == True)}  # noqa: E712
    return [kind for kind in scan_collect.RECORD_KINDS if kind in enabled]


def matched_records(session, kinds, computers):
    """Записи включённых источников, сопоставленные с рабочими ПК по признаку
    или вручную: (kind, source_id, итог сопоставления, запись)."""
    for kind in kinds:
        matches, _ = scan_collect.match(session, kind)
        records = {r.source_id: r for r in session.query(ScanRecord).filter(ScanRecord.source == kind)}

        for source_id, item in matches.items():
            if item["state"] in ("key", "link") and item["computer_id"] in computers:
                yield kind, source_id, item, records[source_id]


# ---------- Антивирусы (этап 26д) ----------

AV_STATUSES = {"on": "Работает", "old": "Базы устарели", "off": "Выключен"}


def av_status(item):
    if not item.get("active"):
        return "off"
    return "on" if item.get("uptodate") else "old"


def av_entries(kind, record):
    """Антивирусы записи: [{name, status, version, source}]."""
    title = f"{SOURCES[kind]['title']} №{record.source_id}"
    return [
        {"name": a.get("name") or "?", "status": av_status(a), "version": a.get("version"), "source": title}
        for a in ((record.data or {}).get("antivirus") or [])
    ]


def pick_antivirus(found):
    """found: {ПК: {источник: [антивирусы]}} → {ПК: [антивирусы]}: из первого по
    главенству источника, где они есть (GLPI, потом GSIT)."""
    result = {}

    for computer_id, by_kind in found.items():
        for kind in scan_collect.RECORD_KINDS:
            if by_kind.get(kind):
                result[computer_id] = by_kind[kind]
                break

    return result


def computer_antivirus(session):
    """{id ПК: [антивирусы]} у рабочих ПК, сопоставленных с записями включённых
    источников (для выгрузки; Таблица получает то же в /api/scan/diffs)."""
    computers = {
        row.id for row in session.query(Computer.id).filter(Computer.archived == False)  # noqa: E712
    }
    found = {}

    for kind, _source_id, item, record in matched_records(session, enabled_kinds(session), computers):
        found.setdefault(item["computer_id"], {}).setdefault(kind, []).extend(av_entries(kind, record))

    return pick_antivirus(found)


def ipv4_set(text):
    result = set()

    for line in str(text or "").splitlines():
        try:
            address = ipaddress.ip_address(line.strip())
        except ValueError:
            continue

        if address.version == 4:
            result.add(str(address))

    return result


def jabber_enabled(session):
    source = load_source(session, "jabber")
    return bool(source and source.enabled and source.url)


def jabber_fresh(session):
    """Сколько дней пользователь Jabber считается недавним (настройка подключения)."""
    return timedelta(days=fresh_days_of(load_source(session, "jabber"), "jabber"))


def jabber_state(session):
    """Что известно о пользователях Jabber:
    by_ip — {IP: {логины}}: в сети — адреса ресурсов, не в сети — последний адрес,
            если был в сети не раньше срока «Актуальны» (адреса по DHCP меняются);
    seen — {логин: когда был в сети}; names — {логин: как пишется};
    stale — не подключались дольше срока; gone — таких пользователей нет.
    stale и gone — только если получали список пользователей (listed)."""
    since = datetime.now(timezone.utc) - jabber_fresh(session)
    users = session.query(ScanJabberUser).all()
    listed = any(user.registered is not None for user in users)
    by_ip = defaultdict(set)
    seen, names = {}, {}
    stale, gone = set(), set()

    for user in users:
        login = user.login.strip().lower()
        names[login] = user.login.strip()
        last = max((d for d in (user.last_login_at, user.last_seen_at) if d), default=None)
        seen[login] = last

        if user.registered is False:
            gone.add(login)
        elif listed and not user.online and (last is None or last < since):
            stale.add(login)

        if user.online:
            ips = [r.get("ip") for r in user.resources or [] if r.get("ip")]
        elif user.last_ip and user.last_seen_at and user.last_seen_at >= since:
            ips = [user.last_ip]
        else:
            ips = []

        for ip in ips:
            if ipv4_set(ip):
                by_ip[ip].add(login)

    return {"by_ip": by_ip, "seen": seen, "names": names, "stale": stale, "gone": gone, "listed": listed}


def computer_vacuum(session, computers):
    """{id ПК: {логин строчными: как записан}} у рабочих ПК."""
    result = defaultdict(dict)
    rows = (
        session.query(VacuumAccountComputer.computer_id, VacuumAccount.login)
        .join(VacuumAccount, VacuumAccount.id == VacuumAccountComputer.account_id)
    )

    for computer_id, login in rows:
        if computer_id in computers:
            result[computer_id][login.lower()] = login

    return result


def vacuum_missing(state, vacuum):
    """Логины из ячеек VACUUM, которых в Jabber нет (удалены или с ошибкой)."""
    if not state["listed"]:
        return []

    table = {login for logins in vacuum.values() for login in logins}
    return sorted(login for login in table if login in state["gone"] or login not in state["names"])


def vacuum_stale(state, vacuum):
    """Логины из ячеек VACUUM, давно не подключавшиеся: {логин: сколько дней};
    None — не подключался никогда."""
    now = datetime.now(timezone.utc)
    table = {login for logins in vacuum.values() for login in logins}
    result = {}

    for login in sorted(table & state["stale"]):
        last = state["seen"].get(login)
        result[login] = (now - last).days if last else None

    return result


# Буквы, одинаковые на вид в латинице и кириллице: логин «cумкина» с латинской «c»
# в Jabber не найдётся, хотя на глаз он тот же (02.10)
LOOKALIKE = str.maketrans("aceopxyk", "асеорхук")


def lookalike_key(login):
    return login.lower().replace("ё", "е").translate(LOOKALIKE)


def jabber_rows(computers, record_ips, state, vacuum):
    """Предложения VACUUM из Jabber: ([(ПК, таблица, предлагается, вид, почему
    неточно, пояснение, источник)], {ПК: кого Jabber видит с его адреса}).

    ПК — только по IP (этап 26ж): тот, у кого этот адрес в таблице или в записи
    GLPI / GSIT, сопоставленной с ним; адрес у двух ПК — не понять, чей, — пропуск.
    - Добавить: кто в Jabber с адреса ПК (сейчас или не раньше срока «Актуальны»
      назад), а в VACUUM ПК его нет. Логин уже записан у другого ПК — «неточно».
    - Заменить: в ячейке логин, которого в Jabber нет, но на вид он тот же, что
      у человека с адреса ПК (латинская буква вместо русской), — вместо него.
    Из ячейки сканер никого не убирает: давно не подключавшиеся и удалённые
    только выделяются (vacuum_stale, vacuum_missing)."""
    by_ip, names = state["by_ip"], state["names"]
    owners = defaultdict(set)   # IP → ПК (таблица и записи GLPI / GSIT)

    for computer_id, values in computers.items():
        for ip in ipv4_set(values.get("ip")):
            owners[ip].add(computer_id)

    for ip, ids in record_ips.items():
        owners[ip] |= ids

    login_pcs = defaultdict(set)

    for computer_id, logins in vacuum.items():
        for login in logins:
            login_pcs[login].add(computer_id)

    hosts = {cid: values.get("hostname") or f"ПК №{cid}" for cid, values in computers.items()}
    at_pc = defaultdict(set)

    for ip, logins in by_ip.items():
        if len(logins) <= JABBER_MAX_LOGINS and len(owners.get(ip, ())) == 1:
            at_pc[next(iter(owners[ip]))] |= logins

    result = []

    for computer_id in set(at_pc) | set(vacuum):
        if computer_id not in computers:
            continue

        table = vacuum.get(computer_id, {})
        add = sorted(at_pc.get(computer_id, set()) - set(table))

        if not add:
            continue

        # Опечатка в таблице: такого логина в Jabber нет, а на вид он — как у пришедшего
        looks = {lookalike_key(login) for login in add}
        drop = sorted(login for login in table if login not in names and lookalike_key(login) in looks)
        kept = [text for login, text in table.items() if login not in drop]
        proposed = vacuum_text(sorted(kept + [names.get(login, login) for login in add], key=str.lower)) or ""
        table_text = vacuum_text(sorted(table.values(), key=str.lower)) or ""
        elsewhere = [
            f"{names.get(login, login)} записан у {', '.join(sorted(hosts[c] for c in login_pcs[login] if c != computer_id))}"
            for login in add if login_pcs[login] - {computer_id}
        ]
        unsure = "; ".join(elsewhere)
        note = "; ".join(part for part in (
            "с IP этого ПК: " + ", ".join(names.get(login, login) for login in add),
            "вместо «" + "», «".join(table[login] for login in drop) + "» — там латинские буквы" if drop else "",
        ) if part)
        dates = [state["seen"][login] for login in add if state["seen"].get(login)]
        result.append((
            computer_id, table_text, proposed, "unsure" if unsure else ("diff" if table else "fill"), unsure, note,
            {
                "source": "jabber", "title": SOURCES["jabber"]["title"], "source_id": None,
                "checked_at": max(dates) if dates else None, "state": "key", "by": ["ip"],
                "value": proposed,
            },
        ))

    seen_at = {
        computer_id: sorted((names.get(login, login) for login in logins), key=str.lower)
        for computer_id, logins in at_pc.items() if computer_id in computers
    }
    return result, seen_at


def host_observations(session):
    """Свежие наблюдения включённых источников сети (DHCP, Сеть) и сами источники."""
    result, kinds = [], []
    moment = datetime.now(timezone.utc)

    for kind in scan_collect.HOST_KINDS:
        source = load_source(session, kind)

        if not (source and source.enabled):
            continue

        kinds.append(kind)
        since = moment - timedelta(days=fresh_days_of(source, kind))

        for row in session.query(ScanHost).filter(
            ScanHost.source.in_(scan_collect.HOST_SOURCES[kind]), ScanHost.seen_at >= since,
        ):
            result.append({
                "source": kind, "ip": row.ip, "mac": row.mac, "name": row.name, "seen_at": row.seen_at,
                "data": row.data or {},
            })

    return result, kinds


def compute(session, with_rejected=False):
    """(расхождения, число отклонённых, источники, антивирусы ПК, логины VACUUM,
    которых нет в Jabber, кого Jabber видит с адресов ПК, логины VACUUM, давно не
    подключавшиеся, что видно в сети у ПК, ПК, проверенные и записью, и сетью) по всем включённым источникам. Одно поле ПК — одна строка;
    если источники предлагают разное — «неточно»."""
    kinds = enabled_kinds(session)
    computers = scan_collect.active_values(session)
    names = scan_collect.load_names(session, computers)
    rejects = {}

    for r in session.query(ScanReject):
        rejects[(r.computer_id, r.field, r.value_key)] = r

    rows = {}   # (ПК, поле) → {row из compare, sources: [...]}
    antivirus = {}
    in_records = defaultdict(list)  # ПК → источники записей, уверенно сопоставленных с ним
    record_ips = defaultdict(set)   # IP → ПК, с которыми сопоставлены записи с этим IP
    numbers = {     # номера записей GLPI / GSIT, записанные в таблице
        row[0]: dict(zip(ID_FIELDS.values(), row[1:]))
        for row in session.query(Computer.id, *(getattr(Computer, field) for field in ID_FIELDS.values()))
    }

    for kind, source_id, item, record in matched_records(session, kinds, computers):
        computer_id = item["computer_id"]
        values = (record.data or {}).get("values") or {}

        if SOURCES[kind]["title"] not in in_records[computer_id]:
            in_records[computer_id].append(SOURCES[kind]["title"])

        antivirus.setdefault(computer_id, {}).setdefault(kind, []).extend(av_entries(kind, record))
        source = {
            "source": kind, "title": SOURCES[kind]["title"], "source_id": source_id,
            "checked_at": record.checked_at, "state": item["state"], "by": item["by"],
        }
        # Номер записи — в столбец GLPI / GSIT (этап 26ж)
        number = clean_text((numbers.get(computer_id) or {}).get(ID_FIELDS[kind]))

        if number != str(source_id):
            rows[(computer_id, ID_FIELDS[kind])] = {
                "rows": [{"itdb": number, "source": str(source_id), "raw": str(source_id), "mark": "≠" if number else ""}],
                "sources": [dict(source, value=str(source_id))],
            }

        for ip in ipv4_set(values.get("ip")):
            record_ips[ip].add(computer_id)

        for row in scan_collect.compare_record(names, values, computers[computer_id]):
            if not row["raw"]:
                continue

            entry = rows.setdefault((computer_id, row["field"]), {"rows": [], "sources": []})
            entry["rows"].append(row)
            entry["sources"].append(dict(source, value=row["source"]))

    # Сеть (этап 28): MAC, IP и имя — там, где записи GLPI / GSIT об этом поле молчат
    hosts, host_kinds = host_observations(session)
    net_seen = {}
    verified = {}

    if hosts:
        proposals, net_seen = host_rows(computers, hosts)
        # Проверен и записью GLPI / GSIT, и сетью (этап 28б)
        verified = {
            computer_id: in_records[computer_id] + [HOST_TITLES.get(kind, kind) for kind in found]
            for computer_id, found in confirmed(computers, hosts).items() if in_records.get(computer_id)
        }

        for proposal in proposals:
            computer_id, field = proposal["computer_id"], proposal["field"]

            if (computer_id, field) in rows:
                continue

            table = computers[computer_id].get(field)
            row = names.compare(field, proposal["value"], table)

            # MAC из сети дописывается к записанным, а не заменяет их
            if field == "mac" and lines_of(table):
                row["source"] = "\n".join(lines_of(table) + [proposal["value"]])
                row["mark"] = "≠"

            if row["mark"] in ("=", "≈"):
                continue

            row.update(field=field, itdb=table or "")
            rows[(computer_id, field)] = {
                "rows": [row], "sources": [dict(proposal["source"], value=row["source"])], "unsure": proposal["unsure"],
            }

    items = []
    rejected = 0

    def add(computer_id, field, table, proposed, raw, diff_kind, unsure, sources, note=""):
        nonlocal rejected
        reject = rejects.get((computer_id, field, key_of(raw)))

        if reject is not None and diff_kind != "partial":
            rejected += 1

            if not with_rejected:
                return

        items.append({
            "id": f"{computer_id}:{field}", "computer_id": computer_id, "field": field,
            "table": table or "", "proposed": proposed, "raw": raw,
            "kind": diff_kind, "unsure": unsure, "note": note, "name_field": field in NAME_FIELDS,
            "can_take": field not in INFO_FIELDS or not table,
            "sources": sources,
            "rejected_by": reject.user_name if reject else None,
            "rejected_at": reject.at if reject else None,
        })

    for (computer_id, field), entry in rows.items():
        proposals = {key_of(r["source"]) for r in entry["rows"]}
        row = entry["rows"][0]
        marks = {r["mark"] for r in entry["rows"]}
        unsure = entry.get("unsure", "")

        if len(proposals) > 1:
            unsure = "источники предлагают разное: " + "; ".join(f"{s['title']} — {s['value']}" for s in entry["sources"])
        elif field == "vnc" and len(row["source"].splitlines()) > 1:
            unsure = "установлено несколько VNC — какой из них сервер, по программам не понять"

        if "≠" in marks or (unsure and not row["itdb"]):
            diff_kind = "unsure" if unsure else "diff"
        elif not row["itdb"] and "" in marks:
            diff_kind = "unsure" if unsure else "fill"
        elif "≈" in marks:
            diff_kind = "partial"
        else:
            continue

        add(computer_id, field, row["itdb"], row["source"], row["raw"], diff_kind, unsure, entry["sources"])

    missing = []
    seen_at = {}
    stale = {}

    if jabber_enabled(session):
        state = jabber_state(session)
        vacuum = computer_vacuum(session, computers)
        missing = vacuum_missing(state, vacuum)
        stale = vacuum_stale(state, vacuum)

        jabber, seen_at = jabber_rows(computers, record_ips, state, vacuum)

        for computer_id, table, proposed, diff_kind, unsure, note, src in jabber:
            # Ключ отклонения — что предлагается: изменится состав — предложит снова
            add(computer_id, "vacuum", table, proposed, proposed or "—", diff_kind, unsure, [src], note)

        kinds = kinds + ["jabber"]

    kinds = kinds + host_kinds

    # «Ещё у N ПК»: та же пара «в таблице — у сканера» в том же поле
    pairs = {}

    for entry in items:
        pair = (entry["field"], key_of(entry["table"]), key_of(entry["raw"]))
        pairs[pair] = pairs.get(pair, 0) + 1

    ids = {entry["computer_id"] for entry in items}
    hosts = {}

    if ids:
        locations = load_locations(session)

        for c in session.query(Computer.id, Computer.hostname, Computer.location_id).filter(Computer.id.in_(ids)):
            hosts[c.id] = (c.hostname, location_path(c.location_id, locations))

    order = {field: i for i, field in enumerate(DIFF_FIELDS)}
    result = []

    for entry in items:
        pair = (entry["field"], key_of(entry["table"]), key_of(entry["raw"]))
        hostname, place = hosts.get(entry["computer_id"], (None, None))
        result.append(DiffOut(**entry, hostname=hostname, place=place, same_pair=pairs[pair] - 1))

    result.sort(key=lambda d: ((d.hostname or "").lower(), d.computer_id, order.get(d.field, 99)))
    return result[:MAX_ITEMS], rejected, kinds, pick_antivirus(antivirus), missing, seen_at, stale, net_seen, verified


def record_links(session):
    """Начало ссылки на запись ПК в GLPI / GSIT: {столбец: «https://glpi/front/computer.form.php?id=»}."""
    result = {}

    for kind, field in ID_FIELDS.items():
        base = web_url_of(load_source(session, kind))

        if base:
            result[field] = base + "/front/computer.form.php?id="

    return result


@router.get("", response_model=DiffsOut)
def list_diffs(
    rejected: bool = Query(False),
    me=Depends(get_current_user),
    session=Depends(get_db),
):
    items, rejected_count, kinds, antivirus, missing, seen_at, stale, net_seen, verified = compute(session, with_rejected=rejected)
    return DiffsOut(
        items=items,
        computers=len({d.computer_id for d in items if not d.rejected_by and d.kind != "partial"}),
        rejected=rejected_count,
        sources=kinds,
        antivirus=antivirus,
        links=record_links(session),
        vacuum_missing=missing,
        vacuum_stale=stale,
        jabber=seen_at,
        net=net_seen,
        verified=verified,
    )


# ---------- Решения ----------


class AcceptItem(BaseModel):
    computer_id: int
    field: str
    value: str            # что записать (как показано: в названиях таблицы)
    table: str = ""       # что было в таблице, когда смотрели
    source: str = ""      # «GLPI №12» — пометка в Истории


class AcceptIn(BaseModel):
    items: list[AcceptItem]


class RejectItem(BaseModel):
    computer_id: int
    field: str
    raw: str


class RejectIn(BaseModel):
    items: list[RejectItem]


def check_field(field):
    if field not in DIFF_FIELDS:
        raise HTTPException(status_code=400, detail=f"Это поле из сканера не принимается: {field}")


@router.post("/accept")
def accept(payload: AcceptIn, me=Depends(require_editor), session=Depends(get_db)):
    """Записать значения сканера в ПК. Пропускаются ПК, у которых значение в
    таблице уже не то, что было при просмотре (кто-то успел поменять)."""
    user_field_keys = user_field_keys_of(session)
    batch = ChangeBatch(me["login"])
    accepted = 0
    skipped = []
    by_computer = {}

    for item in payload.items:
        check_field(item.field)
        by_computer.setdefault(item.computer_id, []).append(item)

    for computer_id, items in by_computer.items():
        computer = session.query(Computer).filter(Computer.id == computer_id).with_for_update().first()

        if computer is None or computer.archived:
            skipped.extend(f"ПК №{computer_id}" for _ in items)
            continue

        changes = {}

        for item in items:
            if item.field == "vacuum":
                now_value = vacuum_text(get_vacuum_logins(session, computer.id)) or ""
            else:
                now_value = getattr(computer, item.field) or ""

            # Другое имя у источника только сообщается: в таблице — каким оно должно быть
            if key_of(now_value) != key_of(item.table) or (item.field in INFO_FIELDS and now_value.strip()):
                skipped.append(f"{computer.hostname or computer.id}: {COLUMNS_BY_KEY[item.field].short}")
                continue

            field_changes = apply_fields(session, computer, {item.field: item.value}, user_field_keys, batch)

            for field, change in field_changes.items():
                changes[field] = dict(change, scan=item.source or "сканер")

            if field_changes:
                accepted += 1

        save_changes(session, computer, changes, me["login"])

    batch.finish(session)
    session.commit()
    return {"accepted": accepted, "skipped": skipped}


class BoardIn(BaseModel):
    computer_id: int
    raw: str              # название модели, как в источнике
    value: str            # как писать в «Мат. плате»
    source: str = ""      # «GLPI №12» — пометка в Истории


@router.post("/board")
def to_board(payload: BoardIn, me=Depends(require_editor), session=Depends(get_db)):
    """«Это материнская плата»: название, которое источник отдаёт как модель ПК,
    записывается этому ПК в «Мат. плату» и закрепляется — у всех ПК оно будет
    предлагаться в этот столбец, а не в «Модель». Если в «Модели» этого ПК
    записана эта же плата, она оттуда убирается."""
    raw, value = clean_text(payload.raw), clean_text(payload.value)

    if not raw or not value:
        raise HTTPException(status_code=400, detail="Не указано название платы.")

    computer = session.query(Computer).filter(Computer.id == payload.computer_id).with_for_update().first()

    if computer is None or computer.archived:
        raise HTTPException(status_code=404, detail="ПК не найден.")

    save_alias(session, me, "model", raw, value, "board")
    fields = {"motherboard": value}

    if computer.model and key_of(computer.model) in (key_of(raw), key_of(value)):
        fields["model"] = ""

    batch = ChangeBatch(me["login"])
    changes = apply_fields(session, computer, fields, user_field_keys_of(session), batch)

    for change in changes.values():
        change["scan"] = payload.source or "сканер"

    save_changes(session, computer, changes, me["login"])
    batch.finish(session)
    session.commit()
    return {"ok": True}


@router.post("/reject")
def reject(payload: RejectIn, me=Depends(require_editor), session=Depends(get_db)):
    """Не предлагать это значение этому ПК, пока источник отдаёт то же."""
    added = 0

    for item in payload.items:
        check_field(item.field)
        key = key_of(item.raw)
        exists = (
            session.query(ScanReject)
            .filter(ScanReject.computer_id == item.computer_id, ScanReject.field == item.field, ScanReject.value_key == key)
            .first()
        )

        if exists or session.get(Computer, item.computer_id) is None:
            continue

        session.add(ScanReject(
            computer_id=item.computer_id, field=item.field, value=item.raw, value_key=key, user_name=me["login"],
        ))
        session.flush()
        added += 1

    session.commit()
    return {"rejected": added}


@router.post("/unreject")
def unreject(payload: RejectIn, me=Depends(require_editor), session=Depends(get_db)):
    """Вернуть отклонённое: снова предлагать."""
    removed = 0

    for item in payload.items:
        removed += (
            session.query(ScanReject)
            .filter(
                ScanReject.computer_id == item.computer_id, ScanReject.field == item.field,
                ScanReject.value_key == key_of(item.raw),
            )
            .delete()
        )

    session.commit()
    return {"returned": removed}


# ---------- Пометки в Таблице: вид и когда показывать (этап 26б) ----------

marks_router = APIRouter(prefix="/api/scan/marks", tags=["scan"])

# Названия ситуаций — как в «Принять изменения…» (просьба 02.10)
MARK_LABELS = {
    "diff": "Замена",
    "fill": "Новые значения",
    "unsure": "Неточно",
    "partial": "Добавление значений",
}
MARK_FIELDS = ("color", "bg_color", "bold", "italic", "strike", "frame", "enabled", "always")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class MarkOut(BaseModel):
    kind: str
    label: str
    color: Optional[str]
    bg_color: Optional[str]
    bold: bool
    italic: bool
    strike: bool
    frame: Optional[str]
    enabled: bool
    always: bool


class MarkUpdate(BaseModel):
    """None — не менять; у цветов "" — убрать."""
    color: Optional[str] = None
    bg_color: Optional[str] = None
    bold: Optional[bool] = None
    italic: Optional[bool] = None
    strike: Optional[bool] = None
    frame: Optional[str] = None
    enabled: Optional[bool] = None
    always: Optional[bool] = None


def mark_out(mark):
    return MarkOut(label=MARK_LABELS.get(mark.kind, mark.kind), **{
        "kind": mark.kind, **{field: getattr(mark, field) for field in MARK_FIELDS}
    })


@marks_router.get("", response_model=list[MarkOut])
def list_marks(me=Depends(get_current_user), session=Depends(get_db)):
    return [mark_out(m) for m in session.query(ScanMark).order_by(ScanMark.sort, ScanMark.kind)]


@marks_router.patch("/{kind}", response_model=MarkOut)
def update_mark(kind: str, payload: MarkUpdate, me=Depends(require_editor), session=Depends(get_db)):
    """Вид пометки — общий для всех, как оформление в Справочниках."""
    mark = session.get(ScanMark, kind)

    if mark is None:
        raise HTTPException(status_code=404, detail="Нет такой пометки.")

    data = payload.model_dump(exclude_none=True)
    changes = {}

    for field, value in data.items():
        if field in ("color", "bg_color", "frame"):
            value = (value or "").strip() or None

            if value is not None and not COLOR_RE.match(value):
                raise HTTPException(status_code=400, detail="Цвет — в виде #RRGGBB.")

        changes[field] = {"old": getattr(mark, field), "new": value}
        setattr(mark, field, value)

    log_change(session, "scan_marks", 0, me["login"], changes, title=MARK_LABELS.get(kind, kind), entity_key=kind)
    session.commit()
    return mark_out(mark)


# ---------- Столбец «Антивирусы»: вид и что показывать (этап 26д) ----------

av_router = APIRouter(prefix="/api/scan/antivirus", tags=["scan"])

AV_KEY = "antivirus"
AV_STYLE_FIELDS = ("color", "bg_color", "bold", "italic", "underline", "strike", "chip", "show")
# Начальный вид (26е): блочком с фоном по состоянию, как значения в Справочниках —
# зелёный, оранжевый, красный (миграция a3d7c1e5f9b2 переводит и прежний вид 26д)
# С 28б — те же кнопки, что у значений Справочников: Ч, З и «фон блочком» (chip)
AV_PLAIN = {"color": None, "bold": False, "italic": False, "underline": False, "strike": False, "chip": True, "show": True}
AV_DEFAULTS = {
    "on": {**AV_PLAIN, "bg_color": "#cdebd0"},
    "old": {**AV_PLAIN, "bg_color": "#fde0b8"},
    "off": {**AV_PLAIN, "bg_color": "#f7c6c6"},
}
AV_HIDDEN_MAX = 100
AV_NAMES_MAX = 300
AV_NAME_LEN = 60


class AvStatusOut(BaseModel):
    kind: str
    label: str
    color: Optional[str]
    bg_color: Optional[str]
    bold: bool
    italic: bool
    underline: bool = False
    strike: bool = False
    chip: bool = True
    show: bool


class AvSettingsOut(BaseModel):
    statuses: list[AvStatusOut]
    hidden: list[str]       # названия, которые не показывать (без учёта регистра)
    names: dict[str, str] = {}   # своё название: название в источнике (строчными) → как показывать


class AvRename(BaseModel):
    source: str             # название, как в GLPI / GSIT
    name: str = ""          # как показывать; "" — как в источнике


class AvUpdate(BaseModel):
    """Вид состояния kind (None — не менять; у цветов "" — убрать) или список hidden."""
    kind: Optional[str] = None
    color: Optional[str] = None
    bg_color: Optional[str] = None
    bold: Optional[bool] = None
    italic: Optional[bool] = None
    underline: Optional[bool] = None
    strike: Optional[bool] = None
    chip: Optional[bool] = None
    show: Optional[bool] = None
    hidden: Optional[list[str]] = None
    rename: Optional[AvRename] = None


def av_key(name):
    return " ".join(str(name or "").split()).lower()


def av_settings(session):
    """Настройки столбца: сохранённые поверх значений по умолчанию."""
    row = session.get(AppSetting, AV_KEY)
    saved = (row.value if row else None) or {}
    statuses = {}

    for kind, default in AV_DEFAULTS.items():
        own = (saved.get("statuses") or {}).get(kind) or {}
        statuses[kind] = {field: own.get(field, value) for field, value in default.items()}

    hidden = [name for name in saved.get("hidden") or [] if isinstance(name, str)]
    names = {
        key: name for key, name in (saved.get("names") or {}).items()
        if isinstance(key, str) and isinstance(name, str) and name.strip()
    }
    return {"statuses": statuses, "hidden": hidden, "names": names}


def av_name(settings, name):
    """Как показывать антивирус: своё название (Справочники) или как в источнике."""
    return settings["names"].get(av_key(name)) or name


def av_settings_out(settings):
    return AvSettingsOut(
        statuses=[
            AvStatusOut(kind=kind, label=AV_STATUSES[kind], **settings["statuses"][kind])
            for kind in AV_DEFAULTS
        ],
        hidden=settings["hidden"],
        names=settings["names"],
    )


def av_visible(settings, item):
    """Показывать ли антивирус в столбце: состояние включено и название не скрыто."""
    hidden = {name.strip().lower() for name in settings["hidden"]}
    return settings["statuses"][item["status"]]["show"] and item["name"].strip().lower() not in hidden


@av_router.get("", response_model=AvSettingsOut)
def get_av_settings(me=Depends(get_current_user), session=Depends(get_db)):
    return av_settings_out(av_settings(session))


@av_router.patch("", response_model=AvSettingsOut)
def update_av_settings(payload: AvUpdate, me=Depends(require_editor), session=Depends(get_db)):
    """Вид столбца — общий для всех, как оформление в Справочниках."""
    settings = av_settings(session)
    data = payload.model_dump(exclude_none=True)
    kind = data.pop("kind", None)
    hidden = data.pop("hidden", None)
    rename = data.pop("rename", None)
    changes = {}

    if data:
        if kind not in AV_DEFAULTS:
            raise HTTPException(status_code=400, detail="Нет такого состояния антивируса.")

        status = settings["statuses"][kind]

        for field, value in data.items():
            if field in ("color", "bg_color"):
                value = (value or "").strip() or None

                if value is not None and not COLOR_RE.match(value):
                    raise HTTPException(status_code=400, detail="Цвет — в виде #RRGGBB.")

            changes[field] = {"old": status[field], "new": value}
            status[field] = value

        title = AV_STATUSES[kind]
    elif rename is not None:
        title = "Название"
    else:
        title = "Не показывать"

    if rename is not None:
        source = " ".join(rename["source"].split())
        name = " ".join(rename["name"].split())
        key = av_key(source)

        if not key or len(source) > 200:
            raise HTTPException(status_code=400, detail="Не указано название антивируса.")

        if len(name) > AV_NAME_LEN:
            raise HTTPException(status_code=400, detail=f"Название — не длиннее {AV_NAME_LEN} знаков.")

        old = settings["names"].get(key)
        names = dict(settings["names"])

        if name and av_key(name) != key:
            names[key] = name
        else:
            names.pop(key, None)

        if len(names) > AV_NAMES_MAX:
            raise HTTPException(status_code=400, detail="Слишком много своих названий.")

        changes["name"] = {"old": old or source, "new": names.get(key) or source}
        settings["names"] = names
        kind = None
        title = source

    if hidden is not None:
        names = []

        for name in hidden:
            name = (name or "").strip()

            if name and len(name) <= 200 and name.lower() not in {n.lower() for n in names}:
                names.append(name)

        if len(names) > AV_HIDDEN_MAX:
            raise HTTPException(status_code=400, detail="Слишком много скрытых названий.")

        changes["hidden"] = {"old": ", ".join(settings["hidden"]) or None, "new": ", ".join(names) or None}
        settings["hidden"] = names

    row = session.get(AppSetting, AV_KEY)

    if row is None:
        row = AppSetting(key=AV_KEY)
        session.add(row)

    row.value = {"statuses": settings["statuses"], "hidden": settings["hidden"], "names": settings["names"]}
    row.updated_at = datetime.now(timezone.utc)
    entity_key = kind or ("name" if rename is not None else "hidden")
    log_change(session, "scan_antivirus", 0, me["login"], changes, title=title, entity_key=entity_key)
    session.commit()
    return av_settings_out(settings)
