"""Этап 61: число принтеров у модели – рабочие, как на «Принтерах» и у картриджей; принтеры в
архиве – отдельным числом (подсказка), из-за них модель по-прежнему не удалить."""
from conftest import ok
from test_printers import add_printer


def model_counts(client, model_id):
    model = next(m for m in ok(client.get("/api/printer-models"))["items"] if m["id"] == model_id)
    return model["printers"], model["archived_printers"]


def test_model_counts_working_printers(editor, reader, room, models):
    model_id = models["printer"]["id"]
    a = add_printer(editor, room["room"], name="prn-a", model="HP LaserJet M404")
    b = add_printer(editor, room["room"], name="prn-b", model="HP LaserJet M404")
    assert model_counts(reader, model_id) == (2, 0)
    assert model_counts(reader, models["mfu"]["id"]) == (0, 0)

    ok(editor.post("/api/printers/archive", json={"ids": [b], "archived": True}))
    assert model_counts(reader, model_id) == (1, 1)

    # Ответ правки модели – те же числа
    saved = ok(editor.patch(f"/api/printer-models/{model_id}", json={"duplex": True}))
    assert (saved["printers"], saved["archived_printers"]) == (1, 1)

    # Рабочий – тоже в архив: в справочнике 0, но модель не удалить
    ok(editor.post("/api/printers/archive", json={"ids": [a], "archived": True}))
    assert model_counts(reader, model_id) == (0, 2)
    response = editor.delete(f"/api/printer-models/{model_id}")
    assert response.status_code == 400
    assert "2" in response.json()["detail"]

    # Новая модель – без принтеров
    created = ok(editor.post("/api/printer-models", json={"model": "Spare"}))
    assert (created["printers"], created["archived_printers"]) == (0, 0)
