"""Сканирование, этап 24: подключения к источникам (GLPI, GSIT, Jabber; с этапа 28 —
DHCP по SSH и «Сеть» — проход подсетей) и подсети для сетевого сканирования.
Только администратор.

У каждого источника одна строка настроек; строки в базе появляются при
первом сохранении, до этого отдаются значения по умолчанию. Пароли и токены
хранятся зашифрованными (secret_box.py) и наружу не отдаются — только «задан».
Изменения пишутся в Историю (видит администратор); пароли — «задан новый».
"""
import ipaddress
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import scan_dhcp
import scan_glpi
import scan_jabber
import scan_net
import scan_ssh
from auth import require_admin
from db import get_db
from history_log import PASSWORD_SET, log_change
from models import Computer, Location, ScanRun, ScanSource, ScanSubnet
from scan_http import SourceError, check_url
from secret_box import decrypt, encrypt, key_ready

router = APIRouter(prefix="/api/scan", tags=["scan"])

# Источники: название, какие поля есть в форме, чем проверять подключение
# form — какая форма у источника: glpi, jabber, ssh (DHCP: адрес, файл, логин,
# пароль, ключ), net (проход подсетей: адреса нет, только что проверять).
# fresh — срок «Актуальны» по умолчанию и наибольший:
# - GLPI / GSIT: записи, проверенные не раньше, чем N дней назад;
# - Jabber: кто не подключался дольше — «давно не в сети» (выделяется в VACUUM);
# - DHCP: аренды, которые действуют или кончились не раньше N дней назад;
# - Сеть: сколько дней помнить адрес, который перестал отвечать.
SOURCES = {
    "glpi": {"title": "GLPI", "check": scan_glpi.check, "glpi": True, "form": "glpi", "fresh": (3, 60)},
    "gsit": {"title": "GSIT", "check": scan_glpi.check, "glpi": True, "form": "glpi", "fresh": (3, 60)},
    "jabber": {"title": "Jabber", "check": scan_jabber.check, "glpi": False, "form": "jabber", "fresh": (7, 365)},
    "dhcp": {"title": "DHCP", "check": scan_dhcp.check, "glpi": False, "form": "ssh", "fresh": (30, 365)},
    "net": {"title": "Сеть", "check": scan_net.check, "glpi": False, "form": "net", "fresh": (7, 365)},
}
SECRET_FIELDS = ("password", "user_token", "app_token")
SECRET_LABELS = {"password": "пароль", "user_token": "токен пользователя", "app_token": "токен приложения"}
SECRET_REMOVED = "удалён"
# Ключ SSH (DHCP) создаёт сама программа; хранится в secrets, наружу — только открытая часть
SSH_KEY = "ssh_key"
KEY_CREATED = "создан"
HOST_KEY_FORGOTTEN = "забыт"

# Назначение подсети
PURPOSES = {
    "mixed": "Всё подряд",
    "printers": "Принтеры",
    "servers": "Серверы",
    "other": "Прочее (не ПК)",
}
# Больше /16 (65 тысяч адресов) сканировать не даём — это почти наверняка опечатка
SUBNET_MIN_PREFIX = 16
NOTE_MAX = 500


# ---------- Источники ----------


class RunOut(BaseModel):
    """Запуск сбора (этап 25): stats — счётчики отчёта, пока идёт — progress."""
    id: int
    source: str
    status: str
    user_name: Optional[str]
    started_at: datetime
    finished_at: Optional[datetime]
    message: Optional[str]
    stats: dict


# Запуск «идёт», начатый до старта программы, уже не идёт: программу
# перезапускали (в базе его закроет следующий сбор — scan_collect.running_run)
PROCESS_STARTED = datetime.now(timezone.utc)
INTERRUPTED = "Сбор прервался: программу перезапустили."


def interrupted(run):
    return run.status == "running" and run.started_at < PROCESS_STARTED


def run_out(run):
    stopped = interrupted(run)
    return RunOut(
        id=run.id, source=run.source, status="error" if stopped else run.status, user_name=run.user_name,
        started_at=run.started_at, finished_at=run.finished_at, message=INTERRUPTED if stopped else run.message,
        stats=run.stats or {},
    )


class SourceOut(BaseModel):
    kind: str
    title: str
    enabled: bool
    url: Optional[str]
    domain: Optional[str]
    login: Optional[str]
    secrets: dict[str, bool]
    verify_tls: bool
    fresh_days: Optional[int]
    checked_at: Optional[datetime]
    check_ok: Optional[bool]
    check_message: Optional[str]
    last_run: Optional[RunOut] = None
    form: str = "glpi"
    ready: bool = False               # можно собирать: адрес указан (Сеть — есть подсети)
    path: Optional[str] = None        # DHCP: файл аренд
    configs: list[str] = []           # DHCP: файлы настроек с привязками MAC — IP
    has_key: bool = False             # DHCP: ключ ITDB создан
    host_key: Optional[str] = None    # DHCP: отпечаток ключа сервера (запомнен)
    names: Optional[bool] = None      # Сеть: спрашивать имена (NetBIOS, DNS)
    ports: Optional[bool] = None      # Сеть: проверять порты


class SourcesOut(BaseModel):
    key_ready: bool
    sources: list[SourceOut]


class SourceUpdate(BaseModel):
    """None — не менять; у паролей и токенов "" — удалить сохранённый."""
    enabled: Optional[bool] = None
    url: Optional[str] = None
    domain: Optional[str] = None
    login: Optional[str] = None
    password: Optional[str] = None
    user_token: Optional[str] = None
    app_token: Optional[str] = None
    verify_tls: Optional[bool] = None
    fresh_days: Optional[int] = None
    path: Optional[str] = None
    configs: Optional[list[str]] = None
    names: Optional[bool] = None
    ports: Optional[bool] = None
    forget_host: Optional[bool] = None


class CheckOut(BaseModel):
    ok: bool
    message: str
    checked_at: datetime
    saved: bool


def check_kind(kind):
    if kind not in SOURCES:
        raise HTTPException(status_code=404, detail="Нет такого источника.")


def load_source(session, kind, lock=False):
    query = session.query(ScanSource).filter(ScanSource.kind == kind)

    if lock:
        query = query.with_for_update()

    return query.first()


def fresh_days_of(source, kind):
    value = (source.options or {}).get("fresh_days") if source else None

    if isinstance(value, int):
        return value

    return SOURCES[kind]["fresh"][0]


def option_of(source, name, default):
    value = (source.options or {}).get(name) if source else None
    return default if value is None else value


def dhcp_files(source, data=None):
    """DHCP: (файл аренд, [файлы настроек]) — сохранённые, поверх них — из формы
    (data). В «Файл» раньше дописывали и dhcpd.conf через пробел: первый путь —
    аренды, остальные — настройки. Плохой путь — SourceError."""
    data = data or {}
    paths = scan_ssh.split_paths(data.get("path") or option_of(source, "path", scan_dhcp.DEFAULT_PATH))
    configs = data["configs"] if "configs" in data else (option_of(source, "configs", None) or [])
    extra = [path for path in paths[1:] if path not in configs]
    return paths[0], scan_ssh.config_paths(extra + list(configs))


def scan_subnets(session):
    """Подсети, отмеченные для сканирования."""
    return [s.cidr for s in session.query(ScanSubnet).filter(ScanSubnet.scan == True).order_by(ScanSubnet.id)]  # noqa: E712


def source_ready(session, kind, source):
    if SOURCES[kind]["form"] == "net":
        return session.query(ScanSubnet).filter(ScanSubnet.scan == True).first() is not None  # noqa: E712

    return bool(source and source.url)


def last_run_of(session, kind):
    run = session.query(ScanRun).filter(ScanRun.source == kind).order_by(ScanRun.id.desc()).first()
    return run_out(run) if run else None


def source_out(kind, source, last_run=None, ready=None):
    secrets = (source.secrets or {}) if source else {}
    glpi = SOURCES[kind]["glpi"]
    form = SOURCES[kind]["form"]
    fields = SECRET_FIELDS if glpi else (() if form == "net" else ("password",))
    host_key = option_of(source, "host_key", None)
    files = dhcp_files(source) if form == "ssh" else None

    return SourceOut(
        form=form,
        ready=bool(source and source.url) if ready is None else ready,
        path=files[0] if files else None,
        configs=files[1] if files else [],
        has_key=bool(secrets.get(SSH_KEY)),
        host_key=scan_ssh.fingerprint(host_key) if host_key else None,
        names=option_of(source, "names", True) if form == "net" else None,
        ports=option_of(source, "ports", False) if form == "net" else None,
        kind=kind,
        title=SOURCES[kind]["title"],
        enabled=bool(source and source.enabled),
        url=source.url if source else None,
        domain=source.domain if source and form == "jabber" else None,
        login=source.login if source else None,
        secrets={field: bool(secrets.get(field)) for field in fields},
        verify_tls=source.verify_tls if source else True,
        fresh_days=fresh_days_of(source, kind),
        checked_at=source.checked_at if source else None,
        check_ok=source.check_ok if source else None,
        check_message=source.check_message if source else None,
        last_run=last_run,
    )


def clean(value, limit=500):
    value = (value or "").strip()

    if len(value) > limit:
        raise HTTPException(status_code=400, detail="Слишком длинное значение.")

    return value or None


def clean_fresh_days(value, kind):
    limit = SOURCES[kind]["fresh"][1]

    if value is None or not (1 <= value <= limit):
        raise HTTPException(
            status_code=400,
            detail=f"Срок актуальности — от 1 до {limit} дней.",
        )
    return value


def connection_params(kind, source, overlay=None, session=None):
    """Параметры подключения: сохранённые (пароли расшифрованы) + несохранённые
    значения из формы (overlay) — чтобы проверить до сохранения. У «Сети» —
    подсети для прохода (нужна session) и что проверять."""
    secrets = (source.secrets or {}) if source else {}
    form = SOURCES[kind]["form"]

    if form == "net":
        data = overlay.model_dump(exclude_none=True) if overlay is not None else {}
        return {
            "subnets": scan_subnets(session),
            "names": data.get("names", option_of(source, "names", True)),
            "ports": data.get("ports", option_of(source, "ports", False)),
        }

    params = {
        "url": source.url if source else None,
        "domain": source.domain if source else None,
        "login": source.login if source else None,
        "verify_tls": source.verify_tls if source else True,
    }

    for field in SECRET_FIELDS:
        token = secrets.get(field)
        params[field] = decrypt(token, SECRET_LABELS[field]) if token else None

    if overlay is not None:
        data = overlay.model_dump(exclude_none=True)

        for field in ("url", "domain", "login"):
            if field in data:
                params[field] = clean(data[field])

        if "verify_tls" in data:
            params["verify_tls"] = data["verify_tls"]

        for field in SECRET_FIELDS:
            if field in data:
                params[field] = data[field] or None

    if form == "ssh":
        data = overlay.model_dump(exclude_none=True) if overlay is not None else {}
        token = secrets.get(SSH_KEY)
        params["ssh_key"] = decrypt(token, "ключ SSH") if token else None
        params["path"], params["configs"] = dhcp_files(source, data)
        # Адрес в форме другой — запомненный ключ сервера к нему не относится
        same_host = "url" not in data or address_of(data["url"]) == (source.url if source else None)
        params["host_key"] = option_of(source, "host_key", None) if same_host and not data.get("forget_host") else None

    if not params["url"]:
        raise SourceError("Укажи адрес.")

    return params


def address_of(value):
    try:
        return scan_ssh.clean_address(value)
    except SourceError:
        return None


def remember_host(source, seen):
    """Запомнить ключ сервера SSH при первом удачном подключении."""
    if source is not None and seen and seen.get("host_key") and not option_of(source, "host_key", None):
        source.options = dict(source.options or {}, host_key=seen["host_key"])


@router.get("/sources", response_model=SourcesOut)
def list_sources(me=Depends(require_admin), session=Depends(get_db)):
    rows = {source.kind: source for source in session.query(ScanSource).all()}
    return SourcesOut(
        key_ready=key_ready(),
        sources=[
            source_out(kind, rows.get(kind), last_run_of(session, kind), source_ready(session, kind, rows.get(kind)))
            for kind in SOURCES
        ],
    )


@router.patch("/sources/{kind}", response_model=SourceOut)
def update_source(kind: str, payload: SourceUpdate, me=Depends(require_admin), session=Depends(get_db)):
    check_kind(kind)
    glpi = SOURCES[kind]["glpi"]
    form = SOURCES[kind]["form"]
    data = payload.model_dump(exclude_none=True)

    if not glpi:
        for field in ("user_token", "app_token"):
            data.pop(field, None)

    if form != "jabber":
        data.pop("domain", None)

    if form != "ssh":
        for field in ("path", "configs", "forget_host"):
            data.pop(field, None)

    if form != "net":
        for field in ("names", "ports"):
            data.pop(field, None)
    else:
        for field in ("url", "login", "password", "verify_tls"):
            data.pop(field, None)

    source = load_source(session, kind, lock=True)

    if source is None:
        source = ScanSource(kind=kind, enabled=False, verify_tls=True, secrets={}, options={})
        session.add(source)

    before = {
        "enabled": bool(source.enabled),
        "url": source.url,
        "domain": source.domain,
        "login": source.login,
        "verify_tls": source.verify_tls if source.verify_tls is not None else True,
        "fresh_days": fresh_days_of(source, kind),
    }
    changes = {}

    # Jabber: адрес любой страницы веб-админки → адрес админки, домен — из пути
    if form == "jabber" and data.get("url"):
        try:
            data["url"], domain = scan_jabber.normalize(data["url"])
        except SourceError as err:
            raise HTTPException(status_code=400, detail=str(err))

        if domain and not clean(data.get("domain")) and not source.domain:
            data["domain"] = domain

    for field in ("url", "domain", "login"):
        if field in data:
            value = clean(data[field])

            if field == "url" and value:
                try:
                    value = scan_ssh.clean_address(value) if form == "ssh" else check_url(value, "Адрес")
                except SourceError as err:
                    raise HTTPException(status_code=400, detail=str(err))

            setattr(source, field, value)
            changes[field] = {"old": before[field], "new": value}

    if "verify_tls" in data:
        source.verify_tls = data["verify_tls"]
        changes["verify_tls"] = {"old": before["verify_tls"], "new": data["verify_tls"]}

    if "fresh_days" in data:
        days = clean_fresh_days(data["fresh_days"], kind)
        source.options = dict(source.options or {}, fresh_days=days)
        changes["fresh_days"] = {"old": before["fresh_days"], "new": days}

    if "path" in data or "configs" in data:
        old_path, old_configs = dhcp_files(source)

        try:
            path, configs = dhcp_files(source, data)
        except SourceError as err:
            raise HTTPException(status_code=400, detail=str(err))

        source.options = dict(source.options or {}, path=path, configs=configs)

        if path != old_path:
            changes["path"] = {"old": old_path, "new": path}

        if configs != old_configs:
            changes["configs"] = {"old": "\n".join(old_configs) or None, "new": "\n".join(configs) or None}

    for field, default in (("names", True), ("ports", False)):
        if field in data:
            old = option_of(source, field, default)
            source.options = dict(source.options or {}, **{field: data[field]})
            changes[field] = {"old": old, "new": data[field]}

    # Запомненный ключ сервера SSH: забыть по просьбе или при смене адреса
    host_changed = form == "ssh" and "url" in changes and changes["url"]["old"] != changes["url"]["new"]

    if (data.get("forget_host") or host_changed) and option_of(source, "host_key", None):
        source.options = {key: value for key, value in (source.options or {}).items() if key != "host_key"}
        changes["host_key"] = {"old": None, "new": HOST_KEY_FORGOTTEN}

    secrets = dict(source.secrets or {})

    for field in SECRET_FIELDS:
        if field not in data:
            continue

        value = data[field]

        if value:
            secrets[field] = encrypt(value)
            changes[field] = {"old": None, "new": PASSWORD_SET}
        elif secrets.pop(field, None):
            changes[field] = {"old": None, "new": SECRET_REMOVED}

    source.secrets = secrets

    if "enabled" in data:
        if data["enabled"] and not source.url and form != "net":
            raise HTTPException(status_code=400, detail="Сначала укажи адрес.")
        source.enabled = data["enabled"]
        changes["enabled"] = {"old": before["enabled"], "new": data["enabled"]}

    # Параметры подключения изменились — прошлая проверка больше ничего не говорит
    connection = {"url", "domain", "login", "verify_tls", "path", "configs", "host_key"} | set(SECRET_FIELDS)

    if any(field in connection for field, change in changes.items() if change["old"] != change["new"]):
        source.checked_at = None
        source.check_ok = None
        source.check_message = None

    source.updated_at = datetime.now(timezone.utc)

    log_change(
        session, "scan_sources", 0, me["login"], changes,
        title=SOURCES[kind]["title"], entity_key=kind,
    )
    session.commit()
    return source_out(kind, source, last_run_of(session, kind), source_ready(session, kind, source))


@router.post("/sources/{kind}/check", response_model=CheckOut)
def check_source(
    kind: str,
    payload: Optional[SourceUpdate] = None,
    me=Depends(require_admin),
    session=Depends(get_db),
):
    """Проверка подключения. Можно передать несохранённые значения формы — тогда
    результат не запоминается (он про форму, а не про сохранённые настройки)."""
    check_kind(kind)
    unsaved = payload is not None and bool(payload.model_dump(exclude_none=True))
    source = load_source(session, kind)

    params = {}

    try:
        params = connection_params(kind, source, payload if unsaved else None, session)
        message = SOURCES[kind]["check"](params)
        ok = True
    except SourceError as err:
        message = str(err)
        ok = False

    now = datetime.now(timezone.utc)
    saved = source is not None and not unsaved

    if saved:
        source.checked_at = now
        source.check_ok = ok
        source.check_message = message

        if ok:
            remember_host(source, params.get("seen"))

        session.commit()

    return CheckOut(ok=ok, message=message, checked_at=now, saved=saved)


# ---------- Ключ SSH (DHCP, этап 28) ----------


class KeyOut(BaseModel):
    line: str          # строка для ~/.ssh/authorized_keys (с ограничением «только читать файл»)
    public: str        # сам открытый ключ
    created: bool


class KeyInstallOut(BaseModel):
    ok: bool
    message: str
    source: SourceOut


def check_ssh_kind(kind):
    check_kind(kind)

    if SOURCES[kind]["form"] != "ssh":
        raise HTTPException(status_code=404, detail="У этого источника нет ключа SSH.")


def ensure_key(session, kind, me):
    """Ключ ITDB для источника: создаётся при первой надобности. (источник, создан ли)."""
    source = load_source(session, kind, lock=True)

    if source is None:
        source = ScanSource(kind=kind, enabled=False, verify_tls=True, secrets={}, options={})
        session.add(source)

    if (source.secrets or {}).get(SSH_KEY):
        return source, False

    source.secrets = dict(source.secrets or {}, **{SSH_KEY: encrypt(scan_ssh.generate_key())})
    log_change(
        session, "scan_sources", 0, me["login"], {SSH_KEY: {"old": None, "new": KEY_CREATED}},
        title=SOURCES[kind]["title"], entity_key=kind,
    )
    return source, True


@router.post("/sources/{kind}/key", response_model=KeyOut)
def source_key(kind: str, payload: Optional[SourceUpdate] = None, me=Depends(require_admin), session=Depends(get_db)):
    """Открытый ключ ITDB строкой для authorized_keys — поставить на сервер вручную."""
    check_ssh_kind(kind)
    source, created = ensure_key(session, kind, me)
    try:
        path, configs = dhcp_files(source, payload.model_dump(exclude_none=True) if payload else None)
        paths = scan_ssh.all_paths({"path": path, "configs": configs})
        private = decrypt(source.secrets[SSH_KEY], "ключ SSH")
        out = KeyOut(line=scan_ssh.authorized_line(private, paths), public=scan_ssh.public_line(private), created=created)
    except SourceError as err:
        raise HTTPException(status_code=400, detail=str(err))

    session.commit()
    return out


@router.post("/sources/{kind}/key/install", response_model=KeyInstallOut)
def install_source_key(kind: str, payload: Optional[SourceUpdate] = None, me=Depends(require_admin), session=Depends(get_db)):
    """Поставить ключ ITDB на сервер: вход по паролю (из формы или сохранённому),
    дальше — по ключу, пароль можно не хранить."""
    check_ssh_kind(kind)
    source, _ = ensure_key(session, kind, me)
    session.commit()   # ключ остаётся, даже если поставить не выйдет
    source = load_source(session, kind, lock=True)
    unsaved = payload is not None and bool(payload.model_dump(exclude_none=True))

    try:
        params = connection_params(kind, source, payload if unsaved else None, session)
        info = scan_ssh.install_key(params)
        ok, message = True, "Ключ поставлен: вход по ключу работает, пароль можно не хранить."
    except SourceError as err:
        ok, message, info = False, str(err), None

    if ok:
        # Ключ сервера запоминается, только если адрес в форме — сохранённый
        if source.url and address_of(params["url"]) == source.url:
            remember_host(source, info)

        log_change(
            session, "scan_sources", 0, me["login"], {"key_installed": {"old": None, "new": params["url"]}},
            title=SOURCES[kind]["title"], entity_key=kind,
        )
        session.commit()

    return KeyInstallOut(
        ok=ok, message=message,
        source=source_out(kind, source, last_run_of(session, kind), source_ready(session, kind, source)),
    )


# ---------- Подсети ----------


class SubnetOut(BaseModel):
    id: int
    cidr: str
    purpose: str
    location_id: Optional[int]
    scan: bool
    note: Optional[str]
    size: int
    computers: int


class UncoveredOut(BaseModel):
    cidr: str
    computers: int


class BuildingOut(BaseModel):
    id: int
    name: str


class SubnetsOut(BaseModel):
    subnets: list[SubnetOut]
    uncovered: list[UncoveredOut]
    buildings: list[BuildingOut]
    purposes: dict[str, str]


class SubnetCreate(BaseModel):
    cidr: str = ""
    purpose: str = "mixed"
    location_id: Optional[int] = None
    scan: bool = True
    note: Optional[str] = None


class SubnetUpdate(BaseModel):
    cidr: Optional[str] = None
    purpose: Optional[str] = None
    location_id: Optional[int] = None
    clear_location: bool = False
    scan: Optional[bool] = None
    note: Optional[str] = None


def parse_subnet(value):
    """«192.168.89.0/24», «192.168.89.7/24» (→ .0/24), «192.168.89.0» (→ /24)."""
    text = (value or "").strip()

    if not text:
        raise HTTPException(status_code=400, detail="Укажи подсеть, например 192.168.89.0/24.")

    if "/" not in text:
        text += "/24"

    try:
        network = ipaddress.ip_network(text, strict=False)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Не похоже на подсеть: «{value.strip()}». Нужно, например, 192.168.89.0/24.")

    if network.version != 4:
        raise HTTPException(status_code=400, detail="Нужна подсеть IPv4.")

    if network.prefixlen < SUBNET_MIN_PREFIX:
        raise HTTPException(
            status_code=400,
            detail=f"Слишком большая подсеть {network}: не больше /{SUBNET_MIN_PREFIX} (65 536 адресов).",
        )

    return network


def check_purpose(purpose):
    if purpose not in PURPOSES:
        raise HTTPException(status_code=400, detail="Неизвестное назначение подсети.")
    return purpose


def check_building(session, location_id):
    if location_id is None:
        return None

    building = session.get(Location, location_id)

    if building is None or building.kind != "building" or building.archived:
        raise HTTPException(status_code=400, detail="Адрес не найден.")

    return building


def building_name(session, location_id):
    building = session.get(Location, location_id) if location_id else None
    return building.name if building else None


def computer_ips(session):
    """IPv4 адреса рабочих ПК (каждый ПК — список адресов)."""
    result = []

    for (ip_text,) in session.query(Computer.ip).filter(Computer.archived == False, Computer.ip.isnot(None)):
        ips = []

        for line in ip_text.splitlines():
            try:
                address = ipaddress.ip_address(line.strip())
            except ValueError:
                continue

            if address.version == 4:
                ips.append(address)

        if ips:
            result.append(ips)

    return result


def most_specific(address, networks):
    """Самая узкая из подсетей, куда входит адрес (вложенные подсети разрешены)."""
    best = None

    for network in networks:
        if address in network and (best is None or network.prefixlen > best.prefixlen):
            best = network

    return best


def check_unique(session, network, skip_id=None):
    query = session.query(ScanSubnet).filter(ScanSubnet.cidr == str(network))

    if skip_id is not None:
        query = query.filter(ScanSubnet.id != skip_id)

    if query.first():
        raise HTTPException(status_code=409, detail=f"Подсеть {network} уже есть.")


@router.get("/subnets", response_model=SubnetsOut)
def list_subnets(me=Depends(require_admin), session=Depends(get_db)):
    subnets = session.query(ScanSubnet).all()
    networks = {subnet.id: ipaddress.ip_network(subnet.cidr) for subnet in subnets}
    by_network = {network: subnet_id for subnet_id, network in networks.items()}
    counts = {subnet.id: 0 for subnet in subnets}
    uncovered = {}

    # ПК считается в самой узкой подсети, куда входит любой его адрес;
    # адреса вне всех подсетей — подсказкой «добавить» по /24
    for ips in computer_ips(session):
        found = set()
        outside = set()

        for address in ips:
            network = most_specific(address, networks.values())

            if network is not None:
                found.add(by_network[network])
            elif not (address.is_link_local or address.is_loopback):
                outside.add(ipaddress.ip_network(f"{address}/24", strict=False))

        for subnet_id in found:
            counts[subnet_id] += 1

        for network in outside:
            uncovered[network] = uncovered.get(network, 0) + 1

    subnets.sort(key=lambda s: (networks[s.id].network_address, networks[s.id].prefixlen))
    buildings = (
        session.query(Location)
        .filter(Location.kind == "building", Location.archived == False)
        .order_by(Location.sort, Location.name)
        .all()
    )

    return SubnetsOut(
        subnets=[
            SubnetOut(
                id=s.id, cidr=s.cidr, purpose=s.purpose, location_id=s.location_id,
                scan=s.scan, note=s.note, size=networks[s.id].num_addresses, computers=counts[s.id],
            )
            for s in subnets
        ],
        uncovered=[
            UncoveredOut(cidr=str(network), computers=count)
            for network, count in sorted(uncovered.items(), key=lambda item: item[0].network_address)
        ],
        buildings=[BuildingOut(id=b.id, name=b.name) for b in buildings],
        purposes=PURPOSES,
    )


@router.post("/subnets")
def create_subnet(payload: SubnetCreate, me=Depends(require_admin), session=Depends(get_db)):
    network = parse_subnet(payload.cidr)
    check_unique(session, network)
    check_purpose(payload.purpose)
    check_building(session, payload.location_id)
    note = clean(payload.note, NOTE_MAX)

    subnet = ScanSubnet(
        cidr=str(network), purpose=payload.purpose, location_id=payload.location_id,
        scan=payload.scan, note=note,
    )
    session.add(subnet)
    session.flush()

    changes = {"created": {"old": None, "new": str(network)}, "purpose": {"old": None, "new": PURPOSES[subnet.purpose]}}

    if subnet.location_id:
        changes["building"] = {"old": None, "new": building_name(session, subnet.location_id)}

    if not subnet.scan:
        changes["scan"] = {"old": None, "new": False}

    if note:
        changes["note"] = {"old": None, "new": note}

    log_change(session, "scan_subnets", subnet.id, me["login"], changes, title=subnet.cidr)
    session.commit()
    return {"id": subnet.id, "cidr": subnet.cidr}


@router.patch("/subnets/{subnet_id}")
def update_subnet(subnet_id: int, payload: SubnetUpdate, me=Depends(require_admin), session=Depends(get_db)):
    subnet = session.query(ScanSubnet).filter(ScanSubnet.id == subnet_id).with_for_update().first()

    if subnet is None:
        raise HTTPException(status_code=404, detail="Подсеть не найдена.")

    changes = {}

    if payload.cidr is not None:
        network = parse_subnet(payload.cidr)
        check_unique(session, network, skip_id=subnet.id)
        changes["cidr"] = {"old": subnet.cidr, "new": str(network)}
        subnet.cidr = str(network)

    if payload.purpose is not None:
        check_purpose(payload.purpose)
        changes["purpose"] = {"old": PURPOSES.get(subnet.purpose, subnet.purpose), "new": PURPOSES[payload.purpose]}
        subnet.purpose = payload.purpose

    if payload.clear_location or payload.location_id is not None:
        new_id = None if payload.clear_location else payload.location_id
        check_building(session, new_id)
        changes["building"] = {"old": building_name(session, subnet.location_id), "new": building_name(session, new_id)}
        subnet.location_id = new_id

    if payload.scan is not None:
        changes["scan"] = {"old": subnet.scan, "new": payload.scan}
        subnet.scan = payload.scan

    if payload.note is not None:
        note = clean(payload.note, NOTE_MAX)
        changes["note"] = {"old": subnet.note, "new": note}
        subnet.note = note

    log_change(session, "scan_subnets", subnet.id, me["login"], changes, title=subnet.cidr)
    session.commit()
    return {"id": subnet.id, "cidr": subnet.cidr}


@router.delete("/subnets/{subnet_id}")
def delete_subnet(subnet_id: int, me=Depends(require_admin), session=Depends(get_db)):
    subnet = session.query(ScanSubnet).filter(ScanSubnet.id == subnet_id).with_for_update().first()

    if subnet is None:
        raise HTTPException(status_code=404, detail="Подсеть не найдена.")

    log_change(
        session, "scan_subnets", subnet.id, me["login"],
        {"deleted": {"old": subnet.cidr, "new": None}}, title=subnet.cidr,
    )
    session.delete(subnet)
    session.commit()
    return {"ok": True}
