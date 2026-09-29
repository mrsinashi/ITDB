// Фильтры по столбцам (этап 21): воронка в шапке столбца (или правый клик по шапке) —
// список значений столбца с галочками и числом ПК, как в Excel. Активные фильтры —
// плашками слева на панели. Фильтры работают вместе с поиском и фильтром по дереву,
// не запоминаются (после перезагрузки страницы таблица снова полная).
//
// Фильтр столбца: colFilters[field] = { exclude, keys, labels }
//   exclude: true  — показаны все значения, кроме keys (сняли галочки);
//   exclude: false — показаны только keys («только это», «Снять все» и отметить нужные).
// Так новое значение, появившееся после «кроме списан», в таблице видно.
// keys — значения строчными (как в Справочниках), "" — пустая ячейка;
// у IP — подсеть /24, у многострочных (несколько IP, MAC, дисков) — каждая строка:
// ПК виден, если отмечено хотя бы одно из его значений.

import { matchesAllWords, searchNorm, searchWords, splitMulti } from "../util.js";
import { columnTitle, dateKey, ipSubnetKey, isOverdue, OVERDUE_STYLE } from "../columns.js";

export const EMPTY_KEY = "";
const EMPTY_LABEL = "(пусто)";

// Значения ячейки для фильтра: [{ key, value }]; пустая — [{ key: "" }]
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
                return { col: col, filter: filter, set: new Set(filter.keys) };
            });
        },

        // Строки режима (рабочие / архив) с фильтром по дереву — основа для
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

        // Значения столбца открытого фильтра — по строкам, прошедшим все остальные
        // фильтры и поиск (как в Excel): сначала справочник в его порядке, потом
        // остальные по возрастанию, «(пусто)» — в конце. [{ key, value, count }]
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
            // Отмеченные в фильтре «только эти», которых сейчас нет в строках, —
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
            const words = menu ? searchWords(menu.query) : [];
            if (!words.length) {
                return this.colFilterOptions;
            }
            return this.colFilterOptions.filter(function (o) {
                return !o.empty && matchesAllWords(searchNorm(o.value), words);
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

        // Поля с фильтром — для пересчёта ширины шапки
        colFilterFields() {
            return Object.keys(this.colFilters).sort().join(",");
        },

        colFilterMenuTitle() {
            const menu = this.colFilterMenu;
            const col = menu && this.allColumns.find(function (c) { return c.field === menu.field; });
            return col ? columnTitle(col) : "";
        },
    },

    watch: {
        // Закрыли меню (Esc, клик мимо, другое меню) — убрать слежение за прокруткой
        openMenu(name) {
            if (name !== "colFilter" && this.colFilterMenu) {
                this.colFilterMenu = null;
                this.removeColFilterMove();
            }
        },

        // Шапка отфильтрованного столбца шире на значок фильтра
        colFilterFields() {
            this.recalcWidths();
        },
    },

    methods: {
        // Строки, прошедшие фильтры по столбцам; except — поле, фильтр которого не учитывать
        applyColFilters(rows, except) {
            const active = this.activeColFilters.filter(function (f) { return f.col.field !== except; });
            if (!active.length) {
                return rows;
            }
            return rows.filter(function (row) {
                return active.every(function (f) {
                    return rowPasses(row, f.col, f.filter, f.set);
                });
            });
        },

        isColFiltered(field) {
            return !!this.colFilters[field];
        },

        // Открыть список значений под шапкой столбца (воронка или правый клик).
        // Повторный клик по той же воронке — закрыть.
        openColFilter(col, event) {
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

        // Меню — угол в угол под ячейкой шапки; за край окна не уходит
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

        // Записать фильтр столбца; «все отмечены» — фильтра нет
        setColFilter(field, filter) {
            const next = Object.assign({}, this.colFilters);
            if (!filter || (filter.exclude && !filter.keys.length)) {
                delete next[field];
            } else {
                next[field] = filter;
            }
            this.colFilters = next;
        },

        // Отметить / снять значения открытого столбца
        setColFilterChecked(options, checked) {
            const field = this.colFilterMenu.field;
            const old = this.colFilters[field] || { exclude: true, keys: [], labels: {} };
            const keys = new Set(old.keys);
            const labels = Object.assign({}, old.labels);
            options.forEach(function (o) {
                // exclude: в keys — снятые; include: в keys — отмеченные
                if (checked === !old.exclude) {
                    keys.add(o.key);
                    labels[o.key] = o.value;
                } else {
                    keys.delete(o.key);
                    delete labels[o.key];
                }
            });
            const filter = { exclude: old.exclude, keys: Array.from(keys), labels: labels };
            // «Только эти», а отмечено всё, что есть в столбце, — фильтра нет
            if (!filter.exclude && this.colFilterOptions.every(function (o) { return keys.has(o.key); })) {
                this.setColFilter(field, null);
                return;
            }
            this.setColFilter(field, filter);
        },

        toggleColFilterValue(option) {
            this.setColFilterChecked([option], !this.isColFilterChecked(option.key));
        },

        // «Все» (при поиске — «Все найденные»)
        toggleColFilterAll() {
            const menu = this.colFilterMenu;
            const checked = this.colFilterAllState !== true;
            if (!searchWords(menu.query).length) {
                this.setColFilter(menu.field, checked ? null : { exclude: false, keys: [], labels: {} });
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
            });
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
            // В списке «Фильтры: N» осталось меньше трёх — снова плашки, меню не нужно
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

        // Текст плашки: «OS: Win 7, Win 10», «Статус: кроме списан», «ИНВ: (пусто)»
        colFilterChipText(item) {
            const labels = item.filter.labels;
            const names = item.filter.keys.map(function (key) {
                return key === EMPTY_KEY ? EMPTY_LABEL : (labels[key] || key);
            });
            let list;
            if (!names.length) {
                list = "ничего";
            } else if (names.length <= 3) {
                list = names.join(", ");
            } else {
                list = names.slice(0, 2).join(", ") + " и ещё " + (names.length - 2);
            }
            return item.col.headerName + ": " + (item.filter.exclude ? "кроме " : "") + list;
        },

        colFilterChipTitle(item) {
            const labels = item.filter.labels;
            const names = item.filter.keys.map(function (key) {
                return key === EMPTY_KEY ? EMPTY_LABEL : (labels[key] || key);
            });
            return "«" + columnTitle(item.col) + "»: " + (item.filter.exclude ? "скрыты " : "показаны только ") +
                (names.join(", ") || "—") + ". Нажми, чтобы снять фильтр";
        },

        // Значение в списке — в оформлении из Справочников (цвет, фон, Ж, К)
        colFilterItemStyle(option) {
            const menu = this.colFilterMenu;
            if (!menu || option.empty) {
                return null;
            }
            const choice = (this.choiceStyleMap[menu.field] || {})[option.key] || null;
            let st = this.effectiveStyle(menu.field, choice);
            // Просроченная дата — красным жирным, как в таблице
            const col = this.allColumns.find(function (c) { return c.field === menu.field; });
            if (col && col.date && isOverdue(option.value)) {
                st = Object.assign({}, st, OVERDUE_STYLE);
            }
            return st.color || st.backgroundColor || st.fontWeight || st.fontStyle ? st : null;
        },
    }
};
