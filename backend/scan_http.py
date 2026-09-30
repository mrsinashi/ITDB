"""HTTP-запросы к источникам данных (GLPI, GSIT, веб-админка Jabber) — этап 24.

Только стандартная библиотека. Прокси не используется: источники — внутри сети.
Сбои связи превращаются в SourceError с понятным текстом по-русски; ответ
с кодом ошибки (401, 404…) — не исключение, его разбирает вызывающий.
"""
import base64
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 20
MAX_BYTES = 64 * 1024 * 1024


class SourceError(Exception):
    """Ошибка источника: текст — для пользователя."""


class Response:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = body

    def text(self):
        charset = self.headers.get_content_charset() if self.headers else None
        return self.body.decode(charset or "utf-8", errors="replace")


def basic_auth(login, password):
    raw = f"{login}:{password}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def check_url(url, what="Адрес"):
    """Адрес вида http(s)://имя[:порт][/путь] — без лишних пробелов и хвостового «/»."""
    url = (url or "").strip().rstrip("/")

    if not url:
        raise SourceError(f"{what} не указан.")

    parts = urllib.parse.urlsplit(url)

    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise SourceError(f"{what} должен начинаться с http:// или https://, например https://glpi.lan")

    return url


def _opener(verify):
    context = ssl.create_default_context()

    if not verify:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE

    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=context),
    )


def _reason_text(url, reason):
    host = urllib.parse.urlsplit(url).hostname or url

    if isinstance(reason, ssl.SSLCertVerificationError):
        return (
            f"Сертификат сервера {host} не прошёл проверку ({reason.verify_message or reason}). "
            "Поставь корневой сертификат организации на сервер ITDB "
            "или сними галочку «Проверять сертификат»."
        )

    if isinstance(reason, ssl.SSLError):
        text = str(reason)
        if any(mark in text for mark in ("WRONG_VERSION_NUMBER", "wrong version number", "UNEXPECTED_EOF", "EOF occurred")):
            return f"Не удалось установить защищённое соединение с {host} — похоже, он работает по http://, а не https://"
        return f"Ошибка защищённого соединения с {host}: {reason}"

    if isinstance(reason, socket.gaierror):
        return f"Не найден сервер «{host}»: проверь имя в адресе (или DNS на сервере ITDB)."

    if isinstance(reason, ConnectionRefusedError):
        return f"{host} не принимает подключения на этом порту: проверь адрес и порт."

    if isinstance(reason, (socket.timeout, TimeoutError)):
        return f"{host} не ответил за {TIMEOUT} с."

    if isinstance(reason, OSError) and reason.errno in (101, 113):
        return f"Нет маршрута до {host}: сервер ITDB его не видит по сети."

    return f"Не удалось подключиться к {host}: {reason}"


def request(url, headers=None, verify=True, method="GET", data=None):
    """Запрос; ответ с любым кодом — Response, сбой связи — SourceError."""
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})

    try:
        with _opener(verify).open(req, timeout=TIMEOUT) as resp:
            return Response(resp.status, resp.headers, resp.read(MAX_BYTES))
    except urllib.error.HTTPError as err:
        body = err.read(MAX_BYTES) if err.fp else b""
        return Response(err.code, err.headers, body)
    except urllib.error.URLError as err:
        raise SourceError(_reason_text(url, err.reason))
    except (socket.timeout, TimeoutError) as err:
        raise SourceError(_reason_text(url, err))
    except ssl.SSLError as err:
        raise SourceError(_reason_text(url, err))
    except ValueError as err:
        raise SourceError(f"Неверный адрес: {err}")
