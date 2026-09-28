// ============================================================
// Варианты оформления. Спорные решения можно вернуть, поставив false.
// ============================================================

const UI_OPTIONS = {
    lightToolbar: true,   // светлая панель под меню (false — красная, как было)
    darkHostname: true,   // HOSTNAME тёмным, подчёркивание при наведении (false — синий)
    cardGroups: true      // поля карточки разбиты на группы (false — одним списком, как было)
};

document.body.classList.toggle("ui-light-toolbar", UI_OPTIONS.lightToolbar);
document.body.classList.toggle("ui-dark-hostname", UI_OPTIONS.darkHostname);

// ============================================================
// Общие утилиты
// ============================================================

function loadJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) {
            return fallback;
        }
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
        return fallback;
    }
}

function saveJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        // ignore
    }
}

function pad2(n) {
    return n < 10 ? "0" + n : String(n);
}

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

// ---------- Поиск по словам ----------
// «хир орд 3»: каждое слово ищется отдельно, найтись должны все.
// Регистр и ё/е не различаются.
function searchNorm(text) {
    return String(text).toLowerCase().replace(/ё/g, "е");
}

function searchWords(query) {
    return searchNorm(query).split(/\s+/).filter(Boolean);
}

function matchesAllWords(text, words) {
    const t = searchNorm(text);
    return words.every(function (w) { return t.indexOf(w) !== -1; });
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
        if (row.archived) {
            return; // ПК из архива дублей не создают
        }
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

// Цветовые схемы (личная настройка, шестерёнка в меню). Цвета — в app.css,
// здесь только список для выбора и цвет кружка.
const THEMES = [
    { key: "red", label: "Красная", color: "#8a2828" },
    { key: "green", label: "Зелёная", color: "#2e5e3e" },
    { key: "blue", label: "Синяя", color: "#233d66" },
    { key: "graphite", label: "Тёмно-серая", color: "#31363c" },
    { key: "teal", label: "Бирюзовая", color: "#1f5c63" }
];
const THEME_KEY = "itdb.theme";

function applyTheme(key) {
    if (!THEMES.some(function (t) { return t.key === key; })) {
        key = "red";
    }
    document.documentElement.dataset.theme = key;
    try {
        localStorage.setItem(THEME_KEY, key);
    } catch (e) {
        // ignore
    }
    return key;
}

const ROLE_LABELS = {
    admin: "Администратор",
    editor: "Редактор",
    reader: "Только чтение"
};

const kindLabels = {
    building: "Адрес",
    department: "Отделение",
    floor: "Этаж",
    room: "Кабинет"
};

// ============================================================
// Определения столбцов таблицы
// ============================================================

// values: false — значения почти всегда уникальны, в «Справочниках»
// у такого столбца настраивается только оформление столбца целиком.
const COLUMN_DEFS = [
    { field: "user", headerName: "ФИО", editable: true, values: false },
    // location: правка — выбор узла дерева (двойной клик в режиме правки)
    { field: "building", headerName: "Адрес", location: true },
    { field: "department", headerName: "Отделение", location: true },
    { field: "floor", headerName: "Эт.", fullName: "Этаж", center: true, location: true },
    { field: "room_code", headerName: "Каб", fullName: "№ Кабинета", center: true, values: false, location: true },
    { field: "room_name", headerName: "Кабинет", location: true },
    { field: "seat_no", headerName: "№", fullName: "№ Места", center: true, editable: true, values: false },
    { field: "hostname", headerName: "HOSTNAME", link: true, sticky: true, bold: true, editable: true, values: false },
    { field: "ip", headerName: "IP", fullName: "IP адрес", sticky: true, editable: true, multiline: true, values: "subnet" },
    { field: "vacuum", headerName: "VACUUM", fullName: "Vacuum", editable: true, multiline: true, values: false },
    { field: "os", headerName: "OS", fullName: "Операционная система (ОС / OS)", center: true, editable: true  },
    { field: "type", headerName: "ТИП", fullName: "Тип компьютера", center: true, editable: true },
    { field: "model", headerName: "Модель", center: true, editable: true },
    { field: "cpu", headerName: "CPU", fullName: "Процессор (ЦП / CPU)", center: true, editable: true },
    { field: "ram", headerName: "RAM", fullName: "Оперативная память (ОЗУ / RAM)", center: true, editable: true },
    { field: "drive", headerName: "DRIVE", fullName: "Дисковые накопители (DRIVE)", center: true, editable: true, multiline: true },
    { field: "gpu", headerName: "GPU", fullName: "Видеокарта (ГП / GPU)", center: true, editable: true },
    { field: "mac", headerName: "MAC", fullName: "MAC адрес", editable: true, multiline: true, values: false },
    { field: "inv_no", headerName: "ИНВ", fullName: "Инвентарный номер", editable: true, values: false },
    { field: "gsit", headerName: "GSIT", center: true, editable: true },
    { field: "state", headerName: "Сост.", center: true, editable: true },
    { field: "label", headerName: "Метка", center: true, editable: true },
    { field: "status", headerName: "Статус", center: true, editable: true },
    { field: "note", headerName: "Примечание", note: true, maxWidth: 200, editable: true, multiline: true, values: false }
];

// Название столбца вне самой таблицы (меню, карточка, история, справочники)
function columnTitle(col) {
    return col.fullName || col.headerName;
}

// Ключ оформления для строки значения. У IP оформляется подсеть /24:
// «10.0.5.17» → «10.0.5.0/24», цвет применяется ко всему адресу.
function ipSubnetKey(text) {
    const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?(?:\/\d{1,2})?\s*$/.exec(String(text || ""));
    if (!m || [m[1], m[2], m[3]].some(function (n) { return Number(n) > 255; })) {
        return null;
    }
    return Number(m[1]) + "." + Number(m[2]) + "." + Number(m[3]) + ".0/24";
}

function styleKey(field, line) {
    if (field === "ip") {
        return ipSubnetKey(line);
    }
    return String(line).trim().toLowerCase();
}

// Нельзя менять сразу у нескольких ПК (как BULK_EXCLUDED на сервере)
const BULK_EXCLUDED = ["location_id", "seat_no", "hostname", "ip", "mac", "inv_no", "serial", "vacuum"];

// Поля, дубли в которых подсвечиваются красным
const DUP_FIELDS = ["ip", "mac", "hostname", "inv_no", "vacuum"];

// Подписи полей в истории (ключ поля → как показывать)
const FIELD_LABELS = Object.assign(
    {},
    Object.fromEntries(COLUMN_DEFS.map(function (c) { return [c.field, columnTitle(c)]; })),
    {
        serial: "Серийный",
        vnc: "VNC",
        glpi_id: "GLPI",
        temp_note: "Врем. примечание",
        location_id: "Расположение",
        seat_sort: "Порядок строки",
        archived: "Архив",
        replaced: "Заменил",
        replaced_by: "Заменён на",
        created: "Создан"
    }
);
const LOCATION_FIELD_LABELS = {
    name: "Название",
    code: "Код",
    sort: "Порядок",
    kind: "Тип",
    parent_id: "Родитель",
    archived: "Архив",
    created: "Создан"
};

const HIDDEN_COLUMNS_KEY = "itdb.hiddenColumns.v1";
const SEARCH_HIDDEN_KEY = "itdb.searchHidden.v1";

// Поля карточки, которые можно править двойным кликом (ключ строки карточки → поле)
const LOCATION_EDIT = { field: "location_id", headerName: "Расположение", location: true };
const CARD_EDIT_EXTRA = {
    serial: { field: "serial", headerName: "Серийный", editable: true },
    building: LOCATION_EDIT,
    department: LOCATION_EDIT,
    floor: LOCATION_EDIT,
    room: LOCATION_EDIT,
    location: LOCATION_EDIT
};

// Столбцы таблицы, которые показывают расположение ПК
const LOCATION_FIELDS = ["building", "department", "floor", "room_code", "room_name"];

// ============================================================
// Замер ширины текста и автоматический размер столбцов
// ============================================================

const TABLE_WIDTHS_KEY = "itdb.tableWidths.v1";
const DEFAULT_MAX_WIDTH = 400;
const WIDTH_EXTRA = 0;
let widthProbe = null;

// Обычная ячейка данных — образец для шрифта и отступов.
function sampleDataCell() {
    return document.querySelector(".data-table tbody td:not(.editing)");
}

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
    const sample = sampleDataCell() || document.querySelector(".data-table th");
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
    const sample = sampleDataCell();
    if (!sample) {
        return 13;
    }
    const style = window.getComputedStyle(sample);
    const left = parseFloat(style.paddingLeft) || 0;
    const right = parseFloat(style.paddingRight) || 0;
    // +1 — линия сетки (inset box-shadow), рамки у ячеек нет
    return left + right + 1;
}

function computeAutoWidths(rows, fieldDefs, choiceStyleMap, columnStyles) {
    ensureWidthProbe();
    syncProbeFont();
    const overhead = cellOverhead();
    const probe = ensureWidthProbe();
    const savedFontSize = probe.style.fontSize;
    probe.style.fontSize = "9px";
    probe.textContent = "▲";
    const arrowWidth = probe.getBoundingClientRect().width;
    probe.style.fontSize = savedFontSize;
    probe.textContent = "";
    const sortArrowSpace = arrowWidth + 3;
    const widths = {};
    const allCols = COLUMN_DEFS.concat((fieldDefs || []).map(function (fd) {
        return { field: fd.key, headerName: fd.label };
    }));
    const styleMap = choiceStyleMap || {};
    const colStyles = columnStyles || {};
    allCols.forEach(function (col) {
        const colBold = col.bold || !!(colStyles[col.field] && colStyles[col.field].bold);
        probe.style.fontWeight = "600";
        let max = measureTextWidth(col.headerName) + sortArrowSpace;
        rows.forEach(function (row) {
            const value = row[col.field];
            if (value === null || value === undefined || value === "") {
                return;
            }
            const fieldStyles = styleMap[col.field];
            String(value).split("\n").forEach(function (line) {
                const s = fieldStyles ? fieldStyles[styleKey(col.field, line)] : null;
                probe.style.fontWeight = (colBold || (s && s.bold)) ? "700" : "400";
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
    // Дерево получает корень через inject, а не через window
    provide() {
        return { root: this };
    },

    data() {
        return {
            authChecked: false,
            user: null,
            view: "table",
            theme: document.documentElement.dataset.theme || "red",
            // Акценты (личные настройки): границы блоков цветом схемы и
            // цветная шапка таблиц — отдельно для каждой страницы
            accentBorders: false,
            accentHeaders: { tree: true, history: true, choices: true },

            // Таблица
            tableLoading: true,
            tableError: "",
            quickFilter: "",
            // Таблица показывает архив (кнопка «Архив» на панели)
            showArchive: false,
            archiveSaving: false,
            rows: [],
            hiddenColumns: loadJson(HIDDEN_COLUMNS_KEY, []),
            searchHidden: loadJson(SEARCH_HIDDEN_KEY, false),
            locationFilter: null,
            savedFlash: {},
            pendingCells: {},
            openMenu: null,
            noteTooltip: { visible: false, text: "", top: 0, left: 0, width: 0 },
            stickyStuck: false,
            editingRowId: null,
            editingField: null,
            editValue: "",
            autoWidths: {},
            manualWidths: loadManualWidths(),
            sortField: null,
            sortDir: null,
            // Форма «+ Компьютер» под панелью
            newComputer: null,
            // Строка действия с выбранными: переместить / заменить / изменить поле
            actionBar: null,
            newComputerError: "",
            newComputerSaving: false,

            // Дерево
            treeLoading: false,
            treeError: "",
            treeRoots: [],
            unlocated: 0,
            treeForm: null,
            treeFormError: "",
            treeIndex: {},
            treeOpenState: {},
            treeQuery: "",
            choicesQuery: "",
            choicesPos: 0,
            treeWidth: 480,
            treeHover: null,
            treeScrollbar: 0,

            // История
            historyLoading: false,
            historyError: "",
            historyItems: [],
            historyQuery: "",

            // Карточка
            card: null,
            cardLoading: false,
            cardError: "",
            cardHostname: "",
            editingHostname: false,
            cardPeople: [],
            cardVacuum: [],
            cardHistory: [],
            cardHistoryOpen: false,
            cardEditKey: null,
            cardEditValue: "",
            // Диалог и сообщения
            dialog: null,
            toasts: [],
            // Справочники
            choicesLoading: false,
            choicesItems: [],
            newChoiceValue: {},
            columnStyles: {},
            fieldDefEdit: null,
            // Пользовательские поля
            fieldDefs: [],
            fieldDefsLoading: false,
            selectedRows: [],
            selectAnchorId: null,   // строка, от которой идёт Shift+клик
            dupVersion: 0,          // пересчитаны дубли — пересчитать заливку ячеек
            altDown: false,         // зажат Alt — клик копирует значение
            copyHint: null,         // подсветка значения под курсором при Alt
            newFieldDef: { key: "", label: "", field_type: "text" }
        };
    },

    computed: {
        // reader — только просмотр; правка у admin и editor
        canEdit() {
            return !!this.user && (this.user.role === "admin" || this.user.role === "editor");
        },

        themes() {
            return THEMES;
        },

        userInitial() {
            return this.user && this.user.login ? this.user.login.charAt(0).toUpperCase() : "?";
        },

        roleLabel() {
            return this.user ? (ROLE_LABELS[this.user.role] || this.user.role) : "";
        },

        // Пользовательские поля для таблицы (без старых с занятым ключом)
        tableFieldDefs() {
            return this.fieldDefs.filter(function (fd) {
                return !fd.reserved;
            });
        },

        // Все столбцы (и скрытые) — для меню «Столбцы»
        allColumns() {
            const self = this;
            const base = COLUMN_DEFS.map(function (col) {
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

        // Кнопка «Архив»: с выбранными строками — убрать в архив / вернуть,
        // без выбора — показать архив / вернуться к таблице
        archiveAction() {
            if (this.canEdit && this.selectedRows.length) {
                return this.showArchive ? "restore" : "archive";
            }
            return "toggle";
        },

        archiveButtonTitle() {
            const n = this.selectedRows.length;
            if (this.archiveAction === "archive") {
                return "В архив: выбранные (" + n + ")";
            }
            if (this.archiveAction === "restore") {
                return "Вернуть из архива: выбранные (" + n + ")";
            }
            if (this.showArchive) {
                return "Архив открыт. Нажми, чтобы вернуться к таблице";
            }
            return "Архив: показать ПК из архива" + (this.canEdit ? ". Если сначала выбрать строки — уберёт их в архив" : "");
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

        filteredRows() {
            let rows = this.modeRows;
            if (this.locationFilter) {
                const ids = this.locationFilter.ids;
                rows = rows.filter(function (row) {
                    return ids.has(row.location_id);
                });
            }
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
          for (const col of this.columns) {
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
            const code = this.card.room_code;
            const name = this.card.room_name;
            // Номер и название в одной строке — номер в скобках: «[214] Процедурная»
            return code && name ? "[" + code + "] " + name : (code || name || "");
        },

        // Строки карточки ПК: [{ key, label, value, copy }] или { group }
        cardRows() {
            const c = this.card;
            if (!c) {
                return [];
            }
            // field — столбец таблицы, чьё оформление из Справочников показывать
            function F(key, label, value, copy, field) {
                return { key: key, label: label, value: value, copy: !!copy, field: field === undefined ? key : field };
            }
            const status = [F("status", "Статус", c.status)];
            const place = [
                F("building", "Адрес", c.building, true),
                F("department", "Отделение", c.department, true),
                F("floor", "Этаж", c.floor),
                F("room", "Кабинет", this.cardRoom, true, null),
                F("seat_no", "№ Места", c.seat_no)
            ];
            if (!c.location_id) {
                // Без расположения — строка есть, чтобы его можно было задать
                place.unshift(F("location", "Расположение", "не указано", false, null));
            }
            const net = [F("ip", "IP адрес", c.ip, true), F("mac", "MAC адрес", c.mac, true)];
            const ids = [F("inv_no", "Инвентарный номер", c.inv_no, true), F("serial", "Серийный", c.serial, true)];
            const hw = [
                F("type", "Тип компьютера", c.type),
                F("model", "Модель", c.model, true),
                F("os", "Операционная система", c.os, true),
                F("cpu", "Процессор", c.cpu, true),
                F("ram", "Оперативная память", c.ram),
                F("drive", "Дисковые накопители", c.drive, true),
                F("gpu", "Видеокарта", c.gpu, true)
            ];
            const marks = [F("gsit", "GSIT", c.gsit), F("state", "Сост.", c.state), F("label", "Метка", c.label)];
            const custom = this.tableFieldDefs.map(function (fd) {
                return F("x-" + fd.key, fd.label, c[fd.key], false, fd.key);
            });
            const note = [F("note", "Примечание", c.note)];

            function filled(list) {
                return list.filter(function (r) {
                    return r.value !== null && r.value !== undefined && r.value !== "";
                });
            }

            if (!UI_OPTIONS.cardGroups) {
                return filled([].concat(status, place, net, ids, hw, marks, custom, note));
            }
            const groups = [
                [null, status],
                ["Размещение", place],
                ["Сеть", net],
                ["Оборудование", hw],
                ["Учёт", ids.concat(marks)],
                ["Прочее", custom.concat(note)]
            ];
            const result = [];
            groups.forEach(function (g) {
                const rows = filled(g[1]);
                if (!rows.length) {
                    return;
                }
                if (g[0]) {
                    result.push({ key: "g-" + g[0], group: g[0] });
                }
                result.push.apply(result, rows);
            });
            return result;
        },

        // Поиск по дереву: self — совпали сами, anc — предки совпавших
        treeMatch() {
            // Слова ищутся по всему пути узла («хир орд» — ординаторские
            // хирургии). Найденным считается верхний узел, на котором путь
            // впервые собрал все слова; его потомки видны под ним.
            const q = this.treeQuery.trim();
            const words = searchWords(q);
            const self = new Set();
            const anc = new Set();
            if (words.length) {
                const walk = (nodes, parents, parentPath) => {
                    nodes.forEach((node) => {
                        const own = [node.code, node.name, treeNodeTexts(node).name].filter(Boolean).join(" ");
                        const path = parentPath + " / " + own;
                        if (matchesAllWords(path, words)) {
                            self.add(node.id);
                            parents.forEach(function (id) { anc.add(id); });
                            return;
                        }
                        if (node.children && node.children.length) {
                            walk(node.children, parents.concat([node.id]), path);
                        }
                    });
                };
                walk(this.treeRoots, [], "");
            }
            return { query: q, words: words, self: self, anc: anc, size: self.size };
        },

        // Поиск в Справочниках: «ЦП 101» — раздел по словам в названии,
        // значения — по остальным. Ничего не скрывается: совпавшие значения
        // подсвечены, страница переходит к разделу (Enter — к следующему).
        // Значение найдено, если все слова есть в «название раздела + значение»
        // и хотя бы одно — в самом значении.
        choicesMatch() {
            const words = searchWords(this.choicesQuery);
            const res = { words: words, blocks: [], blockSet: new Set(), valueSet: new Set(), hits: 0, pos: 0, current: null };
            if (!words.length) {
                return res;
            }
            this.styleBlocks.forEach(function (b) {
                const label = searchNorm(b.label);
                let found = matchesAllWords(label, words);
                (b.values || []).forEach(function (v) {
                    const value = searchNorm(v.value);
                    if (matchesAllWords(label + " " + value, words) && words.some(function (w) { return value.indexOf(w) !== -1; })) {
                        res.valueSet.add(b.field + "|" + v.key);
                        res.hits++;
                        found = true;
                    }
                });
                if (found) {
                    res.blocks.push(b.field);
                    res.blockSet.add(b.field);
                }
            });
            if (res.blocks.length) {
                res.pos = this.choicesPos % res.blocks.length;
                res.current = res.blocks[res.pos];
            }
            return res;
        },

        // Рабочие ПК для «Заменить на…»: имя, расположение, № места
        computerOptions() {
            const skip = new Set(this.actionBar ? this.actionBar.ids : []);
            return this.activeRows.filter(function (row) { return !skip.has(row.id); }).map((row) => {
                const entry = this.treeIndex[row.location_id];
                const place = [entry ? entry.path : "", row.seat_no ? "№ " + row.seat_no : ""].filter(Boolean).join(", ");
                const path = (row.hostname || "без имени") + (place ? " — " + place : "");
                return {
                    id: row.id,
                    kind: "pc",
                    path: path,
                    search: searchNorm([path, row.inv_no, row.status].filter(Boolean).join(" "))
                };
            });
        },

        // Столбцы для «Изменить поле у выбранных»: без расположения и № места
        // (это «Переместить») и без значений, которые у каждого ПК свои
        bulkColumns() {
            return this.allColumns.filter(function (col) {
                return col.editable && !col.location && BULK_EXCLUDED.indexOf(col.field) === -1;
            });
        },

        // Все узлы дерева в его порядке — для выбора расположения ПК
        locationOptions() {
            const list = [];
            const walk = (nodes) => {
                nodes.forEach((node) => {
                    const entry = this.treeIndex[node.id];
                    const path = entry ? entry.path : (node.name || node.code || "");
                    list.push({ id: node.id, kind: node.kind, path: path, search: searchNorm(path) });
                    walk(node.children || []);
                });
            };
            walk(this.treeRoots);
            return list;
        },

        filteredHistory() {
            const words = searchWords(this.historyQuery);
            if (!words.length) {
                return this.historyItems;
            }
            return this.historyItems.filter((item) => {
                const parts = [
                    item.title,
                    item.user_name,
                    this.entityLabel(item.entity),
                    this.formatTime(item.at)
                ];
                Object.keys(item.changes || {}).forEach((field) => {
                    const ch = item.changes[field] || {};
                    parts.push(field, this.fieldLabel(item.entity, field), this.displayValue(ch.old), this.displayValue(ch.new));
                });
                const text = parts.filter(function (p) { return p !== null && p !== undefined; }).join("\n");
                return matchesAllWords(text, words);
            });
        },

        // Записи истории, разбитые по дням (порядок — как пришёл с сервера)
        historyDays() {
            const days = [];
            let current = null;
            this.filteredHistory.forEach((item) => {
                const date = this.formatDate(item.at);
                if (!current || current.date !== date) {
                    current = { key: date + ":" + item.id, date: date, items: [] };
                    days.push(current);
                }
                current.items.push(item);
            });
            return days;
        },

        historyCountText() {
            const total = this.historyItems.length;
            const shown = this.filteredHistory.length;
            return shown === total ? "Записей: " + total : "Показано: " + shown + " из " + total;
        },

        choicesByField() {
            const result = {};
            this.choicesItems.forEach(function (item) {
                if (!result[item.field]) {
                    result[item.field] = [];
                }
                result[item.field].push(item);
            });
            ["gsit", "state", "label"].forEach(function (field) {
                if (!result[field]) {
                    result[field] = [];
                }
            });
            return result;
        },

        choiceStyleMap() {
            const map = {};
            this.choicesItems.forEach(function (item) {
                if (!item.color && !item.bg_color && !item.bold && !item.italic) {
                    return;
                }
                if (!map[item.field]) {
                    map[item.field] = {};
                }
                map[item.field][item.value.toLowerCase()] = {
                    color: item.color || null,
                    bg_color: item.bg_color || null,
                    bold: item.bold || false,
                    italic: item.italic || false
                };
            });
            return map;
        },

        // «Справочники»: блок на каждый столбец таблицы, в том же порядке.
        // Значения — из справочника и из самих данных, с числом ПК.
        styleBlocks() {
            const byField = this.choicesByField;
            const rows = this.activeRows;
            const collect = (field, multiline, subnet) => {
                const map = new Map();
                (byField[field] || []).forEach(function (ch) {
                    const key = ch.value.trim().toLowerCase();
                    if (!map.has(key)) {
                        map.set(key, { key: key, value: ch.value, choice: ch, count: 0 });
                    }
                });
                rows.forEach(function (row) {
                    const raw = row[field];
                    if (raw === null || raw === undefined || raw === "") {
                        return;
                    }
                    const lines = multiline ? splitMulti(raw) : [String(raw).trim()];
                    lines.forEach(function (line) {
                        if (!line) {
                            return;
                        }
                        const key = subnet ? ipSubnetKey(line) : line.toLowerCase();
                        if (!key) {
                            return;
                        }
                        let entry = map.get(key);
                        if (!entry) {
                            entry = { key: key, value: subnet ? key : line, choice: null, count: 0 };
                            map.set(key, entry);
                        }
                        entry.count += 1;
                    });
                });
                const list = Array.from(map.values());
                // Сначала значения справочника в его порядке, потом остальные по алфавиту
                list.sort(function (a, b) {
                    if (a.choice && b.choice) {
                        return (a.choice.sort - b.choice.sort) || (a.choice.id - b.choice.id);
                    }
                    if (a.choice) return -1;
                    if (b.choice) return 1;
                    return a.value.localeCompare(b.value, "ru", { numeric: true, sensitivity: "base" });
                });
                return list;
            };
            const blocks = this.allColumns.map((col) => {
                const valuesOn = col.values !== false;
                return {
                    field: col.field,
                    label: columnTitle(col),
                    extra: !!col.extra,
                    subnet: col.values === "subnet",
                    valuesOn: valuesOn,
                    values: valuesOn ? collect(col.field, !!col.multiline, col.values === "subnet") : []
                };
            });
            // Справочники полей, которых нет в таблице (например, VNC)
            const known = new Set(blocks.map(function (b) { return b.field; }));
            Object.keys(byField).forEach((field) => {
                if (!known.has(field) && byField[field].length) {
                    blocks.push({
                        field: field,
                        label: this.choiceFieldLabel(field),
                        extra: false,
                        orphan: true,
                        valuesOn: true,
                        values: collect(field, false)
                    });
                }
            });
            return blocks;
        }
    },

    watch: {
        accentBorders: {
            handler(on) {
                document.body.classList.toggle("accent-borders", on);
            },
            immediate: true
        },

        choicesQuery() {
            this.choicesPos = 0;
            this.scrollToChoicesHit();
        },

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

        // Другой набор дней (поиск, обновление) — пересчитать выталкивание
        historyDays() {
            this.$nextTick(() => {
                this.pushHistoryDays();
            });
        },

        hiddenColumns() {
            saveJson(HIDDEN_COLUMNS_KEY, this.hiddenColumns);
            this.$nextTick(() => {
                this.updateStickyShadow();
            });
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
            await this.$nextTick();
            this.snapNavUser();
            window.addEventListener("resize", () => this.snapNavUser());
            await Promise.all([this.loadChoices(), this.loadColumnStyles(), this.loadFieldDefs()]);
            await this.loadTable();
        }
    },

    methods: {
        // ---------- Авторизация ----------

        async checkAuth() {
            try {
                const response = await apiFetch("/api/auth/me");
                this.user = await response.json();
                // Схема — личная: у пользователя без настройки — красная,
                // даже если в этом браузере до него работал другой
                const prefs = (this.user && this.user.prefs) || {};
                this.theme = applyTheme(prefs.theme || "red");
                this.accentBorders = !!prefs.accent_borders;
                this.accentHeaders = Object.assign({ tree: true, history: true, choices: true }, prefs.accent_headers || {});
            } catch (e) {
                this.user = null;
            }
        },

        // Ширина кнопки пользователя — целое число пикселей экрана.
        // Иначе при масштабе Windows 125–150% край шестерёнки и её меню
        // сглаживаются по-разному и меню кажется на 1px уже кнопки.
        snapNavUser() {
            const el = this.$refs.navUser;
            if (!el) {
                return;
            }
            el.style.minWidth = "";
            const dpr = window.devicePixelRatio || 1;
            const w = el.getBoundingClientRect().width;
            el.style.minWidth = (Math.ceil(w * dpr - 0.01) / dpr) + "px";
        },

        async savePrefs(patch) {
            try {
                const response = await apiFetch("/api/auth/me/prefs", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                return true;
            } catch (e) {
                this.toastError("Не удалось сохранить настройку: " + (e.message || e));
                return false;
            }
        },

        async setTheme(key) {
            const previous = this.theme;
            this.theme = applyTheme(key);
            if (!(await this.savePrefs({ theme: key }))) {
                this.theme = applyTheme(previous);
            }
        },

        async toggleAccentBorders() {
            this.accentBorders = !this.accentBorders;
            if (!(await this.savePrefs({ accent_borders: this.accentBorders }))) {
                this.accentBorders = !this.accentBorders;
            }
        },

        async toggleAccentHeader(page) {
            const on = !this.accentHeaders[page];
            this.accentHeaders = Object.assign({}, this.accentHeaders, { [page]: on });
            if (!(await this.savePrefs({ accent_headers: { [page]: on } }))) {
                this.accentHeaders = Object.assign({}, this.accentHeaders, { [page]: !on });
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
                this.loadColumnStyles();
                this.loadFieldDefs();
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
            this.startLoading();
            this.tableError = "";
            try {
                const response = await apiFetch("/api/computers?archived=all");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                this.rows = data.rows || [];
                duplicateSets = buildDuplicateSets(this.rows);
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
            this.autoWidths = computeAutoWidths(this.rows, this.tableFieldDefs, this.choiceStyleMap, this.columnStyles);
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
            if (!row.archived && DUP_FIELDS.indexOf(col.field) !== -1 && hasDuplicateValue(row[col.field], col.field)) {
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
            if (!row.archived && DUP_FIELDS.indexOf(col.field) !== -1 && hasDuplicateValue(row[col.field], col.field)) {
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
            const base = this.cellTextStyle(row, col) || {};
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
                add: this.$refs.addWrap,
                export: this.$refs.exportWrap,
                settings: this.$refs.settingsWrap,
                user: this.$refs.userWrap,
                page: this.$refs.pageSetWrap
            };
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

        // ---------- Расположение ПК и новый компьютер ----------

        // Дерево нужно для выбора расположения; грузится один раз
        async ensureTree() {
            if (!this.treeRoots.length && !this.treeLoading) {
                await this.loadTree();
            }
        },

        onCellLocationPick(row, locationId) {
            this.cancelEdit();
            this.saveLocation(row, locationId);
        },

        onCardLocationPick(locationId) {
            this.cardEditKey = null;
            if (!this.card) {
                return;
            }
            const row = this.rows.find((item) => item.id === this.card.id) || this.card;
            this.saveLocation(row, locationId);
        },

        // Смена расположения: строка переезжает на своё место в порядке
        // дерева, поэтому таблица перечитывается целиком
        async saveLocation(row, locationId) {
            if (!locationId || locationId === row.location_id) {
                return;
            }
            try {
                const response = await apiFetch("/api/computers/" + row.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ location_id: locationId, _version: row.version })
                });
                if (response.status === 409) {
                    this.toastError(await this.errorText(response));
                    await this.loadTable();
                    this.refreshCardRow();
                    return;
                }
                if (!response.ok) {
                    this.toastError("Не удалось сохранить: " + (await this.errorText(response)));
                    return;
                }
                await this.loadTable();
                this.refreshCardRow();
                this.reloadCardHistory(row.id);
                LOCATION_FIELDS.concat(["location_id"]).forEach((field) => this.flashCell(row.id, field));
                this.$nextTick(() => this.scrollToRow(row.id));
            } catch (e) {
                this.toastError("Не удалось сохранить: " + e);
            }
        },

        // Открыта карточка этого ПК — перечитать её историю после правки
        async reloadCardHistory(id) {
            if (!this.card || this.card.id !== id) {
                return;
            }
            try {
                const response = await apiFetch("/api/computers/" + id);
                if (!response.ok || !this.card || this.card.id !== id) {
                    return;
                }
                const data = await response.json();
                this.cardHistory = data.history || [];
            } catch (e) {
                // не страшно: история обновится при следующем открытии
            }
        },

        // После перечитывания таблицы карточка показывает новую строку
        refreshCardRow() {
            if (!this.card) {
                return;
            }
            const id = this.card.id;
            const row = this.rows.find((item) => item.id === id);
            if (row) {
                this.card = row;
            }
        },

        scrollToRow(id) {
            const wrap = this.$refs.tableWrap;
            const tr = wrap && wrap.querySelector('tr[data-id="' + id + '"]');
            if (!tr) {
                return false;
            }
            const w = wrap.getBoundingClientRect();
            const r = tr.getBoundingClientRect();
            const head = this.$refs.table ? this.$refs.table.tHead.getBoundingClientRect().height : 0;
            if (r.top < w.top + head || r.bottom > w.bottom) {
                wrap.scrollTop += r.top - w.top - head - (w.height - head) / 3;
            }
            return true;
        },

        toggleNewComputer() {
            if (this.newComputer) {
                this.closeNewComputer();
                return;
            }
            // Новый ПК появится среди рабочих — из архива уходим
            this.setArchiveView(false);
            this.actionBar = null;
            this.ensureTree();
            // По умолчанию — узел, выбранный фильтром из дерева
            const locationId = this.locationFilter ? this.locationFilter.id : null;
            this.newComputer = { location_id: locationId, seat_no: "", hostname: "", ip: "" };
            this.newComputerError = "";
            if (locationId) {
                this.newComputer.seat_no = this.nextSeatNo(locationId);
            }
            this.$nextTick(() => this.focusNewComputer(locationId ? "hostname" : "location"));
        },

        closeNewComputer() {
            this.newComputer = null;
            this.newComputerError = "";
        },

        focusNewComputer(which) {
            const el = this.$refs["nc-" + which];
            const input = el && (el.$el ? el.$el.querySelector("input") : el);
            if (input) {
                input.focus();
            }
        },

        // Следующий свободный № места в узле: наибольший + 1
        nextSeatNo(locationId, excludeIds) {
            let max = 0;
            const skip = new Set(excludeIds || []);
            this.rows.forEach(function (row) {
                if (!row.archived && !skip.has(row.id) && row.location_id === locationId && Number(row.seat_no) > max) {
                    max = Number(row.seat_no);
                }
            });
            return String(max + 1);
        },

        onNewComputerLocation(locationId) {
            if (!this.newComputer) {
                return;
            }
            const changed = this.newComputer.location_id !== locationId;
            this.newComputer.location_id = locationId;
            if (changed) {
                this.newComputer.seat_no = this.nextSeatNo(locationId);
            }
            this.newComputerError = "";
            this.$nextTick(() => this.focusNewComputer("hostname"));
        },

        async submitNewComputer() {
            const form = this.newComputer;
            if (!form || this.newComputerSaving) {
                return;
            }
            if (!form.location_id) {
                this.newComputerError = "Выбери расположение.";
                this.focusNewComputer("location");
                return;
            }
            this.newComputerError = "";
            this.newComputerSaving = true;
            try {
                const response = await apiFetch("/api/computers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        location_id: form.location_id,
                        seat_no: form.seat_no,
                        hostname: form.hostname,
                        ip: form.ip
                    })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                await this.loadTable();
                this.flashRow(data.id);
                this.$nextTick(() => {
                    if (!this.scrollToRow(data.id)) {
                        this.toast("Компьютер добавлен, но скрыт поиском или фильтром");
                    }
                });
                (data.shifted || []).forEach((id) => this.flashCell(id, "seat_no"));
                this.toast("Добавлен: " + (form.hostname.trim() || "компьютер без имени") +
                    (data.shifted && data.shifted.length ? ". № места был занят — следующие сдвинуты: " + data.shifted.length : ""), "success");
                // Форма остаётся открытой: можно сразу добавить следующий в тот же узел
                form.hostname = "";
                form.ip = "";
                form.seat_no = this.nextSeatNo(form.location_id);
                this.$nextTick(() => this.focusNewComputer("hostname"));
            } catch (e) {
                this.newComputerError = String(e.message || e);
            }
            this.newComputerSaving = false;
        },

        flashRow(id) {
            this.allColumns.forEach((col) => this.flashCell(id, col.field));
        },

        // «Создан» — первым: в базе ключи изменений хранятся в другом порядке
        orderedChanges(changes) {
            if (!changes || !changes.created) {
                return changes;
            }
            return Object.assign({ created: changes.created }, changes);
        },

        // ---------- Архив ----------

        onArchiveButton() {
            if (this.archiveAction === "toggle") {
                this.setArchiveView(!this.showArchive);
            } else {
                this.setArchived(this.selectedRows.slice(), this.archiveAction === "archive");
            }
        },

        setArchiveView(on) {
            if (this.showArchive === on) {
                return;
            }
            this.showArchive = on;
            // Выбранные строки другого режима не видны — снимаем
            this.selectedRows = [];
            this.selectAnchorId = null;
            if (on) {
                this.closeNewComputer();
            }
            this.actionBar = null;
            this.cancelEdit();
            this.$nextTick(() => {
                if (this.$refs.tableWrap) {
                    this.$refs.tableWrap.scrollTop = 0;
                }
            });
        },

        async setArchived(ids, archived) {
            this.closeMenus();
            if (!ids.length || this.archiveSaving) {
                return;
            }
            this.archiveSaving = true;
            try {
                const response = await apiFetch("/api/computers/archive", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ids: ids, archived: archived })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                let text;
                if (ids.length === 1) {
                    const row = this.rows.find(function (r) { return r.id === ids[0]; });
                    const name = (row && row.hostname) || "компьютер без имени";
                    text = (archived ? "В архиве: " : "Возвращён из архива: ") + name;
                } else {
                    text = (archived ? "В архив убрано ПК: " : "Возвращено из архива ПК: ") + ids.length;
                }
                this.selectedRows = [];
                this.selectAnchorId = null;
                await this.loadTable();
                if (this.card && ids.indexOf(this.card.id) !== -1) {
                    this.refreshCardRow();
                    this.reloadCardHistory(this.card.id);
                }
                this.toast(text, "success");
            } catch (e) {
                this.toastError("Не удалось: " + (e.message || e));
            }
            this.archiveSaving = false;
        },

        // ---------- Действия с выбранными строками ----------

        // Выбранные ПК в порядке таблицы (так они и встанут при перемещении)
        selectedInOrder() {
            const set = this.selectedSet;
            const shown = this.displayRows.filter(function (row) { return set.has(row.id); }).map(function (row) { return row.id; });
            const rest = this.selectedRows.filter(function (id) { return shown.indexOf(id) === -1; });
            return shown.concat(rest);
        },

        rowName(id) {
            const row = this.rows.find(function (r) { return r.id === id; });
            return (row && row.hostname) || "компьютер без имени";
        },

        openAction(kind) {
            this.closeMenus();
            this.closeNewComputer();
            this.cancelEdit();
            this.ensureTree();
            const ids = this.selectedInOrder();
            const bar = { kind: kind, ids: ids, error: "", saving: false, location_id: null, with_people: true };
            if (kind === "move") {
                bar.seat_no = "";
            } else if (kind === "replace") {
                bar.new_id = null;
            } else if (kind === "bulk") {
                bar.field = (this.bulkColumns[0] || {}).field || "";
                bar.value = "";
            }
            this.actionBar = bar;
            this.$nextTick(() => this.focusAction(kind === "replace" ? "new" : kind === "bulk" ? "value" : "location"));
        },

        closeAction() {
            this.actionBar = null;
        },

        focusAction(which) {
            const el = this.$refs["ab-" + which];
            const input = el && (el.$el ? el.$el.querySelector("input") : el);
            if (input) {
                input.focus();
            }
        },

        actionTitle() {
            const bar = this.actionBar;
            if (!bar) {
                return "";
            }
            const what = bar.ids.length === 1 ? "«" + this.rowName(bar.ids[0]) + "»" : bar.ids.length + " ПК";
            if (bar.kind === "move") {
                return "Переместить " + what + " в:";
            }
            if (bar.kind === "replace") {
                return "Заменить " + what + " на:";
            }
            return "Изменить у " + what + ":";
        },

        onActionLocation(locationId) {
            const bar = this.actionBar;
            if (!bar) {
                return;
            }
            const changed = bar.location_id !== locationId;
            bar.location_id = locationId;
            bar.error = "";
            if (bar.kind === "move") {
                if (changed) {
                    bar.seat_no = this.nextSeatNo(locationId, bar.ids);
                }
                this.$nextTick(() => this.focusAction("seat"));
            }
        },

        // Новый ПК выбран: старый по умолчанию уходит туда, откуда взят новый
        onReplaceNew(computerId) {
            const bar = this.actionBar;
            if (!bar) {
                return;
            }
            bar.new_id = computerId;
            bar.error = "";
            const row = this.rows.find(function (r) { return r.id === computerId; });
            if (!bar.location_id && row && row.location_id) {
                bar.location_id = row.location_id;
            }
            this.$nextTick(() => this.focusAction("location"));
        },

        async submitAction() {
            const bar = this.actionBar;
            if (!bar || bar.saving) {
                return;
            }
            let url;
            let body;
            if (bar.kind === "move") {
                if (!bar.location_id) {
                    bar.error = "Выбери, куда переместить.";
                    return;
                }
                url = "/api/computers/move";
                body = { ids: bar.ids, location_id: bar.location_id, seat_no: bar.seat_no, with_people: bar.with_people };
            } else if (bar.kind === "replace") {
                if (!bar.new_id) {
                    bar.error = "Выбери новый ПК.";
                    return;
                }
                if (!bar.location_id) {
                    bar.error = "Выбери, куда убрать старый.";
                    return;
                }
                url = "/api/computers/replace";
                body = { old_id: bar.ids[0], new_id: bar.new_id, location_id: bar.location_id, with_people: bar.with_people };
            } else {
                if (!bar.field) {
                    bar.error = "Выбери поле.";
                    return;
                }
                url = "/api/computers/bulk-update";
                body = { ids: bar.ids, field: bar.field, value: bar.value };
            }
            bar.error = "";
            bar.saving = true;
            const done = await this.runAction(url, body, (data) => {
                if (bar.kind === "move") {
                    return bar.ids.length === 1 ? "Перемещён: " + this.rowName(bar.ids[0]) : "Перемещено ПК: " + bar.ids.length;
                }
                if (bar.kind === "replace") {
                    return "Заменён: " + this.rowName(bar.ids[0]) + " → " + this.rowName(bar.new_id);
                }
                return "Изменено у ПК: " + data.changed.length + " из " + bar.ids.length;
            }, (message) => { bar.error = message; });
            bar.saving = false;
            if (done) {
                this.actionBar = null;
            }
        },

        // Enter в строке действия — выполнить (открытый список выбора
        // расположения забирает Enter себе и дальше его не пускает)
        onActionEnter(event) {
            if (event.target.tagName === "SELECT" || event.target.tagName === "BUTTON") {
                return;
            }
            event.preventDefault();
            this.submitAction();
        },

        async startSwap() {
            this.closeMenus();
            const ids = this.selectedInOrder();
            if (ids.length !== 2) {
                return;
            }
            const text = "Поменять местами «" + this.rowName(ids[0]) + "» и «" + this.rowName(ids[1]) + "»?\n" +
                "Меняются расположение и № места, остальное остаётся при своих ПК.";
            if (!(await this.confirmDialog(text, { okText: "Поменять" }))) {
                return;
            }
            await this.runAction("/api/computers/swap", { ids: ids }, () => "Поменяны местами: " + this.rowName(ids[0]) + " и " + this.rowName(ids[1]), (message) => this.toastError(message));
        },

        // Запрос действия; после успеха — таблица перечитывается, затронутые
        // строки вспыхивают, выделение снимается
        async runAction(url, body, doneText, onError) {
            try {
                const response = await apiFetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (!response.ok) {
                    onError(await this.errorText(response));
                    return false;
                }
                const data = await response.json();
                const text = doneText(data);
                this.selectedRows = [];
                this.selectAnchorId = null;
                await this.loadTable();
                this.refreshCardRow();
                if (this.card) {
                    this.reloadCardHistory(this.card.id);
                }
                (data.changed || []).forEach((id) => this.flashRow(id));
                const first = (data.ids || [])[0];
                if (first) {
                    this.$nextTick(() => this.scrollToRow(first));
                }
                this.toast(text, "success");
                return true;
            } catch (e) {
                onError(String(e.message || e));
                return false;
            }
        },

        // ---------- Правка в карточке (двойной клик по строке) ----------

        cardEditCol(r) {
            if (!r || r.group) {
                return null;
            }
            if (CARD_EDIT_EXTRA[r.key]) {
                return CARD_EDIT_EXTRA[r.key];
            }
            const field = r.key.indexOf("x-") === 0 ? r.key.slice(2) : r.key;
            const col = this.allColumns.find(function (c) { return c.field === field; });
            return col && col.editable ? col : null;
        },

        isCardEditable(r) {
            return this.canEdit && !!this.cardEditCol(r);
        },

        onCardRowDblclick(event, r) {
            // Двойной клик по самому значению — это два копирования, не правка
            if (event.target.closest(".copy-val")) {
                return;
            }
            if (!this.isCardEditable(r) || this.cardEditKey === r.key) {
                return;
            }
            const sel = window.getSelection && window.getSelection();
            if (sel) {
                sel.removeAllRanges();
            }
            this.cardEditKey = r.key;
            if (this.cardEditCol(r).location) {
                this.ensureTree();
                return;
            }
            const value = this.card[this.cardEditCol(r).field];
            this.cardEditValue = value === null || value === undefined ? "" : String(value);
            this.$nextTick(() => {
                const el = this.$refs.cardEditor;
                const input = Array.isArray(el) ? el[0] : el;
                if (!input) {
                    return;
                }
                this.growCardEditor(input);
                input.focus({ preventScroll: true });
                const len = input.value.length;
                input.setSelectionRange(len, len);
            });
        },

        growCardEditor(el) {
            const td = el.closest("td");
            if (!td) {
                return;
            }
            el.style.width = td.clientWidth + "px";
            el.style.height = td.clientHeight + "px";
            if (el.scrollHeight > el.clientHeight) {
                el.style.height = el.scrollHeight + 2 + "px";
            }
        },

        onCardEditKeydown(event, r) {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                this.saveCardEdit(r);
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation(); // Esc отменяет правку, а не закрывает карточку
                this.cardEditKey = null;
            }
        },

        saveCardEdit(r) {
            if (this.cardEditKey !== r.key || !this.card) {
                return;
            }
            const col = this.cardEditCol(r);
            this.cardEditKey = null;
            if (!col) {
                return;
            }
            const row = this.rows.find((item) => item.id === this.card.id) || this.card;
            const old = row[col.field] === null || row[col.field] === undefined ? "" : String(row[col.field]);
            if (this.cardEditValue === old) {
                return;
            }
            this.saveCellValue(row, col, this.cardEditValue);
        },

        isCardFlash(r) {
            const col = this.cardEditCol(r);
            return !!(this.card && col && this.savedFlash[this.card.id + ":" + col.field]);
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
                    duplicateSets = buildDuplicateSets(this.rows);
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

        // ---------- Карточка ----------

        async openCard(row) {
            this.card = row;
            this.setHoverRow(null); // подсветка остаётся на строке карточки
            this.cardHistoryOpen = false;
            this.cardEditKey = null;
            this.cardHostname = row.hostname || "";
            this.editingHostname = false;
            this.cardLoading = true;
            this.startLoading();
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
            this.finishLoading();
            this.cardLoading = false;
        },

        // ---------- История: строки дней ----------
        // Липкая строка дня прилипает под шапкой, но у ячеек таблицы границей
        // прилипания служит вся таблица, а не день (tbody) — строки дней
        // наезжали друг на друга. Поэтому следующий день выталкивает
        // прилипшую строку вверх вручную, как адреса в Дереве.
        onHistoryScroll() {
            if (this._dayRaf) {
                return;
            }
            this._dayRaf = requestAnimationFrame(() => {
                this._dayRaf = null;
                this.pushHistoryDays();
            });
        },

        pushHistoryDays() {
            const sc = this.$refs.historyScroll;
            const table = sc ? sc.querySelector(".history-table") : null;
            if (!table || !table.tHead) {
                return;
            }
            const headH = table.tHead.offsetHeight;
            const limit = sc.getBoundingClientRect().top + headH;
            Array.prototype.forEach.call(table.tBodies, function (tbody) {
                const dayCell = tbody.rows[0] && tbody.rows[0].cells[0];
                const last = tbody.rows[tbody.rows.length - 1];
                if (!dayCell || !last) {
                    return;
                }
                const push = last.getBoundingClientRect().bottom - dayCell.offsetHeight - limit;
                const top = push < 0 ? (headH + push) + "px" : "";
                if (dayCell.style.top !== top) {
                    dayCell.style.top = top;
                }
            });
        },

        closeCard() {
            this.card = null;
            this.setHoverRow(null);
        },

        openCardById(id) {
            const row = this.rows.find(function (r) { return r.id === id; });
            if (row) {
                this.openCard(row);
            } else {
                this.toast("Этого ПК нет в таблице");
            }
        },

        toggleCardHistory() {
            this.cardHistoryOpen = !this.cardHistoryOpen;
        },

        // Оформление значения в карточке — как в таблице: значение из
        // Справочников поверх оформления столбца. line — строка значения
        // (у многострочных — каждая своя); без line — первая оформленная.
        cardValueStyle(r, line) {
            if (!r.field) {
                return null;
            }
            const fieldStyles = this.choiceStyleMap[r.field] || {};
            let choice = null;
            const lines = line === undefined ? String(r.value).split("\n") : [line];
            for (const l of lines) {
                const s = fieldStyles[styleKey(r.field, l)];
                if (s) {
                    choice = s;
                    break;
                }
            }
            const st = this.effectiveStyle(r.field, choice);
            return st.color || st.backgroundColor || st.fontWeight || st.fontStyle ? st : null;
        },

        splitLines(value) {
            return splitMulti(value);
        },

        // Копирование в буфер. navigator.clipboard работает только по https
        // или на localhost, поэтому есть запасной путь через execCommand.
        async copyText(text) {
            text = String(text);
            let ok = false;
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(text);
                    ok = true;
                }
            } catch (e) {
                ok = false;
            }
            if (!ok) {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.setAttribute("readonly", "");
                ta.style.position = "fixed";
                ta.style.top = "-1000px";
                document.body.appendChild(ta);
                ta.select();
                try {
                    ok = document.execCommand("copy");
                } catch (e) {
                    ok = false;
                }
                ta.remove();
            }
            if (ok) {
                this.toast("Скопировано: " + text, "success", 1800);
            } else {
                this.toastError("Не удалось скопировать");
            }
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
                    body: JSON.stringify({
                        hostname: newValue === "" ? null : newValue,
                        _version: this.card.version
                    })
                });
                if (response.status === 409) {
                    this.toastError(await this.errorText(response));
                    this.closeCard();
                    await this.loadTable();
                    return;
                }
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
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
                this.dupVersion++;
                    this.recalcWidths();
                    this.card = updatedRow;
                    this.toast("Имя сохранено", "success");
                }
                this.reloadCardHistory(id);
            } catch (e) {
                this.editingHostname = true;
                this.toastError("Не удалось сохранить: " + (e.message || e));
            }
        },

        // ---------- Дерево ----------

        async loadTree() {
            this.treeLoading = true;
            this.startLoading();
            this.treeError = "";
            try {
                const response = await apiFetch("/api/locations/tree");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                this.treeRoots = data.roots || [];
                this.treeHover = null;
                this.$nextTick(() => this.watchTreeScroll());
                this.unlocated = data.unlocated || 0;
                this.buildTreeIndex();
            } catch (e) {
                this.treeError = String(e.message || e);
            }
            this.finishLoading();
            this.treeLoading = false;
        },

        buildTreeIndex() {
            const index = {};
            const walk = (nodes, parts) => {
                nodes.forEach((node) => {
                    // Как в дереве: «214 Процедурная», «2 этаж»
                    const t = treeNodeTexts(node);
                    const title = [t.code, t.name].filter(Boolean).join(" ") || node.name || node.code || "";
                    const path = parts.concat([title]).join(" → ");
                    index[node.id] = { node: node, path: path };
                    if (node.children && node.children.length) {
                        walk(node.children, parts.concat([title]));
                    }
                });
            };
            walk(this.treeRoots, []);
            this.treeIndex = index;
            this.treeWidth = computeTreeWidth(this.treeRoots);
        },

        kindLabel(kind) {
            return kindLabels[kind] || kind;
        },

        // Плашка действий у строки дерева — одна на всё дерево и стоит
        // снаружи таблицы (сама таблица обрезана по скруглённой рамке)
        setTreeHover(node, rowEl) {
            const wrap = rowEl.closest(".tree-wrap");
            if (!wrap) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const r = rowEl.getBoundingClientRect();
            this.treeHover = { id: node.id, node: node, top: r.top - w.top, height: r.height };
        },

        // Когда у дерева появляется полоса прокрутки, колонка расширяется
        // на её ширину — текст узлов не обрезается
        watchTreeScroll() {
            const el = this.$refs.treeScroll;
            const content = this.$refs.treeContent;
            if (!el || !content || this._treeObservedEl === el) {
                return;
            }
            if (this._treeObserver) {
                this._treeObserver.disconnect();
            }
            const update = () => {
                const sb = el.offsetWidth - el.clientWidth;
                if (sb !== this.treeScrollbar) {
                    this.treeScrollbar = sb;
                }
            };
            this._treeObserver = new ResizeObserver(update);
            this._treeObserver.observe(el);
            this._treeObserver.observe(content);
            this._treeObservedEl = el;
            update();
        },

        treeAction(method) {
            const hover = this.treeHover;
            this.treeHover = null;
            if (hover) {
                this[method](hover.node);
            }
        },

        // Раскрыт ли узел: по умолчанию всё свёрнуто; что раскрыл пользователь —
        // остаётся раскрытым до перезагрузки страницы
        isTreeOpen(node, level) {
            const state = this.treeOpenState[node.id];
            return state === true;
        },

        setTreeOpen(id, open) {
            this.treeOpenState[id] = open;
        },

        setAllTreeOpen(open) {
            const state = {};
            const walk = (nodes) => {
                nodes.forEach((node) => {
                    if (node.children && node.children.length) {
                        state[node.id] = open;
                        walk(node.children);
                    }
                });
            };
            walk(this.treeRoots);
            this.treeOpenState = state;
        },

        expandAllTree() {
            this.setAllTreeOpen(true);
        },

        collapseAllTree() {
            this.setAllTreeOpen(false);
        },

        // Показать в таблице только ПК из узла и всех вложенных
        showLocationInTable(node) {
            const ids = new Set();
            const walk = (n) => {
                ids.add(n.id);
                (n.children || []).forEach(walk);
            };
            walk(node);
            const entry = this.treeIndex[node.id];
            this.setArchiveView(false);
            this.locationFilter = {
                id: node.id,
                path: entry ? entry.path : (node.name || node.code || ""),
                ids: ids
            };
            this.setView("table");
        },

        kindLabel(kind) {
            return kindLabels[kind] || kind;
        },

        // Подсветка слов поиска Справочников в тексте
        hl(text) {
            return highlightParts(String(text || ""), this.choicesMatch.words);
        },

        nextChoicesBlock() {
            if (this.choicesMatch.blocks.length) {
                this.choicesPos = (this.choicesPos + 1) % this.choicesMatch.blocks.length;
                this.scrollToChoicesHit();
            }
        },

        // Показать текущий найденный раздел и первое совпавшее значение в нём
        scrollToChoicesHit() {
            this.$nextTick(() => {
                const field = this.choicesMatch.current;
                if (!field) {
                    return;
                }
                const block = document.querySelector('.st-block[data-field="' + field + '"]');
                if (!block) {
                    return;
                }
                block.scrollIntoView({ block: "nearest" });
                const row = block.querySelector(".st-row.search-hit");
                const list = block.querySelector(".st-values");
                if (row && list) {
                    list.scrollTop = row.offsetTop - list.offsetTop - 25;
                }
            });
        },

        // node — родитель («+» у строки дерева); без него — с панели, kind —
        // что добавить (выбрано в меню «+»), родитель — из списка в форме
        openAddForm(node, kind) {
            const allowedChildren = {
                building: ["department"],
                department: ["floor", "room"],
                floor: ["room"]
            };
            // Кнопка на панели: любой тип, родитель — из списка
            let kinds = ["building", "department", "floor", "room"];
            let path = "";
            if (node) {
                kinds = allowedChildren[node.kind] || [];
                if (!kinds.length) {
                    return;
                }
                this.setTreeOpen(node.id, true);
                const entry = this.treeIndex[node.id];
                path = entry ? entry.path : "";
            }
            if (kind && kinds.indexOf(kind) !== -1) {
                kinds = [kind];
            }
            this.treeForm = {
                action: "add",
                top: !node,
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

        // Куда можно добавить узел этого типа — для формы на панели
        treeParentOptions(kind) {
            const parentKinds = {
                department: ["building"],
                floor: ["department"],
                room: ["department", "floor"]
            }[kind] || [];
            return Object.keys(this.treeIndex)
                .map((id) => this.treeIndex[id])
                .filter(function (e) { return parentKinds.indexOf(e.node.kind) !== -1; })
                .map(function (e) { return { id: e.node.id, path: e.path }; })
                .sort(function (a, b) { return a.path.localeCompare(b.path, "ru", { numeric: true }); });
        },

        async submitTreeForm() {
            const form = this.treeForm;
            if (!form) {
                return;
            }
            this.treeFormError = "";
            if (form.top) {
                if (form.kind === "building") {
                    form.parentId = null;
                } else if (!form.parentId) {
                    this.treeFormError = "Выбери, куда добавить.";
                    return;
                }
            }
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
            if (!(await this.confirmDialog("Архивировать «" + path + "»?\nУзел исчезнет из дерева.", { okText: "Архивировать", danger: true }))) {
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
                this.toastError("Не удалось архивировать: " + e);
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
                this.toastError("Не удалось переместить: " + e);
            }
        },

        // ---------- История ----------

        async loadHistory() {
            this.historyLoading = true;
            this.startLoading();
            this.historyError = "";
            try {
                const response = await apiFetch("/api/history?limit=200");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                this.historyItems = data.items || [];
            } catch (e) {
                this.historyError = String(e.message || e);
            }
            this.finishLoading();
            this.historyLoading = false;
        },

        // ---------- Справочники ----------
        async loadChoices() {
            this.choicesLoading = true;
            this.startLoading();
            try {
                const response = await apiFetch("/api/choices");
                const data = await response.json();
                this.choicesItems = data.items || [];
            } catch (e) {
                // тихо
            }
            this.finishLoading();
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
                vnc: "VNC",
                gsit: "GSIT",
                state: "Сост.",
                label: "Метка"
            };
            return labels[field] || field;
        },

        async addChoice(field) {
            let value = (this.newChoiceValue[field] || "").trim();
            if (!value) {
                return;
            }
            if (field === "ip") {
                const subnet = ipSubnetKey(value);
                if (!subnet) {
                    this.toastError("Подсеть: первые три числа адреса, например 10.0.5 или 10.0.5.0/24");
                    return;
                }
                value = subnet;
            }
            try {
                const response = await apiFetch("/api/choices", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ field: field, value: value })
                });
                if (!response.ok) {
                    const data = await response.json();
                    this.toastError(data.detail || "Ошибка");
                    return;
                }
                this.newChoiceValue[field] = "";
                await this.loadChoices();
            } catch (e) {
                this.toastError("Не удалось добавить: " + e);
            }
        },

        // ---------- Оформление столбцов и значений ----------

        async loadColumnStyles() {
            try {
                const response = await apiFetch("/api/column-styles");
                if (!response.ok) {
                    return;
                }
                const data = await response.json();
                const map = {};
                (data.items || []).forEach(function (item) {
                    map[item.field] = item;
                });
                this.columnStyles = map;
            } catch (e) {
                // тихо: без оформления столбцов таблица всё равно работает
            }
        },

        hasStyle(st) {
            return !!(st && (st.color || st.bg_color || st.bold || st.italic));
        },

        // Как значение выглядит в таблице: столбец + значение поверх
        effectiveStyle(field, choice) {
            const col = this.columnStyles[field] || {};
            const val = choice || {};
            return {
                color: val.color || col.color || null,
                backgroundColor: val.bg_color || col.bg_color || null,
                fontWeight: (val.bold || col.bold) ? "700" : null,
                fontStyle: (val.italic || col.italic) ? "italic" : null
            };
        },

        async setColumnStyle(field, patch) {
            try {
                const response = await apiFetch("/api/column-styles/" + encodeURIComponent(field), {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                const next = Object.assign({}, this.columnStyles);
                if (this.hasStyle(data.item)) {
                    next[field] = data.item;
                } else {
                    delete next[field];
                }
                this.columnStyles = next;
                if ("bold" in patch) {
                    this.recalcWidths();
                }
            } catch (e) {
                this.toastError("Не удалось сохранить оформление: " + (e.message || e));
            }
        },

        resetColumnStyle(field) {
            this.setColumnStyle(field, { color: "", bg_color: "", bold: false, italic: false });
        },

        // Значение из данных, которого нет в справочнике, добавляется туда
        // при первом изменении оформления.
        async ensureChoice(field, entry) {
            if (entry.choice) {
                return entry.choice;
            }
            const response = await apiFetch("/api/choices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ field: field, value: entry.value })
            });
            if (!response.ok) {
                throw new Error(await this.errorText(response));
            }
            const data = await response.json();
            const maxSort = this.choicesItems
                .filter(function (c) { return c.field === field; })
                .reduce(function (m, c) { return Math.max(m, c.sort || 0); }, 0);
            this.choicesItems.push({
                id: data.id, field: field, value: entry.value, sort: maxSort + 1,
                color: null, bg_color: null, bold: false, italic: false
            });
            return this.choicesItems[this.choicesItems.length - 1];
        },

        async setValueStyle(field, entry, patch) {
            try {
                const choice = await this.ensureChoice(field, entry);
                const response = await apiFetch("/api/choices/" + choice.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                Object.keys(patch).forEach(function (k) {
                    const v = patch[k];
                    choice[k] = (k === "color" || k === "bg_color") ? (v || null) : v;
                });
                if ("bold" in patch) {
                    this.recalcWidths();
                }
            } catch (e) {
                this.toastError("Не удалось сохранить оформление: " + (e.message || e));
            }
        },

        resetValueStyle(field, entry) {
            this.setValueStyle(field, entry, { color: "", bg_color: "", bold: false, italic: false });
        },

        async deleteChoice(item) {
            if (!(await this.confirmDialog("Удалить значение «" + item.value + "» из справочника?", { okText: "Удалить", danger: true }))) {
                return;
            }
            try {
                const response = await apiFetch("/api/choices/" + item.id, {
                    method: "DELETE"
                });
                if (!response.ok) {
                    const data = await response.json();
                    this.toastError(data.detail || "Не удалось удалить");
                    return;
                }
                await this.loadChoices();
                this.recalcWidths();
            } catch (e) {
                this.toastError("Не удалось удалить: " + e);
            }
        },

        // ---------- Пользовательские поля ----------
        async loadFieldDefs() {
            this.fieldDefsLoading = true;
            this.startLoading();
            try {
                const response = await apiFetch("/api/field-defs");
                const data = await response.json();
                this.fieldDefs = data.items || [];
            } catch (e) {
                // тихо
            }
            this.finishLoading();
            this.fieldDefsLoading = false;
        },

        async addFieldDef() {
            const key = this.newFieldDef.key.trim();
            const label = this.newFieldDef.label.trim();
            if (!key || !label) {
                return;
            }
            try {
                const response = await apiFetch("/api/field-defs", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        key: key,
                        label: label,
                        field_type: this.newFieldDef.field_type
                    })
                });
                if (!response.ok) {
                    const data = await response.json();
                    this.toastError(data.detail || "Ошибка");
                    return;
                }
                this.newFieldDef = { key: "", label: "", field_type: "text" };
                await this.loadFieldDefs();
                this.recalcWidths();
            } catch (e) {
                this.toastError("Не удалось создать: " + e);
            }
        },

        startRenameFieldDef(fd) {
            this.fieldDefEdit = { id: fd.id, label: fd.label };
            this.$nextTick(() => {
                const el = document.querySelector(".fd-rename");
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },

        async saveRenameFieldDef(fd) {
            const edit = this.fieldDefEdit;
            if (!edit || edit.id !== fd.id) {
                return;
            }
            this.fieldDefEdit = null;
            const label = edit.label.trim();
            if (!label || label === fd.label) {
                return;
            }
            await this.patchFieldDef(fd, { label: label });
        },

        async patchFieldDef(fd, patch) {
            try {
                const response = await apiFetch("/api/field-defs/" + fd.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                return true;
            } catch (e) {
                this.toastError("Не удалось сохранить: " + (e.message || e));
                return false;
            } finally {
                await this.loadFieldDefs();
                this.recalcWidths();
            }
        },

        // Порядок пользовательских полей = порядок их столбцов в таблице
        async moveFieldDef(fd, dir) {
            const list = this.fieldDefs.slice();
            const index = list.findIndex(function (f) { return f.id === fd.id; });
            const target = list[index + dir];
            if (!target) {
                return;
            }
            list[index] = target;
            list[index + dir] = fd;
            // Перенумеровать подряд — у старых полей sort мог совпадать
            const changed = [];
            list.forEach(function (f, i) {
                if (f.sort !== i + 1) {
                    changed.push({ f: f, sort: i + 1 });
                }
            });
            try {
                for (const c of changed) {
                    const response = await apiFetch("/api/field-defs/" + c.f.id, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ sort: c.sort })
                    });
                    if (!response.ok) {
                        throw new Error(await this.errorText(response));
                    }
                }
            } catch (e) {
                this.toastError("Не удалось переместить: " + (e.message || e));
            }
            await this.loadFieldDefs();
        },

        async archiveFieldDef(item) {
            if (!(await this.confirmDialog("Архивировать поле «" + item.label + "»?\nОно исчезнет из таблицы.", { okText: "Архивировать", danger: true }))) {
                return;
            }
            try {
                const response = await apiFetch("/api/field-defs/" + item.id + "/archive", {
                    method: "POST"
                });
                if (!response.ok) {
                    this.toastError("Не удалось архивировать: " + (await this.errorText(response)));
                    return;
                }
                await this.loadFieldDefs();
            } catch (e) {
                this.toastError("Не удалось архивировать: " + e);
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
            const d = new Date(value);
            if (isNaN(d.getTime())) {
                return String(value);
            }
            return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear() + " " +
                pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
        },

        formatDate(value) {
            const d = new Date(value);
            if (!value || isNaN(d.getTime())) {
                return "";
            }
            return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear();
        },

        // Время для таблицы истории: «чч:мм:сс» (дата — в строке дня)
        formatClock(value) {
            const d = new Date(value);
            if (!value || isNaN(d.getTime())) {
                return String(value || "");
            }
            return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
        },

        entityLabel(entity) {
            if (entity === "computers") {
                return "ПК";
            }
            if (entity === "locations") {
                return "Расположение";
            }
            return entity;
        },

        fieldLabel(entity, field) {
            if (entity === "locations") {
                return LOCATION_FIELD_LABELS[field] || field;
            }
            // Поля из computers.extra пишутся в историю как «extra.<ключ>»
            if (field && field.indexOf("extra.") === 0) {
                field = field.slice(6);
                const builtin = { "GSIT": "gsit", "Сост.": "state", "Метка": "label" }[field];
                if (builtin) {
                    return FIELD_LABELS[builtin];
                }
            }
            if (FIELD_LABELS[field]) {
                return FIELD_LABELS[field];
            }
            const fd = this.fieldDefs.find(function (item) { return item.key === field; });
            return fd ? fd.label : field;
        },

        // ---------- Полоска загрузки ----------

        startLoading() {
            this._loadCount = (this._loadCount || 0) + 1;
            if (this._loadCount !== 1) {
                return;
            }
            const el = this.$refs.loadBar;
            if (!el) {
                return;
            }
            clearTimeout(this._loadHideTimer);
            el.classList.remove("running", "done");
            void el.offsetWidth; // сброс, чтобы анимация началась с нуля
            el.classList.add("running");
        },

        finishLoading() {
            this._loadCount = Math.max(0, (this._loadCount || 0) - 1);
            if (this._loadCount !== 0) {
                return;
            }
            const el = this.$refs.loadBar;
            if (!el) {
                return;
            }
            el.classList.add("done");
            this._loadHideTimer = setTimeout(() => {
                if (!this._loadCount) {
                    el.classList.remove("running", "done");
                }
            }, 700);
        },

        // ---------- Сообщения и подтверждения ----------

        toast(text, type, ms) {
            const id = (this._toastSeq = (this._toastSeq || 0) + 1);
            this.toasts.push({ id: id, text: String(text), type: type || "info" });
            const delay = ms || (type === "error" ? 7000 : 3000);
            setTimeout(() => {
                this.dismissToast(id);
            }, delay);
        },

        toastError(text) {
            this.toast(text, "error");
        },

        dismissToast(id) {
            this.toasts = this.toasts.filter(function (t) { return t.id !== id; });
        },

        confirmDialog(text, options) {
            const opts = options || {};
            if (this.dialog) {
                this.dialog.resolve(false);
            }
            return new Promise((resolve) => {
                this.dialog = {
                    text: text,
                    okText: opts.okText || "OK",
                    danger: !!opts.danger,
                    resolve: resolve
                };
                this.$nextTick(() => {
                    if (this.$refs.dialogOk) {
                        this.$refs.dialogOk.focus();
                    }
                });
            });
        },

        closeDialog(result) {
            const dialog = this.dialog;
            this.dialog = null;
            if (dialog) {
                dialog.resolve(result);
            }
        },

        // Зелёная вспышка после сохранения. Повторное сохранение той же
        // ячейки во время вспышки перезапускает её с начала.
        flashCell(rowId, field) {
            const key = rowId + ":" + field;
            this._flashTimers = this._flashTimers || {};
            const drop = () => {
                const next = Object.assign({}, this.savedFlash);
                delete next[key];
                this.savedFlash = next;
            };
            const start = () => {
                this.savedFlash = Object.assign({}, this.savedFlash, { [key]: true });
                clearTimeout(this._flashTimers[key]);
                this._flashTimers[key] = setTimeout(drop, 1500);
            };
            if (this.savedFlash[key]) {
                drop();
                this.$nextTick(() => requestAnimationFrame(start));
            } else {
                start();
            }
        },

        displayValue(value) {
            if (value === null || value === undefined) {
                return "—";
            }
            if (typeof value === "boolean") {
                return value ? "да" : "нет";
            }
            if (typeof value === "object") {
                return JSON.stringify(value);
            }
            return String(value);
        },

        // withArchive — ещё лист «Архив» с ПК из архива
        async downloadExport(withArchive) {
            try {
                const response = await apiFetch("/api/export/computers.xlsx" + (withArchive ? "?archive=true" : ""));
                if (!response.ok) {
                    this.toastError("Не удалось выгрузить: " + (await this.errorText(response)));
                    return;
                }
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
                setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
            } catch (e) {
                this.toastError("Не удалось выгрузить: " + e);
            }
        }
    }
});

const KIND_ICONS = {
    building: '<path d="M8 14.5s4.5-4.2 4.5-8a4.5 4.5 0 0 0-9 0c0 3.8 4.5 8 4.5 8z"/><circle cx="8" cy="6.5" r="1.6"/>',
    department: '<path d="M2 4.5h4l1.2 1.5H14v7.5H2z"/>',
    floor: '<path d="M8 2 14 5 8 8 2 5zM2 8l6 3 6-3M2 11l6 3 6-3"/>',
    room: '<path d="M4 14V2.5h8V14M2.5 14h11M9.5 8.5h0.01"/>'
};

// ------------------------------------------------------------
// Геометрия строки дерева. Те же числа — в app.css (раздел «Дерево»),
// по ним считается ширина колонки дерева.
// ------------------------------------------------------------
const TREE = {
    padL: 6,         // отступ строки слева
    indent: 18,      // сдвиг на уровень
    toggle: 12,      // стрелка
    gap: 5,          // промежуток между стрелкой, значком и названием
    icon: 14,        // значок
    codeMin: 30,     // номер кабинета — колонкой
    codeGap: 6,
    padR: 10,
    countCol: 46,    // столбец «ПК»
    border: 2,       // рамка таблицы
    min: 300
};
// Шрифт по типу узла: [размер, жирность, заглавные]
const TREE_FONTS = {
    building: [13, 600, false],
    department: [13, 400, false],
    floor: [13, 400, false],
    room: [13, 400, false]
};

// Подпись узла: номер кабинета отдельно, у этажа — «2 этаж»
function treeNodeTexts(node) {
    let code = "";
    let name = node.name || node.code || "";
    if (node.kind === "room" && node.code) {
        code = node.code;
        name = (!node.name || node.name === node.code) ? "" : node.name;
    }
    if (node.kind === "floor" && /^\d+$/.test(String(node.name || "").trim())) {
        name = node.name + " этаж";
    }
    return { code: code, name: name };
}

let treeCanvas = null;

function computeTreeWidth(roots) {
    treeCanvas = treeCanvas || document.createElement("canvas");
    const ctx = treeCanvas.getContext("2d");
    const family = window.getComputedStyle(document.body).fontFamily;
    function textWidth(text, size, weight, upper) {
        if (!text) {
            return 0;
        }
        ctx.font = weight + " " + size + "px " + family;
        const t = upper ? text.toUpperCase() : text;
        // letter-spacing у заглавных подписей этажей: 0.04em
        return ctx.measureText(t).width + (upper ? t.length * size * 0.04 : 0);
    }
    let max = TREE.min;
    const walk = function (nodes, level) {
        nodes.forEach(function (node) {
            const f = TREE_FONTS[node.kind] || TREE_FONTS.room;
            const t = treeNodeTexts(node);
            let title = textWidth(t.name, f[0], f[1], f[2]);
            if (t.code) {
                title += Math.max(TREE.codeMin, textWidth(t.code, 13, 600, false)) + (t.name ? TREE.codeGap : 0);
            }
            const w = TREE.padL + level * TREE.indent + TREE.toggle + TREE.gap + TREE.icon + TREE.gap +
                title + TREE.padR + TREE.countCol + TREE.border;
            if (w > max) {
                max = w;
            }
            if (node.children && node.children.length) {
                walk(node.children, level + 1);
            }
        });
    };
    walk(roots || [], 0);
    return Math.ceil(max) + 2;
}

// Разбивка строки на части для подсветки найденного (любое из слов)
function highlightParts(text, words) {
    text = text || "";
    if (!words || !words.length) {
        return [{ t: text, m: false }];
    }
    const lower = searchNorm(text);
    const marked = new Array(text.length).fill(false);
    words.forEach(function (w) {
        let idx = lower.indexOf(w);
        while (idx !== -1) {
            for (let i = idx; i < idx + w.length; i++) {
                marked[i] = true;
            }
            idx = lower.indexOf(w, idx + w.length);
        }
    });
    const parts = [];
    let i = 0;
    while (i < text.length) {
        let j = i;
        while (j < text.length && marked[j] === marked[i]) {
            j++;
        }
        parts.push({ t: text.slice(i, j), m: marked[i] });
        i = j;
    }
    return parts.length ? parts : [{ t: text, m: false }];
}

app.component("tree-node", {
    name: "tree-node",
    inject: ["root"],
    props: {
        node: Object,
        level: Number,
        underMatch: Boolean
    },
    computed: {
        hasChildren() {
            return !!(this.node.children && this.node.children.length);
        },
        match() {
            return this.root.treeMatch;
        },
        visible() {
            const m = this.match;
            if (!m.query || this.underMatch) {
                return true;
            }
            return m.self.has(this.node.id) || m.anc.has(this.node.id);
        },
        isOpen() {
            const m = this.match;
            if (m.query && m.anc.has(this.node.id)) {
                return true;
            }
            return this.root.isTreeOpen(this.node, this.level);
        },
        kindLabel() {
            return kindLabels[this.node.kind] || this.node.kind;
        },
        icon() {
            return KIND_ICONS[this.node.kind] || KIND_ICONS.room;
        },
        texts() {
            return treeNodeTexts(this.node);
        },
        codeParts() {
            return highlightParts(this.texts.code, this.match.words);
        },
        nameParts() {
            return highlightParts(this.texts.name, this.match.words);
        },
        canAddChild() {
            return this.node.kind !== "room";
        },
        canEdit() {
            return this.root.canEdit;
        },
        formHere() {
            const f = this.root.treeForm;
            if (!f) {
                return false;
            }
            return (f.action === "add" && !f.top && f.parentId === this.node.id) ||
                (f.action === "edit" && f.nodeId === this.node.id);
        }
    },
    methods: {
        toggle() {
            if (this.hasChildren) {
                this.root.setTreeOpen(this.node.id, !this.isOpen);
            }
        },
        call(method) {
            this.root[method](this.node);
        }
    },
    template: `
        <div class="node" v-if="visible">
            <div class="node-row" :class="['kind-' + node.kind, { 'has-children': hasChildren, 'is-open': hasChildren && isOpen, 'is-hover': root.treeHover && root.treeHover.id === node.id }]"
                :style="{ '--lvl': level }" @click="toggle" @mouseenter="root.setTreeHover(node, $event.currentTarget)">
                <span class="node-main">
                    <span class="node-toggle" :class="{ open: isOpen }">
                        <svg v-if="hasChildren" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>
                    </span>
                    <svg class="node-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" v-html="icon"></svg>
                    <span class="node-title" :title="kindLabel">
                        <span v-if="texts.code" class="node-code"><template v-for="(p, i) in codeParts" :key="'c' + i"><mark v-if="p.m">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span><span v-if="texts.name" class="node-name"><template v-for="(p, i) in nameParts" :key="'n' + i"><mark v-if="p.m">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span>
                    </span>
                </span>
                <span class="node-count" title="Компьютеров внутри"><span class="cnt" :class="{ zero: !node.total_count }">{{ node.total_count || 0 }}</span></span>
            </div>
            <tree-form v-if="formHere" :level="level + 1"></tree-form>
            <template v-if="isOpen && hasChildren">
                <tree-node
                    v-for="child in node.children"
                    :key="child.id"
                    :node="child"
                    :level="level + 1"
                    :under-match="underMatch || match.self.has(node.id)"
                ></tree-node>
            </template>
        </div>
    `
});

// Кнопки оформления: цвет текста, цвет фона, жирный, курсив.
// Отдаёт наружу только изменённое свойство: { color: "#aa0000" } и т. п.
app.component("style-controls", {
    props: {
        value: Object,
        disabled: Boolean
    },
    emits: ["change"],
    computed: {
        s() {
            return this.value || {};
        }
    },
    methods: {
        emit(patch) {
            if (!this.disabled) {
                this.$emit("change", patch);
            }
        }
    },
    template: `
        <span class="sc" :class="{ disabled: disabled }">
            <label class="sc-btn sc-color" :class="{ set: !!s.color }" :title="s.color ? 'Цвет текста ' + s.color : 'Цвет текста не задан'">
                <span class="sc-letter" :style="{ color: s.color || null }">A</span>
                <span class="sc-bar" :style="{ background: s.color || null }"></span>
                <input type="color" :value="s.color || '#222222'" :disabled="disabled" @change="emit({ color: $event.target.value })">
            </label>
            <label class="sc-btn sc-color sc-bg" :class="{ set: !!s.bg_color }" :title="s.bg_color ? 'Цвет фона ' + s.bg_color : 'Цвет фона не задан'">
                <span class="sc-swatch" :style="{ background: s.bg_color || null }"></span>
                <input type="color" :value="s.bg_color || '#ffffff'" :disabled="disabled" @change="emit({ bg_color: $event.target.value })">
            </label>
            <button type="button" class="sc-btn" :class="{ on: s.bold }" :disabled="disabled" title="Жирный" @click="emit({ bold: !s.bold })"><b>Ж</b></button>
            <button type="button" class="sc-btn" :class="{ on: s.italic }" :disabled="disabled" title="Курсив" @click="emit({ italic: !s.italic })"><i>К</i></button>
        </span>
    `
});

// Форма добавления/правки узла — прямо в дереве, под узлом
app.component("tree-form", {
    inject: ["root"],
    props: {
        level: { type: Number, default: 0 }
    },
    computed: {
        form() {
            return this.root.treeForm;
        }
    },
    mounted() {
        const input = this.$el.querySelector && this.$el.querySelector("input");
        if (input) {
            input.focus();
        }
        // Форма с панели прилипает под шапкой и не уезжает при прокрутке;
        // прилипший адрес встаёт под неё — ему нужна её высота (--tf-h)
        if (this.form && this.form.top && this.$el.nodeType === 1 && window.ResizeObserver) {
            const content = this.$el.parentElement;
            this._ro = new ResizeObserver(() => {
                content.style.setProperty("--tf-h", this.$el.offsetHeight + "px");
            });
            this._ro.observe(this.$el);
        }
    },
    beforeUnmount() {
        if (this._ro) {
            this._ro.disconnect();
            this.$el.parentElement && this.$el.parentElement.style.removeProperty("--tf-h");
        }
    },
    methods: {
        submit() {
            this.root.submitTreeForm();
        },
        cancel() {
            this.root.treeForm = null;
        },
        kindLabel(kind) {
            return kindLabels[kind] || kind;
        }
    },
    template: `
        <div class="tree-form" v-if="form" :class="{ 'tf-top': form.top }" :style="{ '--lvl': level }" @keydown.esc.stop="cancel">
            <span class="tf-title">{{ form.action === 'add' ? 'Добавить:' : 'Правка:' }}</span>
            <select v-if="form.kinds.length > 1" class="input" v-model="form.kind" @change="form.top && (form.parentId = null)">
                <option v-for="k in form.kinds" :key="k" :value="k">{{ kindLabel(k) }}</option>
            </select>
            <select v-if="form.top && form.kind !== 'building'" class="input tf-parent" v-model="form.parentId" title="Куда добавить">
                <option :value="null" disabled>Куда…</option>
                <option v-for="o in root.treeParentOptions(form.kind)" :key="o.id" :value="o.id">{{ o.path }}</option>
            </select>
            <input v-if="form.kind !== 'floor'" class="input tf-code" v-model="form.code" @keydown.enter="submit" placeholder="Код"
                title="Код — короткое обозначение узла, необязательно. У кабинета это его номер (например, 214): он показывается в таблице в столбце «№ Кабинета» и по нему удобно искать. У адреса или отделения — сокращение для себя (например, «Л12», «ТО»).">
            <input class="input tf-name" v-model="form.name" @keydown.enter="submit" placeholder="Название">
            <span class="tf-buttons">
                <button class="btn btn-primary icon-only" @click="submit" :title="form.action === 'add' ? 'Добавить (Enter)' : 'Сохранить (Enter)'"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></button>
                <button class="btn icon-only" @click="cancel" title="Отмена (Esc)"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
            </span>
            <span v-if="root.treeFormError" class="tf-error">{{ root.treeFormError }}</span>
        </div>
    `
});

// Выбор расположения ПК: поле поиска и список узлов дерева путями
// («ул. Ленина, 1 → Терапия → 201»). Слова ищутся в любом месте пути.
// editor — редактор поверх ячейки: открыт сразу, Esc и уход фокуса — отмена.
// Список выносится в body: таблица и карточка обрезают всё, что за краем.
app.component("location-picker", {
    props: {
        value: { default: null },
        options: { type: Array, default: function () { return []; } },
        editor: Boolean,
        placeholder: { type: String, default: "" },
        inputClass: { default: "" },
        emptyText: { type: String, default: "Загрузка дерева…" }
    },
    emits: ["pick", "cancel"],
    data() {
        return { open: false, query: "", active: 0, pos: null };
    },
    computed: {
        current() {
            const value = this.value;
            return this.options.find(function (o) { return o.id === value; }) || null;
        },
        filtered() {
            const words = searchWords(this.query);
            if (!words.length) {
                return this.options;
            }
            return this.options.filter(function (o) {
                return words.every(function (w) { return o.search.indexOf(w) !== -1; });
            });
        },
        shownText() {
            return this.open ? this.query : (this.current ? this.current.path : "");
        },
        listStyle() {
            const p = this.pos;
            if (!p) {
                return null;
            }
            const style = {
                left: p.left + "px",
                minWidth: p.minWidth + "px",
                maxWidth: p.maxWidth + "px",
                maxHeight: p.maxHeight + "px"
            };
            if (p.up) {
                style.bottom = p.bottom + "px";
            } else {
                style.top = p.top + "px";
            }
            return style;
        }
    },
    watch: {
        query() {
            this.active = 0;
        },
        // Дерево догрузилось, пока список открыт, — встать на текущий узел
        options() {
            if (this.open && !this.query) {
                this.activateCurrent();
            }
        }
    },
    mounted() {
        this._onMove = () => this.place();
        window.addEventListener("scroll", this._onMove, true);
        window.addEventListener("resize", this._onMove);
        if (this.editor) {
            const input = this.$refs.input;
            const td = this.$el.closest("td");
            if (td) {
                input.style.width = Math.max(td.clientWidth, 260) + "px";
                input.style.height = td.clientHeight + "px";
            }
            input.focus({ preventScroll: true });
            this.show();
        }
    },
    beforeUnmount() {
        window.removeEventListener("scroll", this._onMove, true);
        window.removeEventListener("resize", this._onMove);
    },
    methods: {
        show() {
            if (this.open) {
                return;
            }
            this.open = true;
            this.query = "";
            this.activateCurrent();
            this.$nextTick(() => this.place());
        },
        hide() {
            this.open = false;
            this.query = "";
        },
        activateCurrent() {
            const value = this.value;
            const i = this.filtered.findIndex(function (o) { return o.id === value; });
            this.active = i >= 0 ? i : 0;
            this.$nextTick(() => this.scrollActive(true));
        },
        place() {
            if (!this.open || !this.$refs.input) {
                return;
            }
            const r = this.$refs.input.getBoundingClientRect();
            const minWidth = Math.max(Math.round(r.width), 420);
            const left = Math.max(4, Math.min(Math.round(r.left), window.innerWidth - minWidth - 4));
            const below = window.innerHeight - r.bottom;
            const up = below < 220 && r.top > below;
            this.pos = {
                up: up,
                left: left,
                top: Math.round(r.bottom),
                bottom: Math.round(window.innerHeight - r.top),
                minWidth: minWidth,
                maxWidth: window.innerWidth - left - 8,
                maxHeight: Math.min(360, Math.round((up ? r.top : below) - 8))
            };
        },
        scrollActive(center) {
            const list = this.$refs.list;
            const item = list && list.children[this.active];
            if (!item || !item.classList.contains("ll-item")) {
                return;
            }
            if (center) {
                list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2;
            } else if (item.offsetTop < list.scrollTop) {
                list.scrollTop = item.offsetTop;
            } else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
                list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
            }
        },
        onInput(event) {
            this.query = event.target.value;
            if (!this.open) {
                this.open = true;
                this.$nextTick(() => this.place());
            }
        },
        onFocus() {
            if (!this.editor) {
                this.show();
            }
        },
        onBlur() {
            if (this.editor) {
                this.$emit("cancel");
            } else {
                this.hide();
            }
        },
        onKeydown(event) {
            const key = event.key;
            if (key === "ArrowDown" || key === "ArrowUp") {
                event.preventDefault();
                if (!this.open) {
                    this.show();
                    return;
                }
                const n = this.filtered.length;
                if (n) {
                    this.active = (this.active + (key === "ArrowDown" ? 1 : -1) + n) % n;
                    this.$nextTick(() => this.scrollActive(false));
                }
            } else if (key === "Enter") {
                if (!this.open) {
                    return; // в форме Enter без открытого списка — дальше, к форме
                }
                event.preventDefault();
                event.stopPropagation();
                const option = this.filtered[this.active];
                if (option) {
                    this.pick(option);
                }
            } else if (key === "Escape") {
                if (this.editor) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.$emit("cancel");
                } else if (this.open) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.hide();
                }
            } else if (key === "Tab" && !this.editor) {
                this.hide();
            }
        },
        pick(option) {
            this.hide();
            this.$emit("pick", option.id);
        }
    },
    template: `
        <span class="loc-pick">
            <input ref="input" :class="inputClass" :value="shownText" autocomplete="off" spellcheck="false"
                :placeholder="open && current ? current.path : placeholder"
                :title="!open && current ? current.path : null"
                @input="onInput" @focus="onFocus" @blur="onBlur" @keydown="onKeydown" @click="show">
            <teleport to="body">
                <div v-if="open && pos" ref="list" class="loc-list" :class="{ up: pos.up }" :style="listStyle" @mousedown.prevent>
                    <div v-if="!options.length" class="ll-empty">{{ emptyText }}</div>
                    <div v-else-if="!filtered.length" class="ll-empty">Ничего не найдено</div>
                    <div v-for="(o, i) in filtered" :key="o.id" class="ll-item"
                        :class="['kind-' + o.kind, { active: i === active, current: o.id === value }]"
                        @mousemove="active = i" @click="pick(o)">{{ o.path }}</div>
                </div>
            </teleport>
        </span>
    `
});

app.mount("#app");

// Сочетания клавиш проверяются по самой клавише (event.code), а не по букве:
// так они работают в любой раскладке (Ctrl+F и в русской, где это «Ctrl+А»).

// Фокус в поле ввода — там Ctrl+A, Esc и т. п. работают по-своему
function isTypingTarget(el) {
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

// Ctrl+F — в поиск текущего раздела
window.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === "KeyF") {
        const input = Array.from(document.querySelectorAll(".tb-search input")).find(function (el) {
            return el.offsetParent !== null;
        });
        if (!input) {
            return;
        }
        event.preventDefault();
        input.focus();
        input.select();
    }
});

window.addEventListener("keydown", function (event) {
    const vm = window.itdbTable;
    if (!vm) {
        return;
    }
    // Открыт диалог подтверждения: Esc — отмена, Enter — OK
    if (vm.dialog) {
        if (event.key === "Escape") {
            event.preventDefault();
            vm.closeDialog(false);
        } else if (event.key === "Enter") {
            event.preventDefault();
            vm.closeDialog(true);
        }
        return;
    }
    if (event.key === "Escape" && vm.card) {
        if (vm.cardEditKey) {
            vm.cardEditKey = null;
        } else if (vm.editingHostname) {
            vm.cancelEditHostname();
        } else {
            vm.closeCard();
        }
        return;
    }
    // Esc закрывает строку добавления (Таблица) и форму узла (Дерево),
    // где бы ни был фокус; открытый список выбора расположения закрывается
    // своим Esc раньше (он не пропускает событие дальше)
    if (event.key === "Escape" && !event.defaultPrevented && !vm.card) {
        if (vm.view === "table" && vm.newComputer) {
            vm.closeNewComputer();
            return;
        }
        if (vm.view === "table" && vm.actionBar) {
            vm.closeAction();
            return;
        }
        if (vm.view === "tree" && vm.treeForm) {
            vm.treeForm = null;
            return;
        }
    }
    if (vm.view !== "table" || vm.card || event.defaultPrevented || isTypingTarget(document.activeElement)) {
        return;
    }
    // Ctrl+A — выделить все видимые строки таблицы
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === "KeyA") {
        event.preventDefault();
        vm.selectAllVisible();
    } else if (event.key === "Escape" && vm.selectedRows.length && !vm.editingRowId) {
        vm.clearSelection();
    }
});

// Alt над таблицей: курсор «копировать», клик копирует значение.
// Отпущенный Alt в Windows выделяет меню браузера — пока курсор над
// таблицей, это гасится.
window.addEventListener("keydown", function (event) {
    const vm = window.itdbTable;
    if (!vm || event.key !== "Alt") {
        return;
    }
    vm.altDown = true;
    if (vm.lastMouseX !== undefined) {
        event.preventDefault();
        vm.updateCopyHint();
    }
});
window.addEventListener("keyup", function (event) {
    const vm = window.itdbTable;
    if (!vm || event.key !== "Alt") {
        return;
    }
    vm.altDown = false;
    vm.copyHint = null;
    if (vm.lastMouseX !== undefined) {
        event.preventDefault();
    }
});
window.addEventListener("blur", function () {
    if (window.itdbTable) {
        window.itdbTable.altDown = false;
        window.itdbTable.copyHint = null;
    }
});
