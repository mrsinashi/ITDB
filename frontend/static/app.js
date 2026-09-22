let gridApi = null;
let saveTimer = null;

const COLUMN_STATE_KEY = "itdb.gridColumnState.v1";

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

const columnDefs = [
  { field: "user", headerName: "ФИО", width: 190 },
  { field: "building", headerName: "Адрес", width: 140 },
  { field: "department", headerName: "Отделение", width: 120 },
  { field: "floor", headerName: "Эт.", width: 60, cellStyle: { textAlign: "center" } },
  { field: "room_code", headerName: "Каб", width: 70, cellStyle: { textAlign: "center" } },
  { field: "room_name", headerName: "Кабинет", width: 150 },
  { field: "seat_no", headerName: "№", width: 60, cellStyle: { textAlign: "center" } },
  { field: "ip", headerName: "IP", width: 130, autoHeight: true, cellStyle: { whiteSpace: "pre-line" } },
  { field: "hostname", headerName: "HOSTNAME", width: 150 },
  { field: "vacuum", headerName: "VACUUM", width: 140, autoHeight: true, cellStyle: { whiteSpace: "pre-line" } },
  { field: "os", headerName: "OS", width: 120 },
  { field: "type", headerName: "ТИП", width: 100 },
  { field: "model", headerName: "Модель", width: 140 },
  { field: "cpu", headerName: "CPU", width: 170 },
  { field: "ram", headerName: "RAM", width: 70, cellStyle: { textAlign: "center" } },
  { field: "drive", headerName: "DRIVE", width: 130, autoHeight: true, cellStyle: { whiteSpace: "pre-line" } },
  { field: "gpu", headerName: "GPU", width: 140 },
  { field: "mac", headerName: "MAC", width: 165, autoHeight: true, cellStyle: { whiteSpace: "pre-line" } },
  { field: "inv_no", headerName: "ИНВ", width: 90 },
  { field: "gsit", headerName: "GSIT", width: 80 },
  { field: "state", headerName: "Сост.", width: 80 },
  { field: "label", headerName: "Метка", width: 90 },
  { field: "status", headerName: "Статус", width: 100 },
  { field: "note", headerName: "Примечание", width: 230 }
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
  onColumnMoved: scheduleSaveColumnState,
  onColumnResized: scheduleSaveColumnState,
  onColumnVisible: scheduleSaveColumnState
};

const app = Vue.createApp({
  data() {
    return {
      loading: true,
      error: "",
      rowCount: 0,
      quickFilter: "",
      gridApi: null
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

    loadColumnState();

    try {
      const response = await fetch("/api/computers");

      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      const data = await response.json();

      this.setRowData(data.rows || []);
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