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

DRIVE_RE = re.compile(
    r"^(?P<type>SSD|HDD|NVME)\s*[-_]?\s*(?P<size>\d+)(?:\s*(?:GB|ГБ|Г))?$",
    re.I,
)

DRIVE_REVERSE_RE = re.compile(
    r"^(?P<size>\d+)\s*(?P<type>SSD|HDD|NVME)$",
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


def normalize_ip(value):
    text = clean_text(value)

    if text is None:
        return None, True

    try:
        ipaddress.ip_address(text)
        return text, True
    except ValueError:
        return text, False


def normalize_mac(value):
    text = cell_to_text(value)

    if not text:
        return [], []

    macs = []
    bad = []

    for part in re.split(r"[\n\r,;]+", text):
        part = part.strip().upper()

        if not part:
            continue

        if MAC_RE.match(part):
            macs.append(part)
        else:
            bad.append(part)

    return macs, bad


def normalize_drive(value):
    text = clean_text(value)

    if text is None:
        return None, True

    upper = " ".join(text.upper().split())

    match = DRIVE_RE.match(upper)
    if match:
        return f"{match.group('type').upper()} {match.group('size')}", True

    match = DRIVE_REVERSE_RE.match(upper)
    if match:
        return f"{match.group('type').upper()} {match.group('size')}", True

    return text, False


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

        if not room_code and not room_name:
            add_anomaly(row_label, "Кабинет", None, "Нет названия или номера кабинета")

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

        ip_value, ip_ok = normalize_ip(rec.get("ip"))
        if ip_value:
            if not ip_ok:
                add_anomaly(row_label, "IP", ip_value, "IP не распознаётся")
            dup_ip[ip_value].append(row_label)

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

        drive_value, drive_ok = normalize_drive(rec.get("drive"))
        if drive_value:
            choices["drive"].add(drive_value)

            if not drive_ok:
                add_anomaly(
                    row_label,
                    "DRIVE",
                    drive_value,
                    "Значение DRIVE не приведено к виду 'SSD 250' или 'HDD 500'",
                )

        macs, bad_macs = normalize_mac(rec.get("mac"))

        for mac in macs:
            dup_mac[mac].append(row_label)

        for bad_mac in bad_macs:
            add_anomaly(
                row_label,
                "MAC",
                bad_mac,
                "MAC не похож на формат AA:BB:CC:11:22:33",
            )

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