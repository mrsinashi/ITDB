from datetime import date, datetime
from io import BytesIO

from fastapi import APIRouter, File, HTTPException, UploadFile
from openpyxl import load_workbook

router = APIRouter(prefix="/api/import", tags=["import"])


def cell_value(value):
    if value is None:
        return None

    if isinstance(value, (datetime, date)):
        return value.isoformat()

    return value


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

            rows.append([cell_value(v) for v in row])

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