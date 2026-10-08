"""Данные из GLPI / GSIT → значения в формате ITDB и признаки для сопоставления
(этап 25). Здесь только разбор: без базы и без сети.

Признаки (keys) – то, по чему запись источника можно надёжно связать с ПК:
физические MAC (без виртуальных адаптеров и случайных MAC), настоящий серийный
(без «Default string», «To be filled by O.E.M.», испорченных Excel-ом и т. п.),
UUID (без заводских заглушек). Значения (values) – как их пишут в таблице ITDB:
«Win 10», «i5-10400», «8», «SSD 250», MAC прописными через «:».
"""
import ipaddress
import re

# ---------- Серийные номера и UUID ----------

JUNK_SERIALS = {
    "DEFAULT STRING", "TO BE FILLED BY O.E.M.", "TOBEFILLEDBYO.E.M.", "TO BE FILLED BY OEM",
    "SYSTEM SERIAL NUMBER", "CHASSIS SERIAL NUMBER", "BASE BOARD SERIAL NUMBER",
    "SERIAL NUMBER", "SERIALNUMBER", "SERIAL", "NONE", "N/A", "NA", "NULL", "UNKNOWN",
    "NOT APPLICABLE", "NOT SPECIFIED", "NOT AVAILABLE", "INVALID", "OEM", "O.E.M.",
    "DEFAULT", "EMPTY", "NO SERIAL", "SYSTEM SERIAL", "0123456789", "123456789",
    "1234567890", "12345678", "ABCDEFGHIJ", "XXXXXXXXXX", "PBSN", "MB-1234567890",
}
JUNK_SERIAL_PARTS = ("O.E.M", "FILLED BY", "DEFAULT STRING", "SERIAL NUMBER", "TO BE FILLED")
# Число, испорченное Excel-ом: «1,90E+14», «1.9E+14»
EXCEL_NUMBER = re.compile(r"^\d+[.,]?\d*E\+?\d+$", re.I)

JUNK_UUIDS = {
    "03000200-0400-0500-0006-000700080009",
    "00020003-0004-0005-0006-000700080009",
    "12345678-1234-5678-90AB-CDDEEFAABBCC",
}


def clean_serial(value):
    """Настоящий серийный номер или None."""
    text = " ".join(str(value or "").split())
    upper = text.upper()

    if len(text) < 4 or upper in JUNK_SERIALS:
        return None

    if any(part in upper for part in JUNK_SERIAL_PARTS) or EXCEL_NUMBER.match(text):
        return None

    # Одинаковые символы: «0000000», «XXXXXX», «......»
    if len(set(upper.replace("-", "").replace(" ", ""))) <= 1:
        return None

    return text


def clean_uuid(value):
    text = str(value or "").strip().upper()
    hexes = re.sub(r"[^0-9A-F]", "", text)

    if len(hexes) < 16 or text in JUNK_UUIDS or len(set(hexes)) <= 1:
        return None

    return text


# ---------- MAC и сеть ----------

# Виртуальные адаптеры, одинаковые на многих ПК или не отражающие железо
VIRTUAL_MAC_PREFIXES = (
    "00:15:5D",        # Hyper-V (адаптеры хоста)
    "00:50:56:C0",     # VMware Workstation – VMnet на хосте (у всех одинаковые)
    "00:FF:",          # TAP-Windows (OpenVPN и др.)
    "00:05:9A",        # Cisco AnyConnect
    "00:09:0F:FE",     # FortiClient
    "7A:79:",          # Hamachi
    "02:00:4C:4F:4F:50",  # Microsoft Loopback
    "00:00:00:00:00:00",
)
VIRTUAL_PORT_WORDS = (
    "virtual", "vpn", "tap-", "tap ", "tap_", "tunnel", "loopback", "miniport", "hyper-v",
    "vmware", "virtualbox", "vethernet", "wsl", "docker", "bluetooth", "teredo", "isatap",
    "6to4", "pseudo", "npcap", "wireguard", "openvpn", "fortinet", "forticlient", "anyconnect",
    "zerotier", "radmin", "hamachi", "kaspersky", "wan miniport", "ras async", "ppp",
    "виртуальн", "замыкани",
)
MAC_RE = re.compile(r"^[0-9A-F]{2}([:-]?[0-9A-F]{2}){5}$")


def norm_mac(value):
    """«aa-bb-cc-dd-ee-ff» → «AA:BB:CC:DD:EE:FF»; не MAC – None."""
    text = str(value or "").strip().upper()

    if not MAC_RE.match(text):
        return None

    hexes = re.sub(r"[^0-9A-F]", "", text)
    return ":".join(hexes[i:i + 2] for i in range(0, 12, 2))


def is_virtual_mac(mac):
    if mac.startswith(VIRTUAL_MAC_PREFIXES) or mac == "FF:FF:FF:FF:FF:FF":
        return True

    # Второй бит первого байта – «локально назначенный» MAC: виртуальные
    # адаптеры и случайные MAC Wi-Fi. Для опознания ПК не годится
    return bool(int(mac[:2], 16) & 0x02)


def is_virtual_port(name, mac):
    lower = (name or "").lower()

    if any(word in lower for word in VIRTUAL_PORT_WORDS):
        return True

    return bool(mac) and is_virtual_mac(mac)


# Для столбца MAC (не для опознания ПК) годятся все адаптеры, которые видны в
# GLPI / GSIT у железа: Ethernet, Wi-Fi (и со случайным MAC), Bluetooth.
# Не годятся только программные: VPN, виртуальные машины, Wi-Fi Direct и т. п.
SOFT_PORT_WORDS = tuple(word for word in VIRTUAL_PORT_WORDS if word != "bluetooth") + (
    "kernel debug", "wi-fi direct", "wifi direct",
)


def is_soft_port(name, mac):
    """Программный адаптер: его MAC в столбец MAC не предлагается."""
    lower = (name or "").lower()

    if any(word in lower for word in SOFT_PORT_WORDS):
        return True

    return bool(mac) and (mac.startswith(VIRTUAL_MAC_PREFIXES + ("0A:00:27",)) or mac == "FF:FF:FF:FF:FF:FF")


def usable_ipv4(value):
    """IPv4 адрес ПК: без IPv6, 127.x, 169.254.x, 0.0.0.0."""
    try:
        address = ipaddress.ip_address(str(value or "").strip())
    except ValueError:
        return None

    if address.version != 4 or address.is_loopback or address.is_link_local or address.is_unspecified:
        return None

    return str(address)


# ---------- Значения в формате ITDB ----------

def tidy(text):
    """Без (R), (TM), лишних пробелов."""
    text = re.sub(r"\((R|TM|C)\)|®|™", "", str(text or ""), flags=re.I)
    return " ".join(text.split())


WINDOWS_KERNELS = {"5.1": "XP", "5.2": "XP", "6.0": "Vista", "6.1": "7", "6.2": "8", "6.3": "8.1"}


def windows_by_kernel(text):
    """Номер Windows по версии ядра: «10.0.19045» → «10», «10.0.22631» → «11»."""
    found = re.search(r"\b(\d+\.\d+)(?:\.(\d+))?", text or "")

    if not found:
        return None

    if found.group(1) == "10.0":
        return "11" if found.group(2) and int(found.group(2)) >= 22000 else "10"

    return WINDOWS_KERNELS.get(found.group(1))


def os_short(name, version=None, kernel=None):
    """«Microsoft Windows 10 Pro» → «Win 10», «Astra Linux…» → «Astra».
    GSIT (FusionInventory) пишет просто «Windows» + «22H2» – тогда номер
    берётся из версии ядра (10.0.19045 → 10, 10.0.22631 → 11)."""
    full = tidy(name)

    if not full:
        return None

    windows = re.search(r"Windows\s+(Server\s+\d{4}(?:\s*R2)?|XP|Vista|\d+(?:\.\d)?)\b", full, re.I)

    if windows:
        return "Win " + re.sub(r"\s+", " ", windows.group(1)).replace("server", "Server")

    if re.search(r"windows", full, re.I):
        number = None

        if re.fullmatch(r"\s*(XP|Vista|7|8|8\.1|10|11)\s*", version or "", re.I):
            number = version.strip()

        number = number or windows_by_kernel(kernel) or windows_by_kernel(version)
        return f"Win {number}" if number else "Windows"

    if re.search(r"astra", full, re.I):
        return "Astra"

    return re.sub(r"^Microsoft\s+", "", full)


CPU_PATTERNS = [
    r"Core\s+Ultra\s+\d\s+\d{3}[A-Z]{0,2}",
    r"\bi[3579]-\s?\d{3,5}[A-Z]{0,3}\d?",
    r"Core\s*2\s+(?:Duo|Quad)\s+[A-Z]?\d{4}",
    r"Pentium\s+(?:Gold\s+|Silver\s+|Dual-Core\s+|Dual\s+)?(?:CPU\s+)?[A-Z]{0,2}\d{3,5}[A-Z]?",
    r"Celeron\s+(?:CPU\s+)?[A-Z]{0,2}\d{3,5}[A-Z]?",
    r"Xeon\s+(?:CPU\s+)?[A-Z]{1,2}\d?-?\s?\d{4}[A-Z]?(?:\s+v\d)?",
    r"Ryzen\s+\d\s+(?:PRO\s+)?\d{4}[A-Z]{0,2}\d?",
    r"Athlon\s+(?:II\s+X\d\s+|Gold\s+|Silver\s+)?\d{3,4}[A-Z]{0,2}",
    r"\bA\d{1,2}-\d{4}[A-Z]?",
    r"\bFX-\d{4}",
    r"\bE\d-\d{4}",
]


def cpu_short(name):
    """«Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz» → «i5-10400»."""
    full = tidy(name)

    if not full:
        return None

    for pattern in CPU_PATTERNS:
        found = re.search(pattern, full, re.I)

        if found:
            text = re.sub(r"\s*CPU\s*", " ", found.group(0))
            # В таблице пишут «Pentium G5400», без Gold / Silver
            text = re.sub(r"^(Pentium)\s+(Gold|Silver|Dual-Core|Dual)\s+", r"\1 ", text, flags=re.I)
            text = re.sub(r"-\s+", "-", text)
            return " ".join(text.split())

    text = re.sub(r"\s*@.*$|\bCPU\b|\bProcessor\b|\d+-Core|with Radeon.*$", "", full, flags=re.I)
    text = re.sub(r"^(Intel|AMD)\s+", "", text.strip(), flags=re.I)
    return " ".join(text.split()) or None


def ram_short(total_mb):
    """8192 МБ → «8»; 12288 → «12»; 1536 → «1.5»."""
    if not total_mb or total_mb <= 0:
        return None

    gb = total_mb / 1024

    if gb >= 2:
        return str(round(gb))

    return f"{gb:.1f}".rstrip("0").rstrip(".")


DISK_SIZES = [16, 32, 60, 64, 80, 120, 128, 160, 180, 240, 250, 256, 320, 480, 500, 512, 640, 750, 960]
DISK_SKIP = re.compile(
    r"usb|flash|card\s*reader|multi-?card|sd\s*card|mass storage|virtual|msft|iscsi|dvd|cd-?rom"
    # флешки и внешние диски, в названии которых нет «USB» (этап 26к)
    r"|data\s*traveler|jet\s*flash|store\s*jet|cruzer|u\s?disk|pen\s*drive|removable|external|portable"
    r"|my\s*passport|my\s*book|\belements\b|\bexpansion\b|backup\+?\s*plus|canvio|uas\b|uasp",
    re.I,
)
# Как подключён диск (GLPI: «Интерфейс» у модели диска): внешние – не DRIVE
DISK_SKIP_INTERFACE = re.compile(r"usb|1394|firewire|thunderbolt", re.I)
SSD_WORDS = re.compile(
    r"ssd|nvme|solid\s*state|\bm\.2\b|kingston\s+s[auvnkq]|\bsa400|\bsuv|\bskc|\bsnv|\bct\d+(bx|mx|p\d)"
    r"|\bwds\d|\bsu\d{3}|adata\s+s|apacer\s+as|\br5sl|ssdpr|patriot|spcc|netac|\bmz-|samsung\s+(pm|mz)"
    r"|\bthnsn|\bsdssd|\bhfs\d|intenso|smartbuy|\bkbg|\bpc\d{3}\s+nvme",
    re.I,
)
HDD_WORDS = re.compile(
    r"^st\d|seagate|^wdc\s+wd\d|^wd\d{3,}[a-z]{2}|hgst|hitachi|toshiba\s+(dt|mq|hd|md|mg|p300)|maxtor"
    r"|samsung\s+hd\d|\bhdd\b",
    re.I,
)


MIB_TO_GB = 1024 * 1024 / 1e9


def size_text(gb):
    """«256», «1TB», «1.5TB»."""
    if gb >= 900:
        tb = round(gb / 1000 * 2) / 2
        return (f"{tb:.1f}".rstrip("0").rstrip(".")) + "TB"

    return str(round(gb))


def nearest_size(gb):
    """Ближайший объём с наклейки и насколько он далёк (доля)."""
    if gb >= 900:
        tb = round(gb / 1000 * 2) / 2 or 1
        return tb * 1000, abs(tb * 1000 - gb) / (tb * 1000)

    nearest = min(DISK_SIZES, key=lambda size: abs(size - gb))
    return nearest, abs(nearest - gb) / nearest


def size_in_name(name, gb):
    """Объём из названия модели, если он сходится с объёмом диска (±12%):
    «KINGSTON SA400S37240G» → 240, «Samsung SSD 860 EVO 250GB» → 250,
    «CT480BX500SSD1» → 480, «… 1TB» → 1000. Нет – None."""
    text = (name or "").upper()
    found = []

    for size in DISK_SIZES + [1000, 2000, 4000]:
        tb = size // 1000 if size >= 1000 else None
        patterns = [rf"(?<!\d){size}(?!\d)", rf"{size}\s?GB?(?![A-Z])"]

        if tb:
            patterns.append(rf"(?<![\d.]){tb}\s?TB?(?![A-Z\d])")

        if any(re.search(p, text) for p in patterns) and abs(size - gb) <= size * 0.12:
            found.append(size)

    return min(found, key=lambda size: abs(size - gb)) if found else None


def disk_size_text(mb, name=None):
    """Объём, как пишут на наклейке и в названии диска.

    Агенты GLPI и FusionInventory пишут объём в «двоичных» МБ (1024×1024 байт):
    128 ГБ = 122 104 МБ, 256 ГБ = 244 198 МБ. Поэтому: сначала – объём из
    названия модели («SA400S37240G» → 240), если он сходится с объёмом диска;
    иначе – ближайший объём с наклейки (128, 240, 256, 500…) по объёму в
    двоичных МБ. Если источник записал обычные МБ (250 059 у диска 250 ГБ) –
    берётся то прочтение, которое ближе к объёму с наклейки."""
    binary = mb * MIB_TO_GB
    decimal = mb / 1000
    named = [(abs(size - gb) / size, size) for gb in (binary, decimal) for size in [size_in_name(name, gb)] if size]

    if named:
        return size_text(min(named)[1])

    size_b, off_b = nearest_size(binary)
    size_d, off_d = nearest_size(decimal)
    size, off, gb = (size_b, off_b, binary) if off_b <= off_d else (size_d, off_d, decimal)

    if off <= 0.1:
        return size_text(size)

    return size_text(gb)


def disk_kind(name, kind=None):
    text = f"{name or ''} {kind or ''}"

    if SSD_WORDS.search(text):
        return "SSD"

    if HDD_WORDS.search((name or "").strip()) or re.search(r"\bhdd\b", kind or "", re.I):
        return "HDD"

    return None


def drives_short(disks):
    """[{"name", "mb", "kind", "interface"}] → «SSD 250\\nHDD 1TB» (SSD первыми).
    Флешки и внешние диски (USB – по названию или интерфейсу) не считаются."""
    items = []

    for disk in disks:
        mb = disk.get("mb") or 0

        if mb <= 0 or DISK_SKIP.search(disk.get("name") or "") or DISK_SKIP_INTERFACE.search(disk.get("interface") or ""):
            continue

        kind = disk_kind(disk.get("name"), disk.get("kind"))
        size = disk_size_text(mb, disk.get("name"))
        items.append((0 if kind == "SSD" else 1 if kind == "HDD" else 2, f"{kind} {size}" if kind else size))

    items.sort(key=lambda item: item[0])
    return "\n".join(text for _, text in items) or None


GPU_SKIP = re.compile(
    r"basic\s+(display|render)|remote|radmin|dameware|mirage|vnc|citrix|parsec|meta\s+virtual|virtual"
    r"|hyper-v|virtualbox|vmware|standard\s+vga|стандартный|idd|spacedesk|duet|splashtop|anydesk|teamviewer"
    # драйверы-перехватчики экрана программ удалённого доступа («mv video hook driver2»)
    r"|\bhook\b|mirror|\bdriver\d*\b|драйвер|\brdp|displaylink|usb\s+display|ammyy|litemanager|\brms\b|rustdesk"
    r"|logmein|screenconnect|nomachine|sunlogin|aeroadmin|supremo|zoom|webex",
    re.I,
)
GPU_INTEGRATED = re.compile(
    r"intel|radeon\s*(\(tm\))?\s*(r\d\s+)?graphics|vega\s+\d+\s+graphics|radeon\s+vega\s+\d+\s+graphics"
    r"|radeon\s+\d{3}m|amd\s+radeon\(tm\)\s+graphics",
    re.I,
)


def gpu_list(names):
    """Видеокарты без виртуальных «адаптеров» удалённого доступа."""
    result = []

    for name in names:
        text = tidy(name)

        if text and not GPU_SKIP.search(text) and text not in result:
            result.append(text)

    return result


def gpu_short(names):
    """Дискретные видеокарты: «NVIDIA GeForce GT 1030» → «GT 1030». Встроенные
    (Intel, Radeon Graphics в Ryzen) в столбце GPU не пишут – None."""
    result = []

    for text in gpu_list(names):
        if GPU_INTEGRATED.search(text):
            continue

        short = re.sub(r"\b(NVIDIA|GeForce|AMD|ATI|Series|Graphics)\b", "", text, flags=re.I)
        short = re.sub(r"\bRadeon\s+(?=(RX|HD|R\d|Pro)\b)", "", short, flags=re.I)
        short = " ".join(short.split())

        if short and short not in result:
            result.append(short)

    return "\n".join(result) or None


MANUFACTURERS = [
    (r"hewlett|^hp\b|^hpe\b", "HP"),
    (r"lenovo", "Lenovo"),
    (r"^dell", "Dell"),
    (r"asus", "ASUS"),
    (r"gigabyte", "Gigabyte"),
    (r"micro-?star|^msi\b", "MSI"),
    (r"^acer", "Acer"),
    (r"aquarius", "Aquarius"),
    (r"^intel", "Intel"),
    (r"asrock", "ASRock"),
    (r"^apple", "Apple"),
    (r"samsung", "Samsung"),
    (r"fujitsu", "Fujitsu"),
    (r"depo", "DEPO"),
    (r"iru\b", "iRU"),
]
JUNK_MODELS = re.compile(
    r"^(system (product name|version|manufacturer)|to be filled|default string|all series|not applicable"
    r"|oem|o\.e\.m\.|none|unknown|type1productconfigid|base board product name|\s*)$",
    re.I,
)


def manufacturer_short(name):
    text = tidy(name)

    if not text or JUNK_MODELS.match(text) or "O.E.M" in text.upper():
        return None

    for pattern, short in MANUFACTURERS:
        if re.search(pattern, text, re.I):
            return short

    return re.sub(r",?\s*(Inc\.?|Co\.,? ?Ltd\.?|Ltd\.?|Corporation|Corp\.?|GmbH|Technology|Computer)\b\.?", "", text).strip() or None


def model_short(manufacturer, model):
    """«HP» + «ProDesk 400 G7» → «HP ProDesk 400 G7»; заглушки – None."""
    brand = manufacturer_short(manufacturer)
    text = tidy(model)

    if not text or JUNK_MODELS.match(text) or "O.E.M" in text.upper():
        return None

    if brand and not text.lower().startswith(brand.lower()):
        return f"{brand} {text}"

    return text


VNC_KINDS = [
    (r"tightvnc|tight\s*vnc", "TightVNC"),
    (r"ultra\s*vnc|ultr@vnc", "UltraVNC"),
    (r"tigervnc", "TigerVNC"),
    (r"realvnc|vnc\s+(server|connect)", "RealVNC"),
]
# Только просмотрщик – не сервер: «UltraVNC Viewer», «VNC Viewer», «TightVNC Viewer»
VNC_VIEWER = re.compile(r"viewer|просмотр", re.I)


# Если найдено несколько, сервер – TightVNC: UltraVNC рядом с ним ставят ради
# просмотрщика (решение пользователя 01.10: «99,9% сервер – TightVNC»)
VNC_MAIN = "TightVNC"


def vnc_short(software_names):
    """VNC-сервер из установленных программ. Просмотрщики не в счёт. Найдено
    несколько и среди них TightVNC – это TightVNC. Несколько других – все
    строками (в расхождениях – «неточно»); точно покажет этап 28 – какой
    сервер отвечает на порту 5900."""
    found = []

    for name in software_names:
        if VNC_VIEWER.search(name or ""):
            continue

        for pattern, kind in VNC_KINDS:
            if re.search(pattern, name or "", re.I) and kind not in found:
                found.append(kind)

    if len(found) > 1 and VNC_MAIN in found:
        return VNC_MAIN

    return "\n".join(found) or None


# ---------- Запись целиком ----------

def build(raw):
    """raw – то, что собрал клиент источника (scan_glpi.collect):
    name, serial, uuid, manufacturer, model, os_name, os_version, cpus[],
    memory_mb, disks[{name, mb, kind}], gpus[], ports[{name, mac, ips}],
    softwares[], antivirus[{name, active, uptodate, version}], tag.
    Ответ: (values, keys, data) – values в формате ITDB, keys для сопоставления."""
    macs = []        # признаки: только физические адаптеры с заводским MAC
    value_macs = []  # столбец MAC: все адаптеры железа (и Wi-Fi, Bluetooth)
    ips = []
    ports = []

    for port in raw.get("ports") or []:
        mac = norm_mac(port.get("mac"))
        virtual = is_virtual_port(port.get("name"), mac)
        soft = is_soft_port(port.get("name"), mac)
        port_ips = [ip for ip in (usable_ipv4(v) for v in port.get("ips") or []) if ip]
        ports.append({"name": port.get("name"), "mac": mac, "ips": port_ips, "virtual": virtual})

        if soft:
            continue

        if mac and mac not in value_macs:
            value_macs.append(mac)

        # IP Wi-Fi со случайным MAC – тоже адрес этого ПК
        for ip in port_ips:
            if ip not in ips:
                ips.append(ip)

        if mac and not virtual and mac not in macs:
            macs.append(mac)

    serial = clean_serial(raw.get("serial"))
    uuid = clean_uuid(raw.get("uuid"))
    cpus = [tidy(name) for name in raw.get("cpus") or [] if tidy(name)]
    softwares = raw.get("softwares") or []

    values = {
        "hostname": (raw.get("name") or "").strip() or None,
        "ip": "\n".join(ips) or None,
        "mac": "\n".join(value_macs) or None,
        "serial": serial,
        "model": model_short(raw.get("manufacturer"), raw.get("model")),
        "os": os_short(raw.get("os_name"), raw.get("os_version"), raw.get("os_kernel")),
        "cpu": cpu_short(cpus[0]) if cpus else None,
        "ram": ram_short(raw.get("memory_mb")),
        "drive": drives_short(raw.get("disks") or []),
        "gpu": gpu_short(raw.get("gpus") or []),
        "vnc": vnc_short(softwares),
    }

    keys = {"macs": macs, "serial": serial, "uuid": uuid}

    data = {
        "values": values,
        "antivirus": raw.get("antivirus") or [],
        "full": {
            "serial": raw.get("serial"),
            "uuid": raw.get("uuid"),
            "manufacturer": raw.get("manufacturer"),
            "model": raw.get("model"),
            "os": " ".join(
                x for x in (tidy(raw.get("os_name")), raw.get("os_edition"), raw.get("os_version"),
                            f"({raw['os_kernel']})" if raw.get("os_kernel") else None) if x
            ) or None,
            "cpu": cpus,
            "memory_mb": raw.get("memory_mb"),
            "disks": raw.get("disks") or [],
            "gpus": gpu_list(raw.get("gpus") or []),
            "tag": raw.get("tag"),
        },
        "ports": ports,
    }
    return values, keys, data
