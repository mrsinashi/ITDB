"""Jabber (ejabberd, VACUUM) через веб-админку — этап 24: проверка подключения.

Как в скрипте пользователя check_users.sh: страница
  {адрес}/admin/server/{домен}/online-users/
с входом по логину и паролю администратора (Basic). Пользователи в сети —
ссылки вида …/user/<имя>/ на этой странице.
"""
import re
import urllib.parse

from scan_http import SourceError, basic_auth, check_url, request

USER_LINK = re.compile(r"/user/([^\"'/?#]+)/")
# Версия — в подвале страницы: «<a …>ejabberd</a> 23.10-1 (c) …»
VERSION = re.compile(r"ejabberd</a>\s*([0-9][0-9A-Za-z.\-]*)")


def split_admin_url(url, domain=None):
    """Адрес веб-админки и домен XMPP. Можно вставить адрес любой страницы
    админки (…/admin/server/jabber.lan/shared-roster/) — домен возьмётся из него."""
    url = check_url(url, "Адрес веб-админки")
    parts = urllib.parse.urlsplit(url)
    path = parts.path

    match = re.search(r"/admin/server/([^/]+)", path)

    if match and not domain:
        domain = urllib.parse.unquote(match.group(1))

    if "/admin" in path:
        path = path[: path.index("/admin")]

    base = urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, "", ""))
    domain = (domain or parts.hostname or "").strip()

    if not domain:
        raise SourceError("Не указан домен XMPP (например, jabber.lan).")

    return base, domain


def normalize(url):
    """Для сохранения: адрес веб-админки без пути к странице и домен из пути
    (если адрес вставили со страницы админки), иначе домен None."""
    url = check_url(url, "Адрес веб-админки")
    match = re.search(r"/admin/server/([^/]+)", urllib.parse.urlsplit(url).path)
    base, _ = split_admin_url(url, "-")
    return base, urllib.parse.unquote(match.group(1)) if match else None


def full_login(login, domain):
    """Вход в веб-админку — полным адресом: admin → admin@домен."""
    login = (login or "").strip()
    return login if "@" in login else f"{login}@{domain}"


def admin_page(params, page):
    base, domain = split_admin_url(params["url"], params.get("domain"))

    if not params.get("login") or not params.get("password"):
        raise SourceError("Укажи логин и пароль администратора Jabber.")

    url = f"{base}/admin/server/{urllib.parse.quote(domain)}/{page}"
    headers = {"Authorization": basic_auth(full_login(params["login"], domain), params["password"])}
    response = request(url, headers, params.get("verify_tls", True))

    if response.status == 401:
        raise SourceError("Jabber не пустил: неверный логин или пароль (логин — полный, например admin@jabber.lan).")

    if response.status == 404:
        raise SourceError(f"Нет страницы {url} (404): проверь адрес веб-админки и домен XMPP.")

    if response.status != 200:
        raise SourceError(f"Веб-админка Jabber ответила кодом {response.status}.")

    return response.text()


def online_users(html):
    return sorted({urllib.parse.unquote(name) for name in USER_LINK.findall(html)})


def check(params):
    html = admin_page(params, "online-users/")

    if "ejabberd" not in html.lower() and not USER_LINK.search(html):
        raise SourceError("Ответила не веб-админка ejabberd (нет списка пользователей в сети). Проверь адрес.")

    version = VERSION.search(html)
    server = f"ejabberd {version.group(1)}, " if version else ""
    return f"Подключено: {server}сейчас в сети {len(online_users(html))}."
