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
    splitMulti(row.ip).forEach(function (value) {
      add("ip", value);
    });

    splitMulti(row.mac).forEach(function (value) {
      add("mac", value);
    });

    if (row.hostname) {
      add("hostname", row.hostname);
    }

    if (row.inv_no) {
      add("inv_no", row.inv_no);
    }

    splitMulti(row.vacuum).forEach(function (value) {
      add("vacuum", value);
    });
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
    // игнорируем, сохранение порядка столбцов не должно ломать таблицу
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
    // если сохранённое состояние битое, просто используем порядок по умолчанию
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
      "dup-red": function (params) {
        return hasDuplicate(params, "ip");
      }
    }
  },
  {
    field: "hostname",
    headerName: "HOSTNAME",
    width: 150,
    editable: true,
    cellClassRules: {
      "dup-red": function (params) {
        return hasDuplicate(params, "hostname");
      }
    }
  },
  {
    field: "vacuum",
    headerName: "VACUUM",
    width: 140,
    autoHeight: true,
    cellStyle: { whiteSpace: "pre-line" },
    cellClassRules: {
      "dup-red": function (params) {
        return hasDuplicate(params, "vacuum");
      }
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
      "dup-red": function (params) {
        return hasDuplicate(params, "mac");
      }
    }
  },
  {
    field: "inv_no",
    headerName: "ИНВ",
    width: 90,
    editable: true,
    cellClassRules: {
      "dup-red": function (params) {
        return hasDuplicate(params, "inv_no");
      }
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
      loading: true,
      error: "",
      rowCount: 0,
      quickFilter: "",
      gridApi: null,
      rows: []
    };
  },

  async mounted() {
    const gridDiv = document.getElementById("grid");

    if (agGrid.createGrid) {
      gridApi = agGrid.createGrid(gridDiv, gridOptions);
    } else {
      new agGrid.Grid(gridDiv, gridOptions);
      gridApi = gridOptions.api;
    }

    this.gridApi = gridApi;
    window.itdbTable = this;

    loadColumnState();

    try {
      const response = await apiFetch("/api/computers");

      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      const data = await response.json();

      this.rows = data.rows || [];
      duplicateSets = buildDuplicateSets(this.rows);

      this.setRowData(this.rows);
      this.rowCount = data.total || 0;
    } catch (e) {
      this.error = String(e);
    }

    this.loading = false;
  },

  methods: {
    setRowData(rows) {
      if (!this.gridApi) {
        return;
      }

      if (this.gridApi.setGridOption) {
        this.gridApi.setGridOption("rowData", rows);
      } else {
        this.gridApi.setRowData(rows);
      }
    },

    applyQuickFilter() {
      if (!this.gridApi) {
        return;
      }

      if (this.gridApi.setGridOption) {
        this.gridApi.setGridOption("quickFilterText", this.quickFilter);
      } else {
        this.gridApi.setQuickFilterText(this.quickFilter);
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

          if (this.gridApi.applyTransaction) {
            this.gridApi.applyTransaction({ update: [updatedRow] });
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
          if (this.gridApi.applyTransaction) {
            this.gridApi.applyTransaction({ update: [this.rows[index]] });
          } else {
            this.setRowData(this.rows);
          }
        }
      }
    }
  }
});

app.mount("#app");

window.addEventListener("keydown", function (event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();

    const input = document.getElementById("quickFilter");

    if (input) {
      input.focus();
      input.select();
    }
  }
});