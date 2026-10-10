// Таблица: виды – наборы столбцов (этап 43; до него – основной и второй вид, этап 28б).
// Кнопка вида справа от поиска – номер вида в квадратике; нажатие – следующий вид по
// кругу, с Ctrl – окно «Виды таблицы» посередине экрана: название, столбцы (галочки,
// закрепление), «По ширине окна», удалить вид. Новый вид – «Добавить» → «Вид» или «＋» в
// окне: копия текущего, сразу в окне. Выбор вида в окне – таблица за ним сразу в нём.
// Вид 1 – основной: скрытые столбцы, порядок и закрепление – прежние записи в браузере,
// масштаб по ширине окна не запоминается (при входе в вид – обычный). Остальные виды
// помнят показанные столбцы, порядок, закреплённые и «По ширине окна». Всё – в браузере.
// У таблицы принтеров (этап 44) виды свои (ключи – tableStoreKey).

import { loadJson, saveJson } from "../util.js";
import { COLUMN_ORDER2_KEY, HIDDEN_COLUMNS2_KEY, TABLE_FIT_KEY, TABLE_VIEW_KEY, TABLE_VIEWS_KEY, VIEW2_COLUMNS, tableStoreKey } from "../columns.js";

// Номер вида – одна цифра в квадратике
export const VIEWS_MAX = 9;

// Вид 2…9: shown – показанные столбцы (новые столбцы в такой вид сами не попадают);
// hidden – скрытые: только у второго вида, сохранённого до этапа 43, до первой правки
function viewOf(v) {
    return {
        name: String(v.name || ""),
        shown: Array.isArray(v.shown) ? v.shown : null,
        hidden: Array.isArray(v.hidden) ? v.hidden : null,
        order: Array.isArray(v.order) ? v.order : null,
        pins: Array.isArray(v.pins) ? v.pins : null,
        fit: v.fit === true
    };
}

// Виды из браузера; до этапа 43 – основной и второй (его столбцы, порядок; масштаб
// по ширине окна был общий – достаётся второму). У принтеров сначала – один основной
export function loadViews(kind) {
    const saved = loadJson(tableStoreKey(TABLE_VIEWS_KEY, kind), null);
    if (Array.isArray(saved) && saved.length && saved[0]) {
        return saved.slice(0, VIEWS_MAX).map(function (v, i) {
            return i ? viewOf(v || {}) : { name: String(saved[0].name || "") };
        });
    }
    if (kind === "printer") {
        return [{ name: "Основной" }];
    }
    const hidden2 = loadJson(HIDDEN_COLUMNS2_KEY, null);
    return [
        { name: "Основной" },
        viewOf({
            name: "Второй",
            shown: Array.isArray(hidden2) ? null : VIEW2_COLUMNS.slice(),
            hidden: hidden2,
            order: loadJson(COLUMN_ORDER2_KEY, null),
            fit: loadJson(TABLE_FIT_KEY, false) === true
        })
    ];
}

// Номер вида на экране из браузера
export function loadViewNumber(kind, views) {
    const saved = Number(loadJson(tableStoreKey(TABLE_VIEW_KEY, kind), 1));
    return saved >= 1 && saved <= views.length ? Math.floor(saved) : 1;
}

export default {
    data() {
        const views = loadViews("pc");
        const view = loadViewNumber("pc", views);
        return {
            tableViews: views,
            tableView: view,     // номер вида на экране, с 1
            // Масштаб таблицы по ширине окна: у вида 1 при входе – выключен
            tableFit: view > 1 && views[view - 1].fit,
            viewsDlg: null       // окно «Виды таблицы» открыто: {}
        };
    },

    computed: {
        viewNow() {
            return this.tableViews[this.tableView - 1] || this.tableViews[0];
        },

        viewsMax() {
            return VIEWS_MAX;
        },

        // Закреплённые столбцы вида: список полей; null – как в описании столбцов (HOSTNAME, IP)
        pinsNow() {
            return this.tableView === 1 ? this.pinnedColumns : this.viewNow.pins;
        },

        viewButtonTitle() {
            return "Вид " + this.tableView + ": " + this.viewName(this.tableView);
        },
    },

    methods: {
        viewName(n) {
            const v = this.tableViews[n - 1];
            return (v && v.name.trim()) || "Вид " + n;
        },

        saveViews() {
            saveJson(tableStoreKey(TABLE_VIEWS_KEY, this.tableKind), this.tableViews);
        },

        // Изменить вид на экране (вид 1 хранит здесь только название)
        patchView(patch) {
            const at = this.tableView - 1;
            this.tableViews = this.tableViews.map(function (v, i) {
                return i === at ? Object.assign({}, v, patch) : v;
            });
            this.saveViews();
        },

        // Кнопка вида: следующий по кругу; с Ctrl (или вид один) – окно «Виды таблицы»
        onViewButton(event) {
            if (event.ctrlKey || event.metaKey || this.tableViews.length < 2) {
                this.openViewsDlg();
                return;
            }
            this.closeMenus();
            this.setTableView(this.tableView % this.tableViews.length + 1);
        },

        setTableView(n, force) {
            if ((n === this.tableView && !force) || n < 1 || n > this.tableViews.length) {
                return;
            }
            this.cancelEdit();
            this.scanPop = null;
            this.tableView = n;
            saveJson(tableStoreKey(TABLE_VIEW_KEY, this.tableKind), n);
            const fit = n > 1 && this.tableViews[n - 1].fit;
            if (fit !== this.tableFit) {
                this.tableFit = fit;
            }
            // Сортировка и фильтры по столбцу, которого в этом виде нет, снимаются
            const fields = this.allColumns.map(function (col) { return col.field; });
            if (this.sortField && fields.indexOf(this.sortField) === -1) {
                this.resetSort();
            }
            Object.keys(this.colFilters).forEach((field) => {
                if (fields.indexOf(field) === -1) {
                    this.clearColFilter(field);
                }
            });
            this.$nextTick(() => {
                this.updateTableFit();
                this.updateStickyShadow();
                this.placeRowMark();
            });
        },

        openViewsDlg(selectName) {
            this.closeMenus();
            this.cancelEdit();
            this.scanPop = null;
            this.viewsDlg = {};
            this.$nextTick(() => {
                const input = this.$refs.viewNameInput;
                if (input && selectName) {
                    input.focus();
                    input.select();
                }
            });
        },

        closeViewsDlg() {
            this.viewsDlg = null;
        },

        // Новый вид – копия текущего: столбцы, порядок, закреплённые, масштаб
        addTableView() {
            this.closeMenus();
            if (this.tableViews.length >= VIEWS_MAX) {
                this.toastError("Видов – не больше " + VIEWS_MAX + ".");
                return;
            }
            const n = this.tableViews.length + 1;
            const all = this.allColumns;
            this.tableViews = this.tableViews.concat([viewOf({
                name: "Вид " + n,
                shown: all.filter((col) => !this.isColumnHidden(col.field)).map(function (col) { return col.field; }),
                order: all.map(function (col) { return col.field; }),
                pins: all.filter(function (col) { return col.sticky; }).map(function (col) { return col.field; }),
                fit: this.tableFit
            })]);
            this.saveViews();
            this.setTableView(n);
            this.openViewsDlg(true);
        },

        renameTableView(value) {
            this.patchView({ name: value });
        },

        // Удалить вид на экране (вид 1 – нельзя); дальше – вид, вставший на его место
        async deleteTableView() {
            const n = this.tableView;
            if (n === 1) {
                return;
            }
            if (!(await this.confirmDialog("Удалить вид «" + this.viewName(n) + "»?", { okText: "Удалить", danger: true }))) {
                return;
            }
            this.tableViews = this.tableViews.filter(function (v, i) { return i !== n - 1; });
            this.saveViews();
            this.setTableView(Math.min(n, this.tableViews.length), true);
        },
    }
};
