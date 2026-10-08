// Фильтры по столбцам (этап 21): воронка в шапке столбца (или правый клик по шапке) –
// список значений столбца с галочками и числом ПК, как в Excel. Активные фильтры –
// плашками слева на панели. Фильтры работают вместе с поиском и фильтром по дереву,
// не запоминаются (после перезагрузки страницы таблица снова полная).
//
// Фильтр столбца: colFilters[field] = { exclude, keys, labels }
//   exclude: true  – показаны все значения, кроме keys (сняли галочки);
//   exclude: false – показаны только keys («только это», «Снять все» и отметить нужные).
// Так новое значение, появившееся после «кроме списан», в таблице видно.
// keys – значения строчными (как в Справочниках), "" – пустая ячейка;
// у IP – подсеть /24, у многострочных (несколько IP, MAC, дисков) – каждая строка:
// ПК виден, если отмечено хотя бы одно из его значений.
//
// «Антивирусы» (этап 26з): в списке сверху – ещё и состояния (работает, базы
// устарели, выключен); filter.states – отметки состояний: { only: [виды] } после
// «только» (как exclude: false у значений) или { off: [виды] } – снятые галочки.
// ПК виден, если у него есть антивирус в отмеченном состоянии с отмеченным названием.
//
// Остальные столбцы (этап 40) – так же, по выделению значения: выделения Таблицы
// (повтор, проверен, нет в Jabber, срок прошёл… – Справочники), блочок сканера (по
// ситуации, и когда кнопка «Значения сканера» выключена) и «Обычные» – без них.
// ПК виден, если у значения есть отмеченное выделение (и значение отмечено ниже).

import { matchesAllWords, searchNorm, searchWords, searchWordsIn, splitMulti } from "../util.js";
import { columnTitle, dateKey, ipSubnetKey, isOverdue } from "../columns.js";

export const EMPTY_KEY = "";
const EMPTY_LABEL = "(пусто)";
const AV_STATES = ["on", "old", "off"];
// Выделения значения в порядке Справочников, блочки сканера – «scan-<ситуация>»
const MARK_STATES = ["dup", "hostname", "gone", "stale", "overdue", "verified", "checked"];
const SCAN_STATES = ["diff", "fill", "unsure", "partial", "link"].map(function (kind) { return "scan-" + kind; });
const PLAIN_STATE = "none";
const VALUE_STATES = MARK_STATES.concat(SCAN_STATES, [PLAIN_STATE]);
const NO_STATES = { only: null, off: [] };

// Отмечено ли состояние в фильтре
function stateOn(states, kind) {
    return states.only ? states.only.indexOf(kind) !== -1 : states.off.indexOf(kind) === -1;
}

function statesActive(states) {
    return !!states && (!!states.only || states.off.length > 0);
}

// Значения ячейки для фильтра: [{ key, value }]; пустая – [{ key: "" }]
function valuesOf(row, col) {
    const raw = row[col.field];
    if (raw === null || raw === undefined || String(raw).trim() === "") {
        return [{ key: EMPTY_KEY, value: EMPTY_LABEL }];
    }
    const lines = col.multiline && !col.note ? splitMulti(raw) : [String(raw).trim()];
    const result = [];
    lines.forEach(function (line) {
        const subnet = col.values === "subnet" ? ipSubnetKey(line) : null;
        result.push(subnet ? { key: subnet, value: subnet } : { key: line.toLowerCase(), value: line });
    });
    return result.length ? result : [{ key: EMPTY_KEY, value: EMPTY_LABEL }];
}

function rowPasses(row, col, filter, set) {
    return valuesOf(row, col).some(function (v) {
        return filter.exclude ? !set.has(v.key) : set.has(v.key);
    });
}

export default {
    computed: {
        // Активные фильтры по порядку столбцов: [{ col, filter, set }]
        activeColFilters() {
            const filters = this.colFilters;
            return this.allColumns.filter(function (col) {
                return !!filters[col.field];
            }).map(function (col) {
                const filter = filters[col.field];
                return { col: col, filter: filter, set: new Set(filter.keys), states: filter.states || NO_STATES };
            });
        },

        // Строки режима (рабочие / архив) с фильтром по дереву – основа для
        // фильтров по столбцам и поиска
        locationRows() {
            let rows = this.modeRows;
            if (this.locationFilter) {
                const ids = this.locationFilter.ids;
                rows = rows.filter(function (row) {
                    return ids.has(row.location_id);
                });
            }
            return rows;
        },

        // Значения столбца открытого фильтра – по строкам, прошедшим все остальные
        // фильтры и поиск (как в Excel): сначала справочник в его порядке, потом
        // остальные по возрастанию, «(пусто)» – в конце. [{ key, value, count }]
        colFilterOptions() {
            const menu = this.colFilterMenu;
            const col = menu && this.allColumns.find(function (c) { return c.field === menu.field; });
            if (!col) {
                return [];
            }
            const rows = this.searchRows(this.applyColFilters(this.locationRows, col.field));
            const map = new Map();
            rows.forEach(function (row) {
                const seen = new Set();
                valuesOf(row, col).forEach(function (v) {
                    if (seen.has(v.key)) {
                        return;
                    }
                    seen.add(v.key);
                    let entry = map.get(v.key);
                    if (!entry) {
                        entry = { key: v.key, value: v.value, count: 0, empty: v.key === EMPTY_KEY };
                        map.set(v.key, entry);
                    }
                    entry.count += 1;
                });
            });
            // Отмеченные в фильтре «только эти», которых сейчас нет в строках, –
            // тоже в списке (с нулём), чтобы галочку можно было снять
            const filter = this.colFilters[col.field];
            if (filter && !filter.exclude) {
                filter.keys.forEach(function (key) {
                    if (!map.has(key)) {
                        map.set(key, { key: key, value: filter.labels[key] || key, count: 0, empty: key === EMPTY_KEY });
                    }
                });
            }
            const order = new Map();
            (this.choicesByField[col.field] || []).forEach(function (ch, i) {
                const key = col.values === "subnet" ? (ipSubnetKey(ch.value) || ch.value.trim().toLowerCase()) : ch.value.trim().toLowerCase();
                if (!order.has(key)) {
                    order.set(key, i);
                }
            });
            return Array.from(map.values()).sort(function (a, b) {
                if (a.empty !== b.empty) {
                    return a.empty ? 1 : -1;
                }
                const oa = order.has(a.key) ? order.get(a.key) : -1;
                const ob = order.has(b.key) ? order.get(b.key) : -1;
                if (oa !== -1 || ob !== -1) {
                    if (oa === -1) return 1;
                    if (ob === -1) return -1;
                    return oa - ob;
                }
                if (col.date) {
                    return (dateKey(a.value) || 0) - (dateKey(b.value) || 0);
                }
                return a.value.localeCompare(b.value, "ru", { numeric: true, sensitivity: "base" });
            });
        },

        // Что видно в списке с учётом поиска по значениям
        colFilterShown() {
            const menu = this.colFilterMenu;
            if (!menu || !searchWords(menu.query).length) {
                return this.colFilterOptions;
            }
            const texts = this.colFilterOptions.map(function (o) { return o.empty ? "" : searchNorm(o.value); });
            const words = searchWordsIn(menu.query, texts);
            return this.colFilterOptions.filter(function (o, i) {
                return !o.empty && matchesAllWords(texts[i], words);
            });
        },

        // Галочка «Все»: true / false / null (часть)
        colFilterAllState() {
            const shown = this.colFilterShown;
            if (!shown.length) {
                return false;
            }
            let on = 0;
            shown.forEach((o) => {
                if (this.isColFilterChecked(o.key)) {
                    on += 1;
                }
            });
            return on === shown.length ? true : (on === 0 ? false : null);
        },

        colFilterMenuStyle() {
            const p = this.colFilterMenu && this.colFilterMenu.pos;
            if (!p) {
                return { visibility: "hidden" };
            }
            return { left: p.left + "px", top: p.top + "px", width: p.width + "px" };
        },

        // Состояния в списке фильтра: у «Антивирусов» – состояния антивирусов, у остальных
        // столбцов (этап 40) – выделения значений, какие есть в столбце (и снятые), и
        // «Обычные»; выделений нет – списка нет. [{ kind, label, count, checked, style, chip }]
        colFilterStates() {
            const menu = this.colFilterMenu;
            const col = menu && this.allColumns.find(function (c) { return c.field === menu.field; });
            if (!col || (col.scanOnly && !this.avSettings)) {
                return [];
            }
            const rows = this.searchRows(this.applyColFilters(this.locationRows, col.field));
            const counts = {};
            rows.forEach((row) => {
                const seen = col.scanOnly ? new Set(this.avItems(row).map(function (a) { return a.status; })) : this.valueStates(row, col);
                seen.forEach(function (kind) { counts[kind] = (counts[kind] || 0) + 1; });
            });
            const states = this.colFilterStatesOf(col.field) || NO_STATES;
            if (col.scanOnly) {
                return this.avSettings.statuses.filter(function (st) { return st.show; }).map((st) => {
                    const style = this.avStatusStyle(st);
                    return {
                        kind: st.kind, label: st.label, count: counts[st.kind] || 0,
                        checked: stateOn(states, st.kind), style: style, chip: !!(style || {}).backgroundColor
                    };
                });
            }
            // Те, что есть в столбце, и выбранные (снятые / «только»), которых в строках
            // сейчас нет, – чтобы галочку можно было вернуть
            const picked = states.only || states.off;
            const list = VALUE_STATES.filter(function (kind) {
                return kind !== PLAIN_STATE && (counts[kind] || picked.indexOf(kind) !== -1);
            });
            if (!list.length) {
                return [];
            }
            list.push(PLAIN_STATE);
            return list.map((kind) => {
                const style = this.valueStateStyle(kind);
                return {
                    kind: kind, label: this.valueStateLabel(kind), count: counts[kind] || 0,
                    checked: stateOn(states, kind), style: style,
                    chip: !!style && !!(style.backgroundColor || style.boxShadow),
                    title: kind === PLAIN_STATE ? "Без выделений и значений сканера" : this.valueStateLabel(kind)
                };
            });
        },

        colFilterMenuTitle() {
            const menu = this.colFilterMenu;
            const col = menu && this.allColumns.find(function (c) { return c.field === menu.field; });
            return col ? columnTitle(col) : "";
        },
    },

    watch: {
        // Закрыли меню (Esc, клик мимо, другое меню) – убрать слежение за прокруткой
        openMenu(name) {
            if (name !== "colFilter" && this.colFilterMenu) {
                this.colFilterMenu = null;
                this.removeColFilterMove();
            }
        },
    },

    methods: {
        // Строки, прошедшие фильтры по столбцам; except – поле, фильтр которого не учитывать
        applyColFilters(rows, except) {
            const active = this.activeColFilters.filter(function (f) { return f.col.field !== except; });
            if (!active.length) {
                return rows;
            }
            return rows.filter((row) => {
                return active.every((f) => {
                    return f.col.scanOnly ? this.avRowPasses(row, f) : rowPasses(row, f.col, f.filter, f.set) && this.statesPass(row, f);
                });
            });
        },

        // Выделения значения ячейки (этап 40): виды выделений Таблицы по всем строкам
        // ячейки и блочок сканера («scan-diff»…); нет ничего – «none». Блочок – если его
        // ситуация включена в Справочниках, и когда кнопка «Значения сканера» выключена
        valueStates(row, col) {
            void this.dupVersion; // дубли считаются вне Vue – зависимость вручную
            const kinds = new Set();
            const value = row[col.field];
            if ((col.dup || col.date || col.field === "vacuum" || col.field === "hostname") &&
                value !== null && value !== undefined && String(value).trim() !== "") {
                const lines = col.multiline ? String(value).split("\n") : [String(value)];
                lines.forEach((line) => {
                    this.lineMarkKinds(this.lineMarks(row, col, line)).forEach(function (kind) { kinds.add(kind); });
                });
            }
            const entry = row.archived ? null : this.diffIndex.get(row.id);
            const d = entry ? entry[col.field] : null;
            const mark = d ? this.scanMarkByKind[d.kind] : null;
            if (mark && mark.enabled && !this.scanChipHidden(d)) {
                kinds.add("scan-" + d.kind);
            }
            if (!kinds.size) {
                kinds.add(PLAIN_STATE);
            }
            return kinds;
        },

        // Подпись и вид выделения – как в Справочниках
        valueStateLabel(kind) {
            if (kind === PLAIN_STATE) {
                return "Обычные";
            }
            const m = kind.indexOf("scan-") === 0 ? this.scanMarkByKind[kind.slice(5)] : this.tableMarkMap[kind];
            return m ? m.label : kind;
        },

        valueStateStyle(kind) {
            if (kind === PLAIN_STATE) {
                return null;
            }
            if (kind.indexOf("scan-") === 0) {
                const mark = this.scanMarkByKind[kind.slice(5)];
                return mark ? this.scanChipStyle(mark) : null;
            }
            return this.markStyle(kind);
        },

        // Отметки выделений: у значения есть отмеченное (отметок нет – фильтра нет)
        statesPass(row, f) {
            if (!statesActive(f.states)) {
                return true;
            }
            for (const kind of this.valueStates(row, f.col)) {
                if (stateOn(f.states, kind)) {
                    return true;
                }
            }
            return false;
        },

        isColFiltered(field) {
            return !!this.colFilters[field];
        },

        // Открыть список значений под шапкой столбца (воронка или правый клик).
        // Повторный клик по той же воронке – закрыть.
        openColFilter(col, event) {
            if (col.virtual) {
                return;
            }
            const th = event.currentTarget.closest("th");
            if (this.openMenu === "colFilter" && this.colFilterMenu && this.colFilterMenu.field === col.field && event.type === "click") {
                this.closeMenus();
                return;
            }
            const already = this.openMenu === "colFilter";
            if (this.openMenu && !already) {
                this.closeMenus();
            }
            this.colFilterMenu = { field: col.field, query: "", pos: null, th: th };
            this.openMenu = "colFilter";
            if (!already) {
                this.$nextTick(() => {
                    document.addEventListener("click", this.onDocClickCloseMenu, true);
                    document.addEventListener("keydown", this.onEscCloseMenu, true);
                });
                this._cfMove = () => this.placeColFilter();
                window.addEventListener("scroll", this._cfMove, true);
                window.addEventListener("resize", this._cfMove);
            }
            this.$nextTick(() => {
                this.placeColFilter();
                const input = this.$refs.colFilterInput;
                if (input) {
                    input.focus({ preventScroll: true });
                }
            });
        },

        removeColFilterMove() {
            if (this._cfMove) {
                window.removeEventListener("scroll", this._cfMove, true);
                window.removeEventListener("resize", this._cfMove);
                this._cfMove = null;
            }
        },

        // Меню – угол в угол под ячейкой шапки; за край окна не уходит
        placeColFilter() {
            const menu = this.colFilterMenu;
            if (!menu) {
                return;
            }
            let th = menu.th;
            if (!th || !th.isConnected) {
                th = document.querySelector('.data-table th[data-field="' + menu.field + '"]');
                menu.th = th;
            }
            if (!th) {
                this.closeMenus();
                return;
            }
            const r = th.getBoundingClientRect();
            const width = Math.min(360, Math.max(240, Math.round(r.width)), window.innerWidth - 8);
            let left = Math.round(r.left);
            if (left + width > window.innerWidth - 4) {
                left = Math.max(4, Math.round(r.right) - width);
            }
            menu.pos = { left: left, top: Math.round(r.bottom), width: width };
        },

        isColFilterChecked(key) {
            const filter = this.colFilters[this.colFilterMenu ? this.colFilterMenu.field : ""];
            if (!filter) {
                return true;
            }
            const has = filter.keys.indexOf(key) !== -1;
            return filter.exclude ? !has : has;
        },

        // «Антивирусы»: у ПК есть антивирус в отмеченном состоянии с отмеченным названием
        avRowPasses(row, f) {
            const check = function (key) { return f.filter.exclude ? !f.set.has(key) : f.set.has(key); };
            const list = this.avItems(row);
            if (!list.length) {
                return !statesActive(f.states) && check(EMPTY_KEY);
            }
            return list.some(function (a) {
                return stateOn(f.states, a.status) && check(a.title.trim().toLowerCase());
            });
        },

        // Записать фильтр столбца; «все отмечены» – фильтра нет.
        // states – отметки состояний ({ only } / { off }, остаются при смене значений)
        setColFilter(field, filter, states) {
            const next = Object.assign({}, this.colFilters);
            states = statesActive(states) ? { only: states.only || null, off: states.only ? [] : states.off } : null;
            if (!filter && states) {
                filter = { exclude: true, keys: [], labels: {} };
            }
            if (!filter || (filter.exclude && !filter.keys.length && !states)) {
                delete next[field];
            } else {
                next[field] = Object.assign({}, filter, { states: states || NO_STATES });
            }
            this.colFilters = next;
        },

        colFilterStatesOf(field) {
            return (this.colFilters[field] || {}).states || null;
        },

        // Отметки состояний открытого столбца: { only: [виды] } / { off: [виды] }; null – без фильтра
        setColStates(states) {
            const field = this.colFilterMenu.field;
            const old = this.colFilters[field];
            this.setColFilter(field, old ? { exclude: old.exclude, keys: old.keys, labels: old.labels } : null, states);
        },

        // Галочка у состояния: после «только» – дописать / убрать из «только этих» (отмечены
        // все из списка – фильтра нет), иначе – из снятых
        toggleColState(kind) {
            const states = this.colFilterStatesOf(this.colFilterMenu.field) || NO_STATES;
            const flip = function (list) {
                return list.indexOf(kind) === -1 ? list.concat([kind]) : list.filter(function (k) { return k !== kind; });
            };
            if (!states.only) {
                this.setColStates({ off: flip(states.off) });
                return;
            }
            const only = flip(states.only);
            const all = this.colFilterStates.every(function (st) { return only.indexOf(st.kind) !== -1; });
            this.setColStates(all ? null : { only: only });
        },

        // Отметить / снять значения открытого столбца
        setColFilterChecked(options, checked) {
            const field = this.colFilterMenu.field;
            const old = this.colFilters[field] || { exclude: true, keys: [], labels: {} };
            const keys = new Set(old.keys);
            const labels = Object.assign({}, old.labels);
            options.forEach(function (o) {
                // exclude: в keys – снятые; include: в keys – отмеченные
                if (checked === !old.exclude) {
                    keys.add(o.key);
                    labels[o.key] = o.value;
                } else {
                    keys.delete(o.key);
                    delete labels[o.key];
                }
            });
            const filter = { exclude: old.exclude, keys: Array.from(keys), labels: labels };
            const states = this.colFilterStatesOf(field);
            // «Только эти», а отмечено всё, что есть в столбце, – фильтра нет
            if (!filter.exclude && this.colFilterOptions.every(function (o) { return keys.has(o.key); })) {
                this.setColFilter(field, null, states);
                return;
            }
            this.setColFilter(field, filter, states);
        },

        toggleColFilterValue(option) {
            this.setColFilterChecked([option], !this.isColFilterChecked(option.key));
        },

        // «Все» (при поиске – «Все найденные»)
        toggleColFilterAll() {
            const menu = this.colFilterMenu;
            const checked = this.colFilterAllState !== true;
            if (!searchWords(menu.query).length) {
                this.setColFilter(menu.field, checked ? null : { exclude: false, keys: [], labels: {} }, this.colFilterStatesOf(menu.field));
                return;
            }
            this.setColFilterChecked(this.colFilterShown, checked);
        },

        // Показать только эти значения
        onlyColFilterValues(options) {
            const labels = {};
            options.forEach(function (o) { labels[o.key] = o.value; });
            this.setColFilter(this.colFilterMenu.field, {
                exclude: false,
                keys: options.map(function (o) { return o.key; }),
                labels: labels
            }, this.colFilterStatesOf(this.colFilterMenu.field));
        },

        // Enter в поиске по значениям: только найденные, меню закрывается
        onColFilterEnter() {
            const menu = this.colFilterMenu;
            if (menu && searchWords(menu.query).length && this.colFilterShown.length) {
                this.onlyColFilterValues(this.colFilterShown);
            }
            this.closeMenus();
        },

        clearColFilter(field) {
            this.setColFilter(field, null);
            // В списке «Фильтры: N» осталось меньше трёх – снова плашки, меню не нужно
            if (this.openMenu === "colFilterList" && this.activeColFilters.length < 3) {
                this.closeMenus();
            }
        },

        clearAllColFilters() {
            this.colFilters = {};
            if (this.openMenu === "colFilter" || this.openMenu === "colFilterList") {
                this.closeMenus();
            }
        },

        // Отмеченные состояния словами: «выключен, базы устарели»; у выделений значений
        // (этап 40) – «повтор» после «только», иначе «кроме повтор»
        statesText(item) {
            const states = item.states;
            if (!statesActive(states)) {
                return "";
            }
            const labels = this.avStatusMap;
            const text = (list) => list.map((kind) => {
                return (item.col.scanOnly ? (labels[kind] ? labels[kind].label : kind) : this.valueStateLabel(kind)).toLowerCase();
            }).join(", ") || "ничего";
            if (states.only) {
                return text(states.only);
            }
            if (item.col.scanOnly) {
                return text(AV_STATES.filter(function (kind) { return states.off.indexOf(kind) === -1; }));
            }
            return "кроме " + text(states.off);
        },

        // Текст плашки: «OS: Win 7, Win 10», «Статус: кроме списан», «ИНВ: (пусто)»,
        // «Антивирус: выключен»
        colFilterChipText(item) {
            const labels = item.filter.labels;
            const names = item.filter.keys.map(function (key) {
                return key === EMPTY_KEY ? EMPTY_LABEL : (labels[key] || key);
            });
            const states = this.statesText(item);
            if (states && item.filter.exclude && !names.length) {
                return item.col.headerName + ": " + states;
            }
            let list;
            if (!names.length) {
                list = "ничего";
            } else if (names.length <= 3) {
                list = names.join(", ");
            } else {
                list = names.slice(0, 2).join(", ") + " и ещё " + (names.length - 2);
            }
            return item.col.headerName + ": " + (states ? states + "; " : "") + (item.filter.exclude ? "кроме " : "") + list;
        },

        colFilterChipTitle(item) {
            const labels = item.filter.labels;
            const names = item.filter.keys.map(function (key) {
                return key === EMPTY_KEY ? EMPTY_LABEL : (labels[key] || key);
            });
            const states = this.statesText(item);
            if (states && item.filter.exclude && !names.length) {
                return "«" + columnTitle(item.col) + "»: " + states;
            }
            return "«" + columnTitle(item.col) + "»: " + (states ? states + "; " : "") + (item.filter.exclude ? "скрыты " : "показаны только ") +
                (names.join(", ") || "–");
        },

        // Значение в списке – в оформлении из Справочников (цвет, фон, Ж, К)
        colFilterItemStyle(option) {
            const menu = this.colFilterMenu;
            if (!menu || option.empty) {
                return null;
            }
            const choice = (this.choiceStyleMap[menu.field] || {})[option.key] || null;
            let st = this.effectiveStyle(menu.field, choice);
            // Просроченная дата – красным жирным, как в таблице
            const col = this.allColumns.find(function (c) { return c.field === menu.field; });
            if (col && col.date && isOverdue(option.value)) {
                st = Object.assign({}, st, this.markStyle("overdue"));
            }
            return st.color || st.backgroundColor || st.fontWeight || st.fontStyle || st.textDecoration ? st : null;
        },
    }
};
