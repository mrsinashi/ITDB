from collections import defaultdict
from datetime import date, datetime
from io import BytesIO
import ipaddress
import re

from fastapi import APIRouter, File, HTTPException, UploadFile
from openpyxl import load_workbook

router = APIRouter(prefix="/api/import", tags=["import"])

HEADER_MAPPING = {
    "#": "row_num",
    "фио": "person",
    "адрес": "address",
    "отделение": "department",
    "эт.": "floor",
    "каб": "room_code",
    "кабинет": "room_name",
    "№": "seat_no",
    "ip": "ip",
    "hostname": "hostname",
    "vacuum": "vacuum",
    "os": "os",
    "тип": "type",
    "модель": "model",
    "cpu": "cpu",
    "ram": "ram",
    "drive": "drive",
    "gpu": "gpu",
    "mac": "mac",
    "инв": "inv_no",
    "gsit": "gsit",
    "сост.": "state",
    "метка": "label",
    "принтер": "printer_skip",
    "пр": "pr_skip",
    "#примечание": "note",
}

IMPORTANT_FIELDS = (
    "person",
    "address",
    "department",
    "room_code",
    "room_name",
    "hostname",
    "ip",
    "mac",
    "inv_no",
)

MAC_RE = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")

HOSTNAME_RE = re.compile(r"^[0-9A-ZА-ЯЁ][0-9A-ZА-ЯЁ._-]*$", re.I)

DRIVE_TYPED_RE = re.compile(
    r"(?P<type>SSD|HDD|NVME)\s*[-_]?\s*(?P<size>\d+)\s*(?P<unit>TB|GB|ТБ|ГБ|Т|Г)?",
    re.I,
)

DRIVE_REVERSE_RE = re.compile(
    r"(?P<size>\d+)\s*(?P<unit>TB|GB|ТБ|ГБ|Т|Г)?\s*(?P<type>SSD|HDD|NVME)",
    re.I,
)

BARE_DRIVE_RE = re.compile(
    r"\b(?P<size>\d+)\s*(?P<unit>TB|GB|ТБ|ГБ|Т|Г)?\b",
    re.I,
)


def cell_to_text(value):
    if value is None:
        return None

    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"

    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return str(value)

    if isinstance(value, int):
        return str(value)

    if isinstance(value, (datetime, date)):
        return value.isoformat()

    text = str(value).strip()
    return text if text else None


def normalize_header(value):
    text = cell_to_text(value)
    if text is None:
        return None
    return text.lower()


def detect_header(rows):
    best_index = 0
    best_score = -1

    for index, row in enumerate(rows[:10]):
        headers = []

        for value in row:
            header = normalize_header(value)
            if header:
                headers.append(header)

        score = len(headers)

        if any(h in headers for h in ("ip", "hostname", "адрес", "фио")):
            score += 20

        if score > best_score:
            best_score = score
            best_index = index

    return best_index


def parse_int(value):
    text = cell_to_text(value)

    if text is None:
        return None, True

    try:
        number = float(text.replace(",", "."))
    except ValueError:
        return None, False

    if number.is_integer():
        return int(number), True

    return None, False


def clean_text(value):
    text = cell_to_text(value)

    if text is None:
        return None

    return " ".join(text.split())


def looks_like_hostname(value):
    if not value:
        return False

    if value.isdigit():
        return False

    return bool(HOSTNAME_RE.match(value))


def parse_ips(value):
    text = clean_text(value)

    if not text:
        return [], []

    ips = []
    issues = []

    for part in re.split(r"[\n\r,;\s]+", text):
        part = part.strip()

        if not part:
            continue

        try:
            ipaddress.ip_address(part)
            ips.append(part)
        except ValueError:
            issues.append((part, "IP не распознаётся"))

    return ips, issues


def parse_macs(value):
    text = cell_to_text(value)

    if not text:
        return [], []

    macs = []
    issues = []

    for part in re.split(r"[\n\r,;\s]+", text):
        part = part.strip().upper()

        if not part:
            continue

        if MAC_RE.match(part):
            macs.append(part)
        else:
            issues.append((part, "Неправильное значение MAC"))

    return macs, issues


def normalize_drive_size(size, unit):
    if unit:
        unit_upper = unit.upper()

        if unit_upper in ("TB", "ТБ", "Т"):
            return f"{size}TB"

    return str(size)


def parse_drive_text(value):
    text = clean_text(value)

    if text is None:
        return [], []

    upper = " ".join(text.upper().split())

    if not upper:
        return [], []

    values = []
    issues = []

    def remove_matches(source, regex, typed):
        parts = []
        last_end = 0

        for match in regex.finditer(source):
            size = match.group("size")
            unit = match.group("unit")

            if typed:
                drive_type = match.group("type").upper()
                values.append(f"{drive_type} {normalize_drive_size(size, unit)}")
            else:
                normalized = normalize_drive_size(size, unit)
                values.append(normalized)
                issues.append(f"Указан только объём накопителя: {normalized}")

            parts.append(source[last_end:match.start()])
            last_end = match.end()

        parts.append(source[last_end:])
        return " ".join(parts)

    remaining = remove_matches(upper, DRIVE_TYPED_RE, True)
    remaining = remove_matches(remaining, DRIVE_REVERSE_RE, True)
    remaining = remove_matches(remaining, BARE_DRIVE_RE, False)

    leftover = re.sub(r"[^0-9A-ZА-ЯЁ]+", " ", remaining, flags=re.I).strip()

    if not values and upper:
        values.append(upper)
        issues.append("Не удалось разобрать значение DRIVE")
    elif leftover:
        issues.append(f"Лишняя часть в DRIVE: {leftover}")

    return values, issues


def pack_duplicates(counter):
    result = {}

    for value, rows in counter.items():
        unique_rows = []

        for row in rows:
            if row not in unique_rows:
                unique_rows.append(row)

        if len(unique_rows) > 1:
            result[value] = unique_rows

    return result


@router.post("/preview")
async def preview(file: UploadFile = File(...)):
    name = (file.filename or "").lower()

    if not name.endswith((".xlsx", ".xlsm")):
        raise HTTPException(
            status_code=400,
            detail="Нужен файл .xlsx или .xlsm. Если файл .xls — пересохрани его в .xlsx через Excel.",
        )

    data = await file.read()

    try:
        wb = load_workbook(BytesIO(data), read_only=True, data_only=True)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Не удалось открыть файл: {e}",
        )

    sheets = []

    for ws in wb.worksheets:
        rows = []

        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= 20:
                break

            rows.append([cell_to_text(v) for v in row])

        sheets.append(
            {
                "name": ws.title,
                "rows": rows,
            }
        )

    wb.close()

    return {
        "filename": file.filename,
        "sheets": sheets,
    }


@router.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    name = (file.filename or "").lower()

    if not name.endswith((".xlsx", ".xlsm")):
        raise HTTPException(
            status_code=400,
            detail="Нужен файл .xlsx или .xlsm. Если файл .xls — пересохрани его в .xlsx через Excel.",
        )

    data = await file.read()

    try:
        wb = load_workbook(BytesIO(data), read_only=True, data_only=True)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Не удалось открыть файл: {e}",
        )

    ws = None

    for sheet in wb.worksheets:
        if sheet.title.lower() == "list":
            ws = sheet
            break

    if ws is None:
        for sheet in wb.worksheets:
            if sheet.title.lower() != "@":
                ws = sheet
                break

    if ws is None:
        wb.close()
        raise HTTPException(
            status_code=400,
            detail="В файле нет листа с данными.",
        )

    rows = list(ws.iter_rows(values_only=True))
    sheet_title = ws.title
    wb.close()

    if not rows:
        raise HTTPException(
            status_code=400,
            detail="Лист с данными пуст.",
        )

    header_index = detect_header(rows)
    header_row = rows[header_index]

    col_map = {}
    unknown_columns = []

    for index, raw_header in enumerate(header_row):
        header = normalize_header(raw_header)

        if header is None:
            continue

        mapped = HEADER_MAPPING.get(header)

        if mapped is None:
            unknown_columns.append(cell_to_text(raw_header))
        else:
            col_map[index] = mapped

    anomalies = []

    total_rows = 0
    skipped_empty_rows = 0

    dup_ip = defaultdict(list)
    dup_mac = defaultdict(list)
    dup_hostname = defaultdict(list)
    dup_inv = defaultdict(list)
    dup_vacuum = defaultdict(list)

    locations = {}
    users = set()
    vacuum_logins = set()

    choices = {
        "os": set(),
        "type": set(),
        "model": set(),
        "cpu": set(),
        "gpu": set(),
        "drive": set(),
    }

    extra_fields = {
        "GSIT": set(),
        "Сост.": set(),
        "Метка": set(),
    }

    printer_values = set()
    pr_values = set()

    def add_anomaly(row_label, field, value, message):
        anomalies.append(
            {
                "row": row_label,
                "field": field,
                "value": value,
                "message": message,
            }
        )

    for data_index, row in enumerate(rows[header_index + 1 :]):
        if all(v is None for v in row):
            continue

        rec = {}

        for index, key in col_map.items():
            rec[key] = row[index] if index < len(row) else None

        if all(cell_to_text(rec.get(field)) is None for field in IMPORTANT_FIELDS):
            skipped_empty_rows += 1
            continue

        total_rows += 1

        excel_row = header_index + data_index + 2
        row_num_text = cell_to_text(rec.get("row_num"))

        if row_num_text:
            row_label = f"строка {excel_row}, #{row_num_text}"
        else:
            row_label = f"строка {excel_row}"

        address = clean_text(rec.get("address"))
        department = clean_text(rec.get("department"))

        floor_raw = clean_text(rec.get("floor"))
        floor = None

        if floor_raw:
            floor_int, floor_ok = parse_int(floor_raw)
            if floor_ok and floor_int is not None:
                floor = str(floor_int)
            else:
                floor = floor_raw

        room_code = clean_text(rec.get("room_code"))
        room_name = clean_text(rec.get("room_name"))

        if not address:
            add_anomaly(row_label, "Адрес", address, "Пустой адрес")

        if not department:
            add_anomaly(row_label, "Отделение", department, "Пустое отделение")

        if room_code and room_name:
            room_display = f"{room_code} {room_name}"
        else:
            room_display = room_name or room_code

        path_parts = [p for p in [address, department, floor, room_display] if p]

        if path_parts:
            path = " / ".join(path_parts)
            locations[path] = locations.get(path, 0) + 1

        person = clean_text(rec.get("person"))
        if person:
            users.add(person)

        seat_no, seat_ok = parse_int(rec.get("seat_no"))
        if not seat_ok:
            add_anomaly(
                row_label,
                "№",
                cell_to_text(rec.get("seat_no")),
                "Номер места не является целым числом",
            )

        ips, ip_issues = parse_ips(rec.get("ip"))

        for ip in ips:
            dup_ip[ip].append(row_label)

        for bad_ip, message in ip_issues:
            add_anomaly(row_label, "IP", bad_ip, message)

        hostname = clean_text(rec.get("hostname"))
        if hostname:
            dup_hostname[hostname.lower()].append(row_label)

        vacuum_raw = clean_text(rec.get("vacuum"))
        if vacuum_raw:
            for login in re.split(r"[\n\r,;]+", vacuum_raw):
                login = login.strip().lower()

                if login:
                    vacuum_logins.add(login)
                    dup_vacuum[login].append(row_label)

        for source_key, target_key in (
            ("os", "os"),
            ("type", "type"),
            ("model", "model"),
            ("cpu", "cpu"),
            ("gpu", "gpu"),
        ):
            value = clean_text(rec.get(source_key))
            if value:
                choices[target_key].add(value)

        drive_values, drive_issues = parse_drive_text(rec.get("drive"))

        for drive_value in drive_values:
            choices["drive"].add(drive_value)

        for message in drive_issues:
            add_anomaly(
                row_label,
                "DRIVE",
                clean_text(rec.get("drive")),
                message,
            )

        macs, mac_issues = parse_macs(rec.get("mac"))

        for mac in macs:
            dup_mac[mac].append(row_label)

        for bad_mac, message in mac_issues:
            add_anomaly(row_label, "MAC", bad_mac, message)

        inv_no = clean_text(rec.get("inv_no"))
        if inv_no:
            dup_inv[inv_no].append(row_label)

        gsit = clean_text(rec.get("gsit"))
        if gsit:
            extra_fields["GSIT"].add(gsit)

        state = clean_text(rec.get("state"))
        if state:
            extra_fields["Сост."].add(state)

        label = clean_text(rec.get("label"))
        if label:
            extra_fields["Метка"].add(label)

        printer = clean_text(rec.get("printer_skip"))
        if printer:
            printer_values.add(printer)
            add_anomaly(
                row_label,
                "Принтер",
                printer,
                "Значение из столбца Принтер пока не импортируется как принтер",
            )

        pr = clean_text(rec.get("pr_skip"))
        if pr:
            pr_values.add(pr)

    duplicates = {
        "ip": pack_duplicates(dup_ip),
        "mac": pack_duplicates(dup_mac),
        "hostname": pack_duplicates(dup_hostname),
        "inv_no": pack_duplicates(dup_inv),
        "vacuum": pack_duplicates(dup_vacuum),
    }

    locations_preview = [
        {"path": path, "count": count}
        for path, count in sorted(locations.items(), key=lambda item: item[0].lower())[:200]
    ]

    return {
        "filename": file.filename,
        "sheet": sheet_title,
        "header_row": header_index + 1,
        "headers": [cell_to_text(v) for v in header_row],
        "total_rows": total_rows,
        "skipped_empty_rows": skipped_empty_rows,
        "unknown_columns": unknown_columns,
        "summary": {
            "users": len(users),
            "vacuum_logins": len(vacuum_logins),
            "locations": len(locations),
        },
        "locations_preview": locations_preview,
        "users_preview": sorted(users, key=str.lower)[:200],
        "vacuum_preview": sorted(vacuum_logins, key=str.lower)[:200],
        "choices": {
            key: sorted(values, key=str.lower)
            for key, values in choices.items()
        },
        "extra_fields": {
            key: sorted(values, key=str.lower)
            for key, values in extra_fields.items()
        },
        "skipped_values": {
            "пр": sorted(pr_values, key=str.lower),
            "принтер": sorted(printer_values, key=str.lower),
        },
        "duplicates": duplicates,
        "anomalies_count": len(anomalies),
        "anomalies": anomalies[:200],
    }