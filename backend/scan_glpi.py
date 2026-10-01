"""GLPI и GSIT через REST API GLPI (apirest.php): проверка подключения (этап 24)
и сбор данных о ПК (этап 25).

GSIT — тоже GLPI (старый, с FusionInventory), поэтому код общий. Вход — по
токену пользователя (если задан) или по логину и паролю; токен приложения
(App-Token) — если его требует клиент API в GLPI.

Проверка подключения: вход → версия GLPI → число компьютеров → есть ли поле
с датой последней проверки ПК (по нему сбор отбирает свежие записи) → выход.

Сбор (collect): поиск всех ПК с датой проверки (одним-двумя запросами) → свежие
(не старше N дней) → по каждому свежему ПК — запись с устройствами, сетевыми
портами и программами; антивирусы — одним списком на все ПК.
"""
import json
import re
import urllib.parse
from datetime import datetime, timedelta

from scan_http import SourceError, basic_auth, check_url, request

# Коды ошибок GLPI → понятный текст
GLPI_ERRORS = {
    "ERROR_GLPI_LOGIN": "GLPI не пустил: неверный логин или пароль (или токен пользователя).",
    "ERROR_LOGIN_PARAMETERS_MISSING": "Не заданы ни логин с паролем, ни токен пользователя.",
    "ERROR_LOGIN_WITH_CREDENTIALS_DISABLED": (
        "В GLPI запрещён вход в API по логину и паролю: включи «Разрешить вход по учётным "
        "данным» (Настройки → Общие → API) или укажи токен пользователя."
    ),
    "ERROR_GLPI_LOGIN_USER_TOKEN": "GLPI не пустил: неверный токен пользователя.",
    "ERROR_WRONG_APP_TOKEN_PARAMETER": "Неверный токен приложения (App-Token).",
    "ERROR_APP_TOKEN_PARAMETERS_MISSING": (
        "GLPI требует токен приложения: скопируй App-Token клиента API "
        "(Настройки → Общие → API) в поле «Токен приложения»."
    ),
    "ERROR_NOT_ALLOWED_IP": (
        "GLPI не принимает запросы API с адреса сервера ITDB: добавь его в диапазон IP "
        "клиента API (Настройки → Общие → API)."
    ),
    "ERROR_API_DISABLED": None,  # текст — API_DISABLED ниже
    "ERROR_RIGHT_MISSING": "У пользователя GLPI нет права читать компьютеры.",
}

# GLPI отвечает на выключенный API ["ERROR", "API disabled"] (текст — на языке GLPI)
API_DISABLED = (
    "REST API в GLPI выключен: Настройки → Общие → API → «Включить REST API» "
    "(в GLPI 11 — «Включить устаревший REST API»: ITDB работает через него, как и с GSIT)."
)


def is_api_disabled(code, server):
    text = server.lower()
    return code == "ERROR_API_DISABLED" or (code == "ERROR" and "api" in text and ("отключ" in text or "disabled" in text))


# Поля с датой последней проверки ПК (по таблице и полю в listSearchOptions)
FRESH_FIELDS = [
    ("glpi_computers", "last_inventory_update", "дата последней инвентаризации"),
    ("glpi_agents", "last_contact", "последний контакт агента"),
    ("glpi_plugin_fusioninventory_agents", "last_contact", "последняя связь FusionInventory"),
    ("glpi_plugin_fusioninventory_inventorycomputercomputers", "last_fusioninventory_update",
     "последняя инвентаризация FusionInventory"),
]


def api_base(url):
    """Адрес API: пользователь может указать и адрес GLPI, и сразу …/apirest.php."""
    url = check_url(url, "Адрес GLPI")

    if url.endswith("/apirest.php"):
        return url

    for tail in ("/front/central.php", "/index.php", "/front"):
        if url.endswith(tail):
            url = url[: -len(tail)]

    return url + "/apirest.php"


def error_text(response):
    """Текст ошибки GLPI из ответа (обычно JSON ["КОД", "сообщение"])."""
    try:
        data = json.loads(response.body.decode("utf-8"))
    except ValueError:
        data = None

    if isinstance(data, list) and data:
        code = str(data[0])
        server = str(data[1]) if len(data) > 1 else ""

        if is_api_disabled(code, server):
            return API_DISABLED

        text = GLPI_ERRORS.get(code)

        # Какой адрес ITDB увидел GLPI — его и вписать в клиент API
        seen = re.search(r"\d+\.\d+\.\d+\.\d+", server) if code == "ERROR_NOT_ALLOWED_IP" else None

        if text and seen:
            return f"{text} GLPI видит сервер ITDB с адреса {seen.group(0)}."

        if text:
            return text

        return f"GLPI ответил ошибкой {code}" + (f": {server}" if server else "")

    if response.status == 404:
        return "По этому адресу нет API GLPI (404). Нужен адрес GLPI, например https://glpi.lan"

    snippet = response.text().strip().replace("\n", " ")[:160]
    return f"GLPI ответил кодом {response.status}, а не данными API" + (f": {snippet}" if snippet else "") + "."


class GlpiSession:
    """Сессия API: with GlpiSession(...) as glpi: glpi.get("Computer", range="0-0")."""

    def __init__(self, url, login=None, password=None, user_token=None, app_token=None, verify=True):
        self.base = api_base(url)
        self.verify = verify
        self.headers = {"Content-Type": "application/json", "Accept": "application/json"}

        if app_token:
            self.headers["App-Token"] = app_token

        if user_token:
            self.auth = "user_token " + user_token
        elif login and password:
            self.auth = basic_auth(login, password)
        else:
            raise SourceError("Укажи логин и пароль или токен пользователя GLPI.")

        self.token = None

    def __enter__(self):
        response = request(self.base + "/initSession", dict(self.headers, Authorization=self.auth), self.verify)

        if response.status != 200:
            raise SourceError(error_text(response))

        try:
            self.token = json.loads(response.body.decode("utf-8"))["session_token"]
        except (ValueError, KeyError, TypeError):
            raise SourceError("По этому адресу ответил не GLPI (нет session_token). Проверь адрес.")

        self.headers["Session-Token"] = self.token
        return self

    def __exit__(self, *exc):
        if self.token:
            try:
                request(self.base + "/killSession", self.headers, self.verify)
            except SourceError:
                pass
        return False

    def call(self, path, **params):
        """Ответ как есть (Response) — для разбора заголовков и кодов."""
        url = self.base + "/" + path

        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)

        return request(url, self.headers, self.verify)

    def get(self, path, **params):
        response = self.call(path, **params)

        if response.status not in (200, 206):
            raise SourceError(error_text(response))

        try:
            return json.loads(response.body.decode("utf-8"))
        except ValueError:
            raise SourceError(f"GLPI вернул не JSON на запрос {path}.")


def count_computers(glpi):
    response = glpi.call("Computer", range="0-0", only_id="true")

    if response.status in (200, 206):
        total = (response.headers.get("Content-Range") or "").rsplit("/", 1)[-1]

        if total.isdigit():
            return int(total)

        # Без Content-Range GLPI отдаёт пустой список
        return 0 if response.body.strip() == b"[]" else None

    # Пустой список GLPI отдаёт ошибкой «диапазон больше, чем записей»
    if "ERROR_RANGE_EXCEED_TOTAL" in response.text():
        return 0

    raise SourceError(error_text(response))


def find_fresh_field(options):
    """Поле с датой последней проверки ПК: (id, подпись) или None."""
    for table, field, label in FRESH_FIELDS:
        for option_id, option in options.items():
            if isinstance(option, dict) and option.get("table") == table and option.get("field") == field:
                return option_id, label

    return None


def find_option(options, table, field):
    for option_id, option in options.items():
        if isinstance(option, dict) and option.get("table") == table and option.get("field") == field:
            return option_id
    return None


def glpi_session(params):
    return GlpiSession(
        params["url"],
        login=params.get("login"),
        password=params.get("password"),
        user_token=params.get("user_token"),
        app_token=params.get("app_token"),
        verify=params.get("verify_tls", True),
    )


def check(params):
    """Проверка подключения; текст для пользователя или SourceError."""
    with glpi_session(params) as glpi:
        parts = []

        try:
            version = (glpi.get("getGlpiConfig").get("cfg_glpi") or {}).get("version")
        except (SourceError, AttributeError):
            version = None

        parts.append(f"GLPI {version}" if version else "GLPI")

        total = count_computers(glpi)
        parts.append(f"компьютеров: {total}" if total is not None else "компьютеры доступны")

        try:
            fresh = find_fresh_field(glpi.get("listSearchOptions/Computer"))
        except SourceError:
            fresh = None

        if fresh:
            parts.append(f"дата проверки ПК: {fresh[1]}")
        else:
            parts.append("поле с датой проверки ПК не найдено — свежие записи отобрать не получится")

        return "Подключено: " + ", ".join(parts) + "."


# ---------- Сбор (этап 25) ----------

PAGE = 500
DATE_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d")

# Необязательные столбцы поиска: тег агента, ОС
TAG_FIELDS = [("glpi_agents", "tag"), ("glpi_plugin_fusioninventory_agents", "tag")]
OS_FIELDS = {
    "os_name": ("glpi_operatingsystems", "name"),
    "os_version": ("glpi_operatingsystemversions", "name"),
    "os_kernel": ("glpi_operatingsystemkernelversions", "name"),
    "os_edition": ("glpi_operatingsystemeditions", "name"),
}


def parse_date(value):
    """Дата из поиска GLPI (время сервера GLPI); у нескольких агентов — самая поздняя."""
    values = value if isinstance(value, list) else [value]
    best = None

    for item in values:
        text = str(item or "").strip()[:19]

        for fmt in DATE_FORMATS:
            try:
                parsed = datetime.strptime(text, fmt)
            except ValueError:
                continue
            if best is None or parsed > best:
                best = parsed
            break

    return best


def first(value):
    if isinstance(value, list):
        value = next((v for v in value if v not in (None, "")), None)
    return None if value in (None, "", 0, "0") else value


def dropdown(value):
    """Значение выпадающего списка с expand_dropdowns: 0 / "" — пусто."""
    if value in (None, "", 0, "0") or isinstance(value, (int, float)):
        return None
    text = str(value).strip()
    return text or None


def items_of(block):
    """_devices[тип] бывает и словарём {id: запись}, и списком."""
    if isinstance(block, dict):
        return [item for item in block.values() if isinstance(item, dict)]
    if isinstance(block, list):
        return [item for item in block if isinstance(item, dict)]
    return []


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def search_list(glpi, columns, progress=None):
    """Все ПК из поиска GLPI (без удалённых и шаблонов): [{столбец: значение}]."""
    params = {f"forcedisplay[{i}]": option_id for i, option_id in enumerate(columns)}
    rows = []
    start = 0

    while True:
        response = glpi.call("search/Computer", range=f"{start}-{start + PAGE - 1}", **params)

        if response.status not in (200, 206):
            if "ERROR_RANGE_EXCEED_TOTAL" in response.text():
                break
            raise SourceError(error_text(response))

        try:
            data = json.loads(response.body.decode("utf-8"))
        except ValueError:
            raise SourceError("GLPI вернул не JSON на поиск компьютеров.")

        page = data.get("data") or []
        rows.extend(page)
        total = int(data.get("totalcount") or 0)
        start += PAGE

        if not page or start >= total:
            break

    return rows


def antivirus_by_computer(glpi, warnings):
    """Антивирусы всех ПК одним списком (ComputerAntivirus; в GLPI 11 он же
    ItemAntivirus): {id ПК: [{name, active, uptodate, version}]}."""
    result = {}

    for itemtype in ("ComputerAntivirus", "ItemAntivirus"):
        start = 0
        ok = True

        while True:
            response = glpi.call(itemtype, range=f"{start}-{start + PAGE - 1}")

            if response.status not in (200, 206):
                if "ERROR_RANGE_EXCEED_TOTAL" in response.text():
                    break
                ok = False
                break

            try:
                page = json.loads(response.body.decode("utf-8"))
            except ValueError:
                ok = False
                break

            if not isinstance(page, list) or not page:
                break

            for row in page:
                if not isinstance(row, dict) or row.get("is_deleted"):
                    continue
                computer_id = row.get("computers_id")
                if not computer_id and row.get("itemtype") == "Computer":
                    computer_id = row.get("items_id")
                try:
                    computer_id = int(computer_id)
                except (TypeError, ValueError):
                    continue
                result.setdefault(computer_id, []).append({
                    "name": str(row.get("name") or "").strip() or "?",
                    "active": bool(int(row.get("is_active") or 0)),
                    "uptodate": bool(int(row.get("is_uptodate") or 0)),
                    "version": row.get("antivirus_version") or None,
                })

            start += PAGE
            if len(page) < PAGE:
                break

        if ok:
            return result

    warnings.append("Антивирусы не получены: у пользователя GLPI нет права их читать (или это старый GLPI без них).")
    return {}


def computer_details(glpi, computer_id):
    """Одна запись ПК со всем нужным: устройства, сетевые порты, программы."""
    response = glpi.call(
        f"Computer/{computer_id}",
        with_devices="true", with_networkports="true", with_softwares="true", expand_dropdowns="true",
    )

    if response.status == 404:
        return None

    if response.status not in (200, 206):
        raise SourceError(error_text(response))

    try:
        item = json.loads(response.body.decode("utf-8"))
    except ValueError:
        raise SourceError(f"GLPI вернул не JSON о ПК {computer_id}.")

    devices = item.get("_devices") or {}
    if not isinstance(devices, dict):
        devices = {}

    cpus = [dropdown(d.get("deviceprocessors_id")) for d in items_of(devices.get("Item_DeviceProcessor"))]
    memory = sum(number(d.get("size")) for d in items_of(devices.get("Item_DeviceMemory")))
    disks = [
        {"name": dropdown(d.get("deviceharddrives_id")), "mb": int(number(d.get("capacity")))}
        for d in items_of(devices.get("Item_DeviceHardDrive"))
    ]
    gpus = [dropdown(d.get("devicegraphiccards_id")) for d in items_of(devices.get("Item_DeviceGraphicCard"))]

    ports = []
    networkports = item.get("_networkports") or {}
    if isinstance(networkports, dict):
        for port_type, block in networkports.items():
            if "Local" in port_type:
                continue
            for port in items_of(block):
                name_block = port.get("NetworkName") or {}
                ips = []
                if isinstance(name_block, dict):
                    for address in name_block.get("IPAddress") or []:
                        if isinstance(address, dict) and address.get("name"):
                            ips.append(address["name"])
                ports.append({"name": port.get("name"), "mac": port.get("mac"), "ips": ips})

    # Сетевые карты из устройств: у старых записей портов нет вовсе, а у
    # некоторых карт (Wi-Fi, Bluetooth) бывает только устройство без порта
    port_macs = {str(p.get("mac") or "").lower() for p in ports}
    for card in items_of(devices.get("Item_DeviceNetworkCard")):
        mac = card.get("mac")
        if mac and str(mac).lower() not in port_macs:
            port_macs.add(str(mac).lower())
            ports.append({"name": dropdown(card.get("devicenetworkcards_id")), "mac": mac, "ips": []})

    softwares = []
    for software in item.get("_softwares") or []:
        if isinstance(software, dict):
            name = dropdown(software.get("softwares_id"))
            if name:
                softwares.append(name)

    return {
        "name": item.get("name"),
        "serial": item.get("serial"),
        "uuid": item.get("uuid"),
        "manufacturer": dropdown(item.get("manufacturers_id")),
        "model": dropdown(item.get("computermodels_id")),
        "cpus": [c for c in cpus if c],
        "memory_mb": int(memory),
        "disks": disks,
        "gpus": [g for g in gpus if g],
        "ports": ports,
        "softwares": softwares,
    }


def collect(params, fresh_days, progress=None):
    """Сбор: все ПК из поиска → свежие по дате проверки → подробности каждого.

    Ответ: {"items": [{"id", "checked_at", "raw"}], "stats": {...},
    "warnings": [...], "version": "…"}; progress(done, total) — по ходу."""
    warnings = []

    with glpi_session(params) as glpi:
        try:
            version = (glpi.get("getGlpiConfig").get("cfg_glpi") or {}).get("version")
        except (SourceError, AttributeError):
            version = None

        options = glpi.get("listSearchOptions/Computer")
        fresh = find_fresh_field(options)

        if not fresh:
            raise SourceError(
                "В GLPI не найдено поле с датой последней проверки ПК (нужен агент GLPI или "
                "FusionInventory): без него не отличить свежие записи от старых, сбор не начат."
            )

        fresh_id = fresh[0]
        tag_id = next((find_option(options, t, f) for t, f in TAG_FIELDS if find_option(options, t, f)), None)
        os_ids = {key: find_option(options, *where) for key, where in OS_FIELDS.items()}
        columns = ["2", "1", fresh_id] + [x for x in [tag_id, *os_ids.values()] if x]

        rows = search_list(glpi, columns)
        cutoff = datetime.now() - timedelta(days=fresh_days)
        chosen = []
        stats = {"total": 0, "fresh": 0, "stale": 0, "no_date": 0, "gone": 0}

        for row in rows:
            try:
                computer_id = int(first(row.get("2")))
            except (TypeError, ValueError):
                continue

            stats["total"] += 1
            checked = parse_date(row.get(fresh_id))

            if checked is None:
                stats["no_date"] += 1
            elif checked < cutoff:
                stats["stale"] += 1
            else:
                entry = {"id": computer_id, "checked_at": checked, "tag": first(row.get(tag_id)) if tag_id else None}

                for key, option_id in os_ids.items():
                    entry[key] = first(row.get(option_id)) if option_id else None

                chosen.append(entry)

        antivirus = antivirus_by_computer(glpi, warnings) if chosen else {}
        items = []

        if progress:
            progress(0, len(chosen))

        for done, entry in enumerate(chosen, start=1):
            raw = computer_details(glpi, entry["id"])

            if raw is None:
                stats["gone"] += 1
            else:
                raw.update({key: entry[key] for key in ("tag", *OS_FIELDS)})
                raw["antivirus"] = antivirus.get(entry["id"], [])
                items.append({"id": entry["id"], "checked_at": entry["checked_at"], "raw": raw})

            if progress and (done % 10 == 0 or done == len(chosen)):
                progress(done, len(chosen))

        stats["fresh"] = len(items)

    return {"items": items, "stats": stats, "warnings": warnings, "version": version, "fresh_label": fresh[1]}
