"""Jabber (ejabberd, VACUUM) через веб-админку: проверка подключения (этап 24) и
сбор пользователей (этап 26д).

Как в скрипте пользователя check_users.sh: страницы
  {адрес}/admin/server/{домен}/online-users/      — кто в сети (ссылки …/user/<имя>/)
  {адрес}/admin/server/{домен}/user/<имя>/        — подключённые ресурсы: клиент и IP
  {адрес}/admin/server/{домен}/shared-roster/     — группы общего ростера
  {адрес}/admin/server/{домен}/shared-roster/<группа>/ — участники (textarea members)
с входом по логину и паролю администратора (Basic). Разбор — по HTML ejabberd 14.12
(прислан пользователем 30.09; устройство страниц — в журнале фазы 3).
"""
import html as html_lib
import ipaddress
import re
import urllib.parse

from scan_http import SourceError, basic_auth, check_url, request

USER_LINK = re.compile(r"/user/([^\"'/?#]+)/")
# Версия — в подвале страницы: «<a …>ejabberd</a> 23.10-1 (c) …»
VERSION = re.compile(r"ejabberd</a>\s*([0-9][0-9A-Za-z.\-]*)")
INPUT = re.compile(r"<input\b[^>]*>", re.I)
ATTR = re.compile(r"""([a-zA-Z_:-]+)\s*=\s*(?:'([^']*)'|"([^"]*)")""")
TEXTAREA = re.compile(r"<textarea\b([^>]*)>(.*?)</textarea>", re.I | re.S)
# Ресурс пользователя: «<li>Vacuum-IM (plain://192.168.99.231:10394#ejabberd@localhost)</li>»
RESOURCE = re.compile(r"<li>\s*([^<]*?)\s*\(\s*[a-z0-9_]+://(.+?):(\d+)(?:#[^)]*)?\)\s*</li>", re.I)


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


def attrs_of(tag):
    return {m.group(1).lower(): html_lib.unescape(m.group(2) if m.group(2) is not None else m.group(3)) for m in ATTR.finditer(tag)}


def roster_groups(html):
    """Группы общего ростера: отмеченные галочкой «selected» строки таблицы
    (последняя строка — форма добавления, у неё имя namenew)."""
    groups = []

    for tag in INPUT.findall(html):
        attrs = attrs_of(tag)

        if attrs.get("name") == "selected" and attrs.get("value") and attrs["value"] not in groups:
            groups.append(attrs["value"])

    return groups


def group_page(html):
    """(название, участники): участники — JID из textarea members, по строке."""
    title = None

    for tag in INPUT.findall(html):
        attrs = attrs_of(tag)

        if attrs.get("name") == "name" and attrs.get("value"):
            title = attrs["value"].strip()

    members = []

    for match in TEXTAREA.finditer(html):
        if attrs_of(match.group(1)).get("name") == "members":
            members = [line.strip() for line in html_lib.unescape(match.group(2)).splitlines() if line.strip()]

    return title, members


def login_of(jid, domain):
    """«ivanov@jabber.lan» → «ivanov»; чужой домен — JID целиком; «@all@» и
    подобные служебные записи общего ростера — None."""
    jid = jid.strip()

    if not jid or jid.startswith("@"):
        return None

    jid = jid.split("/", 1)[0]
    name, _, host = jid.partition("@")
    return name if not host or host.lower() == domain.lower() else jid


def ipv4_of(host):
    """Адрес из ресурса: «192.168.0.5», «::ffff:192.168.0.5», «[::1]» → IPv4 или None."""
    host = host.strip().strip("[]")
    tail = host.rsplit(":", 1)[-1] if ":" in host else host

    try:
        address = ipaddress.ip_address(tail)
    except ValueError:
        return None

    return str(address) if address.version == 4 else None


def user_resources(html):
    """Подключённые ресурсы со страницы пользователя: [{client, ip}]."""
    result = []

    for client, host, _port in RESOURCE.findall(html):
        ip = ipv4_of(html_lib.unescape(host))
        result.append({"client": html_lib.unescape(client).strip() or None, "ip": ip})

    return result


def collect(params, fresh_days=None, progress=None):
    """Сбор: кто в сети и с каких адресов, группы общего ростера и их участники.

    Ответ: {"items": [{"login", "groups", "online", "resources"}], "stats": {...},
    "warnings": [...], "groups_ok": группы получены, "version": …}; progress(done, total) — по ходу."""
    _, domain = split_admin_url(params["url"], params.get("domain"))
    warnings = []
    online_html = admin_page(params, "online-users/")
    online = online_users(online_html)
    version = VERSION.search(online_html)

    try:
        groups_html = admin_page(params, "shared-roster/")
        groups = roster_groups(groups_html)
        groups_ok = True
    except SourceError as err:
        warnings.append(f"Группы не получены: {err}")
        groups = []
        groups_ok = False

    total = len(groups) + len(online)
    done = 0
    users = {}

    def user(login):
        return users.setdefault(login, {"login": login, "groups": [], "online": False, "resources": []})

    if progress:
        progress(0, total)

    for group in groups:
        title, members = group_page(admin_page(params, "shared-roster/" + urllib.parse.quote(group, safe="") + "/"))
        title = title or group

        for jid in members:
            login = login_of(jid, domain)

            if login and title not in user(login)["groups"]:
                user(login)["groups"].append(title)

        done += 1

        if progress and done % 10 == 0:
            progress(done, total)

    for login in online:
        item = user(login)
        item["online"] = True
        item["resources"] = user_resources(admin_page(params, "user/" + urllib.parse.quote(login, safe="") + "/"))
        done += 1

        if progress and (done % 10 == 0 or done == total):
            progress(done, total)

    items = sorted(users.values(), key=lambda u: u["login"].lower())
    stats = {
        "total": len(items),
        "online": sum(1 for u in items if u["online"]),
        "groups": len(groups),
        "no_ip": sum(1 for u in items if u["online"] and not any(r["ip"] for r in u["resources"])),
    }
    return {
        "items": items, "stats": stats, "warnings": warnings, "groups_ok": groups_ok,
        "version": version.group(1) if version else None,
    }


def check(params):
    html = admin_page(params, "online-users/")

    if "ejabberd" not in html.lower() and not USER_LINK.search(html):
        raise SourceError("Ответила не веб-админка ejabberd (нет списка пользователей в сети). Проверь адрес.")

    version = VERSION.search(html)
    server = f"ejabberd {version.group(1)}, " if version else ""
    return f"Подключено: {server}сейчас в сети {len(online_users(html))}."
