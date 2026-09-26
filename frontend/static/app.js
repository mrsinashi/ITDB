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
    { field: "building", headerName: "Адрес" },
    { field: "department", headerName: "Отделение" },
    { field: "floor", headerName: "Эт.", fullName: "Этаж", center: true },
    { field: "room_code", headerName: "Каб", fullName: "№ Кабинета", center: true, values: false },
    { field: "room_name", headerName: "Кабинет" },
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
        seat_sort: "Порядок строки"
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
const CHECKBOX_COL_WIDTH = 30;   // ширина столбца чекбоксов в режиме правки
const CHECKBOX_ANIM_MS = 200;    // время выезда/заезда столбца чекбоксов

// Поля карточки, которые можно править двойным кликом (ключ строки карточки → поле)
const CARD_EDIT_EXTRA = { serial: { field: "serial", headerName: "Серийный", editable: true } };

// ============================================================
// Замер ширины текста и автоматический размер столбцов
// ============================================================

const TABLE_WIDTHS_KEY = "itdb.tableWidths.v1";
const DEFAULT_MAX_WIDTH = 400;
const WIDTH_EXTRA = 0;
let widthProbe = null;

// Обычная ячейка данных — образец для шрифта и отступов.
// Ячейку с чекбоксом брать нельзя: у неё padding 2px, и все столбцы
// становились уже на ~9px (баг «после правки всё сузилось»).
function sampleDataCell() {
    return document.querySelector(".data-table tbody td:not(.checkbox-col):not(.editing)");
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
            rowCount: 0,
            quickFilter: "",
            rows: [],
            hiddenColumns: loadJson(HIDDEN_COLUMNS_KEY, []),
            searchHidden: loadJson(SEARCH_HIDDEN_KEY, false),
            checkboxVisible: false,
            locationFilter: null,
            savedFlash: {},
            pendingCells: {},
            openMenu: null,
            noteTooltip: { visible: false, text: "", top: 0, left: 0, width: 0 },
            stickyStuck: false,
            checkboxStuck: false,
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
            treeOpenState: {},
            treeQuery: "",
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
            if (this.displayedCount === this.rowCount) {
                return "Всего: " + this.rowCount;
            }
            return "Показано: " + this.displayedCount + " из " + this.rowCount;
        },

        isAllSelected() {
            if (this.displayRows.length === 0) {
                return false;
            }
            return this.displayRows.every((row) => this.selectedRows.indexOf(row.id) !== -1);
        },

        totalWidth() {
            const base = this.columns.reduce(function (sum, col) {
                return sum + col.width;
            }, 0);
            return base;
        },

        filteredRows() {
            let rows = this.rows;
            if (this.locationFilter) {
                const ids = this.locationFilter.ids;
                rows = rows.filter(function (row) {
                    return ids.has(row.location_id);
                });
            }
            const query = this.quickFilter.trim().toLowerCase();
            if (!query) {
                return rows;
            }
            const fields = (this.searchHidden ? this.allColumns : this.columns).map(function (col) {
                return col.field;
            });
            return rows.filter(function (row) {
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
            return [this.card.room_code, this.card.room_name].filter(Boolean).join(" ");
        },

        // Строки карточки ПК: [{ key, label, value, copy }] или { group }
        cardRows() {
            const c = this.card;
            if (!c) {
                return [];
            }
            function F(key, label, value, copy) {
                return { key: key, label: label, value: value, copy: !!copy };
            }
            const status = [F("status", "Статус", c.status)];
            const place = [
                F("building", "Адрес", c.building, true),
                F("department", "Отделение", c.department, true),
                F("floor", "Этаж", c.floor),
                F("room", "Кабинет", this.cardRoom, true),
                F("seat_no", "№ Места", c.seat_no)
            ];
            const net = [F("ip", "IP адрес", c.ip, true), F("mac", "MAC адрес", c.mac, true)];
            const ids = [F("inv_no", "Инвентарный номер", c.inv_no, true), F("serial", "Серийный", c.serial, true)];
            const hw = [
                F("type", "Тип компьютера", c.type),
                F("model", "Модель", c.model, true),
                F("os", "Операционная система (ОС / OS)", c.os, true),
                F("cpu", "Процессор (ЦП / CPU)", c.cpu, true),
                F("ram", "Оперативная память (ОЗУ / RAM)", c.ram),
                F("drive", "Дисковые накопители (DRIVE)", c.drive, true),
                F("gpu", "Видеокарта (ГП / GPU)", c.gpu, true)
            ];
            const marks = [F("gsit", "GSIT", c.gsit), F("state", "Сост.", c.state), F("label", "Метка", c.label)];
            const custom = this.tableFieldDefs.map(function (fd) {
                return F("x-" + fd.key, fd.label, c[fd.key]);
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
            const q = this.treeQuery.trim().toLowerCase();
            const self = new Set();
            const anc = new Set();
            if (q) {
                const walk = (nodes, parents) => {
                    nodes.forEach((node) => {
                        const text = [node.code, node.name].filter(Boolean).join(" ").toLowerCase();
                        if (text.indexOf(q) !== -1) {
                            self.add(node.id);
                            parents.forEach(function (id) { anc.add(id); });
                        }
                        if (node.children && node.children.length) {
                            walk(node.children, parents.concat([node.id]));
                        }
                    });
                };
                walk(this.treeRoots, []);
            }
            return { query: q, self: self, anc: anc, size: self.size };
        },

        filteredHistory() {
            const q = this.historyQuery.trim().toLowerCase();
            if (!q) {
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
                return parts.some(function (p) {
                    return p !== null && p !== undefined && String(p).toLowerCase().indexOf(q) !== -1;
                });
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
            const rows = this.rows;
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

        editMode(newVal) {
            if (!newVal) {
                this.selectedRows = [];
                if (this.openMenu === "selection") {
                    this.closeMenus();
                }
            }
            this.animateCheckboxCol(newVal);
            this.$nextTick(() => {
                this.updateStickyShadow();
            });
        },

        searchHidden(value) {
            saveJson(SEARCH_HIDDEN_KEY, value);
        },

        // Сняли все галочки — меню действий больше не нужно
        "selectedRows.length"(count) {
            if (count === 0 && this.openMenu === "selection") {
                this.closeMenus();
            }
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
        this._cbWidth = 0;
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
                const response = await apiFetch("/api/computers");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                this.rows = data.rows || [];
                this.rowCount = data.total || this.rows.length;
                duplicateSets = buildDuplicateSets(this.rows);
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
            const cbWidth = this._cbWidth || 0;

            function onMouseMove(e) {
                const delta = e.clientX - startX;
                let newWidth = startWidth + delta;
                if (newWidth < 40) {
                    newWidth = 40;
                }
                const appliedDelta = newWidth - startWidth;
                colEl.style.width = newWidth + "px";
                tableEl.style.width = (startTotal + appliedDelta + cbWidth) + "px";
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
            if (DUP_FIELDS.indexOf(col.field) !== -1 && hasDuplicateValue(row[col.field], col.field)) {
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
                style.left = "calc(var(--cb-w) + " + this.stickyLeft(col) + "px)";
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
            let left = 0; // столбец чекбоксов добавляется через CSS-переменную --cb-w
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
            if (!this.editMode || !this.canEdit || !col.editable) {
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

        isRowSelected(row) {
            return this.selectedRows.indexOf(row.id) !== -1;
        },

        toggleRowSelection(row) {
            const index = this.selectedRows.indexOf(row.id);
            if (index === -1) {
                this.selectedRows.push(row.id);
            } else {
                this.selectedRows.splice(index, 1);
            }
        },

        toggleAllSelection() {
            const self = this;
            if (this.isAllSelected) {
                const displayIds = this.displayRows.map(function (row) { return row.id; });
                this.selectedRows = this.selectedRows.filter(function (id) {
                    return displayIds.indexOf(id) === -1;
                });
            } else {
                const newIds = [];
                this.displayRows.forEach(function (row) {
                    if (self.selectedRows.indexOf(row.id) === -1) {
                        newIds.push(row.id);
                    }
                });
                this.selectedRows = this.selectedRows.concat(newIds);
            }
        },

        clearSelection() {
            this.selectedRows = [];
            this.closeMenus();
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

        startMove() {
            this.closeMenus();
            this.toast("Перемещение пока не реализовано");
        },

        startReplace() {
            this.closeMenus();
            this.toast("Замена пока не реализована");
        },

        startSwap() {
            this.closeMenus();
            this.toast("Обмен пока не реализован");
        },

        // ---------- Выезд столбца чекбоксов ----------
        // Анимируется одна CSS-переменная --cb-w на таблице (ширина столбца,
        // сдвиг липких HOSTNAME/IP, ширина таблицы) — без перерисовки Vue.
        // Повторное нажатие посреди анимации продолжает с текущей ширины.
        animateCheckboxCol(show) {
            const table = this.$refs.table;
            const target = show ? CHECKBOX_COL_WIDTH : 0;
            if (this._cbRaf) {
                cancelAnimationFrame(this._cbRaf);
                this._cbRaf = null;
            }
            if (show) {
                this.checkboxVisible = true;
            }
            const from = this._cbWidth || 0;
            const apply = (w) => {
                this._cbWidth = w;
                if (table) {
                    table.style.setProperty("--cb-w", w + "px");
                }
            };
            const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            if (!table || from === target || reduce) {
                apply(target);
                this.checkboxVisible = show;
                return;
            }
            const duration = CHECKBOX_ANIM_MS * Math.abs(target - from) / CHECKBOX_COL_WIDTH;
            const start = performance.now();
            const step = (now) => {
                const t = Math.min(1, (now - start) / duration);
                const eased = 1 - Math.pow(1 - t, 3);
                apply(Math.round((from + (target - from) * eased) * 10) / 10);
                this.updateStickyShadow();
                if (t < 1) {
                    this._cbRaf = requestAnimationFrame(step);
                } else {
                    this._cbRaf = null;
                    apply(target);
                    this.checkboxVisible = show;
                    this.updateStickyShadow();
                }
            };
            this._cbRaf = requestAnimationFrame(step);
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
                if (index !== -1) {
                    Object.assign(this.rows[index], updated);
                    duplicateSets = buildDuplicateSets(this.rows);
                    this.recalcWidths();
                    this.flashCell(row.id, col.field);
                }
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
            });
        },

        updateStickyShadow() {
            const wrap = this.$refs.tableWrap;
            if (!wrap) {
                return;
            }
            // HOSTNAME прилипает, когда уезжают все столбцы перед ним.
            // Столбец чекбоксов сюда не входит: он сам липкий и сдвигает
            // точку прилипания на те же 30px.
            let threshold = 0;
            for (const col of this.columns) {
                if (col.sticky) {
                    break;
                }
                threshold += col.width;
            }
            const scrollLeft = wrap.scrollLeft;
            this.stickyStuck = scrollLeft >= threshold;
            // Тень у чекбоксов — пока под ними едут обычные столбцы.
            // Когда к ним приклеились HOSTNAME/IP, тень у них, а не у чекбоксов.
            this.checkboxStuck = this.editMode && scrollLeft > 0 && !this.stickyStuck;
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

        closeCard() {
            this.card = null;
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
                    this.recalcWidths();
                    this.card = updatedRow;
                    this.toast("Имя сохранено", "success");
                }
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
            this.locationFilter = {
                id: node.id,
                path: entry ? entry.path : (node.name || node.code || ""),
                ids: ids
            };
            this.setView("table");
        },

        openAddForm(node) {
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
            if (typeof value === "object") {
                return JSON.stringify(value);
            }
            return String(value);
        },

        async downloadExport() {
            try {
                const response = await apiFetch("/api/export/computers.xlsx");
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

// Разбивка строки на части для подсветки найденного
function highlightParts(text, query) {
    text = text || "";
    if (!query) {
        return [{ t: text, m: false }];
    }
    const lower = text.toLowerCase();
    const parts = [];
    let pos = 0;
    let idx = lower.indexOf(query);
    while (idx !== -1) {
        if (idx > pos) {
            parts.push({ t: text.slice(pos, idx), m: false });
        }
        parts.push({ t: text.slice(idx, idx + query.length), m: true });
        pos = idx + query.length;
        idx = lower.indexOf(query, pos);
    }
    if (pos < text.length) {
        parts.push({ t: text.slice(pos), m: false });
    }
    return parts;
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
            return highlightParts(this.texts.code, this.match.query);
        },
        nameParts() {
            return highlightParts(this.texts.name, this.match.query);
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
        <div class="tree-form" v-if="form" :style="{ '--lvl': level }" @keydown.esc.stop="cancel">
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
                <button class="btn btn-primary" @click="submit">OK</button>
                <button class="btn" @click="cancel">Отмена</button>
            </span>
            <span v-if="root.treeFormError" class="tf-error">{{ root.treeFormError }}</span>
        </div>
    `
});

app.mount("#app");

// Ctrl+F — в поиск текущего раздела
window.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
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
    }
});
