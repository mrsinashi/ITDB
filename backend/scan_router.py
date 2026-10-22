"""Router (этап 73): адреса из списка Mikrotik «IP → Firewall → Address List» – по API RouterOS
(не REST; RouterOS 6.49), только api-ssl: порт 8729, сертификат – как у GLPI («Сертификат:
проверять»). Учётке хватает прав read и api. Только стандартная библиотека.

API – слова с длиной впереди, предложение кончается пустым словом; ответ – предложения !re
(строка), !done (конец), !trap (ошибка, потом !done), !fatal (соединение закрыто). Вход – имя и
пароль открытым текстом внутри TLS (с 6.43; прежний вход с challenge с 6.45.1 не работает).
Неверный пароль RouterOS может сообщить !trap, !fatal или просто закрыть соединение.

Берутся только отдельные адреса (ответ пользователя): подсети, диапазоны и имена пропускаются
(сколько – в итоге сбора). Комментарий – имя адреса; Winbox пишет его в кодировке Windows –
не UTF-8 – читается как cp1251.
"""
import ipaddress
import socket
import ssl

from scan_http import SourceError
from scan_ssh import split_host

PORT = 8729
TIMEOUT = 15
MAX_WORD = 16 * 1024 * 1024
LIST_PRINT = "/ip/firewall/address-list/print"


def text(raw):
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1251", errors="replace")


def encode_length(n):
    if n < 0x80:
        return bytes([n])
    if n < 0x4000:
        return (n | 0x8000).to_bytes(2, "big")
    if n < 0x200000:
        return (n | 0xC00000).to_bytes(3, "big")
    if n < 0x10000000:
        return (n | 0xE0000000).to_bytes(4, "big")
    return b"\xf0" + n.to_bytes(4, "big")


def encode_sentence(words):
    data = b""

    for word in words:
        raw = word if isinstance(word, bytes) else word.encode("utf-8")
        data += encode_length(len(raw)) + raw

    return data + b"\x00"


def tls_context(verify):
    context = ssl.create_default_context()

    if verify:
        # Python 3.13 по умолчанию отвергает сертификаты внутренних центров без части расширений
        # (VERIFY_X509_STRICT); цепочка и имя проверяются как прежде
        context.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)
    else:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        # api-ssl без сертификата у RouterOS 6 умеет только анонимный DH – без проверки можно и его
        context.set_ciphers("DEFAULT:ADH:@SECLEVEL=0")

    return context


def connect_error(host, port, err):
    where = f"{host}:{port}"

    if isinstance(err, ssl.SSLCertVerificationError):
        return (
            f"Сертификат {host} не прошёл проверку ({err.verify_message or err}). Поставь корневой "
            "сертификат организации на сервер ITDB или сними галочку «Проверять сертификат»."
        )

    if isinstance(err, ssl.SSLError):
        return f"Не удалось установить защищённое соединение с {where} ({err.reason or err}): включён ли api-ssl с сертификатом?"

    if isinstance(err, socket.gaierror):
        return f"Не найден «{host}»: проверь имя в адресе (или DNS на сервере ITDB)."

    if isinstance(err, ConnectionRefusedError):
        return f"{host} не принимает подключения на порту {port}: включи api-ssl (IP → Services) и проверь порт."

    if isinstance(err, (socket.timeout, TimeoutError)):
        return f"{where} не ответил за {TIMEOUT} с."

    if isinstance(err, OSError) and err.errno in (101, 113):
        return f"Нет маршрута до {host}: сервер ITDB его не видит по сети."

    return f"Не удалось подключиться к {where}: {err}"


def trap_text(message):
    lower = message.lower()

    if "invalid user name or password" in lower or "cannot log in" in lower:
        return "Router не пустил: неверный логин или пароль."

    if "not enough permissions" in lower or "not allowed" in lower:
        return f"У учётки Router не хватает прав (нужны read и api): {message}"

    return f"Router: {message}"


class Closed(SourceError):
    """Router закрыл соединение."""


class Trap(SourceError):
    """Router отказал в команде (!trap): соединение живо, следующую команду можно слать."""


class Api:
    """Соединение с API RouterOS: with Api(params) as api: api.talk(…)."""

    def __init__(self, params):
        self.host, self.port = split_host(params.get("url"), PORT)
        self.verify = params.get("verify_tls", True)
        self.sock = None

    def __enter__(self):
        try:
            raw = socket.create_connection((self.host, self.port), timeout=TIMEOUT)
        except OSError as err:
            raise SourceError(connect_error(self.host, self.port, err))

        try:
            self.sock = tls_context(self.verify).wrap_socket(raw, server_hostname=self.host)
        except (OSError, ValueError) as err:
            raw.close()
            raise SourceError(connect_error(self.host, self.port, err))

        return self

    def __exit__(self, *exc):
        try:
            self.sock.close()
        except OSError:
            pass

    def read(self, n):
        data = b""

        while len(data) < n:
            try:
                chunk = self.sock.recv(n - len(data))
            except (socket.timeout, TimeoutError):
                raise SourceError(f"{self.host} не ответил за {TIMEOUT} с.")
            except OSError as err:
                raise SourceError(f"{self.host} оборвал соединение: {err}")

            if not chunk:
                raise Closed(f"{self.host} закрыл соединение.")

            data += chunk

        return data

    def read_length(self):
        first = self.read(1)[0]

        if first < 0x80:
            return first
        if first < 0xC0:
            return ((first & 0x3F) << 8) | self.read(1)[0]
        if first < 0xE0:
            return ((first & 0x1F) << 16) | int.from_bytes(self.read(2), "big")
        if first < 0xF0:
            return ((first & 0x0F) << 24) | int.from_bytes(self.read(3), "big")
        if first == 0xF0:
            return int.from_bytes(self.read(4), "big")

        raise SourceError(f"{self.host} ответил не как API RouterOS.")

    def sentence(self):
        """Предложение ответа: (вид – «!re», «!done»…, {свойство: значение})."""
        words = []

        # Пустые предложения пропускаются
        while not words:
            while True:
                length = self.read_length()

                if length == 0:
                    break

                if length > MAX_WORD:
                    raise SourceError(f"{self.host} ответил не как API RouterOS.")

                words.append(self.read(length))

        attrs, rest = {}, []

        for word in words[1:]:
            if word.startswith(b"="):
                key, _, value = word[1:].partition(b"=")
                attrs[text(key)] = text(value)
            else:
                rest.append(text(word))

        # У !fatal причина – просто словом
        if rest and "message" not in attrs:
            attrs["message"] = " ".join(rest)

        return text(words[0]), attrs

    def talk(self, *words):
        """Команда → ([строки !re], свойства !done); ошибка – SourceError."""
        try:
            self.sock.sendall(encode_sentence(words))
        except OSError as err:
            raise SourceError(f"{self.host} оборвал соединение: {err}")

        rows, trap = [], None

        while True:
            try:
                kind, attrs = self.sentence()
            except SourceError:
                # После ошибки входа RouterOS может закрыть соединение, не прислав !done
                if trap is not None:
                    raise Trap(trap_text(trap))
                raise

            if kind == "!re":
                rows.append(attrs)
            elif kind == "!trap":
                trap = attrs.get("message") or "ошибка"
            elif kind == "!fatal":
                raise SourceError(trap_text(attrs.get("message") or "соединение закрыто"))
            elif kind == "!done":
                if trap is not None:
                    raise Trap(trap_text(trap))
                return rows, attrs

    def login(self, name, password):
        if not name:
            raise SourceError("Укажи логин.")

        try:
            self.talk("/login", f"=name={name}", f"=password={password or ''}")
        except Closed:
            raise SourceError("Router закрыл соединение при входе: неверный логин или пароль, или у учётки нет права api.")

    def version(self):
        """«6.49.17 (long-term)»; прав на чтение нет – None. Таймаут и обрыв – ошибка: ответ,
        пришедший позже, иначе сочли бы ответом на следующую команду."""
        try:
            rows, _ = self.talk("/system/resource/print")
        except Trap:
            return None

        return rows[0].get("version") if rows else None


def single_ip(address):
    """Отдельный адрес IPv4 («10.0.0.5», «10.0.0.5/32»); подсеть, диапазон, имя – None."""
    value = (address or "").strip()

    if value.endswith("/32"):
        value = value[:-3]

    try:
        return str(ipaddress.IPv4Address(value))
    except ValueError:
        return None


def flag(value):
    return str(value).lower() in ("true", "yes")


def entries(rows):
    """Строки списка → ([{ip, name, data}], сколько пропущено). Адрес дважды (так не бывает,
    но всё же) – включённая запись главнее."""
    found, skipped = {}, 0

    for row in rows:
        ip = single_ip(row.get("address"))

        if ip is None:
            skipped += 1
            continue

        data = {"disabled": flag(row.get("disabled")), "dynamic": flag(row.get("dynamic"))}

        for key, field in (("timeout", "timeout"), ("created", "creation-time")):
            if row.get(field):
                data[key] = row[field]

        item = {"ip": ip, "name": (row.get("comment") or "").strip() or None, "data": data}

        if ip not in found or (found[ip]["data"]["disabled"] and not data["disabled"]):
            found[ip] = item

    return list(found.values()), skipped


def read_list(params):
    """(строки списка, версия RouterOS); списка нет или он пуст – SourceError."""
    name = (params.get("address_list") or "").strip()

    if not name:
        raise SourceError("Укажи адрес-лист.")

    with Api(params) as api:
        api.login(params.get("login"), params.get("password"))
        version = api.version()
        rows, _ = api.talk(LIST_PRINT, f"?list={name}")

        if not rows and not name.isascii():
            # Список заведён в Winbox на русской Windows – имя в кодировке Windows, как комментарии
            rows, _ = api.talk(LIST_PRINT, b"?list=" + name.encode("cp1251", errors="replace"))

    if not rows:
        raise SourceError(f"В адрес-листе «{name}» нет записей: проверь название (большие и маленькие буквы различаются).")

    return rows, version


def check(params):
    rows, version = read_list(params)
    items, skipped = entries(rows)
    on = sum(1 for item in items if not item["data"]["disabled"])
    parts = [f"адресов: {len(items)}", f"Enabled: {on}"]

    if skipped:
        parts.append(f"пропущено (подсети, диапазоны): {skipped}")

    return ("Подключено: RouterOS " + version if version else "Подключено") + f", «{params['address_list'].strip()}» – " + ", ".join(parts)


def collect(params, fresh_days, progress):
    rows, version = read_list(params)
    items, skipped = entries(rows)

    # Список заменяется целиком: без единого адреса прежний остаётся
    if not items:
        raise SourceError(f"В адрес-листе «{params['address_list'].strip()}» нет отдельных адресов – только подсети и диапазоны.")

    disabled = sum(1 for item in items if item["data"]["disabled"])
    warnings = [f"Пропущено (подсети, диапазоны, имена): {skipped}"] if skipped else []
    stats = {
        "total": len(items), "enabled": len(items) - disabled, "disabled": disabled,
        "dynamic": sum(1 for item in items if item["data"]["dynamic"]), "skipped": skipped,
        "list": params["address_list"].strip(),
    }
    return {"items": items, "stats": stats, "warnings": warnings, "version": version}
