// ============================================================
// Общие утилиты
// ============================================================

async function apiFetch(url, options) {
    const response = await fetch(url, options);
    if (response.status === 401) {
        window.location.replace("/login.html");
        return new Promise(function () {});
    }
    return response;
}

function splitMulti(value) {
    if (value === null || value === undefined || value === "") {
        return [];
    }
    return String(value)
        .split(/\r?\n/)
        .map(function (item) {
            return item.trim();
        })
        .filter(Boolean);
}

function normalizeKey(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value).trim().toLowerCase();
}

let duplicateSets = {
    ip: new Set(),
    mac: new Set(),
    hostname: new Set(),
    inv_no: new Set(),
    vacuum: new Set()
};

function buildDuplicateSets(rows) {
    const counters = {
        ip: {},
        mac: {},
        hostname: {},
        inv_no: {},
        vacuum: {}
    };

    function add(field, value) {
        const key = normalizeKey(value);
        if (!key) {
            return;
        }
        counters[field][key] = (counters[field][key] || 0) + 1;
    }

    rows.forEach(function (row) {
        splitMulti(row.ip).forEach(function (value) { add("ip", value); });
        splitMulti(row.mac).forEach(function (value) { add("mac", value); });
        if (row.hostname) add("hostname", row.hostname);
        if (row.inv_no) add("inv_no", row.inv_no);
        splitMulti(row.vacuum).forEach(function (value) { add("vacuum", value); });
    });

    function makeSet(counter) {
        return new Set(
            Object.keys(counter).filter(function (key) {
                return counter[key] > 1;
            })
        );
    }

    return {
        ip: makeSet(counters.ip),
        mac: makeSet(counters.mac),
        hostname: makeSet(counters.hostname),
        inv_no: makeSet(counters.inv_no),
        vacuum: makeSet(counters.vacuum)
    };
}

function hasDuplicateValue(value, field) {
    if (value === null || value === undefined || value === "") {
        return false;
    }
    const set = duplicateSets[field];
    if (!set) {
        return false;
    }
    const multiFields = ["ip", "mac", "vacuum"];
    let values;
    if (multiFields.indexOf(field) !== -1) {
        values = splitMulti(value);
    } else {
        values = [String(value)];
    }
    return values.some(function (item) {
        return set.has(normalizeKey(item));
    });
}

const kindLabels = {
    building: "Здание",
    department: "Отделение",
    floor: "Этаж",
    room: "Кабинет"
};

// ============================================================
// Определения столбцов таблицы
// ============================================================

const COLUMN_DEFS = [
    { field: "user", headerName: "ФИО", editable: true, multiline: true },
    { field: "building", headerName: "Адрес" },
    { field: "department", headerName: "Отделение" },
    { field: "floor", headerName: "Эт.", center: true },
    { field: "room_code", headerName: "Каб", center: true },
    { field: "room_name", headerName: "Кабинет" },
    { field: "seat_no", headerName: "№", center: true, editable: true },
    { field: "hostname", headerName: "HOSTNAME", link: true, sticky: true, editable: true },
    { field: "ip", headerName: "IP", sticky: true, editable: true, multiline: true },
    { field: "vacuum", headerName: "VACUUM", editable: true, multiline: true },
    { field: "os", headerName: "OS", center: true, editable: true  },
    { field: "type", headerName: "ТИП", center: true, editable: true },
    { field: "model", headerName: "Модель", center: true, editable: true },
    { field: "cpu", headerName: "CPU", center: true, editable: true },
    { field: "ram", headerName: "RAM", center: true, editable: true },
    { field: "drive", headerName: "DRIVE", center: true, editable: true, multiline: true },
    { field: "gpu", headerName: "GPU", center: true, editable: true },
    { field: "mac", headerName: "MAC", editable: true, editable: true, multiline: true },
    { field: "inv_no", headerName: "ИНВ", editable: true, editable: true, multiline: true },
    { field: "gsit", headerName: "GSIT", center: true, editable: true },
    { field: "state", headerName: "Сост.", center: true, editable: true },
    { field: "label", headerName: "Метка", center: true, editable: true },
    { field: "status", headerName: "Статус", center: true, editable: true },
    { field: "note", headerName: "Примечание", note: true, maxWidth: 200, editable: true, multiline: true }
];

// Поля, дубли в которых подсвечиваются красным
const DUP_FIELDS = ["ip", "mac", "hostname", "inv_no", "vacuum"];

// ============================================================
// Замер ширины текста и автоматический размер столбцов
// ============================================================

const TABLE_WIDTHS_KEY = "itdb.tableWidths.v1";
const TABLE_FONT = '12px "Segoe UI", system-ui, Arial, sans-serif';
const CELL_PAD = 12;       // запас на отступы внутри ячейки
const HEADER_EXTRA = 20;   // запас на стрелку сортировки
const DEFAULT_MAX_WIDTH = 400;
const WIDTH_EXTRA = 0;
let widthProbe = null;

const measureCtx = document.createElement("canvas").getContext("2d");

function ensureWidthProbe() {
    if (widthProbe) {
        return widthProbe;
    }
    widthProbe = document.createElement("span");
    widthProbe.style.position = "absolute";
    widthProbe.style.left = "-9999px";
    widthProbe.style.top = "0";
    widthProbe.style.visibility = "hidden";
    widthProbe.style.whiteSpace = "pre";
    document.body.appendChild(widthProbe);
    return widthProbe;
}

function syncProbeFont() {
    const sample =
        document.querySelector(".data-table td") ||
        document.querySelector(".data-table th");
    if (!sample) {
        return;
    }
    const style = window.getComputedStyle(sample);
    widthProbe.style.fontFamily = style.fontFamily;
    widthProbe.style.fontSize = style.fontSize;
    widthProbe.style.fontWeight = style.fontWeight;
    widthProbe.style.fontStyle = style.fontStyle;
    widthProbe.style.letterSpacing = style.letterSpacing;
}

function measureTextWidth(text) {
    const probe = ensureWidthProbe();
    probe.textContent = text || "";
    return probe.getBoundingClientRect().width;
}

function cellOverhead() {
    const sample = document.querySelector(".data-table td");
    if (!sample) {
        return 13;
    }
    const style = window.getComputedStyle(sample);
    const left = parseFloat(style.paddingLeft) || 0;
    const right = parseFloat(style.paddingRight) || 0;
    const border = parseFloat(style.borderRightWidth) || 0;
    return left + right + border;
}

function computeAutoWidths(rows) {
    ensureWidthProbe();
    syncProbeFont();
    const overhead = cellOverhead();
    const probe = ensureWidthProbe();
    // Стрелка сортировки рисуется шрифтом 9px (см. .sort-arrow) + отступ 3px
    const savedFontSize = probe.style.fontSize;
    probe.style.fontSize = "9px";
    probe.textContent = "▲";
    const arrowWidth = probe.getBoundingClientRect().width;
    probe.style.fontSize = savedFontSize;
    probe.textContent = "";
    const sortArrowSpace = arrowWidth + 3;
    const widths = {};
    COLUMN_DEFS.forEach(function (col) {
        // Заголовок рисуется жирным (см. .data-table th) — меряем жирным
        probe.style.fontWeight = "600";
        let max = measureTextWidth(col.headerName) + sortArrowSpace;
        // Значения в ячейках обычные — меряем обычным
        probe.style.fontWeight = "400";
        rows.forEach(function (row) {
            const value = row[col.field];
            if (value === null || value === undefined || value === "") {
                return;
            }
            String(value).split("\n").forEach(function (line) {
                const w = measureTextWidth(line);
                if (w > max) {
                    max = w;
                }
            });
        });
        let width = Math.ceil(max) + overhead + WIDTH_EXTRA;
        const cap = col.maxWidth || DEFAULT_MAX_WIDTH;
        if (width > cap) {
            width = cap;
        }
        widths[col.field] = width;
    });
    return widths;
}

function loadManualWidths() {
    try {
        const raw = localStorage.getItem(TABLE_WIDTHS_KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) {
            return {};
        }
        return parsed;
    } catch (e) {
        return {};
    }
}

// ============================================================
// Сортировка значений
// ============================================================

function compareCellValues(a, b) {
    const aEmpty = a === null || a === undefined || a === "";
    const bEmpty = b === null || b === undefined || b === "";
    if (aEmpty && bEmpty) {
        return 0;
    }
    if (aEmpty) {
        return 1; // пустые всегда внизу
    }
    if (bEmpty) {
        return -1;
    }
    const sa = String(a).split("\n")[0];
    const sb = String(b).split("\n")[0];
    return sa.localeCompare(sb, "ru", { numeric: true, sensitivity: "base" });
}

// ============================================================
// Приложение
// ============================================================

const app = Vue.createApp({
    data() {
        return {
            authChecked: false,
            user: null,
            view: "table",

            // Таблица
            tableLoading: true,
            tableError: "",
            rowCount: 0,
            quickFilter: "",
            rows: [],
            noteTooltip: { visible: false, text: "", top: 0, left: 0, width: 0 },
            stickyStuck: false,
            editMode: false,
            editingRowId: null,
            editingField: null,
            editValue: "",
            autoWidths: {},
            manualWidths: loadManualWidths(),
            sortField: null,
            sortDir: null,

            // Дерево
            treeLoading: false,
            treeError: "",
            treeRoots: [],
            unlocated: 0,
            treeForm: null,
            treeFormError: "",
            treeIndex: {},
            treeOpenIds: new Set(),

            // История
            historyLoading: false,
            historyError: "",
            historyItems: [],

            // Карточка
            card: null,
            cardLoading: false,
            cardError: "",
            cardHostname: "",
            editingHostname: false,
            cardPeople: [],
            cardVacuum: [],
            cardHistory: [],
            // Справочники
            choicesLoading: false,
            choicesItems: [],
            newChoiceValue: {}
        };
    },

    computed: {
        columns() {
            const self = this;
            return COLUMN_DEFS.map(function (col) {
                const manual = self.manualWidths[col.field];
                const auto = self.autoWidths[col.field];
                return Object.assign({}, col, {
                    width: manual !== undefined ? manual : (auto || 100)
                });
            });
        },

        totalWidth() {
            return this.columns.reduce(function (sum, col) {
                return sum + col.width;
            }, 0);
        },

        filteredRows() {
            const query = this.quickFilter.trim().toLowerCase();
            if (!query) {
                return this.rows;
            }
            const fields = COLUMN_DEFS.map(function (col) {
                return col.field;
            });
            return this.rows.filter(function (row) {
                return fields.some(function (field) {
                    const value = row[field];
                    if (value === null || value === undefined) {
                        return false;
                    }
                    return String(value).toLowerCase().indexOf(query) !== -1;
                });
            });
        },

        displayRows() {
            const rows = this.filteredRows;
            if (!this.sortField || !this.sortDir) {
                return rows;
            }
            const field = this.sortField;
            const dir = this.sortDir === "asc" ? 1 : -1;
            return rows.slice().sort(function (a, b) {
                return compareCellValues(a[field], b[field]) * dir;
            });
        },

        displayedCount() {
          return this.displayRows.length;
        },

        lastStickyField() {
          let last = null;
          for (const col of COLUMN_DEFS) {
            if (col.sticky) {
              last = col.field;
            }
          }
          return last;
        },

        cardRoom() {
            if (!this.card) {
                return "";
            }
            return [this.card.room_code, this.card.room_name].filter(Boolean).join(" ");
        },

        choicesByField() {
            const result = {};
            this.choicesItems.forEach(function (item) {
                if (!result[item.field]) {
                    result[item.field] = [];
                }
                result[item.field].push(item);
            });
            return result;
        },

        choiceColorMap() {
            const map = {};
            this.choicesItems.forEach(function (item) {
                if (!item.color) {
                    return;
                }
                if (!map[item.field]) {
                    map[item.field] = {};
                }
                map[item.field][item.value.toLowerCase()] = item.color;
            });
            return map;
        }
        
    },

    async mounted() {
        window.itdbTable = this;
        this.hoverRowEl = null;
        this.lastMouseX = undefined;
        this.lastMouseY = undefined;
        this.rafId = null;
        await this.checkAuth();
        this.authChecked = true;
        if (this.user) {
            await this.loadTable();
            await this.loadChoices();
        }
    },

    methods: {
        // ---------- Авторизация ----------

        async checkAuth() {
            try {
                const response = await apiFetch("/api/auth/me");
                this.user = await response.json();
            } catch (e) {
                this.user = null;
            }
        },

        setView(view) {
            this.view = view;
            if (view === "tree") {
                this.loadTree();
            } else if (view === "history") {
                this.loadHistory();
            } else if (view === "choices") {
                this.loadChoices();
            }
        },

        async logout() {
            try {
                await apiFetch("/api/auth/logout", { method: "POST" });
            } catch (e) {
                // сессия уже могла истечь
            }
            window.location.replace("/login.html");
        },

        // ---------- Таблица ----------

        async loadTable() {
            this.tableLoading = true;
            this.tableError = "";
            try {
                const response = await apiFetch("/api/computers");
                const data = await response.json();
                this.rows = data.rows || [];
                this.rowCount = data.total || this.rows.length;
                duplicateSets = buildDuplicateSets(this.rows);
                this.autoWidths = computeAutoWidths(this.rows);
            } catch (e) {
                this.tableError = String(e);
            }
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
            if (DUP_FIELDS.indexOf(col.field) !== -1 && hasDuplicateValue(row[col.field], col.field)) {
                cls["dup-red"] = true;
            }
            if (this.isEditing(row, col)) {
                cls["editing"] = true;
            }
            return cls;
        },

        cellValueStyle(row, col) {
            const style = {};
            const fieldColors = this.choiceColorMap[col.field];
            if (fieldColors) {
                const value = row[col.field];
                if (value !== null && value !== undefined && value !== "") {
                    const lines = String(value).split("\n");
                    for (const line of lines) {
                        const color = fieldColors[line.trim().toLowerCase()];
                        if (color) {
                            style.color = color;
                            break;
                        }
                    }
                }
            }
            if (col.field === "hostname") {
                style.fontWeight = "700";
            }
            return Object.keys(style).length ? style : null;
        },

        cellSpanStyle(row, col) {
            const base = this.cellValueStyle(row, col) || {};
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
            if (!this.editMode || !col.editable) {
                return;
            }
            if (this.editingRowId === row.id && this.editingField === col.field) {
                return;
            }
            this.hideNoteTooltip();
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
            });
        },

        handleEditKeydown(event, row, col) {
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
            if (newValue === oldValue) {
                return;
            }
            this.saveCellValue(row, col, newValue);
        },

        cancelEdit() {
            this.editingRowId = null;
            this.editingField = null;
        },

                cellSpanStyle(row, col) {
            const style = this.cellValueStyle(row, col) || {};
            if (this.isEditing(row, col)) {
                return Object.assign({}, style, { visibility: "hidden" });
            }
            return style;
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
            try {
                const payload = {};
                payload[col.field] = value;
                const response = await apiFetch("/api/computers/" + row.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                if (!response.ok) {
                    const data = await response.json();
                    alert("Не удалось сохранить: " + (data.detail || "ошибка"));
                    return;
                }
                const data = await response.json();
                const updated = data.updated || {};
                const index = this.rows.findIndex((r) => r.id === row.id);
                if (index !== -1) {
                    Object.assign(this.rows[index], updated);
                    duplicateSets = buildDuplicateSets(this.rows);
                    this.autoWidths = computeAutoWidths(this.rows);
                }
            } catch (e) {
                alert("Не удалось сохранить: " + e);
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
            });
        },

        updateStickyShadow() {
            const wrap = this.$refs.tableWrap;
            if (!wrap) {
                return;
            }
            let threshold = 0;
            for (const col of this.columns) {
                if (col.sticky) {
                    break;
                }
                threshold += col.width;
            }
            this.stickyStuck = wrap.scrollLeft >= threshold;
        },
        
        onTableMouseMove(event) {
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
            const tr = event.target.closest("tbody tr");
            this.setHoverRow(tr);
        },
        
        onTableMouseLeave() {
            this.lastMouseX = undefined;
            this.lastMouseY = undefined;
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
        if (this.hoverRowEl && this.hoverRowEl !== tr) {
            this.hoverRowEl.classList.remove("row-hover");
        }
        if (tr && tr !== this.hoverRowEl) {
            tr.classList.add("row-hover");
        }
            this.hoverRowEl = tr || null;
        },

        onCellClick(row, col) {
            if (col.field === "hostname") {
                if (!this.editMode) {
                    this.openCard(row);
                }
            }
        },

        // ---------- Карточка ----------

        async openCard(row) {
            this.card = row;
            this.cardHostname = row.hostname || "";
            this.editingHostname = false;
            this.cardLoading = true;
            this.cardError = "";
            this.cardPeople = [];
            this.cardVacuum = [];
            this.cardHistory = [];
            try {
                const response = await apiFetch("/api/computers/" + row.id);
                const data = await response.json();
                this.cardPeople = data.people || [];
                this.cardVacuum = data.vacuum || [];
                this.cardHistory = data.history || [];
            } catch (e) {
                this.cardError = String(e);
            }
            this.cardLoading = false;
        },

        closeCard() {
            this.card = null;
        },

        startEditHostname() {
            this.editingHostname = true;
            this.$nextTick(() => {
                const input = this.$refs.hostnameInput;
                if (input) {
                    input.focus();
                    const length = input.value.length;
                    input.setSelectionRange(length, length);
                }
            });
        },

        cancelEditHostname() {
            this.cardHostname = this.card ? (this.card.hostname || "") : "";
            this.editingHostname = false;
        },

        async saveHostname() {
            if (!this.card || !this.editingHostname) {
                return;
            }
            const newValue = this.cardHostname.trim();
            const id = this.card.id;
            if (newValue === (this.card.hostname || "")) {
                this.editingHostname = false;
                return;
            }
            this.editingHostname = false;
            try {
                const response = await apiFetch("/api/computers/" + id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ hostname: newValue === "" ? null : newValue })
                });
                if (!response.ok) {
                    throw new Error("HTTP " + response.status);
                }
                const result = await response.json();
                const updated = result.updated || {};
                const index = this.rows.findIndex(function (row) {
                    return row.id === id;
                });
                if (index >= 0) {
                    const updatedRow = Object.assign({}, this.rows[index], updated);
                    this.rows[index] = updatedRow;
                    duplicateSets = buildDuplicateSets(this.rows);
                    this.autoWidths = computeAutoWidths(this.rows);
                    this.card = updatedRow;
                }
            } catch (e) {
                this.editingHostname = true;
                alert("Не удалось сохранить: " + e);
            }
        },

        // ---------- Дерево ----------

        async loadTree() {
            this.treeLoading = true;
            this.treeError = "";
            try {
                const response = await apiFetch("/api/locations/tree");
                const data = await response.json();
                this.treeRoots = data.roots || [];
                this.unlocated = data.unlocated || 0;
                this.buildTreeIndex();
            } catch (e) {
                this.treeError = String(e);
            }
            this.treeLoading = false;
        },

        buildTreeIndex() {
            const index = {};
            const walk = (nodes, parts) => {
                nodes.forEach((node) => {
                    let title = node.name || node.code || "";
                    if (node.kind === "room" && node.code && node.name && node.code !== node.name) {
                        title = node.code + " " + node.name;
                    }
                    const path = parts.concat([title]).join(" → ");
                    index[node.id] = { node: node, path: path };
                    if (node.children && node.children.length) {
                        walk(node.children, parts.concat([title]));
                    }
                });
            };
            walk(this.treeRoots, []);
            this.treeIndex = index;
        },

        kindLabel(kind) {
            return kindLabels[kind] || kind;
        },

        openAddForm(node) {
            const allowedChildren = {
                building: ["department"],
                department: ["floor", "room"],
                floor: ["room"]
            };
            let kinds = ["building"];
            let path = "";
            if (node) {
                kinds = allowedChildren[node.kind] || [];
                if (!kinds.length) {
                    return;
                }
                const entry = this.treeIndex[node.id];
                path = entry ? entry.path : "";
            }
            this.treeForm = {
                action: "add",
                parentId: node ? node.id : null,
                nodeId: null,
                kind: kinds[0],
                kinds: kinds,
                code: "",
                name: "",
                path: path
            };
            this.treeFormError = "";
        },

        openEditForm(node) {
            const entry = this.treeIndex[node.id];
            this.treeForm = {
                action: "edit",
                parentId: node.parent_id,
                nodeId: node.id,
                kind: node.kind,
                kinds: [node.kind],
                code: node.code || "",
                name: node.name || "",
                path: entry ? entry.path : ""
            };
            this.treeFormError = "";
        },

        async submitTreeForm() {
            const form = this.treeForm;
            if (!form) {
                return;
            }
            this.treeFormError = "";
            try {
                let response;
                if (form.action === "add") {
                    response = await apiFetch("/api/locations", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            parent_id: form.parentId,
                            kind: form.kind,
                            name: form.name,
                            code: form.code
                        })
                    });
                } else {
                    response = await apiFetch("/api/locations/" + form.nodeId, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            name: form.name,
                            code: form.code
                        })
                    });
                }
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.treeForm = null;
                await this.loadTree();
                await this.loadTable();
            } catch (e) {
                this.treeFormError = String(e.message || e);
            }
        },

        async archiveLocation(node) {
            const entry = this.treeIndex[node.id];
            const path = entry ? entry.path : node.name;
            if (!confirm("Архивировать «" + path + "»? Узел исчезнет из дерева.")) {
                return;
            }
            try {
                const response = await apiFetch("/api/locations/" + node.id + "/archive", {
                    method: "POST"
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                await this.loadTree();
                await this.loadTable();
            } catch (e) {
                alert("Не удалось архивировать: " + e);
            }
        },

        moveLocationUp(node) {
            this.moveLocation(node, -1);
        },

        moveLocationDown(node) {
            this.moveLocation(node, 1);
        },

        async moveLocation(node, dir) {
            const parentEntry = node.parent_id ? this.treeIndex[node.parent_id] : null;
            const siblings = parentEntry ? parentEntry.node.children : this.treeRoots;
            const index = siblings.findIndex((item) => item.id === node.id);
            const target = siblings[index + dir];
            if (!target) {
                return;
            }
            try {
                let response;
                if (node.sort === target.sort) {
                    response = await apiFetch("/api/locations/" + node.id, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            sort: target.sort + (dir > 0 ? 1 : -1)
                        })
                    });
                    if (!response.ok) {
                        throw new Error(await this.errorText(response));
                    }
                } else {
                    response = await apiFetch("/api/locations/" + node.id, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ sort: target.sort })
                    });
                    if (!response.ok) {
                        throw new Error(await this.errorText(response));
                    }
                    response = await apiFetch("/api/locations/" + target.id, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ sort: node.sort })
                    });
                    if (!response.ok) {
                        throw new Error(await this.errorText(response));
                    }
                }
                await this.loadTree();
                await this.loadTable();
            } catch (e) {
                alert("Не удалось переместить: " + e);
            }
        },

        // ---------- История ----------

        async loadHistory() {
            this.historyLoading = true;
            this.historyError = "";
            try {
                const response = await apiFetch("/api/history?limit=200");
                const data = await response.json();
                this.historyItems = data.items || [];
            } catch (e) {
                this.historyError = String(e);
            }
            this.historyLoading = false;
        },

        // ---------- Справочники ----------
        async loadChoices() {
            this.choicesLoading = true;
            try {
                const response = await apiFetch("/api/choices");
                const data = await response.json();
                this.choicesItems = data.items || [];
            } catch (e) {
                // тихо
            }
            this.choicesLoading = false;
        },

        choiceFieldLabel(field) {
            const labels = {
                status: "Статус",
                os: "OS",
                type: "ТИП",
                model: "Модель",
                cpu: "CPU",
                gpu: "GPU",
                drive: "DRIVE",
                vnc: "VNC"
            };
            return labels[field] || field;
        },

        async addChoice(field) {
            const value = (this.newChoiceValue[field] || "").trim();
            if (!value) {
                return;
            }
            try {
                const response = await apiFetch("/api/choices", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ field: field, value: value })
                });
                if (!response.ok) {
                    const data = await response.json();
                    alert(data.detail || "Ошибка");
                    return;
                }
                this.newChoiceValue[field] = "";
                await this.loadChoices();
                await this.loadTable();
            } catch (e) {
                alert("Не удалось добавить: " + e);
            }
        },

        async setChoiceColor(item, event) {
            const color = event.target.value;
            try {
                const response = await apiFetch("/api/choices/" + item.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ color: color })
                });
                if (!response.ok) {
                    alert("Не удалось сохранить цвет");
                    return;
                }
                item.color = color;
                await this.loadTable();
            } catch (e) {
                alert("Не удалось сохранить цвет: " + e);
            }
        },

        async clearChoiceColor(item) {
            try {
                const response = await apiFetch("/api/choices/" + item.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ color: "" })
                });
                if (!response.ok) {
                    alert("Не удалось убрать цвет");
                    return;
                }
                item.color = null;
                await this.loadTable();
            } catch (e) {
                alert("Не удалось убрать цвет: " + e);
            }
        },

        // ---------- Общие ----------

        async errorText(response) {
            let message = "HTTP " + response.status;
            try {
                const data = await response.json();
                if (data && data.detail) {
                    message = typeof data.detail === "string"
                        ? data.detail
                        : JSON.stringify(data.detail);
                }
            } catch (e) {
                // оставляем HTTP-статус
            }
            return message;
        },

        formatTime(value) {
            if (!value) {
                return "";
            }
            return new Date(value).toLocaleString();
        },

        displayValue(value) {
            if (value === null || value === undefined) {
                return "—";
            }
            if (typeof value === "object") {
                return JSON.stringify(value);
            }
            return String(value);
        },

        async downloadExport() {
            try {
                const response = await apiFetch("/api/export/computers.xlsx");
                const blob = await response.blob();
                let filename = "itdb_computers.xlsx";
                const disposition = response.headers.get("Content-Disposition");
                if (disposition && disposition.includes("filename=")) {
                    filename = disposition.split("filename=")[1].replace(/["']/g, "");
                }
                const link = document.createElement("a");
                link.href = URL.createObjectURL(blob);
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
            } catch (e) {
                // если экспорт не удался, не ломаем интерфейс
            }
        }
    }
});

app.component("tree-node", {
    name: "tree-node",
    props: {
        node: Object,
        level: Number
    },
    data() {
        let open = this.level < 2;
        if (window.itdbTable && window.itdbTable.treeOpenIds.has(this.node.id)) {
            open = true;
        }
        return { open: open };
    },
    computed: {
        kindLabel() {
            return kindLabels[this.node.kind] || this.node.kind;
        },
        title() {
            if (
                this.node.kind === "room" &&
                this.node.code &&
                this.node.name &&
                this.node.code !== this.node.name
            ) {
                return this.node.code + " " + this.node.name;
            }
            return this.node.name || this.node.code || "";
        },
        canAddChild() {
            return this.node.kind !== "room";
        }
    },
    methods: {
        toggle() {
            if (this.node.children && this.node.children.length) {
                this.open = !this.open;
                if (window.itdbTable) {
                    if (this.open) {
                        window.itdbTable.treeOpenIds.add(this.node.id);
                    } else {
                        window.itdbTable.treeOpenIds.delete(this.node.id);
                    }
                }
            }
        },
        call(method) {
            if (window.itdbTable) {
                window.itdbTable[method](this.node);
            }
        }
    },
    template: `
        <div class="node">
            <div class="node-row" @click="toggle">
                <span class="toggle">
                    <template v-if="node.children && node.children.length">{{ open ? "−" : "+" }}</template>
                    <template v-else>•</template>
                </span>
                <span class="kind">{{ kindLabel }}</span>
                <span class="name">{{ title }}</span>
                <span class="count">{{ node.total_count }}</span>
                <span class="node-actions" @click.stop>
                    <span class="act" title="Выше" @click="call('moveLocationUp')">↑</span>
                    <span class="act" title="Ниже" @click="call('moveLocationDown')">↓</span>
                    <span class="act" v-if="canAddChild" title="Добавить внутрь" @click="call('openAddForm')">+</span>
                    <span class="act" title="Изменить" @click="call('openEditForm')">✎</span>
                    <span class="act" title="Архивировать" @click="call('archiveLocation')">✕</span>
                </span>
            </div>
            <div class="children" v-if="open && node.children && node.children.length">
                <tree-node
                    v-for="child in node.children"
                    :key="child.id"
                    :node="child"
                    :level="level + 1"
                ></tree-node>
            </div>
        </div>
    `
});

app.mount("#app");

window.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        if (!window.itdbTable || window.itdbTable.view !== "table") {
            return;
        }
        event.preventDefault();
        const input = document.getElementById("quickFilter");
        if (input) {
            input.focus();
            input.select();
        }
    }
});

window.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && window.itdbTable && window.itdbTable.card) {
        if (window.itdbTable.editingHostname) {
            window.itdbTable.cancelEditHostname();
        } else {
            window.itdbTable.closeCard();
        }
    }
});