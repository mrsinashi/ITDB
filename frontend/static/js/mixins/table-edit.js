// Таблица: правка ячейки – поле правки, Enter / Esc, сохранение (этап 55 – из table.js).
// Особые столбцы открывают своё: выбор узла, окошко «Доступа», подключения ПК – принтер

import { apiFetch, fullIps } from "../util.js";
import { refreshDuplicates } from "../columns.js";
import { splitTokens } from "./cartridges.js";

// Поля-адреса: IP у ПК и принтера, адрес журнала «IP»
const IP_FIELDS = ["ip", "ip_addr"];

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
            // Журнал «IP» (этап 71): у каждой строки своё (описание – у всех, остальное – у записей)
            if (row._ip) {
                if (!this.ipCellEditable(row, col)) {
                    return;
                }
            } else if (col.links) {
                // Принтеры ПК, ПК принтера – окошко с поиском и галочками
                this.cancelEdit();
                this.openLinkPick(row, col, td);
                return;
            }
            // Тип, производитель, печать, дуплекс принтера – из модели: сказать, где меняются
            if (this.canEdit && col.fromModel) {
                this.toast("Меняется в справочнике моделей");
                return;
            }
            // Журнал (этап 66): запись правится в своём окне – двойной клик по любой ячейке открывает
            // его с фокусом на этом поле (правки 2: в ячейке журнал больше не правится)
            if (row._move) {
                this.cancelEdit();
                this.openMoveRecord(row, col.field);
                return;
            }
            if (!row._ip && (!this.canEdit || !(col.editable || col.location))) {
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
            this.editValue = this.cellEditValue(row, col);
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
                if (!col.multiline || col.cartridges || col.ipCol) {
                    this.openSuggest(el, col, (value) => {
                        this.editValue = value;
                        this.saveEdit(row, col, true);
                    }, row._ip ? null : row.id);
                }
            });
        },

        handleEditKeydown(event, row, col) {
            if (this.suggestKeydown(event)) {
                return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                this.saveEdit(row, col, true);
            } else if (event.key === "Escape") {
                event.preventDefault();
                this.cancelEdit();
                // Журнал «IP» (этап 71): Esc в пустом адресе строки «Добавить» убирает её; в строке, где
                // ничего не вписано, – в любом столбце (этап 74); с адресом из поиска (этап 72) – тоже:
                // пока ничего не сохранено
                if (row._draft && (row.prefillIp || this.ipDraftEmpty(row) || (col.field === "ip_addr" && !row.form.ip_addr))) {
                    this.dropIpDraft();
                }
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
                if (c.editable && !c.location && !c.secret && !c.links && !c.fromModel && !c.virtual && (!row._ip || this.ipCellEditable(row, c))) {
                    next = c;
                    break;
                }
            }
            this.saveEdit(row, col, true);
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

        // Что в поле правки ячейки (у журнала «IP» – своё значение строки, не все строки ячейки)
        cellEditValue(row, col) {
            if (row._ip) {
                return this.ipEditValue(row, col);
            }
            return row[col.field] === null || row[col.field] === undefined ? "" : String(row[col.field]);
        },

        // commit – Enter, Tab, выбор подсказки (иначе – ушли из поля)
        saveEdit(row, col, commit) {
            if (this.editingRowId !== row.id || this.editingField !== col.field) {
                return;
            }
            const oldValue = this.cellEditValue(row, col);
            // Картриджи (этап 47): в поле – через запятую, в ячейке – строками
            const newValue = col.cartridges ? splitTokens(this.editValue).join("\n") : this.editValue;
            this.editingRowId = null;
            this.editingField = null;
            this.closeSuggest();
            // Строка «Добавить» журнала «IP» с адресом из поиска (этап 72): ничего не вписали – запись
            // только по Enter / Tab (и с пустым полем); ушли из поля – адрес из поиска снимается
            if (row._draft && row.prefillIp && (newValue === oldValue || (col.field === "ip_addr" && newValue === row.prefillIp))) {
                if (!commit) {
                    this.dropIpPrefill(row);
                    return;
                }
                this.saveCellValue(row, col, newValue);
                return;
            }
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
            // IP коротко (этап 72): «24.46» – 192.168.24.46 (ячейка, карточки ПК и принтера, журнал «IP»)
            if (IP_FIELDS.indexOf(col.field) !== -1 && typeof value === "string") {
                value = fullIps(value);
            }
            // Журнал «IP» (этап 71) – своя правка (mixins/ips.js)
            if (row._ip) {
                return this.saveIpCell(row, col, value);
            }
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
