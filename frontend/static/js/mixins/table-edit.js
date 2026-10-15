// Таблица: правка ячейки – поле правки, Enter / Esc, сохранение (этап 55 – из table.js).
// Особые столбцы открывают своё: выбор узла, окошко «Доступа», подключения ПК – принтер

import { apiFetch } from "../util.js";
import { refreshDuplicates } from "../columns.js";
import { splitTokens } from "./cartridges.js";

export default {
    methods: {
        isEditing(row, col) {
            return this.editingRowId === row.id && this.editingField === col.field;
        },

        // event – двойной клик по ячейке: под ней – окошки «Доступа» и подключений (этап 45)
        startEdit(row, col, event) {
            // Двойной клик по ссылке на принтер / ПК (этап 44) – правка, а не переход
            this.cancelObjLink();
            const td = event && event.currentTarget && event.currentTarget.closest ? event.currentTarget.closest("td") : null;
            // Логин и пароль Web: показать по паролю, задать, изменить показанные
            if (col.secret) {
                if (td && !this.isEditing(row, col)) {
                    this.cancelEdit();
                    this.openWebAccess(row, td, "cell");
                }
                return;
            }
            // Правка другой ячейки прячет показанные логин и пароль
            this.hideWebShown();
            // Принтеры ПК, ПК принтера – окошко с поиском и галочками
            if (col.links) {
                this.cancelEdit();
                this.openLinkPick(row, col, td);
                return;
            }
            // Тип, производитель, печать, дуплекс принтера – из модели: сказать, где меняются
            if (this.canEdit && col.fromModel) {
                this.toast("Меняется в справочнике моделей");
                return;
            }
            if (!this.canEdit || !(col.editable || col.location)) {
                return;
            }
            if (this.editingRowId === row.id && this.editingField === col.field) {
                return;
            }
            this.hideNoteTooltip();
            if (col.location) {
                // Выбор узла дерева; поле поиска фокусирует сам location-picker
                this.ensureTree();
                this.editingRowId = row.id;
                this.editingField = col.field;
                return;
            }
            this.editingRowId = row.id;
            this.editingField = col.field;
            this.editValue = row[col.field] === null || row[col.field] === undefined ? "" : String(row[col.field]);
            // Картриджи (этап 47): в поле – через запятую
            if (col.cartridges) {
                this.editValue = splitTokens(this.editValue).join(", ");
            }
            this.$nextTick(() => {
                // Поле правки – в строке-компоненте, её ref корню не виден
                const tr = this.$refs.table && this.$refs.table.querySelector('tbody tr[data-id="' + row.id + '"]');
                const el = tr && tr.querySelector("td.editing .cell-edit");
                if (!el) {
                    return;
                }
                const td = el.closest("td");
                if (td) {
                    el.style.width = td.clientWidth + "px";
                    el.style.height = td.clientHeight + "px";
                    this.growEditor(el, col);
                }
                el.focus({ preventScroll: true });
                if (el.setSelectionRange) {
                    const len = el.value.length;
                    el.setSelectionRange(len, len);
                }
                if (!col.multiline || col.cartridges) {
                    this.openSuggest(el, col, (value) => {
                        this.editValue = value;
                        this.saveEdit(row, col);
                    }, row.id);
                }
            });
        },

        handleEditKeydown(event, row, col) {
            if (this.suggestKeydown(event)) {
                return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                this.saveEdit(row, col);
            } else if (event.key === "Escape") {
                event.preventDefault();
                this.cancelEdit();
            } else if (event.key === "Tab") {
                event.preventDefault();
                // Выбранная в списке подсказка – как по Enter (у картриджей выбор только дописывает
                // часть – там сохраняется набранное)
                const s = this.suggest;
                const option = s && !s.tokens && s.active >= 0 ? this.suggestShown[s.active] : null;
                if (option) {
                    this.editValue = option.value;
                }
                this.editNextCell(row, col, event.shiftKey ? -1 : 1);
            }
        },

        // Tab / Shift+Tab (этап 62, как в Excel): сохранить и править следующую ячейку строки справа /
        // слева. Пропускаются те, что правятся не полем: расположение (одно на все его столбцы),
        // «Доступ», подключения ПК – принтер, значения модели принтера, «По правилу»
        editNextCell(row, col, dir) {
            const cols = this.viewColumns;
            let next = null;
            for (let i = cols.findIndex((c) => c.field === col.field) + dir; i >= 0 && i < cols.length; i += dir) {
                const c = cols[i];
                if (c.editable && !c.location && !c.secret && !c.links && !c.fromModel && !c.virtual) {
                    next = c;
                    break;
                }
            }
            this.saveEdit(row, col);
            if (next) {
                this.startEdit(row, next);
                this.$nextTick(() => this.revealEditCell(row));
            }
        },

        // Ячейка правки за краем таблицы или под закреплёнными столбцами – прокрутить вбок к ней
        revealEditCell(row) {
            const wrap = this.$refs.tableWrap;
            const tr = this.$refs.table && this.$refs.table.querySelector('tbody tr[data-id="' + row.id + '"]');
            const td = tr && tr.querySelector("td.editing");
            if (!wrap || !td) {
                return;
            }
            // Закреплённые стоят поверх прокрутки: видимое – между ними
            let left = wrap.getBoundingClientRect().left;
            let right = left + wrap.clientWidth;
            let before = true;
            tr.querySelectorAll("td").forEach(function (cell) {
                if (cell === td) {
                    before = false;
                } else if (cell.classList.contains("sticky")) {
                    const r = cell.getBoundingClientRect();
                    if (before) {
                        left = Math.max(left, r.right);
                    } else {
                        right = Math.min(right, r.left);
                    }
                }
            });
            const r = td.getBoundingClientRect();
            if (r.left < left) {
                wrap.scrollLeft -= Math.ceil(left - r.left);
            } else if (r.right > right) {
                wrap.scrollLeft += Math.ceil(Math.min(r.right - right, r.left - left));
            }
        },

        saveEdit(row, col) {
            if (this.editingRowId !== row.id || this.editingField !== col.field) {
                return;
            }
            const oldValue = row[col.field] === null || row[col.field] === undefined ? "" : String(row[col.field]);
            // Картриджи (этап 47): в поле – через запятую, в ячейке – строками
            const newValue = col.cartridges ? splitTokens(this.editValue).join("\n") : this.editValue;
            this.editingRowId = null;
            this.editingField = null;
            this.closeSuggest();
            if (newValue === oldValue) {
                return;
            }
            this.saveCellValue(row, col, newValue);
        },

        cancelEdit() {
            this.closeSuggest();
            this.closeWebEdit();
            this.editingRowId = null;
            this.editingField = null;
        },

        onEditInput(event, col) {
            this.growEditor(event.target, col);
        },

        growEditor(el, col) {
            const td = el.closest("td");
            const minWidth = td ? td.clientWidth : 0;
            const minHeight = td ? td.clientHeight : 0;
            if (!this._measureSpan) {
                const span = document.createElement("span");
                span.style.position = "absolute";
                span.style.visibility = "hidden";
                span.style.whiteSpace = "pre";
                document.body.appendChild(span);
                this._measureSpan = span;
            }
            const span = this._measureSpan;
            const style = window.getComputedStyle(el);
            span.style.fontFamily = style.fontFamily;
            span.style.fontSize = style.fontSize;
            span.style.fontWeight = style.fontWeight;
            const padH = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
            const borderH = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
            if (col.multiline) {
                if (col.note) {
                    el.style.width = minWidth + "px";
                    el.style.height = minHeight + "px";
                    if (el.scrollHeight > el.clientHeight) {
                        el.style.height = el.scrollHeight + "px";
                    }
                } else {
                    const lines = el.value.split("\n");
                    let maxW = 0;
                    for (const line of lines) {
                        span.textContent = line || " ";
                        const w = span.getBoundingClientRect().width;
                        if (w > maxW) maxW = w;
                    }
                    const needW = Math.ceil(maxW + padH + borderH + 2);
                    el.style.width = Math.max(needW, minWidth) + "px";
                    el.style.height = minHeight + "px";
                    if (el.scrollHeight > el.clientHeight) {
                        el.style.height = el.scrollHeight + "px";
                    }
                }
            } else {
                span.textContent = el.value;
                const textW = span.getBoundingClientRect().width;
                const needW = Math.ceil(textW + padH + borderH + 2);
                el.style.width = Math.max(needW, minWidth) + "px";
                el.style.height = minHeight + "px";
            }
        },

        // Ответ – сохранилось ли (true / false). Строка принтера (этап 44) – в его таблицу.
        // sendValue – на сервер другое, чем в ячейке до ответа (связи ПК – принтер номерами, этап 45)
        async saveCellValue(row, col, value, sendValue) {
            const printer = !!row._printer;
            const pendingKey = this.rowKey(row) + ":" + col.field;
            // По ключу, а не новым объектом: иначе перерисуются все строки таблицы (этап 52)
            this.pendingCells[pendingKey] = value;
            const clearPending = () => {
                delete this.pendingCells[pendingKey];
            };
            try {
                const payload = { _version: row.version };
                payload[col.field] = sendValue === undefined ? value : sendValue;
                const response = await apiFetch((printer ? "/api/printers/" : "/api/computers/") + row.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                if (response.status === 409) {
                    clearPending();
                    this.toastError(await this.errorText(response));
                    await (printer ? this.loadPrinters() : this.loadTable());
                    return false;
                }
                if (!response.ok) {
                    clearPending();
                    this.toastError("Не удалось сохранить: " + (await this.errorText(response)));
                    return false;
                }
                const data = await response.json();
                const updated = data.updated || {};
                clearPending();
                if (printer) {
                    await this.afterPrinterSave(row, col, data);
                    return true;
                }
                const index = this.rows.findIndex((r) => r.id === row.id);
                // Новый № места был занят: соседи сдвинулись, строка встала по номеру
                if (data.shifted && data.shifted.length || (col.field === "seat_no" && data.changes && data.changes.seat_no)) {
                    await this.loadTable();
                    this.refreshCardRow();
                    this.flashCell(row.id, col.field);
                    data.shifted.forEach((id) => this.flashCell(id, "seat_no"));
                    if (data.shifted.length) {
                        this.toast("№ места занят – сдвинуты следующие: " + data.shifted.length, "success");
                    }
                    this.reloadCardHistory(row.id);
                    return true;
                }
                // Имя ПК и его принтеры видны и в таблице принтеров (этап 44)
                if (col.field === "printers" || col.field === "hostname") {
                    this.loadPrinters();
                }
                if (index !== -1) {
                    Object.assign(this.rows[index], updated);
                    if (refreshDuplicates(this.rows, this.builtinColumns, "pc")) {
                        this.dupVersion++;
                    }
                    this.recalcWidths();
                    this.flashCell(row.id, col.field);
                }
                this.reloadCardHistory(row.id);
                return true;
            } catch (e) {
                clearPending();
                this.toastError("Не удалось сохранить: " + e);
                return false;
            }
        },
    }
};
