// Таблица: нажатие и клик по ячейке, выделение строк (Ctrl, Shift, протяжка) – этап 55,
// из table.js

import { isTypingTarget } from "../util.js";

export default {
    methods: {
        // Нажатие мыши. С Ctrl / Shift / Alt браузер не должен выделять текст
        // (Shift+клик – от прошлого места до курсора, в Firefox Ctrl+клик
        // выделяет ячейки таблицы). Внутри открытого редактора – как обычно.
        // Обычное нажатие строку не выделяет, но запоминает её: следующий
        // Shift+клик выделит строки от неё. Ctrl – выделение протягиванием.
        onCellMouseDown(event, row) {
            if (event.button !== 0 || event.target.closest(".cell-edit, .loc-pick")) {
                return;
            }
            const ctrl = event.ctrlKey || event.metaKey;
            if (ctrl || event.shiftKey || event.altKey) {
                event.preventDefault();
            }
            // Нажатие с Ctrl / Shift не переносит фокус (чтобы не выделялся текст), и он
            // оставался в поле поиска: Enter, Ctrl+A и Esc после выделения строки шли
            // в поле, а не в таблицу (28в: «Enter по выделенной строке не срабатывает»)
            if ((ctrl || event.shiftKey) && !event.altKey && isTypingTarget(document.activeElement)) {
                document.activeElement.blur();
            }
            // Любое нажатие запоминает ПК для Enter (VNC), Alt+P (ping), Alt+R (RDP)
            this.setActiveRow(row);
            // …и проверяет, в сети ли его логины VACUUM (этап 41)
            this.checkRowOnline(row);
            if (event.altKey || event.shiftKey) {
                return;
            }
            this.selectAnchorId = row.id;
            if (ctrl && this.rowSelectable(row)) {
                this.startDragSelect(row);
            }
        },

        // Клик по ячейке: Alt – копировать значение под курсором,
        // Shift – выделение диапазона, обычный клик по HOSTNAME – карточка.
        // Ctrl+клик уже обработан при нажатии (startDragSelect).
        onCellClick(event, row, col) {
            if (event.target.closest(".cell-edit, .loc-pick")) {
                return;
            }
            if (event.altKey) {
                this.copyCellValue(event);
                return;
            }
            if (event.shiftKey) {
                this.selectByClick(row, event.ctrlKey || event.metaKey, true);
                return;
            }
            if (event.ctrlKey || event.metaKey) {
                return;
            }
            if (col.field === "hostname" || (col.link && (row._printer || row._move))) {
                // Протянули мышью, чтобы выделить кусок имени, – карточку не открываем
                const sel = window.getSelection ? String(window.getSelection()) : "";
                if (!sel) {
                    if (row._move) {
                        // Запись журнала (этап 66) – её окно; второй клик двойного – не повтор
                        if (event.detail === 1) {
                            this.openMoveRecord(row, null);
                        }
                    } else if (row._printer) {
                        this.openPrinterCard(row);
                    } else {
                        this.openCard(row);
                    }
                }
            }
        },

        // ---------- Выделение строк (как в Проводнике) ----------
        // Ctrl+клик – добавить/убрать строку, Ctrl+протягивание – добавить/убрать
        // строки по пути; Shift+клик – строки от прошлой (выбранной или просто
        // нажатой) до этой вместо прежнего выделения; Ctrl+Shift+клик – добавить их.

        // Журнал «IP» (этап 74): выделяются только строки с записью журнала
        rowSelectable(row) {
            return this.tableKind !== "ips" || this.ipRowSelectable(row);
        },

        // id строк на экране, которые можно выделить
        selectableIds() {
            return this.displayRows.filter((r) => this.rowSelectable(r)).map(function (r) { return r.id; });
        },

        // Ctrl+нажатие: строка выделяется (или снимается), дальше – протягивание.
        // Что делать со строками по пути, решает первая: была выбрана – снимаем.
        startDragSelect(row) {
            this.startRowDrag({
                start: row.id,
                keys: () => this.selectableIds(),
                selected: () => this.selectedRows,
                select: (list) => { this.selectedRows = list; },
                wrap: this.$refs.tableWrap,
                rowKey: function (el) {
                    const tr = el.closest(".data-table tbody tr");
                    return tr && tr.dataset.id ? Number(tr.dataset.id) : null;
                }
            });
        },

        // ---------- Протяжка с Ctrl: Таблица и «Проверка» (этап 55) ----------
        // drag: start – ключ первой строки, keys() – ключи строк по порядку (на каждом движении:
        // строки могут смениться, пока тянут), selected() и select(list) – выделение, wrap –
        // блок с прокруткой, rowKey(el) – ключ строки, в которой элемент (не в строке – null).
        // Строки от первой до той, что под курсором, добавляются к прежнему выделению или
        // снимаются с него.
        startRowDrag(drag) {
            drag.base = drag.selected().slice();
            drag.add = drag.base.indexOf(drag.start) === -1;
            drag.x = 0;
            drag.y = 0;
            drag.raf = null;
            this._rowDrag = drag;
            this.applyRowDrag(drag.start);
            const onMove = (e) => {
                drag.x = e.clientX;
                drag.y = e.clientY;
                this.rowDragAtPointer();
                this.rowDragAutoScroll();
            };
            const onUp = () => {
                document.removeEventListener("mousemove", onMove, true);
                document.removeEventListener("mouseup", onUp, true);
                if (drag.raf) {
                    cancelAnimationFrame(drag.raf);
                }
                this._rowDrag = null;
            };
            document.addEventListener("mousemove", onMove, true);
            document.addEventListener("mouseup", onUp, true);
        },

        // То же выделение не записывается: замена – перерисовка
        applyRowDrag(key) {
            const drag = this._rowDrag;
            const keys = drag.keys();
            const a = keys.indexOf(drag.start);
            const b = keys.indexOf(key);
            if (a === -1 || b === -1) {
                return;
            }
            const range = new Set(keys.slice(Math.min(a, b), Math.max(a, b) + 1));
            const base = new Set(drag.base);
            const next = drag.add
                ? drag.base.concat(Array.from(range).filter(function (k) { return !base.has(k); }))
                : drag.base.filter(function (k) { return !range.has(k); });
            const now = drag.selected();
            if (next.length !== now.length || next.some(function (k, i) { return k !== now[i]; })) {
                drag.select(next);
            }
        },

        // Строка под курсором во время протягивания – по высоте, даже если курсор ушёл
        // левее или правее таблицы (справа – не дальше её края и полосы прокрутки)
        rowDragAtPointer() {
            const drag = this._rowDrag;
            if (!drag || !drag.wrap) {
                return;
            }
            const box = drag.wrap.getBoundingClientRect();
            const table = drag.wrap.querySelector("table");
            const right = Math.min(box.right - 20, table ? table.getBoundingClientRect().right - 4 : box.right);
            const x = Math.min(Math.max(drag.x, box.left + 2), right);
            const y = Math.min(Math.max(drag.y, box.top + 1), box.bottom - 2);
            const el = document.elementFromPoint(x, y);
            const key = el ? drag.rowKey(el) : null;
            if (key !== null) {
                this.applyRowDrag(key);
            }
        },

        // У верхнего / нижнего края блока – прокрутка, пока держат мышь
        rowDragAutoScroll() {
            const drag = this._rowDrag;
            if (!drag || !drag.wrap || drag.raf) {
                return;
            }
            const wrap = drag.wrap;
            const step = () => {
                drag.raf = null;
                if (this._rowDrag !== drag) {
                    return;
                }
                const box = wrap.getBoundingClientRect();
                const head = wrap.querySelector("thead");
                const top = box.top + (head ? head.offsetHeight : 0);
                let dy = 0;
                if (drag.y < top + 20) {
                    dy = -Math.min(30, Math.ceil((top + 20 - drag.y) / 3));
                } else if (drag.y > box.bottom - 20) {
                    dy = Math.min(30, Math.ceil((drag.y - box.bottom + 20) / 3));
                }
                if (dy) {
                    wrap.scrollTop += dy;
                    this.rowDragAtPointer();
                    drag.raf = requestAnimationFrame(step);
                }
            };
            step();
        },

        isRowSelected(row) {
            return this.selectedSet.has(row.id);
        },

        selectByClick(row, ctrl, shift) {
            const ids = this.displayRows.map(function (r) { return r.id; });
            const from = this.selectAnchorId === null ? -1 : ids.indexOf(this.selectAnchorId);
            if (shift && from !== -1) {
                const to = ids.indexOf(row.id);
                const allowed = new Set(this.selectableIds());
                const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1).filter(function (id) { return allowed.has(id); });
                if (ctrl) {
                    const have = this.selectedSet;
                    this.selectedRows = this.selectedRows.concat(range.filter(function (id) { return !have.has(id); }));
                } else {
                    this.selectedRows = range;
                }
                return;
            }
            const index = this.selectedRows.indexOf(row.id);
            if (!this.rowSelectable(row)) {
                this.selectAnchorId = row.id;
                return;
            }
            if (index === -1) {
                this.selectedRows.push(row.id);
            } else if (!shift) {
                this.selectedRows.splice(index, 1);
            }
            this.selectAnchorId = row.id;
        },

        // Ctrl+A – все видимые строки (с учётом поиска и фильтра по дереву), которые можно выделить
        selectAllVisible() {
            this.selectedRows = this.selectableIds();
            if (this.selectedRows.length) {
                this.selectAnchorId = this.selectedRows[0];
            }
        },

        clearSelection() {
            this.selectedRows = [];
            this.selectAnchorId = null;
            this.closeMenus();
        },
    }
};
