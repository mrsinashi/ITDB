"""Сканирование, этап 24: подключения к источникам (GLPI, GSIT, Jabber) и
подсети для сетевого сканирования. Только администратор.

Источников три, у каждого одна строка настроек; строки в базе появляются при
первом сохранении, до этого отдаются значения по умолчанию. Пароли и токены
хранятся зашифрованными (secret_box.py) и наружу не отдаются — только «задан».
Изменения пишутся в Историю (видит администратор); пароли — «задан новый».
"""
import ipaddress
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import scan_glpi
import scan_jabber
from auth import require_admin
from db import get_db
from history_log import PASSWORD_SET, log_change
from models import Computer, Location, ScanSource, ScanSubnet
from scan_http import SourceError, check_url
from secret_box import decrypt, encrypt, key_ready

router = APIRouter(prefix="/api/scan", tags=["scan"])

# Источники: название, какие поля есть в форме, чем проверять подключение
SOURCES = {
    "glpi": {"title": "GLPI", "check": scan_glpi.check, "glpi": True},
    "gsit": {"title": "GSIT", "check": scan_glpi.check, "glpi": True},
    "jabber": {"title": "Jabber", "check": scan_jabber.check, "glpi": False},
}
SECRET_FIELDS = ("password", "user_token", "app_token")
SECRET_LABELS = {"password": "пароль", "user_token": "токен пользователя", "app_token": "токен приложения"}
SECRET_REMOVED = "удалён"

# Записи GLPI/GSIT считаются актуальными, если ПК проверялся не раньше, чем N дней назад
FRESH_DAYS_DEFAULT = 3
FRESH_DAYS_MAX = 60

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
    if not SOURCES[kind]["glpi"]:
        return None

    value = (source.options or {}).get("fresh_days") if source else None
    return value if isinstance(value, int) else FRESH_DAYS_DEFAULT


def source_out(kind, source):
    secrets = (source.secrets or {}) if source else {}
    glpi = SOURCES[kind]["glpi"]
    fields = SECRET_FIELDS if glpi else ("password",)

    return SourceOut(
        kind=kind,
        title=SOURCES[kind]["title"],
        enabled=bool(source and source.enabled),
        url=source.url if source else None,
        domain=source.domain if source and not glpi else None,
        login=source.login if source else None,
        secrets={field: bool(secrets.get(field)) for field in fields},
        verify_tls=source.verify_tls if source else True,
        fresh_days=fresh_days_of(source, kind),
        checked_at=source.checked_at if source else None,
        check_ok=source.check_ok if source else None,
        check_message=source.check_message if source else None,
    )


def clean(value, limit=500):
    value = (value or "").strip()

    if len(value) > limit:
        raise HTTPException(status_code=400, detail="Слишком длинное значение.")

    return value or None


def clean_fresh_days(value):
    if value is None or not (1 <= value <= FRESH_DAYS_MAX):
        raise HTTPException(
            status_code=400,
            detail=f"Срок актуальности — от 1 до {FRESH_DAYS_MAX} дней.",
        )
    return value


def connection_params(kind, source, overlay=None):
    """Параметры подключения: сохранённые (пароли расшифрованы) + несохранённые
    значения из формы (overlay) — чтобы проверить до сохранения."""
    secrets = (source.secrets or {}) if source else {}
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

    if not params["url"]:
        raise SourceError("Укажи адрес.")

    return params


@router.get("/sources", response_model=SourcesOut)
def list_sources(me=Depends(require_admin), session=Depends(get_db)):
    rows = {source.kind: source for source in session.query(ScanSource).all()}
    return SourcesOut(
        key_ready=key_ready(),
        sources=[source_out(kind, rows.get(kind)) for kind in SOURCES],
    )


@router.patch("/sources/{kind}", response_model=SourceOut)
def update_source(kind: str, payload: SourceUpdate, me=Depends(require_admin), session=Depends(get_db)):
    check_kind(kind)
    glpi = SOURCES[kind]["glpi"]
    data = payload.model_dump(exclude_none=True)

    if not glpi:
        for field in ("user_token", "app_token", "fresh_days"):
            data.pop(field, None)
    else:
        data.pop("domain", None)

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
    if not glpi and data.get("url"):
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
                    value = check_url(value, "Адрес")
                except SourceError as err:
                    raise HTTPException(status_code=400, detail=str(err))

            setattr(source, field, value)
            changes[field] = {"old": before[field], "new": value}

    if "verify_tls" in data:
        source.verify_tls = data["verify_tls"]
        changes["verify_tls"] = {"old": before["verify_tls"], "new": data["verify_tls"]}

    if "fresh_days" in data:
        days = clean_fresh_days(data["fresh_days"])
        source.options = dict(source.options or {}, fresh_days=days)
        changes["fresh_days"] = {"old": before["fresh_days"], "new": days}

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
        if data["enabled"] and not source.url:
            raise HTTPException(status_code=400, detail="Сначала укажи адрес.")
        source.enabled = data["enabled"]
        changes["enabled"] = {"old": before["enabled"], "new": data["enabled"]}

    # Параметры подключения изменились — прошлая проверка больше ничего не говорит
    connection = {"url", "domain", "login", "verify_tls"} | set(SECRET_FIELDS)

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
    return source_out(kind, source)


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

    try:
        params = connection_params(kind, source, payload if unsaved else None)
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
        session.commit()

    return CheckOut(ok=ok, message=message, checked_at=now, saved=saved)


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
