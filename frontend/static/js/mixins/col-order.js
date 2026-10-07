// Таблица: порядок столбцов — перетаскивание шапки мышью. У каждого вида свой,
// запоминается в браузере; вернуть исходный — меню «Столбцы».

import { saveJson } from "../util.js";
import { COLUMN_ORDER_KEY, COLUMN_ORDER2_KEY } from "../columns.js";

// Сдвиг мыши, после которого нажатие на шапке — перетаскивание, а не клик
const DRAG_START = 5;
// Полоса у левого и правого края области таблицы: там она прокручивается сама
const SCROLL_ZONE = 40;

export default {
    computed: {
        // Порядок столбцов текущего вида; null — как с сервера
        columnOrderNow() {
            const order = this.tableView === 2 ? this.columnOrder2 : this.columnOrder;
            return Array.isArray(order) ? order : null;
        },

        columnOrderChanged() {
            const now = this.allColumns;
            return this.defaultColumns.some(function (col, i) { return now[i].field !== col.field; });
        },
    },

    methods: {
        // Нажатие на шапке: отпустили на месте — клик (сортировка, с Ctrl — закрепление),
        // повели мышь в сторону — перетаскивание столбца. Всё, что меняется на каждое
        // движение, — прямо в стилях элементов, в данные — только итог
        onHeadMouseDown(event, col) {
            if (event.button !== 0 || this._colDrag || event.target.closest(".resize-handle, .th-filter")) {
                return;
            }
            const drag = {
                field: col.field,
                label: col.headerName,
                th: event.currentTarget,
                startX: event.clientX,
                x: event.clientX,
                started: false,
                cancelled: false,
                target: null,
                raf: null
            };
            this._colDrag = drag;
            const onMove = (e) => {
                drag.x = e.clientX;
                if (drag.cancelled) {
                    return;
                }
                if (!drag.started) {
                    if (Math.abs(drag.x - drag.startX) < DRAG_START) {
                        return;
                    }
                    this.startColDrag(drag);
                }
                this.colDragUpdate();
                this.colDragAutoScroll();
            };
            // Esc — отменить; кнопку ещё держат, поэтому отпускание ждём дальше
            const onKey = (e) => {
                if (e.key === "Escape" && drag.started && !drag.cancelled) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    drag.cancelled = true;
                    this.clearColDrag(drag);
                }
            };
            const stop = (drop) => {
                document.removeEventListener("mousemove", onMove, true);
                document.removeEventListener("mouseup", onUp, true);
                window.removeEventListener("keydown", onKey, true);
                window.removeEventListener("blur", onBlur);
                this._colDrag = null;
                if (!drag.started) {
                    return;
                }
                if (drop && !drag.cancelled && drag.target !== null) {
                    this.moveColumn(drag.field, drag.target);
                }
                this.clearColDrag(drag);
                // Отпускание после перетаскивания — не клик по шапке
                this.colDragDone = true;
                setTimeout(() => {
                    this.colDragDone = false;
                });
            };
            const onUp = () => stop(true);
            const onBlur = () => stop(false);
            document.addEventListener("mousemove", onMove, true);
            document.addEventListener("mouseup", onUp, true);
            window.addEventListener("keydown", onKey, true);
            window.addEventListener("blur", onBlur);
        },

        // Столбец «в руке» — полупрозрачный призрак за курсором; куда встанет — линия
        startColDrag(drag) {
            drag.started = true;
            const box = drag.th.getBoundingClientRect();
            drag.grab = drag.startX - box.left;
            drag.width = box.width;
            this.hideNoteTooltip();
            document.documentElement.classList.add("col-dragging");
            drag.th.classList.add("col-drag-src");
            const ghost = document.createElement("div");
            ghost.className = "col-drag-ghost";
            const head = document.createElement("div");
            head.className = "cdg-head";
            head.textContent = drag.label;
            // Шапка призрака — как у столбца, и в масштабе по ширине окна
            head.style.height = head.style.lineHeight = box.height + "px";
            head.style.fontSize = (12 * (this.tableFit ? this.tableZoom : 1)) + "px";
            ghost.appendChild(head);
            const mark = document.createElement("div");
            mark.className = "col-drop-mark";
            document.body.appendChild(ghost);
            document.body.appendChild(mark);
            drag.ghost = ghost;
            drag.mark = mark;
        },

        clearColDrag(drag) {
            if (drag.raf) {
                cancelAnimationFrame(drag.raf);
                drag.raf = null;
            }
            document.documentElement.classList.remove("col-dragging");
            drag.th.classList.remove("col-drag-src");
            if (drag.ghost) {
                drag.ghost.remove();
                drag.mark.remove();
                drag.ghost = drag.mark = null;
            }
        },

        // Куда встанет столбец: ближняя к курсору граница столбца шапки под ним
        // (прилипший закреплённый — поверх тех, что уехали под него)
        colDragUpdate() {
            const drag = this._colDrag;
            const wrap = this.$refs.tableWrap;
            const table = this.$refs.table;
            const head = table && table.querySelector("thead");
            if (!drag || !drag.ghost || !wrap || !head) {
                return;
            }
            const box = wrap.getBoundingClientRect();
            const right = box.left + wrap.clientWidth;   // без полосы прокрутки
            const headBox = head.getBoundingClientRect();
            const tableBox = table.getBoundingClientRect();
            const top = headBox.top;
            const height = Math.min(box.top + wrap.clientHeight, tableBox.bottom) - top;
            const ghost = drag.ghost.style;
            ghost.left = (drag.x - drag.grab) + "px";
            ghost.top = top + "px";
            ghost.width = drag.width + "px";
            ghost.height = height + "px";

            const ths = Array.from(head.querySelectorAll("th"));
            const x = Math.min(Math.max(drag.x, box.left + 1), right - 1);
            const el = document.elementFromPoint(x, headBox.top + headBox.height / 2);
            const th = el && el.closest("th");
            let index;
            let edge;
            if (th && ths.indexOf(th) !== -1) {
                const r = th.getBoundingClientRect();
                const after = x > r.left + r.width / 2;
                index = ths.indexOf(th) + (after ? 1 : 0);
                edge = after ? r.right : r.left;
            } else if (x < tableBox.left + tableBox.width / 2) {
                // Таблица уже окна — левее или правее её
                index = 0;
                edge = ths[0].getBoundingClientRect().left;
            } else {
                index = ths.length;
                edge = ths[ths.length - 1].getBoundingClientRect().right;
            }
            // На своё же место — линии нет
            const from = ths.indexOf(drag.th);
            drag.target = index === from || index === from + 1 ? null : index;
            const mark = drag.mark.style;
            if (drag.target === null) {
                mark.display = "none";
                return;
            }
            mark.display = "";
            mark.left = (Math.round(Math.min(Math.max(edge, box.left + 1), right - 1)) - 1) + "px";
            mark.top = top + "px";
            mark.height = height + "px";
        },

        // У левого и правого края — прокрутка, пока держат мышь
        colDragAutoScroll() {
            const drag = this._colDrag;
            const wrap = this.$refs.tableWrap;
            if (!drag || !wrap || drag.raf) {
                return;
            }
            const step = () => {
                drag.raf = null;
                if (this._colDrag !== drag || drag.cancelled) {
                    return;
                }
                const box = wrap.getBoundingClientRect();
                const right = box.left + wrap.clientWidth;
                let dx = 0;
                if (drag.x < box.left + SCROLL_ZONE) {
                    dx = -Math.min(30, Math.ceil((box.left + SCROLL_ZONE - drag.x) / 3));
                } else if (drag.x > right - SCROLL_ZONE) {
                    dx = Math.min(30, Math.ceil((drag.x - right + SCROLL_ZONE) / 3));
                }
                const before = wrap.scrollLeft;
                if (dx) {
                    wrap.scrollLeft += dx;
                }
                if (wrap.scrollLeft !== before) {
                    this.colDragUpdate();
                    drag.raf = requestAnimationFrame(step);
                }
            };
            step();
        },

        // Переставить столбец на место index среди видимых (счёт — до перестановки).
        // Скрытые столбцы остаются, где были
        moveColumn(field, index) {
            const visible = this.columns.map(function (col) { return col.field; });
            const order = this.allColumns.map(function (col) { return col.field; });
            order.splice(order.indexOf(field), 1);
            if (index < visible.length) {
                order.splice(order.indexOf(visible[index]), 0, field);
            } else {
                order.splice(order.indexOf(visible[visible.length - 1]) + 1, 0, field);
            }
            this.setColumnOrder(order);
        },

        resetColumnOrder() {
            this.setColumnOrder(null);
        },

        setColumnOrder(order) {
            if (this.tableView === 2) {
                this.columnOrder2 = order;
                saveJson(COLUMN_ORDER2_KEY, order);
            } else {
                this.columnOrder = order;
                saveJson(COLUMN_ORDER_KEY, order);
            }
            this.$nextTick(() => {
                this.updateStickyShadow();
            });
        },
    },
};
