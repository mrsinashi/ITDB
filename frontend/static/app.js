let gridApi = null;
let saveTimer = null;

const COLUMN_STATE_KEY = "itdb.gridColumnState.v1";

let duplicateSets = {
    ip: new Set(),
    mac: new Set(),
    hostname: new Set(),
    inv_no: new Set(),
    vacuum: new Set()
};

const kindLabels = {
    building: "Здание",
    department: "Отделение",
    floor: "Этаж",
    room: "Кабинет"
};

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

function hasDuplicate(params, field) {
    const value = params.value;
    if (value === null || value === undefined || value === "") {
        return false;
    }
    const set = duplicateSets[field];
    if (!set) {
        return false;
    }
    const multiFields = ["ip", "mac", "vacuum"];
    let values;
    if (multiFields.includes(field)) {
        values = splitMulti(value);
    } else {
        values = [String(value)];
    }
    return values.some(function (item) {
        return set.has(normalizeKey(item));
    });
}

function saveColumnState() {
    if (!gridApi || !gridApi.getColumnState) {
        return;
    }
    try {
        const fullState = gridApi.getColumnState();
        const state = fullState.map(function (column) {
            return {
                colId: column.colId,
                width: column.width,
                hide: column.hide
            };
        });
        localStorage.setItem(COLUMN_STATE_KEY, JSON.stringify(state));
    } catch (e) {
        // игнорируем
    }
}

function scheduleSaveColumnState() {
    if (saveTimer) {
        clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(saveColumnState, 300);
}

function loadColumnState() {
    if (!gridApi || !gridApi.applyColumnState) {
        return;
    }
    try {
        const raw = localStorage.getItem(COLUMN_STATE_KEY);
        if (!raw) {
            return;
        }
        const state = JSON.parse(raw);
        if (!Array.isArray(state)) {
            return;
        }
        gridApi.applyColumnState({
            state: state,
            applyOrder: true
        });
    } catch (e) {
        // игнорируем
    }
}

function onCellValueChanged(params) {
    if (window.itdbTable) {
        window.itdbTable.saveCellChange(params);
    }
}

const largeTextEditor = {
    cellEditor: "agLargeTextCellEditor",
    cellEditorPopup: true,
    cellEditorParams: {
        rows: 4,
        cols: 35
    }
};

const columnDefs = [
    { field: "user", headerName: "ФИО", width: 190 },
    { field: "building", headerName: "Адрес", width: 140 },
    { field: "department", headerName: "Отделение", width: 120 },
    { field: "floor", headerName: "Эт.", width: 60, cellStyle: { textAlign: "center" } },
    { field: "room_code", headerName: "Каб", width: 70, cellStyle: { textAlign: "center" } },
    { field: "room_name", headerName: "Кабинет", width: 150 },
    {
        field: "seat_no",
        headerName: "№",
        width: 60,
        editable: true,
        cellStyle: { textAlign: "center" }
    },
    {
        field: "ip",
        headerName: "IP",
        width: 130,
        editable: true,
        autoHeight: true,
        cellStyle: { whiteSpace: "pre-line" },
        cellEditor: largeTextEditor.cellEditor,
        cellEditorPopup: largeTextEditor.cellEditorPopup,
        cellEditorParams: largeTextEditor.cellEditorParams,
        cellClassRules: {
            "dup-red": function (params) { return hasDuplicate(params, "ip"); }
        }
    },
    {
        field: "hostname",
        headerName: "HOSTNAME",
        width: 150,
        editable: true,
        cellClassRules: {
            "dup-red": function (params) { return hasDuplicate(params, "hostname"); }
        }
    },
    {
        field: "vacuum",
        headerName: "VACUUM",
        width: 140,
        autoHeight: true,
        cellStyle: { whiteSpace: "pre-line" },
        cellClassRules: {
            "dup-red": function (params) { return hasDuplicate(params, "vacuum"); }
        }
    },
    { field: "os", headerName: "OS", width: 120, editable: true },
    { field: "type", headerName: "ТИП", width: 100, editable: true },
    { field: "model", headerName: "Модель", width: 140, editable: true },
    { field: "cpu", headerName: "CPU", width: 170, editable: true },
    { field: "ram", headerName: "RAM", width: 70, editable: true, cellStyle: { textAlign: "center" } },
    {
        field: "drive",
        headerName: "DRIVE",
        width: 130,
        editable: true,
        autoHeight: true,
        cellStyle: { whiteSpace: "pre-line" },
        cellEditor: largeTextEditor.cellEditor,
        cellEditorPopup: largeTextEditor.cellEditorPopup,
        cellEditorParams: largeTextEditor.cellEditorParams
    },
    { field: "gpu", headerName: "GPU", width: 140, editable: true },
    {
        field: "mac",
        headerName: "MAC",
        width: 165,
        editable: true,
        autoHeight: true,
        cellStyle: { whiteSpace: "pre-line" },
        cellEditor: largeTextEditor.cellEditor,
        cellEditorPopup: largeTextEditor.cellEditorPopup,
        cellEditorParams: largeTextEditor.cellEditorParams,
        cellClassRules: {
            "dup-red": function (params) { return hasDuplicate(params, "mac"); }
        }
    },
    {
        field: "inv_no",
        headerName: "ИНВ",
        width: 90,
        editable: true,
        cellClassRules: {
            "dup-red": function (params) { return hasDuplicate(params, "inv_no"); }
        }
    },
    { field: "gsit", headerName: "GSIT", width: 80, editable: true },
    { field: "state", headerName: "Сост.", width: 80, editable: true },
    { field: "label", headerName: "Метка", width: 90, editable: true },
    { field: "status", headerName: "Статус", width: 100, editable: true },
    {
        field: "note",
        headerName: "Примечание",
        width: 230,
        editable: true,
        autoHeight: true,
        cellStyle: { whiteSpace: "pre-line" },
        cellEditor: largeTextEditor.cellEditor,
        cellEditorPopup: largeTextEditor.cellEditorPopup,
        cellEditorParams: largeTextEditor.cellEditorParams
    }
];

const gridOptions = {
    columnDefs: columnDefs,
    defaultColDef: {
        sortable: true,
        filter: true,
        resizable: true
    },
    rowData: [],
    rowHeight: 24,
    headerHeight: 26,
    animateRows: false,
    singleClickEdit: true,
    stopEditingWhenCellsLoseFocus: true,
    getRowId: function (params) {
        return String(params.data.id);
    },
    onColumnMoved: scheduleSaveColumnState,
    onColumnResized: scheduleSaveColumnState,
    onColumnVisible: scheduleSaveColumnState,
    onCellValueChanged: onCellValueChanged
};

const app = Vue.createApp({
    data() {
        return {
            authChecked: false,
            user: null,
            view: "table",
            tableLoading: true,
            tableError: "",
            rowCount: 0,
            quickFilter: "",
            rows: [],
            treeLoading: false,
            treeError: "",
            treeRoots: [],
            unlocated: 0,
            historyLoading: false,
            historyError: "",
            historyItems: []
        };
    },
    async mounted() {
        window.itdbTable = this;

        await this.checkAuth();
        this.authChecked = true;

        if (this.user) {
            await this.$nextTick();
            const gridDiv = document.getElementById("grid");
            if (gridDiv) {
                if (agGrid.createGrid) {
                    gridApi = agGrid.createGrid(gridDiv, gridOptions);
                } else {
                    new agGrid.Grid(gridDiv, gridOptions);
                    gridApi = gridOptions.api;
                }
                loadColumnState();
                await this.loadTable();
            }
        }
    },
    methods: {
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
            if (view === "table" && gridApi) {
                setTimeout(function () {
                    gridApi.onSizeChanged();
                }, 0);
            } else if (view === "tree") {
                this.loadTree();
            } else if (view === "history") {
                this.loadHistory();
            }
        },
        async loadTable() {
            this.tableLoading = true;
            this.tableError = "";
            try {
                const response = await apiFetch("/api/computers");
                const data = await response.json();
                this.rows = data.rows || [];
                duplicateSets = buildDuplicateSets(this.rows);
                this.setRowData(this.rows);
                this.rowCount = data.total || 0;
            } catch (e) {
                this.tableError = String(e);
            }
            this.tableLoading = false;
        },
        setRowData(rows) {
            if (!gridApi) {
                return;
            }
            if (gridApi.setGridOption) {
                gridApi.setGridOption("rowData", rows);
            } else {
                gridApi.setRowData(rows);
            }
        },
        applyQuickFilter() {
            if (!gridApi) {
                return;
            }
            if (gridApi.setGridOption) {
                gridApi.setGridOption("quickFilterText", this.quickFilter);
            } else {
                gridApi.setQuickFilterText(this.quickFilter);
            }
        },
        async saveCellChange(params) {
            const field = params.colDef.field;
            const id = params.data.id;
            let value = params.newValue;
            if (value === undefined) {
                value = null;
            }
            if (value === params.oldValue) {
                return;
            }
            const payload = {};
            payload[field] = value === "" ? null : value;
            try {
                const response = await apiFetch("/api/computers/" + id, {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(payload)
                });
                if (!response.ok) {
                    let errorMessage = "HTTP " + response.status;
                    try {
                        const errorData = await response.json();
                        if (errorData && errorData.detail) {
                            if (typeof errorData.detail === "string") {
                                errorMessage = errorData.detail;
                            } else {
                                errorMessage = JSON.stringify(errorData.detail);
                            }
                        }
                    } catch (e) {
                        // оставляем HTTP-статус
                    }
                    throw new Error(errorMessage);
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
                    if (gridApi.applyTransaction) {
                        gridApi.applyTransaction({ update: [updatedRow] });
                    } else {
                        this.setRowData(this.rows);
                    }
                }
            } catch (e) {
                alert("Не удалось сохранить: " + e);
                const index = this.rows.findIndex(function (row) {
                    return row.id === id;
                });
                if (index >= 0) {
                    if (gridApi.applyTransaction) {
                        gridApi.applyTransaction({ update: [this.rows[index]] });
                    } else {
                        this.setRowData(this.rows);
                    }
                }
            }
        },
        async loadTree() {
            this.treeLoading = true;
            this.treeError = "";
            try {
                const response = await apiFetch("/api/locations/tree");
                const data = await response.json();
                this.treeRoots = data.roots || [];
                this.unlocated = data.unlocated || 0;
            } catch (e) {
                this.treeError = String(e);
            }
            this.treeLoading = false;
        },
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
        },
        async logout() {
            try {
                await apiFetch("/api/auth/logout", { method: "POST" });
            } catch (e) {
                // если сессия уже истекла, просто уходим на страницу входа
            }
            window.location.replace("/login.html");
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
        return {
            open: this.level < 2
        };
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
        }
    },
    methods: {
        toggle() {
            if (this.node.children && this.node.children.length) {
                this.open = !this.open;
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