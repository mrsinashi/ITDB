"""Этап 26и: оформление значений и столбцов – подчёркнутый, зачёркнутый, фон блочком."""
from conftest import ok


def choice(client, choice_id):
    return next(c for c in ok(client.get("/api/choices"))["items"] if c["id"] == choice_id)


def test_choice_underline_strike_chip(editor):
    choice_id = ok(editor.post("/api/choices", json={"field": "os", "value": "Win 7"}))["id"]
    item = choice(editor, choice_id)
    assert (item["underline"], item["strike"], item["chip"]) == (False, False, False)

    ok(editor.patch(f"/api/choices/{choice_id}", json={"bg_color": "#cdebd0", "chip": True, "underline": True, "strike": True}))
    item = choice(editor, choice_id)
    assert (item["bg_color"], item["chip"], item["underline"], item["strike"]) == ("#cdebd0", True, True, True)

    record = ok(editor.get("/api/history", params={"entity": "choices"}))["items"][0]
    assert set(record["changes"]) == {"bg_color", "chip", "underline", "strike"}

    # Сбрасывается только то, что передано: фон убран – остальное на месте
    ok(editor.patch(f"/api/choices/{choice_id}", json={"bg_color": ""}))
    item = choice(editor, choice_id)
    assert item["bg_color"] is None and item["underline"] is True and item["chip"] is True


def test_column_style_flags(editor):
    styles = lambda: {s["field"]: s for s in ok(editor.get("/api/column-styles"))["items"]}

    item = ok(editor.patch("/api/column-styles/ram", json={"underline": True}))["item"]
    assert item["underline"] is True and item["strike"] is False and item["chip"] is False
    assert styles()["ram"]["underline"] is True

    ok(editor.patch("/api/column-styles/type", json={"bg_color": "#eeeeee", "chip": True}))
    assert styles()["type"]["chip"] is True

    # «Блочком» без фона ничего не значит – пустое оформление удаляется
    ok(editor.patch("/api/column-styles/type", json={"bg_color": ""}))
    ok(editor.patch("/api/column-styles/ram", json={"underline": False}))
    assert styles() == {}


def test_undo_style_flag(editor):
    choice_id = ok(editor.post("/api/choices", json={"field": "cpu", "value": "i9"}))["id"]
    ok(editor.patch(f"/api/choices/{choice_id}", json={"strike": True}))
    record = ok(editor.get("/api/history", params={"entity": "choices"}))["items"][0]
    ok(editor.post("/api/history/cancel", json={"items": [{"id": record["id"]}]}))
    assert choice(editor, choice_id)["strike"] is False
