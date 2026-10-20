"""Удаление насовсем из архива (правки этапа 66, просьба пользователя 15.10): ПК, принтеры,
записи журнала «Движение» – только те, что в архиве, и только администратор (ответ
пользователя). Вернуть нельзя: в Историю – «Удалено» с названием (Ctrl+Z его не отменяет);
прежние записи Истории объекта остаются, название им – из этой записи (api_history.entry_titles).

Связи удалённого уходят вместе с ним: ПК принтера и принтеры ПК (у другой стороны – запись
Истории), пользователи и VACUUM ПК, решения сканера о нём. Запись журнала, поставленная в
удалённый ПК, остаётся в его кабинете («Куда» – в Историю записи).

Замки – всегда ПК, потом принтеры, потом записи журнала (каждые – по возрастанию id): два
удаления связанных ПК и принтера не ждут друг друга вечно. Связи другой стороны читаются уже
под её замком – подключённое в ту же секунду не снимется молча."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api_computers import COMPUTERS_MISSING, load_locations, lock_rows, save_changes
from api_moves import MOVES_MISSING, dest_path, dest_ref, distinct, move_names, record, ref_note
from api_printers import PRINTERS_MISSING
from auth import require_page
from db import get_db
from models import (
    Computer, ComputerPerson, History, Move, Printer, PrinterComputer, ScanLink, ScanReject, VacuumAccountComputer,
)
from printer_links import computers_by_printer, printer_title, printers_by_computer, set_computer_printers, set_printer_computers

router = APIRouter(prefix="/api", tags=["delete"])

NOT_ARCHIVED = "Удалить насовсем можно только из архива."


class IdsIn(BaseModel):
    ids: list[int]


def archived_rows(session, model, ids, missing):
    """Строки по возрастанию id, с блокировкой; все должны быть в архиве."""
    if not ids:
        raise HTTPException(status_code=400, detail="Ничего не выбрано.")

    rows = lock_rows(session, model, sorted(set(ids)), missing)

    if any(not row.archived for row in rows):
        raise HTTPException(status_code=400, detail=NOT_ARCHIVED)

    return rows


def forget(session, row, entity, title, user_name):
    """Объекта больше не будет: в Историю – «Удалено» с его названием."""
    session.add(History(entity=entity, entity_id=row.id, user_name=user_name, title=title,
                        changes={"deleted": {"old": title, "new": None}}))
    session.delete(row)


def drop_links(session, others, ids, links_of, set_links, field, user_name):
    """Связи принтер – ПК с удаляемыми (ids): у каждого объекта другой стороны (others – уже
    под замком) – новая запись Истории, как правка его ячейки. links_of – его связи сейчас:
    {id: [(объект, usb)]}."""
    current = links_of(session, [other.id for other in others])

    for other in others:
        keep = [[obj.id, usb] for obj, usb in current.get(other.id, []) if obj.id not in ids]
        change = set_links(session, other, keep)

        if change:
            save_changes(session, other, {field: change}, user_name)


def linked_ids(session, column, filter_column, ids):
    return sorted({value for (value,) in session.query(column).filter(filter_column.in_(ids))}) if ids else []


@router.post("/computers/delete")
def delete_computers(payload: IdsIn, user=Depends(require_page("table", "edit", admin=True)), session=Depends(get_db)):
    computers = archived_rows(session, Computer, payload.ids, COMPUTERS_MISSING)
    ids = [computer.id for computer in computers]
    login = user["login"]

    # Принтеры этих ПК: у принтера в Истории – его «Компьютеры» без удалённых
    printer_ids = linked_ids(session, PrinterComputer.printer_id, PrinterComputer.computer_id, ids)
    printers = lock_rows(session, Printer, printer_ids, PRINTERS_MISSING) if printer_ids else []
    drop_links(session, printers, set(ids), computers_by_printer, set_printer_computers, "computers", login)

    # Компоненты, поставленные в эти ПК, – в их кабинет
    by_id = {computer.id: computer for computer in computers}
    moves = session.query(Move).filter(Move.dest_computer_id.in_(ids)).order_by(Move.id).with_for_update().all()
    locations_by_id = load_locations(session) if moves else None

    for move in moves:
        computer = by_id[move.dest_computer_id]
        old_ref = dest_ref(None, computer.id)
        new_ref = dest_ref(computer.location_id, None)
        old_text, new_text = distinct(
            dest_path(session, None, computer.id, locations_by_id),
            dest_path(session, computer.location_id, None, locations_by_id),
            ref_note(old_ref), ref_note(new_ref) if new_ref else "",
        )
        changes = {}
        record(changes, "dest", old_text, new_text, old_id=old_ref, new_id=new_ref)
        move.dest_location_id = computer.location_id
        move.dest_computer_id = None
        save_changes(session, move, changes, login)

    # Ссылки на ПК – в базу до удаления самих ПК (связей ORM нет – порядок задаём сами)
    session.flush()

    for model in (ComputerPerson, VacuumAccountComputer, PrinterComputer, ScanLink, ScanReject):
        session.query(model).filter(model.computer_id.in_(ids)).delete(synchronize_session=False)

    for computer in computers:
        forget(session, computer, "computers", computer.hostname or f"ПК #{computer.id}", login)

    session.commit()
    return {"ok": True, "deleted": ids}


@router.post("/printers/delete")
def delete_printers(payload: IdsIn, user=Depends(require_page("printers", "edit", admin=True)), session=Depends(get_db)):
    # Замки – как при удалении ПК: сначала ПК этих принтеров, потом сами принтеры
    computer_ids = linked_ids(session, PrinterComputer.computer_id, PrinterComputer.printer_id, sorted(set(payload.ids)))
    computers = lock_rows(session, Computer, computer_ids, COMPUTERS_MISSING) if computer_ids else []
    printers = archived_rows(session, Printer, payload.ids, PRINTERS_MISSING)
    ids = [printer.id for printer in printers]
    login = user["login"]

    # ПК этих принтеров: у ПК в Истории – его «Принтеры» без удалённых
    drop_links(session, computers, set(ids), printers_by_computer, set_computer_printers, "printers", login)

    for model in (PrinterComputer, ScanReject):
        session.query(model).filter(model.printer_id.in_(ids)).delete(synchronize_session=False)

    for printer in printers:
        forget(session, printer, "printers", printer_title(printer), login)

    session.commit()
    return {"ok": True, "deleted": ids}


@router.post("/moves/delete")
def delete_moves(payload: IdsIn, user=Depends(require_page("journals/moves", "edit", admin=True)), session=Depends(get_db)):
    moves = archived_rows(session, Move, payload.ids, MOVES_MISSING)
    names = move_names(session, [move.id for move in moves])

    for move in moves:
        forget(session, move, "moves", names.get(move.id) or f"#{move.id}", user["login"])

    session.commit()
    return {"ok": True, "deleted": [move.id for move in moves]}
