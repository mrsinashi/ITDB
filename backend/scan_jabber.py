"""Jabber (ejabberd, VACUUM) через веб-админку: проверка подключения (этап 24) и
сбор пользователей (этап 26д).

Как в скрипте пользователя check_users.sh: страницы
  {адрес}/admin/server/{домен}/users/1-1000/      — все пользователи и «Последнее
                                                    подключение» (этап 26ж)
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
from datetime import datetime

from scan_http import SourceError, basic_auth, check_url, request

USER_LINK = re.compile(r"/user/([^\"'/?#]+)/")
# Версия — в подвале страницы: «<a …>ejabberd</a> 23.10-1 (c) …»
VERSION = re.compile(r"ejabberd</a>\s*([0-9][0-9A-Za-z.\-]*)")
INPUT = re.compile(r"<input\b[^>]*>", re.I)
ATTR = re.compile(r"""([a-zA-Z_:-]+)\s*=\s*(?:'([^']*)'|"([^"]*)")""")
TEXTAREA = re.compile(r"<textarea\b([^>]*)>(.*?)</textarea>", re.I | re.S)
# Ресурс пользователя: «<li>Vacuum-IM (plain://192.168.99.231:10394#ejabberd@localhost)</li>»
RESOURCE = re.compile(r"<li>\s*([^<]*?)\s*\(\s*[a-z0-9_]+://(.+?):(\d+)(?:#[^)]*)?\)\s*</li>", re.I)


# Строка списка пользователей: ссылка на пользователя, …, «Последнее подключение»
USER_ROW = re.compile(r"<tr>\s*<td>\s*<a\s+href=['\"][^'\"]*/user/([^'\"/]+)/['\"]>.*?</td>(.*?)</tr>", re.I | re.S)
CELL = re.compile(r"<td[^>]*>(.*?)</td>", re.I | re.S)
TAG = re.compile(r"<[^>]+>")
LAST_DATE = re.compile(r"(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)")
ONLINE_WORDS = ("подключён", "подключен", "online")
# Список пользователей: сколько спросить сразу и на сколько спрашивать больше
USERS_FIRST = 1000
USERS_STEP = 100
USERS_MAX = 20000


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


def last_login(text):
    """«Последнее подключение»: (в сети сейчас, когда) — «Подключён» → (True, None),
    «2026-09-18 11:18:44» → (False, время сервера), «Никогда» → (False, None)."""
    text = html_lib.unescape(TAG.sub("", text or "")).strip()

    if text.lower() in ONLINE_WORDS:
        return True, None

    found = LAST_DATE.search(text)

    if not found:
        return False, None

    try:
        # Время сервера Jabber; считаем, что пояс тот же, что у ITDB
        return False, datetime(*(int(x) for x in found.groups())).astimezone()
    except ValueError:
        return False, None


def users_page(html):
    """Список пользователей: {логин: (в сети, последнее подключение)}."""
    result = {}

    for name, rest in USER_ROW.findall(html):
        cells = CELL.findall(rest)
        result[urllib.parse.unquote(name)] = last_login(cells[-1] if cells else "")

    return result


def all_users(params):
    """Все пользователи сервера. Страница users/1-N/ отдаёт первых N; спрашиваем
    1000, потом на 100 больше — и так, пока пользователей прибавляется."""
    size = USERS_FIRST
    users = users_page(admin_page(params, f"users/1-{size}/"))

    while size < USERS_MAX:
        more = users_page(admin_page(params, f"users/1-{size + USERS_STEP}/"))

        if len(more) <= len(users):
            break

        users, size = more, size + USERS_STEP

    return users


def collect(params, fresh_days=None, progress=None):
    """Сбор: все пользователи и когда подключались, кто в сети и с каких адресов,
    группы общего ростера и их участники.

    Ответ: {"items": [{"login", "groups", "online", "resources", "registered",
    "last_login"}], "stats": {...}, "warnings": [...], "groups_ok": группы получены,
    "users_ok": список пользователей получен, "version": …}; registered — None,
    если списка нет. progress(просмотрено пользователей, всего) — по ходу."""
    _, domain = split_admin_url(params["url"], params.get("domain"))
    warnings = []
    online_html = admin_page(params, "online-users/")
    online = {login.lower() for login in online_users(online_html)}
    version = VERSION.search(online_html)
    users = {}

    def user(login):
        return users.setdefault(login.lower(), {
            "login": login, "groups": [], "online": False, "resources": [], "registered": None, "last_login": None,
        })

    try:
        listed = all_users(params)
        users_ok = bool(listed)

        if not listed:
            warnings.append("Список пользователей пуст.")
    except SourceError as err:
        warnings.append(f"Список пользователей не получен: {err}")
        listed = {}
        users_ok = False

    for login, (is_online, last) in listed.items():
        item = user(login)
        item["registered"] = True
        item["last_login"] = last

        if is_online:
            online.add(login.lower())

    for login in online_users(online_html):
        user(login)

    try:
        groups_html = admin_page(params, "shared-roster/")
        groups = roster_groups(groups_html)
        groups_ok = True
    except SourceError as err:
        warnings.append(f"Группы не получены: {err}")
        groups = []
        groups_ok = False

    for group in groups:
        title, members = group_page(admin_page(params, "shared-roster/" + urllib.parse.quote(group, safe="") + "/"))
        title = title or group

        for jid in members:
            login = login_of(jid, domain)

            if login and title not in user(login)["groups"]:
                user(login)["groups"].append(title)

    items = sorted(users.values(), key=lambda u: u["login"].lower())
    total = len(items)

    if progress:
        progress(0, total)

    for done, item in enumerate(items, 1):
        if users_ok and item["registered"] is None:
            item["registered"] = False      # в группе есть, а пользователя нет

        if item["login"].lower() in online:
            item["online"] = True
            item["resources"] = user_resources(admin_page(params, "user/" + urllib.parse.quote(item["login"], safe="") + "/"))

            if progress:
                progress(done, total)

    if progress:
        progress(total, total)

    stats = {
        "total": sum(1 for u in items if u["registered"]) if users_ok else total,
        "online": sum(1 for u in items if u["online"]),
        "groups": len(groups),
        "no_ip": sum(1 for u in items if u["online"] and not any(r["ip"] for r in u["resources"])),
        "gone": sum(1 for u in items if u["registered"] is False and u["groups"]),
        "no_group": sum(1 for u in items if u["registered"] and not u["groups"]) if groups_ok else 0,
    }
    return {
        "items": items, "stats": stats, "warnings": warnings, "groups_ok": groups_ok, "users_ok": users_ok,
        "version": version.group(1) if version else None,
    }


def check(params):
    html = admin_page(params, "online-users/")

    if "ejabberd" not in html.lower() and not USER_LINK.search(html):
        raise SourceError("Ответила не веб-админка ejabberd (нет списка пользователей в сети). Проверь адрес.")

    version = VERSION.search(html)
    server = f"ejabberd {version.group(1)}, " if version else ""
    return f"Подключено: {server}сейчас в сети {len(online_users(html))}."
