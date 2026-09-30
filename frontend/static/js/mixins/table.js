// Таблица: загрузка, правка ячеек, сортировка, ширина и видимость столбцов, поиск, выделение строк, Alt+клик.

import { apiFetch, loadJson, saveJson, searchNorm, searchWords } from "../util.js";
import { DEFAULT_HIDDEN_SEEN_KEY, HIDDEN_COLUMNS_KEY, SEARCH_HIDDEN_KEY, columnTitle, toColumnDef, compareCellValues, frameColorFor, hasDuplicateValue, isOverdue, OVERDUE_STYLE, refreshDuplicates, styleKey } from "../columns.js";
import { TABLE_WIDTHS_KEY, computeAutoWidths } from "../widths.js";

export default {
    computed: {
        // Пользовательские поля для таблицы (без старых с занятым ключом)
        tableFieldDefs() {
            return this.fieldDefs.filter(function (fd) {
                return !fd.reserved;
            });
        },

        // Все столбцы (и скрытые) — для меню «Столбцы»
        allColumns() {
            const self = this;
            const base = this.builtinColumns.map(function (col) {
                const manual = self.manualWidths[col.field];
                const auto = self.autoWidths[col.field];
                return Object.assign({}, col, {
                    width: manual !== undefined ? manual : (auto || 100)
                });
            });
            const extra = self.tableFieldDefs.map(function (fd) {
                const manual = self.manualWidths[fd.key];
                const auto = self.autoWidths[fd.key];
                return {
                    field: fd.key,
                    headerName: fd.label,
                    editable: true,
                    suggest: true,
                    width: manual !== undefined ? manual : (auto || 100),
                    extra: true
                };
            });
            const statusIndex = base.findIndex(function (c) { return c.field === "status"; });
            if (statusIndex >= 0) {
                return base.slice(0, statusIndex).concat(extra).concat(base.slice(statusIndex));
            }
            return base.concat(extra);
        },

        // Видимые столбцы
        columns() {
            const hidden = this.hiddenColumns;
            return this.allColumns.filter(function (col) {
                return hidden.indexOf(col.field) === -1;
            });
        },

        hiddenColumnCount() {
            return this.allColumns.length - this.columns.length;
        },

        hasManualWidths() {
            return Object.keys(this.manualWidths).length > 0;
        },

        countText() {
            const total = this.showArchive ? "В архиве: " : "Всего: ";
            if (this.displayedCount === this.rowCount) {
                return total + this.rowCount;
            }
            return "Показано: " + this.displayedCount + " из " + this.rowCount + (this.showArchive ? " в архиве" : "");
        },

        // В this.rows — все ПК, и рабочие, и из архива (признак archived)
        activeRows() {
            return this.rows.filter(function (row) { return !row.archived; });
        },

        // Строки текущего режима таблицы: рабочие или архив
        modeRows() {
            const archive = this.showArchive;
            return this.rows.filter(function (row) { return !!row.archived === archive; });
        },

        rowCount() {
            return this.modeRows.length;
        },

        selectedSet() {
            return new Set(this.selectedRows);
        },

        // Заливка ячеек (фон из Справочников или красный дубля) — для линий сетки:
        // Map id строки → { поле: цвет }. Строки без заливки в карту не входят.
        cellFills() {
            void this.dupVersion; // дубли считаются вне Vue — зависимость вручную
            const map = new Map();
            const cols = this.columns;
            this.displayRows.forEach((row) => {
                let fills = null;
                cols.forEach((col) => {
                    const f = this.cellFillOf(row, col);
                    if (f) {
                        (fills || (fills = {}))[col.field] = f;
                    }
                });
                if (fills) {
                    map.set(row.id, fills);
                }
            });
            return map;
        },

        // Соседи ячейки: следующая строка и следующий столбец
        nextRowId() {
            const next = {};
            const rows = this.displayRows;
            for (let i = 0; i + 1 < rows.length; i++) {
                next[rows[i].id] = rows[i + 1].id;
            }
            return next;
        },

        nextColField() {
            const next = {};
            const cols = this.columns;
            for (let i = 0; i + 1 < cols.length; i++) {
                next[cols[i].field] = cols[i + 1].field;
            }
            return next;
        },

        totalWidth() {
            const base = this.columns.reduce(function (sum, col) {
                return sum + col.width;
            }, 0);
            return base;
        },

        // Фильтр по дереву, фильтры по столбцам (mixins/col-filters.js), поиск
        filteredRows() {
            return this.searchRows(this.applyColFilters(this.locationRows, null));
        },

        displayRows() {
            const rows = this.filteredRows;
            if (!this.sortField || !this.sortDir) {
                return rows;
            }
            const field = this.sortField;
            const sortCol = this.allColumns.find(function (c) { return c.field === field; });
            const dir = this.sortDir === "asc" ? 1 : -1;
            return rows.slice().sort(function (a, b) {
                return compareCellValues(a[field], b[field], sortCol) * dir;
            });
        },

        displayedCount() {
          return this.displayRows.length;
        },

        lastStickyField() {
          let last = null;
          for (const col of this.columns) {
            if (col.sticky) {
              last = col.field;
            }
          }
          return last;
        },
    },

    watch: {
        searchHidden(value) {
            saveJson(SEARCH_HIDDEN_KEY, value);
        },

        // Сняли выделение — меню действий больше не нужно
        "selectedRows.length"(count) {
            if (count === 0 && this.openMenu === "selection") {
                this.closeMenus();
            }
        },

        // Vue перерисовал класс строки — вернуть ей подсветку под курсором
        selectedRows() {
            this.$nextTick(() => {
                if (this.hoverRowEl) {
                    this.hoverRowEl.classList.add("row-hover");
                }
            });
        },

        hiddenColumns() {
            saveJson(HIDDEN_COLUMNS_KEY, this.hiddenColumns);
            this.$nextTick(() => {
                this.updateStickyShadow();
            });
        },
    },

    methods: {
        // ---------- Таблица ----------

        // Описание встроенных столбцов (с сервера): таблица, карточка, История
        async loadColumns() {
            try {
                const response = await apiFetch("/api/columns");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                this.builtinColumns = (data.columns || []).map(toColumnDef);
                this.cardGroups = data.card_groups || [];
                this.historyLabels = data.history_labels || {};
                this.applyDefaultHidden();
            } catch (e) {
                this.tableError = String(e.message || e);
            }
        },

        // Столбцы, скрытые по умолчанию, прячутся один раз: показанный
        // пользователем столбец при следующей загрузке не скрывается снова
        applyDefaultHidden() {
            const seen = loadJson(DEFAULT_HIDDEN_SEEN_KEY, []);
            const fresh = this.builtinColumns.filter(function (col) {
                return col.hiddenByDefault && seen.indexOf(col.field) === -1;
            }).map(function (col) { return col.field; });
            if (!fresh.length) {
                return;
            }
            this.hiddenColumns = this.hiddenColumns.concat(fresh.filter((field) => {
                return this.hiddenColumns.indexOf(field) === -1;
            }));
            saveJson(DEFAULT_HIDDEN_SEEN_KEY, seen.concat(fresh));
        },

        async loadTable() {
            this.tableLoading = true;
            this.startLoading();
            this.tableError = "";
            try {
                const response = await apiFetch("/api/computers?archived=all");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                this.rows = data.rows || [];
                refreshDuplicates(this.rows, this.builtinColumns);
                this.dupVersion++;
                this.recalcWidths();
            } catch (e) {
                this.tableError = String(e.message || e);
            }
            this.finishLoading();
            this.tableLoading = false;
        },

        sortBy(col) {
            if (this.sortField !== col.field) {
                this.sortField = col.field;
                this.sortDir = "asc";
            } else if (this.sortDir === "asc") {
                this.sortDir = "desc";
            } else {
                this.sortField = null;
                this.sortDir = null;
            }
        },

        resetSort() {
            this.sortField = null;
            this.sortDir = null;
        },

        startResize(event, col) {
            const startX = event.clientX;
            const startWidth = col.width;
            const tableEl = this.$refs.table;
            if (!tableEl) {
                return;
            }
            const colEl = tableEl.querySelector('col[data-field="' + col.field + '"]');
            if (!colEl) {
                return;
            }
            const startTotal = this.totalWidth;

            function onMouseMove(e) {
                const delta = e.clientX - startX;
                let newWidth = startWidth + delta;
                if (newWidth < 40) {
                    newWidth = 40;
                }
                const appliedDelta = newWidth - startWidth;
                colEl.style.width = newWidth + "px";
                tableEl.style.width = (startTotal + appliedDelta) + "px";
            }

            const self = this;
            function onMouseUp(e) {
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                const delta = e.clientX - startX;
                let newWidth = startWidth + delta;
                if (newWidth < 40) {
                    newWidth = 40;
                }
                self.setColumnWidth(col.field, Math.round(newWidth));
            }

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        },

        setColumnWidth(field, width) {
            const updated = Object.assign({}, this.manualWidths);
            updated[field] = width;
            this.manualWidths = updated;
            this.saveWidths();
            this.updateStickyShadow();
        },

        saveWidths() {
            try {
                localStorage.setItem(TABLE_WIDTHS_KEY, JSON.stringify(this.manualWidths));
            } catch (e) {
                // ignore
            }
        },

        resetWidths() {
            this.manualWidths = {};
            this.saveWidths();
            this.recalcWidths();
        },

        recalcWidths() {
            this.autoWidths = computeAutoWidths(this.rows, this.builtinColumns, this.tableFieldDefs, this.choiceStyleMap, this.columnStyles);
            this.$nextTick(() => {
                this.updateStickyShadow();
            });
        },

        cellClass(row, col) {
            const cls = {
                center: col.center,
                link: col.link,
                sticky: col.sticky
            };
            if (col.note) {
                cls["note-cell"] = true;
            }
            if (col.field === this.lastStickyField) {
                cls["sticky-edge"] = true;
            }
            if (!row.archived && col.dup && hasDuplicateValue(row[col.field], col.field)) {
                cls["dup-red"] = true;
            }
            if (this.isEditing(row, col)) {
                cls["editing"] = true;
            }
            if (this.savedFlash[row.id + ":" + col.field]) {
                cls["cell-saved"] = true;
            }
            return cls;
        },

        cellTextStyle(row, col) {
            const style = {};
            const colStyle = this.columnStyles[col.field];
            if (colStyle && colStyle.color) {
                style.color = colStyle.color;
            }
            const fieldStyles = this.choiceStyleMap[col.field];
            if (fieldStyles) {
                const value = row[col.field];
                if (value !== null && value !== undefined && value !== "") {
                    const lines = String(value).split("\n");
                    for (const line of lines) {
                        const s = fieldStyles[styleKey(col.field, line)];
                        if (s && s.color) {
                            style.color = s.color;
                            break;
                        }
                    }
                }
            }
            return Object.keys(style).length ? style : null;
        },

        // Цвет заливки ячейки: дубль — красный, иначе фон значения из
        // Справочников поверх фона столбца; null — без заливки
        cellFillOf(row, col) {
            if (!row.archived && col.dup && hasDuplicateValue(row[col.field], col.field)) {
                return "var(--dup-bg)";
            }
            let fill = null;
            const colStyle = this.columnStyles[col.field];
            if (colStyle && colStyle.bg_color) {
                fill = colStyle.bg_color;
            }
            const fieldStyles = this.choiceStyleMap[col.field];
            const value = row[col.field];
            if (fieldStyles && value !== null && value !== undefined && value !== "") {
                for (const line of String(value).split("\n")) {
                    const s = fieldStyles[styleKey(col.field, line)];
                    if (s) {
                        if (s.bg_color) {
                            fill = s.bg_color;
                        }
                        break;
                    }
                }
            }
            return fill;
        },

        cellTdStyle(row, col) {
            const style = {};
            // Сначала оформление столбца, поверх — оформление значения
            const colStyle = this.columnStyles[col.field];
            if (colStyle) {
                if (colStyle.bg_color) style.backgroundColor = colStyle.bg_color;
                if (colStyle.bold) style.fontWeight = "700";
                if (colStyle.italic) style.fontStyle = "italic";
            }
            const fieldStyles = this.choiceStyleMap[col.field];
            if (fieldStyles) {
                const value = row[col.field];
                if (value !== null && value !== undefined && value !== "") {
                    const lines = String(value).split("\n");
                    for (const line of lines) {
                        const s = fieldStyles[styleKey(col.field, line)];
                        if (s) {
                            if (s.bg_color) style.backgroundColor = s.bg_color;
                            if (s.bold) style.fontWeight = "700";
                            if (s.italic) style.fontStyle = "italic";
                            break;
                        }
                    }
                }
            }
            if (col.bold) {
                style.fontWeight = "700";
            }
            if (col.sticky) {
                style.left = this.stickyLeft(col) + "px";
            }
            // Заливка — как в Excel: фон идёт поверх линий сетки. У каждой
            // ячейки свои линии справа и снизу; такая линия берёт цвет соседа
            // справа/снизу, если он залит (правый и нижний перекрывают левый
            // и верхний), иначе — своей заливки. Серая линия у залитых не видна.
            // Синий слой выбранной строки подмешивается к цвету линии
            // (--self-a — своя строка, --below-a — строка ниже).
            const fills = this.cellFills;
            const own = (fills.get(row.id) || {})[col.field];
            const right = (fills.get(row.id) || {})[this.nextColField[col.field]];
            const below = (fills.get(this.nextRowId[row.id]) || {})[col.field];
            if (own) {
                style.backgroundColor = own;
            }
            const mix = function (color, amount) {
                return "color-mix(in srgb, var(--sel-base) " + amount + ", " + color + ")";
            };
            if (right || own) {
                style["--v-line"] = mix(right || own, "var(--self-a)");
            }
            // Рамка ячейки под курсором — в тон заливки (заливка темнее), а не
            // бежевая: у самой ячейки и у соседа слева, который рисует её левую линию
            const ownFrame = own && frameColorFor(own);
            const rightFrame = right && frameColorFor(right);
            if (ownFrame) {
                style["--hf"] = ownFrame;
            }
            if (rightFrame) {
                style["--hf-right"] = rightFrame;
            }
            if (below) {
                style["--h-line"] = mix(below, "var(--below-a)");
            } else if (own) {
                style["--h-line"] = mix(own, "var(--self-a)");
            }
            return Object.keys(style).length ? style : null;
        },

        // Пока значение сохраняется, в ячейке уже новое (приглушённое),
        // а не старое — без мигания «старое → новое».
        cellText(row, col) {
            const key = row.id + ":" + col.field;
            if (Object.prototype.hasOwnProperty.call(this.pendingCells, key)) {
                return this.pendingCells[key];
            }
            return row[col.field];
        },

        isPending(row, col) {
            return Object.prototype.hasOwnProperty.call(this.pendingCells, row.id + ":" + col.field);
        },

        cellSpanStyle(row, col) {
            let base = this.cellTextStyle(row, col) || {};
            if (col.date && isOverdue(this.cellText(row, col))) {
                base = Object.assign({}, base, OVERDUE_STYLE);
            }
            if (this.isEditing(row, col)) {
                return Object.assign({}, base, { visibility: "hidden" });
            }
            return base;
        },

        stickyLeft(col) {
            let left = 0;
            for (const c of this.columns) {
                if (c.field === col.field) {
                    break;
                }
                if (c.sticky) {
                    left += c.width;
                }
            }
            return left;
        },

        handleNoteEnter(event, row, col) {
            if (!col.note) {
                return;
            }
            if (this.isEditing(row, col)) {
                return;
            }
            const td = event.currentTarget;
            const span = td.querySelector(".note-text");
            if (!span) {
                return;
            }
            if (span.scrollWidth > span.clientWidth) {
                const rect = td.getBoundingClientRect();
                this.noteTooltip = {
                    visible: true,
                    text: row.note || "",
                    top: rect.top - 1,
                    left: rect.left - 1,
                    width: rect.width + 1
                };
            }
        },

        hideNoteTooltip() {
            this.noteTooltip.visible = false;
        },

                isEditing(row, col) {
            return this.editingRowId === row.id && this.editingField === col.field;
        },

        startEdit(row, col) {
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
            this.$nextTick(() => {
                const ref = this.$refs["edit-" + row.id + "-" + col.field];
                const el = Array.isArray(ref) ? ref[0] : ref;
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
                if (!col.multiline) {
                    this.openSuggest(el, col, (value) => {
                        this.editValue = value;
                        this.saveEdit(row, col);
                    });
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
            }
        },

        saveEdit(row, col) {
            if (this.editingRowId !== row.id || this.editingField !== col.field) {
                return;
            }
            const oldValue = row[col.field] === null || row[col.field] === undefined ? "" : String(row[col.field]);
            const newValue = this.editValue;
            this.editingRowId = null;
            this.editingField = null;
            this.closeSuggest();
            if (newValue === oldValue) {
                return;
            }
            this.saveCellValue(row, col, newValue);
        },

        // ---------- Выпадающие меню панели (одно открыто за раз) ----------

        toggleMenu(name) {
            if (this.openMenu === name) {
                this.closeMenus();
                return;
            }
            this.openMenu = name;
            this.$nextTick(() => {
                document.addEventListener("click", this.onDocClickCloseMenu, true);
                document.addEventListener("keydown", this.onEscCloseMenu, true);
            });
        },

        closeMenus() {
            this.openMenu = null;
            this.removeMenuCloseListeners();
        },

        onDocClickCloseMenu(event) {
            // $el у корня с несколькими элементами — текстовый узел, поэтому ref
            const refs = {
                selection: this.$refs.selectionWrap,
                columns: this.$refs.columnsWrap,
                treeAdd: this.$refs.treeAddWrap,
                treeAddSide: this.$refs.treeAddSideWrap,
                add: this.$refs.addWrap,
                export: this.$refs.exportWrap,
                settings: this.$refs.settingsWrap,
                user: this.$refs.userWrap,
                page: this.$refs.pageSetWrap,
                historySel: this.$refs.historySelWrap,
                historyFilter: this.$refs.historyFilterWrap,
                colFilter: this.$refs.colFilterPanel,
                colFilterList: this.$refs.colFilterListWrap
            };
            // Клик по воронке в шапке решает сам: та же — закрыть, другая — открыть её
            if (this.openMenu === "colFilter" && event.target.closest(".th-filter")) {
                return;
            }
            const wrap = refs[this.openMenu];
            if (!wrap || !wrap.contains(event.target)) {
                this.closeMenus();
            }
        },

        onEscCloseMenu(event) {
            if (event.key === "Escape" && this.openMenu) {
                event.stopPropagation();
                this.closeMenus();
            }
        },

        removeMenuCloseListeners() {
            document.removeEventListener("click", this.onDocClickCloseMenu, true);
            document.removeEventListener("keydown", this.onEscCloseMenu, true);
        },

        // ---------- Видимость столбцов ----------

        colTitle(col) {
            return columnTitle(col);
        },

        isColumnHidden(field) {
            return this.hiddenColumns.indexOf(field) !== -1;
        },

        toggleColumn(field) {
            if (this.isColumnHidden(field)) {
                this.hiddenColumns = this.hiddenColumns.filter(function (f) { return f !== field; });
            } else {
                this.hiddenColumns = this.hiddenColumns.concat([field]);
            }
            if (this.sortField === field && this.isColumnHidden(field)) {
                this.resetSort();
            }
        },

        showAllColumns() {
            this.hiddenColumns = [];
        },

        // ---------- Поиск ----------

        // Строки, в которых нашлись все слова поиска по базе
        searchRows(rows) {
            const words = searchWords(this.quickFilter);
            if (!words.length) {
                return rows;
            }
            const fields = (this.searchHidden ? this.allColumns : this.columns).map(function (col) {
                return col.field;
            });
            // Число среди нескольких слов («хир орд 3») ищется целиком: это № места,
            // № кабинета или отдельное число внутри текста («Win 10»). Иначе «3»
            // находилось бы в каждом IP 10.0.3.x, в этаже, в кабинете 301.
            // Одно слово — как раньше, кусок где угодно (часть ИНВ, IP).
            const whole = words.length > 1;
            return rows.filter(function (row) {
                const texts = [];
                fields.forEach(function (field) {
                    const value = row[field];
                    if (value !== null && value !== undefined && value !== "") {
                        texts.push({ field: field, text: searchNorm(value) });
                    }
                });
                return words.every(function (w) {
                    if (whole && /^\d+$/.test(w)) {
                        return texts.some(function (t) {
                            if (t.field === "seat_no" || t.field === "room_code") {
                                return t.text.trim() === w;
                            }
                            return /\s/.test(t.text.trim()) && t.text.split(/[\s,;]+/).indexOf(w) !== -1;
                        });
                    }
                    return texts.some(function (t) { return t.text.indexOf(w) !== -1; });
                });
            });
        },

        // Esc в поле поиска: сначала очищает, второй раз — убирает фокус
        onSearchEsc(event, prop) {
            if (this[prop]) {
                this[prop] = "";
            } else {
                event.target.blur();
            }
        },

        clearLocationFilter() {
            this.locationFilter = null;
        },

        cancelEdit() {
            this.closeSuggest();
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

        async saveCellValue(row, col, value) {
            const pendingKey = row.id + ":" + col.field;
            this.pendingCells = Object.assign({}, this.pendingCells, { [pendingKey]: value });
            const clearPending = () => {
                const next = Object.assign({}, this.pendingCells);
                delete next[pendingKey];
                this.pendingCells = next;
            };
            try {
                const payload = { _version: row.version };
                payload[col.field] = value;
                const response = await apiFetch("/api/computers/" + row.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                if (response.status === 409) {
                    clearPending();
                    this.toastError(await this.errorText(response));
                    await this.loadTable();
                    return;
                }
                if (!response.ok) {
                    clearPending();
                    this.toastError("Не удалось сохранить: " + (await this.errorText(response)));
                    return;
                }
                const data = await response.json();
                const updated = data.updated || {};
                const index = this.rows.findIndex((r) => r.id === row.id);
                clearPending();
                // Новый № места был занят: соседи сдвинулись, строка встала по номеру
                if (data.shifted && data.shifted.length || (col.field === "seat_no" && data.changes && data.changes.seat_no)) {
                    await this.loadTable();
                    this.refreshCardRow();
                    this.flashCell(row.id, col.field);
                    data.shifted.forEach((id) => this.flashCell(id, "seat_no"));
                    if (data.shifted.length) {
                        this.toast("№ места занят — сдвинуты следующие: " + data.shifted.length, "success");
                    }
                    this.reloadCardHistory(row.id);
                    return;
                }
                if (index !== -1) {
                    Object.assign(this.rows[index], updated);
                    refreshDuplicates(this.rows, this.builtinColumns);
                this.dupVersion++;
                    this.recalcWidths();
                    this.flashCell(row.id, col.field);
                }
                this.reloadCardHistory(row.id);
            } catch (e) {
                clearPending();
                this.toastError("Не удалось сохранить: " + e);
            }
        },

        onTableScroll() {
            this.hideNoteTooltip();
            if (this.rafId) {
                cancelAnimationFrame(this.rafId);
            }
            this.rafId = requestAnimationFrame(() => {
                this.rafId = null;
                this.updateStickyShadow();
                this.refreshHoverFromPoint();
                if (this.copyHint) {
                    this.updateCopyHint();
                }
            });
        },

        updateStickyShadow() {
            const wrap = this.$refs.tableWrap;
            if (!wrap) {
                return;
            }
            // HOSTNAME прилипает, когда уезжают все столбцы перед ним.
            let threshold = 0;
            for (const col of this.columns) {
                if (col.sticky) {
                    break;
                }
                threshold += col.width;
            }
            const scrollLeft = wrap.scrollLeft;
            this.stickyStuck = scrollLeft >= threshold;
        },
        
        onTableMouseMove(event) {
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
            if (this.altDown !== event.altKey) {
                this.altDown = event.altKey;
            }
            if (this.altDown || this.copyHint) {
                this.updateCopyHint();
            }
            const tr = event.target.closest("tbody tr");
            this.setHoverRow(tr);
        },
        
        onTableMouseLeave() {
            this.lastMouseX = undefined;
            this.lastMouseY = undefined;
            this.copyHint = null;
            this.setHoverRow(null);
        },
        
        refreshHoverFromPoint() {
            if (this.lastMouseX === undefined || this.lastMouseY === undefined) {
                return;
            }
            const el = document.elementFromPoint(this.lastMouseX, this.lastMouseY);
            const tr = el ? el.closest("tbody tr") : null;
            this.setHoverRow(tr);
        },
        
        setHoverRow(tr) {
        // Открыта карточка — подсвечена её строка, куда бы ни ушёл курсор
        if (this.card) {
            const wrap = this.$refs.tableWrap;
            tr = wrap ? wrap.querySelector('tbody tr[data-id="' + this.card.id + '"]') : null;
        }
        if (this.hoverRowEl && this.hoverRowEl !== tr) {
            this.hoverRowEl.classList.remove("row-hover");
        }
        if (tr) {
            tr.classList.add("row-hover"); // Vue мог сбросить класс, перерисовав строку
        }
            this.hoverRowEl = tr || null;
        },

        // Нажатие мыши. С Ctrl / Shift / Alt браузер не должен выделять текст
        // (Shift+клик — от прошлого места до курсора, в Firefox Ctrl+клик
        // выделяет ячейки таблицы). Внутри открытого редактора — как обычно.
        // Обычное нажатие строку не выделяет, но запоминает её: следующий
        // Shift+клик выделит строки от неё. Ctrl — выделение протягиванием.
        onCellMouseDown(event, row) {
            if (event.button !== 0 || event.target.closest(".cell-edit, .loc-pick")) {
                return;
            }
            const ctrl = event.ctrlKey || event.metaKey;
            if (ctrl || event.shiftKey || event.altKey) {
                event.preventDefault();
            }
            if (event.altKey || event.shiftKey) {
                return;
            }
            this.selectAnchorId = row.id;
            if (ctrl) {
                this.startDragSelect(row);
            }
        },

        // Клик по ячейке: Alt — копировать значение под курсором,
        // Shift — выделение диапазона, обычный клик по HOSTNAME — карточка.
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
            if (col.field === "hostname") {
                // Протянули мышью, чтобы выделить кусок имени, — карточку не открываем
                const sel = window.getSelection ? String(window.getSelection()) : "";
                if (!sel) {
                    this.openCard(row);
                }
            }
        },

        // ---------- Выделение строк (как в Проводнике) ----------
        // Ctrl+клик — добавить/убрать строку, Ctrl+протягивание — добавить/убрать
        // строки по пути; Shift+клик — строки от прошлой (выбранной или просто
        // нажатой) до этой вместо прежнего выделения; Ctrl+Shift+клик — добавить их.

        // Ctrl+нажатие: строка выделяется (или снимается), дальше — протягивание.
        // Что делать со строками по пути, решает первая: была выбрана — снимаем.
        startDragSelect(row) {
            const drag = {
                startId: row.id,
                add: !this.selectedSet.has(row.id),
                base: this.selectedRows.slice(),
                x: 0,
                y: 0,
                raf: null
            };
            this._drag = drag;
            this.applyDragSelect(row.id);
            const onMove = (e) => {
                drag.x = e.clientX;
                drag.y = e.clientY;
                this.dragSelectAtPointer();
                this.dragAutoScroll();
            };
            const onUp = () => {
                document.removeEventListener("mousemove", onMove, true);
                document.removeEventListener("mouseup", onUp, true);
                if (drag.raf) {
                    cancelAnimationFrame(drag.raf);
                }
                this._drag = null;
            };
            document.addEventListener("mousemove", onMove, true);
            document.addEventListener("mouseup", onUp, true);
        },

        applyDragSelect(currentId) {
            const drag = this._drag;
            const ids = this.displayRows.map(function (r) { return r.id; });
            const a = ids.indexOf(drag.startId);
            const b = ids.indexOf(currentId);
            if (a === -1 || b === -1) {
                return;
            }
            const range = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
            if (drag.add) {
                const base = new Set(drag.base);
                this.selectedRows = drag.base.concat(Array.from(range).filter(function (id) { return !base.has(id); }));
            } else {
                this.selectedRows = drag.base.filter(function (id) { return !range.has(id); });
            }
        },

        // Строка под курсором во время протягивания (по высоте — даже если
        // курсор ушёл левее или правее таблицы)
        dragSelectAtPointer() {
            const drag = this._drag;
            const wrap = this.$refs.tableWrap;
            if (!drag || !wrap) {
                return;
            }
            const box = wrap.getBoundingClientRect();
            const x = Math.min(Math.max(drag.x, box.left + 1), box.right - 20);
            const y = Math.min(Math.max(drag.y, box.top + 1), box.bottom - 2);
            const el = document.elementFromPoint(x, y);
            const tr = el ? el.closest(".data-table tbody tr") : null;
            if (tr && tr.dataset.id) {
                this.applyDragSelect(Number(tr.dataset.id));
            }
        },

        // У верхнего/нижнего края таблицы — прокрутка, пока держат мышь
        dragAutoScroll() {
            const drag = this._drag;
            const wrap = this.$refs.tableWrap;
            if (!drag || !wrap || drag.raf) {
                return;
            }
            const step = () => {
                drag.raf = null;
                if (this._drag !== drag) {
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
                    this.dragSelectAtPointer();
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
                const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
                if (ctrl) {
                    const have = this.selectedSet;
                    this.selectedRows = this.selectedRows.concat(range.filter(function (id) { return !have.has(id); }));
                } else {
                    this.selectedRows = range;
                }
                return;
            }
            const index = this.selectedRows.indexOf(row.id);
            if (index === -1) {
                this.selectedRows.push(row.id);
            } else if (!shift) {
                this.selectedRows.splice(index, 1);
            }
            this.selectAnchorId = row.id;
        },

        // Ctrl+A — все видимые строки (с учётом поиска и фильтра по дереву)
        selectAllVisible() {
            this.selectedRows = this.displayRows.map(function (r) { return r.id; });
            if (this.selectedRows.length) {
                this.selectAnchorId = this.selectedRows[0];
            }
        },

        clearSelection() {
            this.selectedRows = [];
            this.selectAnchorId = null;
            this.closeMenus();
        },

        // ---------- Alt+клик: копирование ----------
        // В многострочной ячейке (несколько IP, MAC, дисков) копируется та
        // строка значения, над которой курсор; в остальных — значение целиком.
        // Пока Alt зажат, это значение подсвечено (copyHint).

        // Что скопирует клик в точке (x, y): { text, rect } или null
        copyTargetAt(x, y) {
            const el = document.elementFromPoint(x, y);
            const td = el ? el.closest(".data-table tbody td") : null;
            if (!td || td.classList.contains("editing")) {
                return null;
            }
            const tr = td.parentElement;
            const col = this.columns[td.cellIndex];
            const id = Number(tr.dataset.id);
            const row = this.displayRows.find(function (r) { return r.id === id; });
            if (!col || !row) {
                return null;
            }
            const value = row[col.field];
            if (value === null || value === undefined || String(value).trim() === "") {
                return null;
            }
            const text = String(value);
            const span = td.querySelector("span");
            const node = span ? span.firstChild : null;
            const tdRect = td.getBoundingClientRect();
            if (!node || node.nodeType !== 3 || node.data !== text) {
                return { text: text.trim(), rect: { top: tdRect.top, bottom: tdRect.bottom, left: tdRect.left, right: tdRect.right, cellRight: tdRect.right } };
            }
            const range = document.createRange();
            const clip = function (rect) {
                // Обрезанное многоточием примечание — не шире ячейки
                const left = Math.max(rect.left, tdRect.left + 2);
                const right = Math.min(rect.right, tdRect.right - 2);
                return { top: rect.top, bottom: rect.bottom, left: left, right: right, cellRight: tdRect.right };
            };
            const lines = text.split("\n");
            if (lines.length < 2 || col.note) {
                range.selectNodeContents(node);
                return { text: text.trim(), rect: clip(range.getBoundingClientRect()) };
            }
            // Для каждой строки значения — её прямоугольник на экране;
            // берём ту, что под курсором (или ближайшую по высоте).
            let best = null;
            let bestDist = Infinity;
            let offset = 0;
            lines.forEach(function (line) {
                const start = offset;
                offset += line.length + 1;
                if (!line.trim()) {
                    return;
                }
                range.setStart(node, start);
                range.setEnd(node, start + line.length);
                const rect = range.getBoundingClientRect();
                if (!rect.height) {
                    return;
                }
                const dist = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
                if (dist < bestDist) {
                    bestDist = dist;
                    best = { text: line.trim(), rect: clip(rect) };
                }
            });
            return best;
        },

        copyCellValue(event) {
            const target = this.copyTargetAt(event.clientX, event.clientY);
            if (!target) {
                return;
            }
            this.copyText(target.text);
            if (this.copyHint) {
                this.copyHint.done = true;
            }
        },

        // Подсветка под курсором при зажатом Alt
        updateCopyHint() {
            if (!this.altDown || this.lastMouseX === undefined) {
                this.copyHint = null;
                return;
            }
            const target = this.copyTargetAt(this.lastMouseX, this.lastMouseY);
            if (!target) {
                this.copyHint = null;
                return;
            }
            const r = target.rect;
            const hint = {
                text: target.text,
                top: Math.round(r.top) - 1,
                left: Math.round(r.left) - 3,
                width: Math.round(r.right - r.left) + 6,
                height: Math.round(r.bottom - r.top) + 2,
                done: false
            };
            const old = this.copyHint;
            if (old && old.text === hint.text && old.top === hint.top && old.left === hint.left) {
                return; // то же значение — не сбрасывать зелёный «скопировано»
            }
            this.copyHint = hint;
        },

        // Второй щелчок двойного клика по HOSTNAME приходится уже на фон
        // открывшейся карточки — он не должен её закрывать
        onCardOverlayClick(event) {
            if (event.detail > 1) {
                return;
            }
            this.closeCard();
        },
    }
};
