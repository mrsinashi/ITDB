// Таблица: загрузка, вид ячеек, сортировка, ширина и видимость столбцов, поиск, Alt+клик.
// Правка ячейки – table-edit.js, выделение строк – table-select.js (этап 55).
// С этапа 44 та же таблица показывает и принтеры (страница «Принтеры», mixins/printers.js):
// строки – tableRows, столбцы – tableBuiltinColumns, всё, что запоминается, – под своими ключами

import { apiFetch, loadJson, saveJson, searchNorm, searchWords, searchWordsIn, setCtrlDown, setIfChanged, wrapLine } from "../util.js";
import { DEFAULT_HIDDEN_SEEN_KEY, HIDDEN_COLUMNS_KEY, NAME_RULE_COLUMN, PINNED_COLUMNS_KEY, ROOM_COLUMN, ROOM_PARTS, SEARCH_HIDDEN_KEY, columnTitle, orderColumns, roomText, tableStoreKey, toColumnDef, compareCellValues, decoration, frameColorFor, isDuplicateLine, isOverdue, keepSameRows, refreshDuplicates, styleKey, todayKey } from "../columns.js";
import { CHIP_PAD, LINK_ICON, ONLINE_DOT, TABLE_WIDTHS_KEY, computeAutoWidths, sameWidths } from "../widths.js";
import { pageLink } from "../route.js";

// Порядок состояний антивируса при сортировке; AV_NONE – антивирусов нет
const AV_RANK = { on: 0, old: 1, off: 2 };
const AV_NONE = 9;
// Строка подсказки с группами VACUUM – не длиннее (≈ столбец «Группы» на странице Vacuum, 320px)
const VACUUM_TITLE_WIDTH = 48;

export default {
    computed: {
        // Пользовательские поля для таблицы (без старых с занятым ключом)
        tableFieldDefs() {
            return this.fieldDefs.filter(function (fd) {
                return !fd.reserved;
            });
        },

        // Все столбцы как в описании с сервера (и скрытые): «Каб» и «Кабинет» – порознь.
        // Для Справочников: оформление задаётся им, а не общему столбцу Таблицы
        baseColumns() {
            const self = this;
            // Пока в ячейке поля правки или показанные логин и пароль, столбец шире (этап 45)
            const widen = this.cellWiden;
            const base = this.tableBuiltinColumns.map(function (col) {
                const manual = self.manualWidths[col.field];
                const auto = self.autoWidths[col.field];
                const width = manual !== undefined ? manual : (auto || 100);
                return Object.assign({}, col, {
                    width: widen[col.field] ? Math.max(width, widen[col.field]) : width
                });
            });
            const extra = self.tableUserDefs.map(function (fd) {
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
            return statusIndex >= 0 ? base.slice(0, statusIndex).concat(extra).concat(base.slice(statusIndex)) : base.concat(extra);
        },

        // Все столбцы Таблицы (и скрытые) в порядке по умолчанию. «Каб» и «Кабинет» –
        // одним столбцом «Кабинет» («[214] Процедурная») в обоих видах (28в)
        defaultColumns() {
            const self = this;
            const all = this.baseColumns;
            const manual = self.manualWidths[ROOM_COLUMN.field];
            const room = Object.assign({}, ROOM_COLUMN, { width: manual !== undefined ? manual : (self.autoWidths[ROOM_COLUMN.field] || 100) });
            const result = [];
            all.forEach(function (col) {
                if (ROOM_PARTS.indexOf(col.field) === -1) {
                    result.push(col);
                } else if (col.field === ROOM_PARTS[0]) {
                    result.push(room);
                }
            });
            return result;
        },

        // Все столбцы Таблицы (и скрытые) – для меню «Столбцы»: в порядке текущего вида
        // (перетаскивание шапки, mixins/col-order.js)
        allColumns() {
            const order = this.columnOrderNow;
            const result = order ? orderColumns(this.defaultColumns, order) : this.defaultColumns.slice();
            // Закрепление своё (Ctrl+клик по шапке) – вместо заданного в описании столбцов;
            // у каждого вида своё (этап 43) – копии столбцов, описание не трогается
            const pinned = this.pinsNow;
            if (!pinned) {
                return result;
            }
            return result.map(function (col) {
                const sticky = pinned.indexOf(col.field) !== -1;
                return !!col.sticky === sticky ? col : Object.assign({}, col, { sticky: sticky });
            });
        },

        // Скрытые столбцы текущего вида (mixins/table-views.js): у вида 1 – прежний список,
        // у остальных – все, кроме показанных
        hiddenNow() {
            if (this.tableView === 1) {
                return this.hiddenColumns;
            }
            const v = this.viewNow;
            if (!v.shown) {
                return v.hidden || [];
            }
            return this.allColumns.map(function (col) { return col.field; }).filter(function (field) {
                return v.shown.indexOf(field) === -1;
            });
        },

        // Видимые столбцы; при кнопке «Значения сканера» – и скрытые, где есть его блочки
        // (этап 40: пока кнопка включена)
        columns() {
            const hidden = this.hiddenNow;
            const open = this.scanOpenFields;
            return this.allColumns.filter(function (col) {
                return hidden.indexOf(col.field) === -1 || open.has(col.field);
            });
        },

        // Столбцы на экране: видимые и при кнопке «Имена по правилам» – «По правилу»
        // справа от HOSTNAME (этапы 36, 38; закреплён, если закреплён HOSTNAME; у принтеров –
        // справа от «Имени», этап 44). Его нет в меню «Столбцы», печати, порядке; не
        // сортируется, не фильтруется, не правится
        viewColumns() {
            const cols = this.columns;
            if (!this.nameCheck) {
                return cols;
            }
            const nameField = this.tableNameField;
            const at = cols.findIndex(function (col) { return col.field === nameField; });
            const host = at === -1 ? null : cols[at];
            const manual = this.manualWidths[NAME_RULE_COLUMN.field];
            const rule = Object.assign({}, NAME_RULE_COLUMN, {
                sticky: !!host && !!host.sticky,
                width: manual !== undefined ? manual : (this.autoWidths[NAME_RULE_COLUMN.field] || 100)
            });
            const list = cols.slice();
            list.splice(at + 1, 0, rule);
            return list;
        },

        // Отступы закреплённых столбцов: слева – ширины закреплённых левее, справа – правее
        // (этап 41). { поле: { left, right } }
        stickyOffsets() {
            const result = {};
            const cols = this.viewColumns.filter(function (col) { return col.sticky; });
            let left = 0;
            cols.forEach(function (col) {
                result[col.field] = { left: left, right: 0 };
                left += col.width;
            });
            let right = 0;
            for (let i = cols.length - 1; i >= 0; i--) {
                result[cols[i].field].right = right;
                right += cols[i].width;
            }
            return result;
        },

        // Столбцы для расчёта ширины: встроенные, общий «Кабинет» и «По правилу»
        widthColumns() {
            return this.tableBuiltinColumns.concat(this.nameCheck ? [ROOM_COLUMN, NAME_RULE_COLUMN] : [ROOM_COLUMN]);
        },

        hiddenColumnCount() {
            const hidden = this.hiddenNow;
            return this.allColumns.filter(function (col) { return hidden.indexOf(col.field) !== -1; }).length;
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

        // В this.rows – все ПК, и рабочие, и из архива (признак archived); на странице
        // «Принтеры» таблица показывает принтеры (tableRows)
        activeRows() {
            return this.tableRows.filter(function (row) { return !row.archived; });
        },

        // Строки текущего режима таблицы: рабочие или архив
        modeRows() {
            const archive = this.showArchive;
            return this.tableRows.filter(function (row) { return !!row.archived === archive; });
        },

        rowCount() {
            return this.modeRows.length;
        },

        selectedSet() {
            return new Set(this.selectedRows);
        },

        // Сосед ячейки справа: следующий столбец (соседа снизу строка получает свойством below)
        nextColField() {
            const next = {};
            const cols = this.viewColumns;
            for (let i = 0; i + 1 < cols.length; i++) {
                next[cols[i].field] = cols[i + 1].field;
            }
            return next;
        },

        totalWidth() {
            const base = this.viewColumns.reduce(function (sum, col) {
                return sum + col.width;
            }, 0);
            return base;
        },

        // Фильтр по дереву, фильтры по столбцам (mixins/col-filters.js), поиск
        filteredRows() {
            const rows = this.searchRows(this.applyColFilters(this.locationRows, null));
            // Значок-воронка у кнопки «Значения сканера»: только строки с предложениями;
            // у кнопки «Имена по правилам» – только ПК с именем не по правилу
            return this.scanOnlyOn || this.nameOnlyOn
                ? rows.filter((row) => (this.scanOnlyOn && this.rowHasScanChip(row)) || (this.nameOnlyOn && this.rowHasNameChip(row)))
                : rows;
        },

        displayRows() {
            const rows = this.filteredRows;
            if (!this.sortField || !this.sortDir) {
                return rows;
            }
            const field = this.sortField;
            const sortCol = this.allColumns.find(function (c) { return c.field === field; });
            const dir = this.sortDir === "asc" ? 1 : -1;
            // Антивирусы – сначала по состоянию (работает, базы устарели, выключен), потом по названию
            if (sortCol && sortCol.scanOnly) {
                const keys = new Map();
                rows.forEach((row) => keys.set(row.id, this.avSortKey(row)));
                return rows.slice().sort(function (a, b) {
                    const ka = keys.get(a.id);
                    const kb = keys.get(b.id);
                    if (ka.rank !== kb.rank) {
                        // без антивирусов – всегда внизу
                        return ka.rank === AV_NONE ? 1 : kb.rank === AV_NONE ? -1 : (ka.rank - kb.rank) * dir;
                    }
                    return ka.text.localeCompare(kb.text, "ru", { numeric: true, sensitivity: "base" }) * dir;
                });
            }
            return rows.slice().sort(function (a, b) {
                return compareCellValues(a[field], b[field], sortCol) * dir;
            });
        },

        displayedCount() {
          return this.displayRows.length;
        },

    },

    watch: {
        searchHidden(value) {
            saveJson(SEARCH_HIDDEN_KEY, value);
        },

        // Сняли выделение – меню действий больше не нужно
        "selectedRows.length"(count) {
            if (count === 0 && this.openMenu === "selection") {
                this.closeMenus();
            }
        },

        // Vue перерисовал класс строки – вернуть ей подсветку под курсором
        selectedRows() {
            this.$nextTick(() => {
                if (this.hoverRowEl) {
                    this.hoverRowEl.classList.add("row-hover");
                }
            });
        },

        hiddenColumns() {
            saveJson(tableStoreKey(HIDDEN_COLUMNS_KEY, this.tableKind), this.hiddenColumns);
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
                setIfChanged(this, "builtinColumns", (data.columns || []).map(toColumnDef));
                setIfChanged(this, "cardGroups", data.card_groups || []);
                setIfChanged(this, "historyLabels", data.history_labels || {});
                // Таблица и карточка принтеров (этап 44)
                setIfChanged(this, "printerColumns", (data.printer_columns || []).map(toColumnDef));
                setIfChanged(this, "printerCardGroups", data.printer_card_groups || []);
                setIfChanged(this, "printerHistoryLabels", data.printer_history_labels || {});
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
                const rows = data.rows || [];
                // Сменился день – «срок прошёл» у дат пересчитается (те же строки сами не перерисуются)
                this.today = todayKey();
                // «Кабинет»: номер и название одной строкой
                rows.forEach(function (row) { row.room = roomText(row); });
                // Неизменившиеся строки – прежние объекты: перерисуются только другие (этап 59)
                const next = keepSameRows(this.rows, rows);
                if (next) {
                    this.rows = next;
                    this.applyAntivirus(true);
                    if (refreshDuplicates(this.rows, this.builtinColumns, "pc")) {
                        this.dupVersion++;
                    }
                }
                // И при тех же строках: могло измениться оформление (Ctrl+Z жирности столбца)
                this.recalcWidths();
            } catch (e) {
                this.tableError = String(e.message || e);
            }
            this.finishLoading();
            this.tableLoading = false;
        },

        // «Обновить» слева от поиска (этап 47): изменения таблицы и значения сканера; у ПК –
        // ещё и кто в сети из VACUUM (быстрая проверка Jabber сейчас)
        async refreshTablePage() {
            if (this.tableRefreshing) {
                return;
            }
            this.tableRefreshing = true;
            try {
                if (this.tableKind === "printer") {
                    await Promise.all([this.loadPrinters(), this.loadPrinterDiffs()]);
                } else {
                    await Promise.all([this.loadTable(), this.loadDiffs(), this.loadVacuumOnline(true), this.loadPrinters()]);
                    this.refreshCardRow();
                }
            } finally {
                this.tableRefreshing = false;
            }
        },

        // Клик по шапке – сортировка, с Ctrl – закрепить столбец / снять закрепление.
        // Столбец только что перетаскивали – это не клик
        onHeadClick(event, col) {
            if (this.colDragDone || col.virtual) {
                return;
            }
            if (event.ctrlKey || event.metaKey) {
                this.togglePin(col);
            } else {
                this.sortBy(col);
            }
        },

        // Закрепить столбец / снять – у каждого вида своё (этап 43)
        togglePin(col) {
            const pinned = this.allColumns.filter(function (c) { return c.sticky; }).map(function (c) { return c.field; });
            const at = pinned.indexOf(col.field);
            if (at === -1) {
                pinned.push(col.field);
            } else {
                pinned.splice(at, 1);
            }
            if (this.tableView === 1) {
                this.pinnedColumns = pinned;
                saveJson(tableStoreKey(PINNED_COLUMNS_KEY, this.tableKind), pinned);
            } else {
                this.patchView({ pins: pinned });
            }
            this.$nextTick(() => {
                this.updateStickyShadow();
            });
        },

        // Клик по шапке: по возрастанию → по убыванию → без сортировки. state – чья
        // сортировка: Таблицы (по умолчанию) или «Сети» (net)
        sortBy(col, state) {
            const s = state || this;
            if (s.sortField !== col.field) {
                s.sortField = col.field;
                s.sortDir = "asc";
            } else if (s.sortDir === "asc") {
                s.sortDir = "desc";
            } else {
                s.sortField = null;
                s.sortDir = null;
            }
        },

        resetSort() {
            this.sortField = null;
            this.sortDir = null;
        },

        startResize(event, col) {
            const startX = event.clientX;
            const startWidth = col.width;
            const zoom = this.tableZoom || 1;   // таблица в масштабе – путь мыши пересчитывается
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
                const delta = (e.clientX - startX) / zoom;
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
                const delta = (e.clientX - startX) / zoom;
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
                localStorage.setItem(tableStoreKey(TABLE_WIDTHS_KEY, this.tableKind), JSON.stringify(this.manualWidths));
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
            // Пока таблица открывается, данные приходят по частям – ширины один раз в конце (этап 59)
            if (!this.tableReady) {
                return;
            }
            // Блочки значений сканера в ячейках – ширина столбца и под них (этап 26в),
            // в «По правилу» – блочок имени по правилу или «своё» (этап 36)
            const scanChip = (row, field) => {
                if (field === NAME_RULE_COLUMN.field) {
                    return this.nameChip(row) || (this.nameKept(row) ? "своё" : null);
                }
                const d = this.scanChipShown(row, field);
                return d ? this.scanChipText(d) : null;
            };
            // Блочок повтора и антивируса шире текста, выделенные логины VACUUM – жирные
            const avBold = !!this.avSettings && this.avSettings.statuses.some(function (st) { return st.bold; });
            // Кружок «в сети» слева от логина VACUUM (этап 41) – ещё ONLINE_DOT
            const dots = this.vacuumDots;
            const lineInfo = (row, col, line) => {
                if (col.field === "antivirus") {
                    return { pad: CHIP_PAD, bold: avBold };
                }
                // Принтеры у ПК, ПК у принтера (этап 44): справа от ссылки – значок таблицы
                if (col.links) {
                    return { pad: LINK_ICON, bold: false };
                }
                const ms = this.markStyle(this.lineMarkKinds(this.lineMarks(row, col, line)));
                const chip = this.chipColumn(col) && this.lineLook(col.field, line).chip;
                const dot = dots && col.field === "vacuum" && !row.archived && line.trim() ? ONLINE_DOT : 0;
                return ms || chip || dot ? { pad: ((ms && ms.backgroundColor) || chip ? CHIP_PAD : 0) + dot, bold: !!ms && !!ms.fontWeight } : null;   // фон «на всю ячейку» – запас не мешает
            };
            const widths = computeAutoWidths(this.tableRows, this.widthColumns, this.tableUserDefs, this.choiceStyleMap, this.tableColumnStyles, scanChip, lineInfo);
            // Те же ширины – данные не трогать: новый объект перерисовал бы все строки (этап 52)
            if (!sameWidths(this.autoWidths, widths)) {
                this.autoWidths = widths;
            }
            this.$nextTick(() => {
                this.updateStickyShadow();
            });
        },

        // editing – ячейка сейчас правится (у строки-компонента – из свойства editField, этап 52)
        cellClass(row, col, editing) {
            const cls = {
                center: col.center,
                link: col.link,
                sticky: col.sticky
            };
            if (col.note) {
                cls["note-cell"] = true;
            }
            if (col.virtual) {
                cls["name-rule-cell"] = true;
            }
            if (col.field === this.stuckEdge) {
                cls["sticky-edge"] = true;
            }
            if (col.field === this.stuckEdgeRight) {
                cls["sticky-edge-r"] = true;
            }
            if (editing) {
                cls["editing"] = true;
            }
            if (this.savedFlash[this.rowKey(row) + ":" + col.field]) {
                cls["cell-saved"] = true;
            }
            return cls;
        },

        // Оформление ячейки целиком: столбец и поверх – первое оформленное значение.
        // Фон блочком ячейку не оформляет (его строки рисует cellParts): тогда –
        // только столбец, а если и у него блочок – ничего. Нет оформления – null
        cellLook(row, col) {
            const fieldStyles = this.choiceStyleMap[col.field];
            if (!fieldStyles && !this.tableColumnStyles[col.field]) {
                return null;
            }
            let found = "";
            const value = row[col.field];
            if (fieldStyles && value !== null && value !== undefined && value !== "") {
                for (const line of String(value).split("\n")) {
                    if (fieldStyles[styleKey(col.field, line)]) {
                        found = line;
                        break;
                    }
                }
            }
            let look = this.lineLook(col.field, found);
            if (look.chip && this.chipColumn(col)) {
                look = found ? this.lineLook(col.field, "") : null;
                if (look && look.chip) {
                    look = null;
                }
            }
            return look;
        },

        // Фон блочком – в столбцах, где значение рисуется обычным текстом
        chipColumn(col) {
            return !col.note && !col.scanOnly && this.chipFields.has(col.field);
        },

        cellTextStyle(row, col) {
            const look = this.cellLook(row, col);
            if (!look) {
                return null;
            }
            const style = {};
            if (look.color) {
                style.color = look.color;
            }
            if (look.underline || look.strike) {
                style.textDecoration = decoration(look.underline, look.strike);
            }
            return Object.keys(style).length ? style : null;
        },

        // Значения ячейки по строкам, если какое-то надо выделить (иначе null –
        // ячейка рисуется одним текстом): выделения Таблицы (повтор, имя на ПК
        // другое, логин VACUUM, срок – вид из Справочников, фон – блочком у самого
        // значения), фон из Справочников блочком, номер записи GLPI / GSIT – ссылкой.
        // VACUUM – всегда по строкам (этап 41): у логина своя подсказка и кружок «в сети».
        // Принтеры у ПК и ПК у принтера (этап 44) – ссылками на них
        cellParts(row, col) {
            void this.dupVersion; // дубли считаются вне Vue – зависимость вручную
            const value = row[col.field];
            if (value === null || value === undefined || value === "" || this.isPending(row, col)) {
                return null;
            }
            if (col.links) {
                return this.linkParts(row, col);
            }
            const link = this.diffs.links[col.field];
            const chips = this.chipColumn(col);
            const host = col.field === "hostname";
            const marks = col.dup || col.date || col.field === "vacuum" || host;
            if (!link && !chips && !marks) {
                return null;
            }
            // Имя ПК – всегда ссылкой на его карточку: средняя кнопка открывает её в новой вкладке
            const vacuum = col.field === "vacuum";
            let special = host || vacuum;
            const lines = col.multiline ? String(value).split("\n") : [String(value)];
            const parts = lines.map((line) => {
                const m = this.lineMarks(row, col, line) || {};
                const href = this.idLink(col.field, line);
                // Фон из Справочников блочком: всё оформление значения – у его строки
                const look = chips && line.trim() ? this.lineLook(col.field, line) : null;
                const chip = !!look && look.chip;
                const kinds = this.lineMarkKinds(m);
                const ms = this.markStyle(kinds);
                if (kinds.length || href || chip) {
                    special = true;
                }
                const checked = m.verified || m.checked;
                const titles = [m.dup ? "Повтор" : "", m.host ? "На ПК: " + m.host : "", checked ? "Проверен: " + checked.join(", ") : "", this.vacuumMarkTitle(m), m.overdue ? "Срок прошёл" : "", href ? this.idLinkTitle(col.field) : ""].filter(Boolean);
                const online = vacuum && !row.archived && line.trim() ? this.vacuumIsOnline(line) : null;
                const style = Object.assign({}, chip ? {
                    backgroundColor: look.bg_color,
                    color: look.color,
                    fontWeight: look.bold ? "700" : null,
                    fontStyle: look.italic ? "italic" : null,
                    textDecoration: decoration(look.underline, look.strike)
                } : null, ms);
                // Фон выделения «на всю ячейку» красит ячейку (cellFillOf), а не значение
                if (ms && ms.backgroundColor && !this.markChip(kinds)) {
                    delete style.backgroundColor;
                    if (chip) {
                        style.backgroundColor = look.bg_color;
                    }
                }
                return {
                    text: line, href: href, card: host ? pageLink("table", { pc: row.id }) : null,
                    title: (vacuum ? this.vacuumTitle(line, m.gone ? null : online, titles) : titles.join(" · ")) || null,
                    cls: { "fill-chip": !!style.backgroundColor, "vac-dot": online !== null, "vac-on": !!online },
                    style: style
                };
            });
            return special ? parts : null;
        },

        // Чем выделить значение (строку ячейки): dup – повтор; host – имя на ПК
        // другое (по сканеру; само имя с ПК); у логина VACUUM: gone – такого
        // пользователя в Jabber нет, stale – давно не подключался (сколько дней;
        // null – никогда); overdue – срок прошёл. Нечего выделять – null
        lineMarks(row, col, line) {
            const overdue = !!col.date && isOverdue(line, this.today);
            if (row.archived) {
                return overdue ? { overdue: true } : null;
            }
            const dup = !!col.dup && isDuplicateLine(line, col.field, row._printer ? "printer" : "pc");
            let gone = false;
            let stale;
            let host = null;
            let verified = null;
            let checked = null;
            if (col.field === "vacuum") {
                const login = String(line).trim().toLowerCase();
                gone = this.vacuumMissingSet.has(login);
                if (!gone && login in this.vacuumStale) {
                    stale = this.vacuumStale[login];
                }
            } else if (col.field === "hostname") {
                host = this.wrongHostname(row.id);
                // Проверен и GLPI / GSIT, и сетью или одним из них (этап 38; чем – в подсказке)
                verified = host ? null : (this.diffs.verified[row.id] || null);
                checked = host || verified ? null : (this.diffs.checked[row.id] || null);
            }
            return dup || gone || stale !== undefined || host || overdue || verified || checked ? { dup: dup, gone: gone, stale: stale, host: host, overdue: overdue, verified: verified, checked: checked } : null;
        },

        // Виды выделений (как в Справочниках) по итогу lineMarks
        lineMarkKinds(m) {
            if (!m) {
                return [];
            }
            return [m.checked ? "checked" : "", m.verified ? "verified" : "", m.dup ? "dup" : "", m.host ? "hostname" : "", m.gone ? "gone" : "", m.stale !== undefined ? "stale" : "", m.overdue ? "overdue" : ""].filter(Boolean);
        },

        // Имя этого ПК по сканеру другое (и «оставить как есть» не нажато) – это имя и откуда
        // («pc-7 · GLPI №12»); иначе null
        wrongHostname(computerId) {
            const d = (this.pcDiffIndex.get(computerId) || {}).hostname;
            return d && d.can_take === false ? String(d.proposed || "").split("\n")[0] + " · " + this.diffSourceShort(d) : null;
        },

        vacuumMarkTitle(m) {
            if (m.gone) {
                return "Нет в Jabber";
            }
            if (m.stale === undefined) {
                return "";
            }
            return m.stale === null ? "Не подключался никогда" : "Не подключался " + m.stale + " дн.";
        },

        // Подсказка логина VACUUM (этап 41): группы Jabber в [ ] первой строкой (переносом – не
        // шире столбца «Группы» на странице Vacuum), дальше – в сети ли (online: null – не писать)
        // и прочие подсказки
        vacuumTitle(login, online, titles) {
            const groups = this.diffs.vacuumGroups[String(login).trim().toLowerCase()];
            return [
                groups && groups.length ? wrapLine("[" + groups.join(", ") + "]", VACUUM_TITLE_WIDTH) : "",
                online === null ? "" : (online ? "В сети" : "Не в сети")
            ].concat(titles).filter(Boolean).join("\n");
        },

        // Логин в карточке ПК: класс, подсказка и кружок «в сети» (online: null – без кружка)
        vacuumLoginMark(login) {
            const key = String(login).trim().toLowerCase();
            const m = { gone: this.vacuumMissingSet.has(key), stale: undefined };
            if (!m.gone && key in this.vacuumStale) {
                m.stale = this.vacuumStale[key];
            }
            const online = this.vacuumIsOnline(key);
            const title = this.vacuumTitle(key, m.gone ? null : online, [this.vacuumMarkTitle(m)]);
            return { style: this.markStyle(this.lineMarkKinds(m)), title: title ? title + "\nСкопировать" : "Скопировать", online: online };
        },

        // Строка, где сейчас виден блочок сканера (в показанных столбцах)
        rowHasScanChip(row) {
            if (row.archived) {
                return false;
            }
            const entry = this.diffIndex.get(row.id);
            if (!entry) {
                return false;
            }
            const kinds = this.scanShownKinds;
            return this.columns.some((col) => {
                const d = entry[col.field];
                return !!d && kinds.has(d.kind) && !this.scanChipHidden(d);
            });
        },

        // Сортировка «Антивирусов»: лучшее состояние у ПК, потом названия
        avSortKey(row) {
            const list = this.avItems(row);
            if (!list.length) {
                return { rank: AV_NONE, text: "" };
            }
            let rank = AV_NONE;
            list.forEach(function (a) { rank = Math.min(rank, AV_RANK[a.status]); });
            return { rank: rank, text: list.map(function (a) { return a.title; }).join(" ") };
        },

        // Ссылка на запись ПК в GLPI / GSIT по номеру из столбца
        idLink(field, value) {
            const base = this.diffs.links[field];
            const id = String(value === null || value === undefined ? "" : value).trim();
            return base && /^\d+$/.test(id) ? base + id : null;
        },

        idLinkTitle(field) {
            return "Открыть в " + (field === "gsit_id" ? "GSIT" : "GLPI");
        },

        // Клик по ссылке открывает запись; с Alt / Ctrl / Shift – как обычный клик по ячейке
        onIdLinkClick(event) {
            if (event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) {
                event.preventDefault();
            } else {
                event.stopPropagation();
            }
        },

        // Цвет заливки ячейки: фон значения из Справочников поверх фона
        // столбца; null – без заливки (повтор заливает только значение – cellParts)
        cellFillOf(row, col) {
            const marked = this.markFillOf(row, col);
            if (marked) {
                return marked;
            }
            if (col.scanOnly) {
                return this.avCellFill(row);
            }
            const look = this.cellLook(row, col);
            return look && !look.chip ? look.bg_color : null;
        },

        // Заливка ячеек строки – для линий сетки: { поле: цвет }; без заливки – null.
        // Строка-компонент считает её для себя и для строки ниже (этап 52)
        rowFills(row) {
            let fills = null;
            this.viewColumns.forEach((col) => {
                const f = this.cellFillOf(row, col);
                if (f) {
                    (fills || (fills = {}))[col.field] = f;
                }
            });
            return fills;
        },

        // Фон выделения (повтор, проверен…), у которого выбрано «на всю ячейку»:
        // по первому такому значению ячейки; нет – null
        markFillOf(row, col) {
            if (!this.markFillOn || !(col.dup || col.date || col.field === "vacuum" || col.field === "hostname")) {
                return null;
            }
            void this.dupVersion;
            const value = row[col.field];
            if (value === null || value === undefined || value === "") {
                return null;
            }
            const lines = col.multiline ? String(value).split("\n") : [String(value)];
            for (const line of lines) {
                const kinds = this.lineMarkKinds(this.lineMarks(row, col, line));
                if (kinds.length && !this.markChip(kinds)) {
                    const ms = this.markStyle(kinds);
                    if (ms && ms.backgroundColor) {
                        return ms.backgroundColor;
                    }
                }
            }
            return null;
        },

        // fills, belowFills – заливка этой строки и строки ниже (rowFills)
        cellTdStyle(row, col, fills, belowFills) {
            const style = {};
            // Оформление столбца и поверх – значения (фон блочком – у строк, cellParts)
            const look = this.cellLook(row, col);
            if (look) {
                if (look.bold) style.fontWeight = "700";
                if (look.italic) style.fontStyle = "italic";
            }
            if (col.bold) {
                style.fontWeight = "700";
            }
            if (col.sticky) {
                Object.assign(style, this.stickyStyle(col));
            }
            // Заливка – как в Excel: фон идёт поверх линий сетки. У каждой
            // ячейки свои линии справа и снизу; такая линия берёт цвет соседа
            // справа/снизу, если он залит (правый и нижний перекрывают левый
            // и верхний), иначе – своей заливки. Серая линия у залитых не видна.
            // Синий слой выбранной строки подмешивается к цвету линии
            // (--self-a – своя строка, --below-a – строка ниже).
            const own = (fills || {})[col.field];
            const right = (fills || {})[this.nextColField[col.field]];
            const below = (belowFills || {})[col.field];
            if (own) {
                style.backgroundColor = own;
            }
            const mix = function (color, amount) {
                return "color-mix(in srgb, var(--sel-base) " + amount + ", " + color + ")";
            };
            if (right || own) {
                style["--v-line"] = mix(right || own, "var(--self-a)");
            }
            // Рамка ячейки под курсором – в тон заливки (заливка темнее), а не
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
        // а не старое – без мигания «старое → новое». pendingCells – по ключу через in:
        // строка следит только за своими ключами (этап 52)
        cellText(row, col) {
            const key = this.rowKey(row) + ":" + col.field;
            if (key in this.pendingCells) {
                return this.pendingCells[key];
            }
            return row[col.field];
        },

        isPending(row, col) {
            return (this.rowKey(row) + ":" + col.field) in this.pendingCells;
        },

        // editing – ячейка сейчас правится
        cellSpanStyle(row, col, editing) {
            let base = this.cellTextStyle(row, col) || {};
            // Рядом блочок сканера и у ситуации «зачёркивать значение таблицы»
            const mark = this.scanCellMark(row, col);
            if (mark && mark.strike && !editing) {
                base = Object.assign({}, base, { textDecoration: (base.textDecoration === "underline" ? "underline " : "") + "line-through" });
            }
            if (editing) {
                return Object.assign({}, base, { visibility: "hidden" });
            }
            return base;
        },

        // Закреплённый столбец липнет и к левому краю (после закреплённых левее), и к правому
        // (этап 41: перед закреплёнными правее)
        stickyStyle(col) {
            const at = this.stickyOffsets[col.field];
            return at ? { left: at.left + "px", right: at.right + "px" } : null;
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
            // $el у корня с несколькими элементами – текстовый узел, поэтому ref
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
                checkSel: this.$refs.checkSelWrap,
                checkFields: this.$refs.checkFieldsWrap,
                collect: this.$refs.collectWrap,
                netScan: this.$refs.netScanWrap,
                namesHelp: this.$refs.namesHelpWrap,
                namingHelp: this.$refs.namingHelpWrap,
                historyFilter: this.$refs.historyFilterWrap,
                colFilter: this.$refs.colFilterPanel,
                colFilterList: this.$refs.colFilterListWrap,
                netFilterList: this.$refs.netFilterListWrap
            };
            // Клик по воронке в шапке решает сам: та же – закрыть, другая – открыть её
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
            return this.hiddenNow.indexOf(field) !== -1;
        },

        // Скрытые столбцы – у каждого вида таблицы свои; у видов 2…9 хранятся показанные
        setHiddenColumns(list) {
            if (this.tableView === 1) {
                this.hiddenColumns = list;
                return;
            }
            const shown = this.allColumns.map(function (col) { return col.field; }).filter(function (field) {
                return list.indexOf(field) === -1;
            });
            this.patchView({ shown: shown, hidden: null });
            this.$nextTick(() => {
                this.updateStickyShadow();
            });
        },

        toggleColumn(field) {
            if (this.isColumnHidden(field)) {
                this.setHiddenColumns(this.hiddenNow.filter(function (f) { return f !== field; }));
            } else {
                this.setHiddenColumns(this.hiddenNow.concat([field]));
            }
            if (this.sortField === field && this.isColumnHidden(field)) {
                this.resetSort();
            }
        },

        showAllColumns() {
            this.setHiddenColumns([]);
        },

        // ---------- Поиск ----------

        // Строки, в которых нашлись все слова поиска по базе
        searchRows(rows) {
            if (!searchWords(this.quickFilter).length) {
                return rows;
            }
            const fields = (this.searchHidden ? this.allColumns : this.columns).map(function (col) {
                return col.field;
            });
            const rowTexts = rows.map(function (row) {
                const texts = [];
                fields.forEach(function (field) {
                    const value = row[field];
                    if (value !== null && value !== undefined && value !== "") {
                        texts.push({ field: field, text: searchNorm(value) });
                    }
                });
                return texts;
            });
            // Слово, которого нет нигде, – в другой раскладке («[bh» → «хир»)
            const words = searchWordsIn(this.quickFilter, function (w) {
                return rowTexts.some(function (texts) {
                    return texts.some(function (t) { return t.text.indexOf(w) !== -1; });
                });
            });
            // Число среди нескольких слов («хир орд 3») ищется целиком: это № места (у принтера – №),
            // № кабинета или отдельное число внутри текста («Win 10»). Иначе «3»
            // находилось бы в каждом IP 10.0.3.x, в этаже, в кабинете 301.
            // Одно слово – как раньше, кусок где угодно (часть ИНВ, IP).
            const whole = words.length > 1;
            return rows.filter(function (row, i) {
                const texts = rowTexts[i];
                return words.every(function (w) {
                    if (whole && /^\d+$/.test(w)) {
                        return texts.some(function (t) {
                            if (t.field === "seat_no" || t.field === "number" || t.field === "room_code") {
                                return t.text.trim() === w;
                            }
                            // «[214] Процедурная» или просто «214»
                            if (t.field === "room") {
                                return t.text.split(/[\s,;[\]]+/).indexOf(w) !== -1;
                            }
                            return /\s/.test(t.text.trim()) && t.text.split(/[\s,;[\]]+/).indexOf(w) !== -1;
                        });
                    }
                    return texts.some(function (t) { return t.text.indexOf(w) !== -1; });
                });
            });
        },

        // Esc в поле поиска: сначала очищает, второй раз – убирает фокус
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
            // Закреплённый столбец прилипает к левому краю, когда уезжают все незакреплённые
            // перед ним, к правому (этап 41) – когда за правым краем все незакреплённые после
            // него. Тень – у крайнего из прилипших с каждой стороны (закреплённые могут стоять
            // не подряд)
            const zoom = this.tableZoom || 1;
            const scrollLeft = wrap.scrollLeft / zoom;
            const hiddenRight = (wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft) / zoom;
            const cols = this.viewColumns;
            let loose = 0;
            let edge = null;
            for (const col of cols) {
                if (!col.sticky) {
                    loose += col.width;
                } else if (scrollLeft > 0 && scrollLeft >= loose - 0.5) {
                    edge = col.field;
                }
            }
            loose = 0;
            let edgeRight = null;
            for (let i = cols.length - 1; i >= 0; i--) {
                const col = cols[i];
                if (!col.sticky) {
                    loose += col.width;
                } else if (hiddenRight > 0.5 && hiddenRight >= loose - 0.5 && col.field !== edge) {
                    edgeRight = col.field;
                }
            }
            if (this.stuckEdge !== edge) {
                this.stuckEdge = edge;
            }
            if (this.stuckEdgeRight !== edgeRight) {
                this.stuckEdgeRight = edgeRight;
            }
        },
        
        onTableMouseMove(event) {
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
            if (this.altDown !== event.altKey) {
                this.altDown = event.altKey;
            }
            setCtrlDown(event.ctrlKey || event.metaKey);
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
        // Открыта карточка – подсвечена её строка, куда бы ни ушёл курсор (карточка ПК – в
        // таблице ПК, принтера – в таблице принтеров)
        const cardId = this.tableKind === "printer" ? (this.pcard ? this.pcard.id : null) : (this.card ? this.card.id : null);
        if (cardId !== null) {
            const wrap = this.$refs.tableWrap;
            tr = wrap ? wrap.querySelector('tbody tr[data-id="' + cardId + '"]') : null;
        }
        if (this.hoverRowEl && this.hoverRowEl !== tr) {
            this.hoverRowEl.classList.remove("row-hover");
        }
        if (tr) {
            tr.classList.add("row-hover"); // Vue мог сбросить класс, перерисовав строку
        }
            this.hoverRowEl = tr || null;
        },

        // ---------- Alt+клик: копирование ----------
        // В многострочной ячейке (несколько IP, MAC, дисков) копируется та
        // строка значения, над которой курсор; в остальных – значение целиком.
        // Пока Alt зажат, это значение подсвечено (copyHint).

        // Что скопирует клик в точке (x, y): { text, rect } или null
        copyTargetAt(x, y) {
            const el = document.elementFromPoint(x, y);
            const td = el ? el.closest(".data-table tbody td") : null;
            if (!td || td.classList.contains("editing")) {
                return null;
            }
            const tr = td.parentElement;
            const col = this.viewColumns[td.cellIndex];
            const id = Number(tr.dataset.id);
            const row = this.displayRows.find(function (r) { return r.id === id; });
            if (!col || !row) {
                return null;
            }
            const tdBox = td.getBoundingClientRect();
            // Блочок сканера и имени по правилу (этап 45): копируется предлагаемое значение –
            // строка под курсором; «пусто» (сканер предлагает очистить) не копируется
            const chip = el.closest("button.scan-chip");
            if (chip) {
                const d = col.virtual ? null : this.scanCellDiff(row, col);
                return d && !d.proposed ? null : this.lineUnderPointer(chip, y, tdBox.right);
            }
            // «Доступ» (этап 45): только показанные логин и пароль, точки – нет
            if (col.secret && !this.webShownFor(row)) {
                return null;
            }
            const value = row[col.field];
            if (value === null || value === undefined || String(value).trim() === "") {
                return null;
            }
            const text = String(value);
            // Значения отдельными строками (повторы, ссылки) – та, что под курсором
            const parts = Array.from(td.querySelectorAll(".cell-line")).filter(function (el) { return !el.classList.contains("cl-none"); });
            if (col.secret && !parts.length) {
                return null;
            }
            if (parts.length) {
                let near = null;
                let nearDist = Infinity;
                parts.forEach(function (el) {
                    // Ссылка на ПК / принтер – по самой ссылке, без места под значок таблицы:
                    // так же, как подсветка под курсором (этап 46)
                    const rect = (el.querySelector("a.obj-link") || el).getBoundingClientRect();
                    const dist = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
                    if (el.textContent.trim() && dist < nearDist) {
                        nearDist = dist;
                        near = { text: el.textContent.trim(), rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, cellRight: tdBox.right } };
                    }
                });
                return near;
            }
            const span = td.querySelector("span");
            const node = span ? span.firstChild : null;
            const tdRect = td.getBoundingClientRect();
            if (!node || node.nodeType !== 3 || node.data !== text) {
                return { text: text.trim(), rect: { top: tdRect.top, bottom: tdRect.bottom, left: tdRect.left, right: tdRect.right, cellRight: tdRect.right } };
            }
            const range = document.createRange();
            const clip = function (rect) {
                // Обрезанное многоточием примечание – не шире ячейки
                const left = Math.max(rect.left, tdRect.left + 2);
                const right = Math.min(rect.right, tdRect.right - 2);
                return { top: rect.top, bottom: rect.bottom, left: left, right: right, cellRight: tdRect.right };
            };
            const lines = text.split("\n");
            if (lines.length < 2 || col.note) {
                range.selectNodeContents(node);
                return { text: text.trim(), rect: clip(range.getBoundingClientRect()) };
            }
            // Для каждой строки значения – её прямоугольник на экране;
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

        // Строка текста элемента (блочок сканера – многострочный) под курсором: { text, rect }
        lineUnderPointer(el, y, cellRight) {
            const node = el.firstChild;
            const text = el.textContent;
            const box = el.getBoundingClientRect();
            const whole = { text: text.trim(), rect: { top: box.top, bottom: box.bottom, left: box.left, right: box.right, cellRight: cellRight } };
            if (!text.trim()) {
                return null;
            }
            if (!node || node.nodeType !== 3 || node.data !== text || text.indexOf("\n") === -1) {
                return whole;
            }
            const range = document.createRange();
            let best = null;
            let bestDist = Infinity;
            let offset = 0;
            text.split("\n").forEach(function (line) {
                const start = offset;
                offset += line.length + 1;
                if (!line.trim()) {
                    return;
                }
                range.setStart(node, start);
                range.setEnd(node, start + line.length);
                const rect = range.getBoundingClientRect();
                const dist = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
                if (rect.height && dist < bestDist) {
                    bestDist = dist;
                    best = { text: line.trim(), rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, cellRight: cellRight } };
                }
            });
            return best || whole;
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
                return; // то же значение – не сбрасывать зелёный «скопировано»
            }
            this.copyHint = hint;
        },
    }
};
