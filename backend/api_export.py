from datetime import date, datetime
from io import BytesIO

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font

from api_columns import COLUMNS as BUILTIN_COLUMNS, PRINTER_COLUMNS
from api_computers import computer_rows, is_reserved_field_key
from api_printers import printer_rows
from api_scan_diffs import av_name, av_settings, av_visible, computer_antivirus
from db import get_db
from models import FieldDef

router = APIRouter(prefix="/api/export", tags=["export"])

# Встроенные столбцы – из общего описания (порядок и подписи как в таблице)
COLUMNS = [
    {
        "field": column.key,
        "header": column.short,
        "width": column.export_width,
        "wrap": column.multiline,
        "date": column.kind == "date",
    }
    for column in BUILTIN_COLUMNS
]


def get_export_columns(session):
    """Встроенные столбцы + пользовательские поля (перед «Статус», как в таблице)."""
    field_defs = (
        session.query(FieldDef)
        .filter(FieldDef.archived == False)
        .order_by(FieldDef.sort, FieldDef.id)
        .all()
    )

    extra_columns = [
        {"field": fd.key, "header": fd.label, "width": 14, "wrap": True}
        for fd in field_defs
        if not is_reserved_field_key(fd.key)
    ]

    status_index = next(
        (i for i, column in enumerate(COLUMNS) if column["field"] == "status"),
        len(COLUMNS),
    )

    return COLUMNS[:status_index] + extra_columns + COLUMNS[status_index:]


def fill_sheet(ws, rows, columns):
    header_font = Font(bold=True)
    wrap_alignment = Alignment(wrap_text=True, vertical="top")

    for col_index, column in enumerate(columns, start=1):
        cell = ws.cell(row=1, column=col_index, value=column["header"])
        cell.font = header_font
        ws.column_dimensions[cell.column_letter].width = column["width"]

    for row_index, row in enumerate(rows, start=2):
        for col_index, column in enumerate(columns, start=1):
            value = row.get(column["field"])

            if column.get("date") and value:
                # В строках таблицы дата – текст «15.10.2026», в Excel – настоящая дата
                value = datetime.strptime(value, "%d.%m.%Y").date()

            cell = ws.cell(row=row_index, column=col_index, value=value)

            if column.get("date"):
                cell.number_format = "DD.MM.YYYY"

            if column.get("wrap"):
                cell.alignment = wrap_alignment

    ws.freeze_panes = "A2"


# Антивирусы в выгрузке – строками, состояние словами (в Таблице – цветом)
AV_SUFFIX = {"on": "", "old": " – базы устарели", "off": " – выключен"}


def fill_antivirus(session, rows):
    """Столбец «Антивирусы» берётся из сканера (этап 26д): как в Таблице –
    только показываемые состояния и названия."""
    antivirus = computer_antivirus(session)
    settings = av_settings(session)

    for row in rows:
        items = [a for a in antivirus.get(row["id"], []) if av_visible(settings, a)]
        row["antivirus"] = "\n".join(av_name(settings, a["name"]) + AV_SUFFIX[a["status"]] for a in items) or None


@router.get("/computers.xlsx")
def export_computers(archive: bool = False, session=Depends(get_db)):
    """Рабочие ПК; archive=true – ещё лист «Архив» с ПК из архива."""
    columns = get_export_columns(session)

    wb = Workbook()
    ws = wb.active
    ws.title = "Компьютеры"
    rows = computer_rows(session, "no")["rows"]
    fill_antivirus(session, rows)
    fill_sheet(ws, rows, columns)

    if archive:
        fill_sheet(wb.create_sheet("Архив"), computer_rows(session, "yes")["rows"], columns)

    return workbook_response(wb, "computers", archive)


# Принтеры (этап 44): все столбцы таблицы принтеров; логин и пароль Web – не выгружаются
PRINTER_EXPORT_COLUMNS = [
    {"field": column.key, "header": column.short, "width": column.export_width, "wrap": column.multiline}
    for column in PRINTER_COLUMNS
    if column.kind != "secret"
]


@router.get("/printers.xlsx")
def export_printers(archive: bool = False, session=Depends(get_db)):
    """Рабочие принтеры; archive=true – ещё лист «Архив»."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Принтеры"
    fill_sheet(ws, printer_rows(session, "no"), PRINTER_EXPORT_COLUMNS)

    if archive:
        fill_sheet(wb.create_sheet("Архив"), printer_rows(session, "yes"), PRINTER_EXPORT_COLUMNS)

    return workbook_response(wb, "printers", archive)


def workbook_response(wb, what, archive):
    buffer = BytesIO()
    wb.save(buffer)
    buffer.seek(0)

    suffix = "_archive" if archive else ""
    filename = f"itdb_{what}{suffix}_{date.today().isoformat()}.xlsx"

    return StreamingResponse(
        buffer,
        headers={
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": f"attachment; filename={filename}",
        },
    )
