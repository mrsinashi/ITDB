"""Этап 37: в проекте нет длинного тире – только короткое «–» (просьба 08.10)."""

import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
LONG = chr(0x2014)
# Папки и файлы проекта (в папке на сервере бывает и чужое: патчи, свои заметки)
PLACES = ["backend", "frontend", "alembic", "tests", "deploy", "README.md"]
SKIP = {"vendor", "__pycache__"}
TEXT = {".py", ".js", ".html", ".css", ".md", ".sh", ".txt", ".ini", ""}


def test_no_long_dash():
    found = []
    for place in PLACES:
        top = ROOT / place
        files = [top] if top.is_file() else [p for p in top.rglob("*") if p.is_file()]
        for path in files:
            if SKIP.intersection(path.relative_to(ROOT).parts) or path.suffix not in TEXT:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if LONG in text:
                found.append(f"{path.relative_to(ROOT)}: {text.count(LONG)}")
    assert not found, "Длинное тире: " + ", ".join(found)
