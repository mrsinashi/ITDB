// Принтеры и МФУ (этап 44): страница «Принтеры» – та же Таблица (mixins/table.js и всё,
// что с ней: фильтры, поиск, ширины, порядок, виды, печать, выделение, правка), но со
// своими строками (/api/printers) и столбцами (printer_columns из /api/columns).
//
// Что у таблицы своё для ПК и для принтеров (скрытые столбцы, ширины, порядок, виды,
// сортировка, фильтры, поиск, выделение…), при переходе на «Принтеры» и обратно меняется
// местами (TABLE_STATE, switchTableKind); в браузере у принтеров – свои ключи
// (tableStoreKey). Строки ПК (rows) и принтеров (printerRows) лежат порознь всегда:
// код ПК (карточка, сканер, имена) работает с rows и на странице принтеров.
//
// Принтеры у ПК и ПК у принтера – ссылками (linkParts): нажатие на принтер – окошко с
// его данными (как у значения сканера), на ПК – карточка ПК; значок таблицы рядом –
// показать в другой таблице без фильтров. Enter на странице – веб-страница принтера.

import { apiFetch, fixIpTyping, loadJson, searchNorm } from "../util.js";
import { COLUMN_ORDER_KEY, HIDDEN_COLUMNS_KEY, PINNED_COLUMNS_KEY, PRINTER_KINDS, refreshDuplicates, roomText, tableStoreKey } from "../columns.js";
import { TABLE_WIDTHS_KEY, loadManualWidths } from "../widths.js";
import { loadViewNumber, loadViews } from "./table-views.js";
import { newPrinterName } from "../naming.js";
import { pageLink } from "../route.js";

// У таблицы ПК и таблицы принтеров – своё
const TABLE_STATE = [
    "hiddenColumns", "pinnedColumns", "columnOrder", "manualWidths", "autoWidths",
    "tableViews", "tableView", "tableFit", "tableZoom", "tableFitMargin", "tableFitScroll",
    "sortField", "sortDir", "colFilters", "quickFilter", "locationFilter",
    "selectedRows", "selectAnchorId", "activeRowId", "showArchive",
    "nameCheck", "nameOnlyRows", "scanOverlay", "scanOnlyRows"
];

// Таблица принтеров при первом входе – из браузера
function printerTableState() {
    const views = loadViews("printer");
    const view = loadViewNumber("printer", views);
    return {
        hiddenColumns: loadJson(tableStoreKey(HIDDEN_COLUMNS_KEY, "printer"), []),
        pinnedColumns: loadJson(tableStoreKey(PINNED_COLUMNS_KEY, "printer"), null),
        columnOrder: loadJson(tableStoreKey(COLUMN_ORDER_KEY, "printer"), null),
        manualWidths: loadManualWidths(tableStoreKey(TABLE_WIDTHS_KEY, "printer")),
        autoWidths: {},
        tableViews: views,
        tableView: view,
        tableFit: view > 1 && views[view - 1].fit,
        tableZoom: 1, tableFitMargin: 0, tableFitScroll: false,
        sortField: null, sortDir: null, colFilters: {}, quickFilter: "", locationFilter: null,
        selectedRows: [], selectAnchorId: null, activeRowId: null, showArchive: false,
        nameCheck: false, nameOnlyRows: false, scanOverlay: false, scanOnlyRows: false,
        scrollTop: 0, scrollLeft: 0
    };
}

// Ссылка в ячейке срабатывает после паузы двойного клика (двойной клик – правка ячейки)
const OBJ_LINK_DELAY = 250;

function firstIp(value) {
    const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/m.exec(String(value || ""));
    return m ? m[1] : null;
}

export default {
    data() {
        return {
            // Таблица на экране: pc – ПК (страница «Таблица»), printer – «Принтеры»
            tableKind: "pc",
            printerRows: [],
            printersLoading: false,
            printersError: "",
            // Описание столбцов и карточки принтера – с сервера (GET /api/columns)
            printerColumns: [],
            printerCardGroups: [],
            printerHistoryLabels: {},
            // Справочник моделей (/api/printer-models)
            printerModels: [],
            // «Добавить» → «Принтер»: строка под панелью; новая модель – строкой под ней
            newPrinter: null,
            newModel: null,
            // Окошко принтера у ссылки на него (как у значения сканера)
            printerPop: null,
            // «Своё имя» принтеров: id → { name, location_id, by, at }
            printerNameKeep: {}
        };
    },

    computed: {
        tableRows() {
            return this.tableKind === "printer" ? this.printerRows : this.rows;
        },

        tableBuiltinColumns() {
            return this.tableKind === "printer" ? this.printerColumns : this.builtinColumns;
        },

        // Столбцы ПК (встроенные и пользовательские) – карточке ПК и правке из «Сканера»,
        // где бы ни была таблица
        pcColumnDefs() {
            const extra = this.tableFieldDefs.map(function (fd) {
                return { field: fd.key, headerName: fd.label, editable: true, suggest: true, extra: true };
            });
            return this.builtinColumns.concat(extra);
        },

        // Пользовательские поля – только у ПК
        tableUserDefs() {
            return this.tableKind === "printer" ? [] : this.tableFieldDefs;
        },

        // Имя строки – HOSTNAME у ПК, «Имя» у принтера («По правилу» – справа от него)
        tableNameField() {
            return this.tableKind === "printer" ? "name" : "hostname";
        },

        printerModelById() {
            const map = new Map();
            this.printerModels.forEach(function (m) { map.set(m.id, m); });
            return map;
        },

        // Модели для выбора: «Kyocera ECOSYS M2040dn · МФУ»
        printerModelOptions() {
            return this.printerModels.map(function (m) {
                const kind = PRINTER_KINDS.find(function (k) { return k.key === m.kind; });
                const path = m.title + (kind ? " · " + kind.label : "");
                return { id: m.id, kind: "model", path: path, search: searchNorm(path) };
            });
        },

        // Строка добавления: модель выбрана – тип для № и имени
        newPrinterKind() {
            const form = this.newPrinter;
            const model = form && form.model_id ? this.printerModelById.get(form.model_id) : null;
            return model ? model.kind : null;
        }
    },

    watch: {
        "newPrinter.location_id"() {
            this.refreshNewPrinterNumber();
        },

        "newPrinter.model_id"() {
            this.refreshNewPrinterNumber();
        },

        "newPrinter.number"() {
            this.refreshNewPrinterName();
        },

        // Дерево догрузилось – имя нового принтера по правилу тоже
        namingIdx() {
            this.refreshNewPrinterName();
        }
    },

    methods: {
        // Страница с таблицей: «Таблица» или «Принтеры»
        isTablePage() {
            return this.view === "table" || this.view === "printers";
        },

        // Ключ строки для вспышки и «сохраняется»: id ПК и принтера могут совпасть
        rowKey(row) {
            return row._printer ? "p" + row.id : row.id;
        },

        // ---------- Таблица ПК ↔ таблица принтеров ----------

        // Перед сменой страницы: таблица показывает другое – меняются местами её настройки
        switchTableKind(kind) {
            if (this.tableKind === kind) {
                return;
            }
            this.cancelEdit();
            this.closeMenus();
            this.closeSuggest();
            this.closeNewComputer();
            this.closeNewPrinter();
            this.actionBar = null;
            this.scanPop = null;
            this.closeNamePop();
            this.closePrinterPop();
            this.copyHint = null;
            this.hideNoteTooltip();
            const states = this._tableStates || (this._tableStates = {});
            const saved = {};
            TABLE_STATE.forEach((key) => { saved[key] = this[key]; });
            const wrap = this.$refs.tableWrap;
            saved.scrollTop = wrap ? wrap.scrollTop : 0;
            saved.scrollLeft = wrap ? wrap.scrollLeft : 0;
            states[this.tableKind] = saved;
            const next = states[kind] || printerTableState();
            TABLE_STATE.forEach((key) => { this[key] = next[key]; });
            this.tableKind = kind;
            this.activeRowEl = null;
            this.setHoverRow(null);
            this.$nextTick(() => {
                this.recalcWidths();
                this.updateTableFit();
                if (wrap) {
                    wrap.scrollTop = next.scrollTop;
                    wrap.scrollLeft = next.scrollLeft;
                }
                this.updateStickyShadow();
                this.markActiveRow();
            });
        },

        // ---------- Загрузка ----------

        async loadPrinters() {
            this.printersLoading = true;
            this.startLoading();
            this.printersError = "";
            try {
                const response = await apiFetch("/api/printers?archived=all");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const rows = (await response.json()).rows || [];
                rows.forEach(function (row) {
                    row._printer = true;
                    row.room = roomText(row);
                });
                this.printerRows = rows;
                refreshDuplicates(rows, this.printerColumns, "printer");
                this.dupVersion++;
                if (this.tableKind === "printer") {
                    this.recalcWidths();
                }
                this.refreshPrinterCard();
            } catch (e) {
                this.printersError = String(e.message || e);
            }
            this.finishLoading();
            this.printersLoading = false;
        },

        async loadPrinterModels() {
            try {
                const response = await apiFetch("/api/printer-models");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.printerModels = (await response.json()).items || [];
            } catch (e) {
                this.toastError("Не удалось загрузить модели принтеров: " + (e.message || e));
            }
        },

        // Таблица на экране – перечитать её строки
        reloadTableRows() {
            return this.tableKind === "printer" ? this.loadPrinters() : this.loadTable();
        },

        // Сохранили значение принтера (saveCellValue): № или место в кабинете могли
        // сдвинуться – перечитать; иначе строка – на месте. Имя и подключение видны и
        // в таблице ПК – её тоже
        async afterPrinterSave(row, col, data) {
            const changes = data.changes || {};
            const moved = (data.shifted && data.shifted.length) || changes.number || changes.model || changes.location_id;
            if (moved) {
                await this.loadPrinters();
                (data.shifted || []).forEach((id) => this.flashCell("p" + id, "number"));
                if (data.shifted && data.shifted.length) {
                    this.toast("№ занят – сдвинуты следующие: " + data.shifted.length, "success");
                }
            } else {
                const index = this.printerRows.findIndex((r) => r.id === row.id);
                if (index !== -1 && data.updated) {
                    Object.assign(this.printerRows[index], data.updated, { _printer: true });
                    this.printerRows[index].room = roomText(this.printerRows[index]);
                    refreshDuplicates(this.printerRows, this.printerColumns, "printer");
                    this.dupVersion++;
                    if (this.tableKind === "printer") {
                        this.recalcWidths();
                    }
                }
            }
            this.flashCell("p" + row.id, col.field);
            if (changes.name || changes.computers) {
                this.loadTable();
            }
            this.refreshPrinterCard();
            this.reloadPrinterCardHistory(row.id);
        },

        // ---------- Ссылки: принтеры у ПК, ПК у принтера ----------

        // Строки ячейки «Принтеры» / «Компьютеры»: ссылка и значок таблицы
        linkParts(row, col) {
            const refs = (col.links === "printer" ? row.printer_refs : row.computer_refs) || [];
            if (!refs.length) {
                return null;
            }
            return refs.map(function (ref) {
                const pc = col.links === "pc";
                return {
                    text: ref.title + (ref.usb ? " [usb]" : ""),
                    obj: { kind: col.links, id: ref.id, usb: ref.usb },
                    href: pc ? pageLink("table", { pc: ref.id }) : pageLink("printers", { pr: ref.id }),
                    title: pc ? "Карточка ПК" : "Принтер",
                    cls: {},
                    style: null
                };
            });
        },

        // Нажатие на ссылку: принтер – окошко, ПК – карточка. С Alt / Ctrl / Shift – как по
        // ячейке (копировать, выделить). В таблице – чуть позже: двойной клик по ячейке –
        // правка (cancelObjLink), а не переход
        onObjLinkClick(event, obj) {
            if (event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) {
                return;
            }
            event.stopPropagation();
            this.cancelObjLink();
            if (event.detail > 1) {
                return;
            }
            const el = event.currentTarget;
            const run = () => {
                this._objLinkTimer = null;
                if (obj.kind === "printer") {
                    this.openPrinterPop(obj.id, el, obj.usb);
                } else {
                    this.closePrinterCard();
                    this.openCardById(obj.id);
                }
            };
            if (el.closest(".data-table")) {
                this._objLinkTimer = setTimeout(run, OBJ_LINK_DELAY);
            } else {
                run();
            }
        },

        cancelObjLink() {
            if (this._objLinkTimer) {
                clearTimeout(this._objLinkTimer);
                this._objLinkTimer = null;
            }
        },

        // Значок таблицы у ссылки: ПК – в Таблице, принтер – в Принтерах; без поиска и
        // фильтров, чтобы строка была видна; полоска у строки
        showObjInTable(obj) {
            const pc = obj.kind === "pc";
            const rows = pc ? this.rows : this.printerRows;
            const row = rows.find(function (r) { return r.id === obj.id; });
            if (!row) {
                this.toast(pc ? "Этого ПК нет в таблице" : "Этого принтера нет в таблице");
                return;
            }
            this.closePrinterPop();
            this.closeCard();
            this.closePrinterCard();
            const view = pc ? "table" : "printers";
            if (this.view !== view) {
                this.setView(view);
            }
            this.quickFilter = "";
            this.colFilters = {};
            this.locationFilter = null;
            this.nameOnlyRows = false;
            this.scanOnlyRows = false;
            this.setArchiveView(!!row.archived);
            this.$nextTick(() => {
                this.scrollToRow(row.id);
                this.setActiveRow(row);
            });
        },

        // ---------- Веб-страница ----------

        // Адрес веб-страницы: свой или http://IP; страницы нет («Web: нет») – null
        printerWebUrl(row) {
            if (!row || row.web === "нет") {
                return null;
            }
            if (row.web_url) {
                return row.web_url;
            }
            const ip = firstIp(row.ip);
            return ip ? "http://" + ip + "/" : null;
        },

        // Enter на странице «Принтеры» – веб-страница в новой вкладке
        openPrinterWeb(row) {
            const url = this.printerWebUrl(row);
            if (!url) {
                this.toastError(row.web === "нет" ? "У принтера нет веб-страницы." : "У принтера нет IP.");
                return;
            }
            window.open(url, "_blank", "noopener");
        },

        // ---------- Окошко принтера (нажатие на ссылку) ----------

        openPrinterPop(id, el, usb) {
            const row = this.printerRows.find(function (r) { return r.id === id; });
            if (!row) {
                this.toast("Этого принтера нет в таблице");
                return;
            }
            const r = el.getBoundingClientRect();
            this.printerPop = {
                row: row,
                usb: usb,
                anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
                left: r.right + 6,
                top: r.top,
                placed: false
            };
            this.$nextTick(() => this.placePrinterPop());
            if (!this._printerPopKey) {
                this._printerPopKey = (e) => {
                    if (e.key === "Escape" && this.printerPop) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.closePrinterPop();
                    }
                };
                this._printerPopDown = (e) => {
                    const pop = this.$refs.printerPop;
                    if (!this.printerPop || (pop && pop.contains(e.target)) || (e.target.closest && e.target.closest("a.obj-link"))) {
                        return;
                    }
                    this.closePrinterPop();
                };
                window.addEventListener("keydown", this._printerPopKey, true);
                window.addEventListener("mousedown", this._printerPopDown, true);
            }
        },

        // Как карточка у блочка сканера: справа от ссылки, не помещается – слева
        placePrinterPop() {
            const pop = this.printerPop;
            const el = this.$refs.printerPop;
            if (!pop || !el) {
                return;
            }
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const a = pop.anchor;
            let left = a.right + 6;
            if (left + w > window.innerWidth - 8) {
                left = Math.max(8, a.left - w - 6);
            }
            let top = a.top - 4;
            if (top + h > window.innerHeight - 8) {
                top = Math.max(8, a.bottom + 4 - h);
            }
            pop.left = left;
            pop.top = top;
            pop.placed = true;
        },

        closePrinterPop() {
            this.printerPop = null;
            if (this._printerPopKey) {
                window.removeEventListener("keydown", this._printerPopKey, true);
                window.removeEventListener("mousedown", this._printerPopDown, true);
                this._printerPopKey = null;
                this._printerPopDown = null;
            }
        },

        // Тянуть за шапку: двигается сам элемент, в данные – итог (как карточка сканера)
        startPrinterPopDrag(event) {
            const pop = this.printerPop;
            if (!pop || event.button !== 0) {
                return;
            }
            const el = this.$refs.printerPop;
            const dx = event.clientX - pop.left;
            const dy = event.clientY - pop.top;
            let left = pop.left;
            let top = pop.top;
            const move = (e) => {
                left = Math.min(Math.max(0, e.clientX - dx), window.innerWidth - 60);
                top = Math.min(Math.max(0, e.clientY - dy), window.innerHeight - 30);
                if (el) {
                    el.style.left = left + "px";
                    el.style.top = top + "px";
                }
            };
            const up = () => {
                window.removeEventListener("mousemove", move);
                window.removeEventListener("mouseup", up);
                if (this.printerPop === pop) {
                    pop.left = left;
                    pop.top = top;
                }
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
        },

        printerPopCard() {
            const pop = this.printerPop;
            if (pop) {
                this.closePrinterPop();
                this.closeCard();
                this.openPrinterCard(pop.row);
            }
        },

        printerPopTable() {
            const pop = this.printerPop;
            if (pop) {
                this.showObjInTable({ kind: "printer", id: pop.row.id });
            }
        },

        // Строки окошка: что за принтер, где, как найти
        printerPopRows(row) {
            const list = [];
            const add = function (label, value) {
                if (value) {
                    list.push({ label: label, value: value });
                }
            };
            add("Модель", [row.kind, row.model_title].filter(Boolean).join(" "));
            add("Печать", [row.color, row.duplex ? "дуплекс " + row.duplex : ""].filter(Boolean).join(", "));
            add("Где", [row.department, row.room].filter(Boolean).join(", ") + (row.number ? ", № " + row.number : ""));
            add("IP", (row.ip || "").split("\n").join(", "));
            add("Компьютеры", (row.computers || "").split("\n").join(", "));
            add("Примечание", row.note);
            return list;
        },

        // ---------- Новый принтер («Добавить» → «Принтер») ----------

        toggleNewPrinter() {
            this.closeMenus();
            if (this.newPrinter) {
                this.closeNewPrinter();
                return;
            }
            this.setArchiveView(false);
            this.actionBar = null;
            this.ensureTree();
            if (!this.printerModels.length) {
                this.loadPrinterModels();
            }
            const locationId = this.locationFilter ? this.locationFilter.id : null;
            // autoName – имя по правилу в поле «Имя», пока его не поменяли руками
            this.newPrinter = { location_id: locationId, model_id: null, number: "", name: "", ip: "", autoName: "", error: "", saving: false };
            this.newRoom = null;
            this.newModel = null;
            this.$nextTick(() => this.focusNewPrinter(locationId ? "model" : "location"));
        },

        closeNewPrinter() {
            this.newPrinter = null;
            this.newModel = null;
            if (this.newRoom && !this.newComputer) {
                this.newRoom = null;
            }
        },

        focusNewPrinter(which) {
            const el = this.$refs["np-" + which];
            const input = el && (el.$el ? el.$el.querySelector("input") : el);
            if (input) {
                input.focus();
            }
        },

        onNewPrinterLocation(locationId) {
            if (!this.newPrinter) {
                return;
            }
            this.newPrinter.location_id = locationId;
            this.newPrinter.error = "";
            this.$nextTick(() => this.focusNewPrinter(this.newPrinter.model_id ? "name" : "model"));
        },

        onNewPrinterModel(modelId) {
            if (!this.newPrinter) {
                return;
            }
            this.newPrinter.model_id = modelId;
            this.newPrinter.error = "";
            this.$nextTick(() => this.focusNewPrinter("name"));
        },

        onNewPrinterIpInput(event) {
            const fixed = fixIpTyping(event.target, event);
            if (fixed !== null && this.newPrinter) {
                this.newPrinter.ip = fixed;
            }
        },

        // Следующий № в кабинете: у МФУ и у принтеров свой счёт
        nextPrinterNumber(locationId, kind) {
            let max = 0;
            this.printerRows.forEach(function (row) {
                if (!row.archived && row.location_id === locationId && (row.kind_key || null) === kind && Number(row.number) > max) {
                    max = Number(row.number);
                }
            });
            return String(max + 1);
        },

        refreshNewPrinterNumber() {
            const form = this.newPrinter;
            if (!form) {
                return;
            }
            form.number = form.location_id ? this.nextPrinterNumber(form.location_id, this.newPrinterKind) : "";
            this.refreshNewPrinterName();
        },

        // Имя по правилу – в поле «Имя», пока его не поменяли руками
        refreshNewPrinterName() {
            const form = this.newPrinter;
            if (!form) {
                return;
            }
            if (form.name && form.name !== form.autoName) {
                return;
            }
            const name = form.location_id ? newPrinterName(this.namingIdx, form.location_id, this.newPrinterKind, form.number, this.printerRows) : "";
            form.name = name;
            form.autoName = name;
        },

        async submitNewPrinter() {
            const form = this.newPrinter;
            if (!form || form.saving) {
                return;
            }
            if (!form.location_id) {
                form.error = "Выбери расположение.";
                this.focusNewPrinter("location");
                return;
            }
            form.error = "";
            form.saving = true;
            try {
                const response = await apiFetch("/api/printers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ location_id: form.location_id, model_id: form.model_id, number: form.number, name: form.name, ip: form.ip })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                await this.loadPrinters();
                this.flashRow(data.id);
                this.$nextTick(() => {
                    if (!this.scrollToRow(data.id)) {
                        this.toast("Принтер добавлен, но скрыт поиском или фильтром");
                    }
                });
                (data.shifted || []).forEach((id) => this.flashCell("p" + id, "number"));
                this.toast("Добавлен: " + (form.name.trim() || "принтер без имени") +
                    (data.shifted && data.shifted.length ? ". № был занят – следующие сдвинуты: " + data.shifted.length : ""), "success");
                // Строка остаётся: можно сразу добавить следующий в тот же кабинет
                form.name = "";
                form.ip = "";
                form.autoName = "";
                this.refreshNewPrinterNumber();
                this.$nextTick(() => this.focusNewPrinter("name"));
            } catch (e) {
                form.error = String(e.message || e);
            }
            form.saving = false;
        },

        // ---------- Новая модель из строки нового принтера ----------

        // «＋ новая модель» в списке моделей: набранное – название (первое слово –
        // производитель, если такой уже есть в справочнике)
        openNewModel(text) {
            const words = String(text || "").trim().split(/\s+/).filter(Boolean);
            const makers = new Set(this.printerModels.map(function (m) { return (m.maker || "").toLowerCase(); }).filter(Boolean));
            const maker = words.length > 1 && makers.has(words[0].toLowerCase()) ? words.shift() : "";
            this.newModel = { kind: "printer", maker: maker, model: words.join(" "), color: false, duplex: false, error: "", saving: false };
            this.$nextTick(() => this.focusNewModel(maker ? "model" : "maker"));
        },

        closeNewModel() {
            this.newModel = null;
            this.$nextTick(() => this.focusNewPrinter("model"));
        },

        focusNewModel(which) {
            const el = this.$refs["nm-" + which];
            if (el) {
                el.focus();
            }
        },

        async submitNewModel() {
            const form = this.newModel;
            if (!form || form.saving) {
                return;
            }
            form.saving = true;
            form.error = "";
            try {
                const response = await apiFetch("/api/printer-models", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ kind: form.kind, maker: form.maker, model: form.model, color: form.color, duplex: form.duplex })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const saved = await response.json();
                await this.loadPrinterModels();
                this.newModel = null;
                this.toast("Модель добавлена: " + saved.title, "success");
                this.onNewPrinterModel(saved.id);
            } catch (e) {
                form.error = String(e.message || e);
                form.saving = false;
            }
        },

        // ---------- Подсказки при правке ячейки ----------

        // Свой список: модели справочника, «есть» / «нет»
        pickOptions(col) {
            if (col.pick === "flag") {
                return [{ key: "есть", value: "есть", count: "" }, { key: "нет", value: "нет", count: "" }];
            }
            const counts = new Map();
            this.printerRows.forEach(function (row) {
                if (!row.archived && row.model_id) {
                    counts.set(row.model_id, (counts.get(row.model_id) || 0) + 1);
                }
            });
            return this.printerModels.map(function (m) {
                return { key: m.title.toLowerCase(), value: m.title, count: counts.get(m.id) || "", countTitle: "Принтеров этой модели" };
            });
        }
    }
};
