"""GLPI и GSIT через REST API GLPI (apirest.php) — этап 24: проверка подключения.

GSIT — тоже GLPI (старый, с FusionInventory), поэтому код общий. Вход — по
токену пользователя (если задан) или по логину и паролю; токен приложения
(App-Token) — если его требует клиент API в GLPI.

Проверка подключения: вход → версия GLPI → число компьютеров → есть ли поле
с датой последней проверки ПК (по нему этап 25 отберёт свежие записи) → выход.
"""
import json
import re
import urllib.parse

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


def check(params):
    """Проверка подключения; текст для пользователя или SourceError."""
    with GlpiSession(
        params["url"],
        login=params.get("login"),
        password=params.get("password"),
        user_token=params.get("user_token"),
        app_token=params.get("app_token"),
        verify=params.get("verify_tls", True),
    ) as glpi:
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
