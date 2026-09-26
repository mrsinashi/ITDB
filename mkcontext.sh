#!/bin/bash
# Собирает нужные файлы проекта в один CONTEXT.txt для передачи в чат
cd "$(dirname "$0")" || exit 1
OUT=CONTEXT.txt

{
    echo "ITDB — снимок $(date '+%Y-%m-%d %H:%M')"
    echo
    echo "### ДЕРЕВО ФАЙЛОВ ###"
    tree -I '__pycache__|.git|.venv|_BACKUP' --dirsfirst
    echo

    {
        find backend frontend/static -type f \
            -not -path '*__pycache__*' \
            -not -path '*vendor*'
        # миграции — чтобы было видно текущую голову (down_revision новой миграции)
        find alembic/versions -type f -name '*.py'
        echo "requirements.txt"
        echo "alembic/env.py"
        echo ".gitignore"
        echo "README.md"
    } | sort | while read -r f; do
        [ -f "$f" ] || continue
        echo "=== FILE: $f ==="
        cat "$f"
        echo
    done
} > "$OUT"

echo "Готово: $OUT ($(du -h "$OUT" | cut -f1))"