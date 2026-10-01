// «Сканирование» → «Проверка» (этап 26г): вместо вкладок «Сопоставление» и
// «Расхождения» — один список того, что сканер (GLPI, GSIT) знает о ПК.
//
// Строка — ПК, с которым сопоставлены записи источников (по признаку или вручную),
// или запись, которую не удалось уверенно связать с ПК («привязать?», конфликт,
// нет в таблице). Фильтры: «Нужно решить» (по умолчанию), «Не узнал ПК»,
// «Предлагает другое», «В порядке», «Нет в таблице», «Отклонённые», «Все».
// Клик по строке — подробности: поле | в таблице | GLPI | GSIT | что предлагается,
// у каждого предложения ✓ / ✕, «ещё у N ПК» — такие же пары разом. Выделение — как
// в Таблице (Ctrl / Shift + клик, Ctrl+A, Esc), «Выбрано: N ▾» — действия над
// выбранными. Плашка действий у открытой строки идёт за строкой при прокрутке,
// не заходя под шапку таблицы (двигается напрямую, без перерисовки Vue).

import { apiFetch, searchNorm, searchWords, matchesAllWords, clickSelect } from "../util.js";

export const CHECK_SOURCES = ["glpi", "gsit"];
const COMPARE_FIELDS = ["hostname", "ip", "mac", "serial", "model", "os", "cpu", "ram", "drive", "gpu", "vnc"];
const STATE_ORDER = { name: 0, conflict: 0, diff: 1, ok: 2, none: 3 };
// Значки плашки (Lucide): галочка, крестик, звено, «вернуть»
const ICONS = {
    ok: '<path d="M20 6 9 17l-5-5"/>',
    no: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>',
    reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    unlink: '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/>'
};

export const CHECK_FILTERS = [
    { key: "todo", label: "Нужно решить", title: "Записи, которые сканер не связал с ПК уверенно, и ПК, у которых он предлагает другие значения" },
    { key: "unknown", label: "Не узнал ПК", title: "Совпало только имя или признаки (MAC, серийный, GLPI ID) противоречат: подтверди или привяжи вручную" },
    { key: "diff", label: "Предлагает другое", title: "ПК, у которых сканер видит другие значения или знает то, чего нет в таблице" },
    { key: "ok", label: "В порядке", title: "Сканер видит то же, что записано в таблице" },
    { key: "none", label: "Нет в таблице", title: "Таких ПК в таблице не нашлось" },
    { key: "rejected", label: "Отклонённые", title: "Значения, которые решено оставить как в таблице: их можно вернуть" },
    { key: "all", label: "Все", title: "Все записи последнего сбора" }
];

function inFilter(row, filter) {
    switch (filter) {
    case "todo":
        return row.state === "name" || row.state === "conflict" || row.state === "diff";
    case "unknown":
        return row.state === "name" || row.state === "conflict";
    case "diff":
        return row.state === "diff";
    case "ok":
        return row.state === "ok";
    case "none":
        return row.state === "none";
    case "rejected":
        return row.rejected.length > 0;
    default:
        return true;
    }
}

function samePair(d, pair) {
    return d.field === pair.field && d.table.toLowerCase() === pair.table.toLowerCase() && d.raw.toLowerCase() === pair.raw.toLowerCase();
}

export default {
    computed: {
        checkFilters() {
            return CHECK_FILTERS;
        },

        // Источники, по которым есть записи: колонки подробностей
        checkSourceKinds() {
            const data = this.check.data || {};
            return CHECK_SOURCES.filter(function (k) { return data[k] && data[k].records.length; });
        },

        checkComputers() {
            const data = this.check.data || {};
            const all = {};
            CHECK_SOURCES.forEach(function (k) {
                if (data[k]) {
                    Object.assign(all, data[k].computers);
                }
            });
            return all;
        },

        // Строки списка: ПК с сопоставленными записями и записи без уверенного ПК
        checkRows() {
            const data = this.check.data;
            if (!data) {
                return [];
            }
            const rows = [];
            const byPc = new Map();
            CHECK_SOURCES.forEach((kind) => {
                const d = data[kind];
                if (!d) {
                    return;
                }
                d.records.forEach((r) => {
                    if (r.state === "dup") {
                        return;
                    }
                    if ((r.state === "key" || r.state === "link") && r.computer_id) {
                        let row = byPc.get(r.computer_id);
                        if (!row) {
                            row = { key: "pc:" + r.computer_id, pcId: r.computer_id, recs: {}, state: "ok", record: null };
                            byPc.set(r.computer_id, row);
                            rows.push(row);
                        }
                        row.recs[kind] = r;
                        return;
                    }
                    const pcId = r.computer_id || (r.state === "name" && r.candidates.length === 1 ? r.candidates[0] : null);
                    rows.push({ key: kind + ":" + r.source_id, pcId: pcId, recs: { [kind]: r }, state: r.state, record: r });
                });
            });
            rows.forEach((row) => {
                const pc = row.pcId ? this.checkComputers[row.pcId] : null;
                const fields = row.record ? {} : (this.diffAllIndex.get(row.pcId) || {});
                row.pc = pc;
                row.diffs = [];
                row.rejected = [];
                Object.keys(fields).forEach(function (field) {
                    const d = fields[field];
                    if (d.kind !== "partial") {
                        (d.rejected_by ? row.rejected : row.diffs).push(d);
                    }
                });
                if (row.state === "ok" && row.diffs.length) {
                    row.state = "diff";
                }
                const recs = Object.values(row.recs);
                row.name = pc ? pc.hostname || "без имени" : (recs[0].name || "без имени");
                row.search = searchNorm([
                    pc ? pc.hostname : "", pc ? pc.place : "",
                    recs.map(function (r) { return [r.name, r.source_id, r.values.ip, r.values.mac, r.values.serial].join(" "); }).join(" "),
                    row.diffs.map(function (d) { return d.proposed + " " + d.table; }).join(" ")
                ].filter(Boolean).join(" "));
            });
            rows.sort(function (a, b) {
                return (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || a.name.localeCompare(b.name, "ru", { numeric: true });
            });
            return rows;
        },

        checkCounts() {
            const counts = {};
            CHECK_FILTERS.forEach((f) => {
                counts[f.key] = this.checkRows.filter(function (r) { return inFilter(r, f.key); }).length;
            });
            return counts;
        },

        checkShown() {
            const words = searchWords(this.scanMatchQuery);
            const pair = this.check.pair;
            return this.checkRows.filter((row) => {
                if (pair) {
                    if (!row.diffs.some(function (d) { return samePair(d, pair); })) {
                        return false;
                    }
                } else if (!inFilter(row, this.check.filter)) {
                    return false;
                }
                return !words.length || matchesAllWords(row.search, words);
            });
        },

        checkCountText() {
            const shown = this.checkShown.length;
            const all = this.checkRows.length;
            return shown === all ? "Всего: " + all : "Показано: " + shown + " из " + all;
        },

        checkSelectedSet() {
            return new Set(this.check.selected);
        },

        checkSelectedRows() {
            const set = this.checkSelectedSet;
            return this.checkRows.filter(function (r) { return set.has(r.key); });
        },

        // Что сделают действия над выбранными (с «ещё у N ПК» — только эта пара)
        checkSelDiffs() {
            const pair = this.check.pair;
            const list = [];
            this.checkSelectedRows.forEach(function (row) {
                row.diffs.forEach(function (d) {
                    if (!pair || samePair(d, pair)) {
                        list.push(d);
                    }
                });
            });
            return list;
        },

        checkSelNames() {
            return this.checkSelectedRows.filter(function (r) { return r.state === "name" && r.pcId; });
        },

        checkOpenRow() {
            const key = this.check.open;
            return key ? this.checkRows.find(function (r) { return r.key === key; }) || null : null;
        },

        // Плашка у строки под курсором (у открытой — своя, она видна всегда)
        checkHoverRow() {
            const h = this.check.hover;
            if (!h || h.key === this.check.open || this.valueEdit) {
                return null;
            }
            return this.checkRows.find(function (r) { return r.key === h.key; }) || null;
        }
    },

    methods: {
        async loadCheck() {
            this.check.loading = true;
            this.check.error = "";
            try {
                const parts = await Promise.all(CHECK_SOURCES.map(async (kind) => {
                    const response = await apiFetch("/api/scan/records?source=" + kind);
                    if (!response.ok) {
                        throw new Error(await this.errorText(response));
                    }
                    return response.json();
                }).concat([this.loadDiffs()]));
                const data = {};
                parts.slice(0, CHECK_SOURCES.length).forEach(function (d) {
                    d.records.forEach(function (r) {
                        r.kind = d.source;
                        r.title = d.title;
                        r.webUrl = d.web_url;
                    });
                    data[d.source] = d;
                });
                this.check.data = data;
                const keys = new Set(this.checkRows.map(function (r) { return r.key; }));
                this.check.selected = this.check.selected.filter(function (k) { return keys.has(k); });
                if (this.check.open && !keys.has(this.check.open)) {
                    this.check.open = null;
                }
                this.afterCheckRender();
            } catch (e) {
                this.check.error = "Не удалось загрузить: " + (e.message || e);
            } finally {
                this.check.loading = false;
            }
        },

        setCheckFilter(key) {
            this.check.filter = key;
            this.check.pair = null;
            this.check.hover = null;
            this.afterCheckRender();
        },

        // ---------- Строка: клик, выделение, подробности ----------

        // Нажатие мыши: с Ctrl / Shift — без выделения текста; Ctrl — выделение
        // протягиванием, как в Таблице (этап 26д): первая строка решает, добавлять или снимать
        onCheckRowMouseDown(event, row) {
            if (event.button !== 0 || event.target.closest("a, .act-ico, .value-edit")) {
                return;
            }
            const ctrl = event.ctrlKey || event.metaKey;
            if (ctrl || event.shiftKey) {
                event.preventDefault();
            }
            if (ctrl && !event.shiftKey) {
                this.startCheckDrag(row);
            }
        },

        onCheckRowClick(event, row) {
            if (event.target.closest("a, .act-ico, .value-edit")) {
                return;
            }
            if (event.shiftKey) {
                const keys = this.checkShown.map(function (r) { return r.key; });
                const r = clickSelect(this.check.selected, keys, this.check.anchor, row.key, event, false);
                this.check.selected = r.selected;
                this.check.anchor = r.anchor;
                return;
            }
            if (event.ctrlKey || event.metaKey) {
                return;   // Ctrl+клик уже обработан при нажатии (startCheckDrag)
            }
            this.check.anchor = row.key;
            this.check.open = this.check.open === row.key ? null : row.key;
            this.check.hover = null;
            this.valueEdit = null;
            this.afterCheckRender();
        },

        startCheckDrag(row) {
            const drag = {
                start: row.key,
                add: !this.checkSelectedSet.has(row.key),
                base: this.check.selected.slice(),
                keys: this.checkShown.map(function (r) { return r.key; }),
                x: 0,
                y: 0,
                raf: null
            };
            this._checkDrag = drag;
            this.check.anchor = row.key;
            this.applyCheckDrag(row.key);
            const onMove = (e) => {
                drag.x = e.clientX;
                drag.y = e.clientY;
                this.checkDragAtPointer();
                this.checkDragAutoScroll();
            };
            const onUp = () => {
                document.removeEventListener("mousemove", onMove, true);
                document.removeEventListener("mouseup", onUp, true);
                if (drag.raf) {
                    cancelAnimationFrame(drag.raf);
                }
                this._checkDrag = null;
            };
            document.addEventListener("mousemove", onMove, true);
            document.addEventListener("mouseup", onUp, true);
        },

        applyCheckDrag(key) {
            const drag = this._checkDrag;
            const a = drag.keys.indexOf(drag.start);
            const b = drag.keys.indexOf(key);
            if (a === -1 || b === -1) {
                return;
            }
            const range = new Set(drag.keys.slice(Math.min(a, b), Math.max(a, b) + 1));
            const base = new Set(drag.base);
            const next = drag.add
                ? drag.base.concat(Array.from(range).filter(function (k) { return !base.has(k); }))
                : drag.base.filter(function (k) { return !range.has(k); });
            if (next.length !== this.check.selected.length || next.some((k, i) => k !== this.check.selected[i])) {
                this.check.selected = next;
            }
        },

        // Строка под курсором во время протягивания — по высоте, даже если курсор
        // ушёл левее или правее таблицы (строки подробностей пропускаются)
        checkDragAtPointer() {
            const drag = this._checkDrag;
            const scroll = document.querySelector(".ck-wrap .history-scroll");
            if (!drag || !scroll) {
                return;
            }
            const box = scroll.getBoundingClientRect();
            const table = scroll.querySelector("table");
            const right = table ? Math.min(box.right, table.getBoundingClientRect().right) : box.right;
            const x = Math.min(Math.max(drag.x, box.left + 2), right - 4);
            const y = Math.min(Math.max(drag.y, box.top + 1), box.bottom - 2);
            const el = document.elementFromPoint(x, y);
            const tr = el ? el.closest(".ck-table tr.ck-row") : null;
            if (tr && tr.dataset.key) {
                this.applyCheckDrag(tr.dataset.key);
            }
        },

        // У верхнего / нижнего края списка — прокрутка, пока держат мышь
        checkDragAutoScroll() {
            const drag = this._checkDrag;
            const scroll = document.querySelector(".ck-wrap .history-scroll");
            if (!drag || !scroll || drag.raf) {
                return;
            }
            const step = () => {
                drag.raf = null;
                if (this._checkDrag !== drag) {
                    return;
                }
                const box = scroll.getBoundingClientRect();
                const head = scroll.querySelector("thead");
                const top = box.top + (head ? head.offsetHeight : 0);
                let dy = 0;
                if (drag.y < top + 20) {
                    dy = -Math.min(30, Math.ceil((top + 20 - drag.y) / 3));
                } else if (drag.y > box.bottom - 20) {
                    dy = Math.min(30, Math.ceil((drag.y - box.bottom + 20) / 3));
                }
                if (dy) {
                    scroll.scrollTop += dy;
                    this.checkDragAtPointer();
                    drag.raf = requestAnimationFrame(step);
                }
            };
            step();
        },

        selectAllCheck() {
            this.check.selected = this.checkShown.map(function (r) { return r.key; });
        },

        clearCheckSelection() {
            this.check.selected = [];
            this.check.anchor = null;
            this.closeMenus();
        },

        isCheckSelected(row) {
            return this.checkSelectedSet.has(row.key);
        },

        setCheckHover(row, rowEl) {
            const wrap = rowEl.closest(".users-wrap");
            if (!wrap) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const rect = rowEl.getBoundingClientRect();
            this.check.hover = { key: row.key, top: rect.top - w.top, height: rect.height };
        },

        onCheckScroll() {
            if (this.check.hover) {
                this.check.hover = null;
            }
            this.placeCheckPlate();
        },

        // После перерисовки: ширина таблички сравнения и место плашки открытой строки
        afterCheckRender() {
            this.$nextTick(() => {
                this.scanFitCompare();
                this.$nextTick(() => this.placeCheckPlate());
            });
        },

        // Плашка открытой строки: идёт за строкой ровно, без задержки (пишем стиль
        // элемента прямо в обработчике прокрутки); под шапку не заходит — у её нижней
        // границы останавливается, пока видны подробности; ушли — плашки нет
        placeCheckPlate() {
            const el = this.$refs.checkOpenPlate;
            if (!el) {
                return;
            }
            const key = this.check.open;
            const tr = key ? document.querySelector('.ck-table tr.ck-row[data-key="' + key + '"]') : null;
            const wrap = tr && tr.closest(".users-wrap");
            const scroll = tr && tr.closest(".history-scroll");
            if (!tr || !wrap || !scroll) {
                el.style.display = "none";
                return;
            }
            const detail = tr.nextElementSibling && tr.nextElementSibling.classList.contains("sm-detail") ? tr.nextElementSibling : null;
            const w = wrap.getBoundingClientRect();
            const s = scroll.getBoundingClientRect();
            const head = scroll.querySelector("thead");
            const headBottom = s.top + (head ? head.offsetHeight : 0);
            const r = tr.getBoundingClientRect();
            const h = r.height;
            const bottom = detail ? detail.getBoundingClientRect().bottom : r.bottom;
            const top = Math.min(Math.max(r.top, headBottom), bottom - h);
            if (top < headBottom - 0.5 || top > s.bottom - h) {
                el.style.display = "none";
                return;
            }
            el.style.display = "flex";
            el.style.top = (top - w.top) + "px";
            el.style.height = h + "px";
        },

        // ---------- Что показывать ----------

        // Ячейка источника в строке списка: «№3 · по MAC», «привязать?», «конфликт»…
        checkSourceCell(row, kind) {
            const r = row.recs[kind];
            if (!r) {
                return null;
            }
            return { rec: r, text: this.scanStateText(r), state: r.state, title: this.scanStateTitle(r) };
        },

        // «Что предлагает»: поля через запятую
        checkSummary(row) {
            if (row.state === "name") {
                return { text: "это " + row.name + "?", cls: "ck-ask" };
            }
            if (row.state === "conflict") {
                return { text: row.record.note || "признаки указывают на разные ПК", cls: "ck-bad" };
            }
            if (row.state === "none") {
                return { text: "в таблице такого ПК нет", cls: "ck-muted" };
            }
            if (!row.diffs.length) {
                return { text: row.rejected.length ? "всё решено" : "всё совпадает", cls: "ck-muted" };
            }
            return { text: row.diffs.map((d) => this.diffFieldLabel(d.field)).join(", "), cls: "" };
        },

        checkPlace(row) {
            return row.pc ? row.pc.place || "" : "";
        },

        // Поля подробностей: в таблице, по источникам, предложение
        checkDetailFields(row) {
            const kinds = this.checkSourceKinds.filter(function (k) { return row.recs[k]; });
            const byKind = {};
            kinds.forEach((k) => {
                byKind[k] = {};
                this.scanCompareRows(row.recs[k]).forEach(function (c) { byKind[k][c.field] = c; });
            });
            const live = row.pcId && row.state !== "name" ? this.rows.find(function (x) { return x.id === row.pcId; }) : null;
            const props = row.record ? {} : (this.diffAllIndex.get(row.pcId) || {});
            return COMPARE_FIELDS.map((field) => {
                const first = kinds.map(function (k) { return byKind[k][field]; }).find(Boolean);
                const itdb = live ? live[field] : (first ? first.itdb : "");
                const prop = props[field] && props[field].kind !== "partial" ? props[field] : null;
                return {
                    field: field,
                    label: this.diffFieldLabel(field),
                    itdb: itdb === null || itdb === undefined ? "" : String(itdb),
                    cells: kinds.map(function (k) { return { kind: k, c: byKind[k][field] || null }; }),
                    prop: prop
                };
            });
        },

        checkCanEditValue(row, f) {
            const col = this.allColumns.find(function (x) { return x.field === f.field; });
            return this.canEdit && !!row.pcId && (row.state === "ok" || row.state === "diff") && !!col && !!col.editable;
        },

        startCheckEdit(row, f) {
            if (this.checkCanEditValue(row, f)) {
                this.startValueEdit("c:" + row.key + ":" + f.field, row.pcId, f.field, f.itdb);
            }
        },

        checkSourceHead(row, kind) {
            const r = row.recs[kind];
            return r ? r.title + " №" + r.source_id : "";
        },

        // Когда источник проверял ПК — в подсказке у шапки (серые подписи убраны, 01.10)
        checkSourceHeadTitle(row, kind) {
            const r = row.recs[kind];
            return r && r.checked_at ? r.title + " проверял этот ПК " + this.formatTime(r.checked_at) : null;
        },

        checkSourceLink(r) {
            return r && r.webUrl ? r.webUrl + "/front/computer.form.php?id=" + r.source_id : null;
        },

        // «Ещё у N ПК»: показать только такие пары и выделить их — решить разом
        showCheckPair(d) {
            this.check.pair = { field: d.field, table: d.table, raw: d.raw };
            this.$nextTick(() => {
                this.check.selected = this.checkShown.map(function (r) { return r.key; });
                this.afterCheckRender();
            });
        },

        clearCheckPair() {
            this.check.pair = null;
            this.check.selected = [];
            this.afterCheckRender();
        },

        checkPairText(p) {
            return this.diffFieldLabel(p.field) + ": " + (p.table || "пусто") + " → " + p.raw.split("\n").join(", ");
        },

        // ---------- Действия ----------

        async checkTake(list) {
            if (list.length) {
                await this.acceptDiffs(list);
            }
        },

        async checkLeave(list, back) {
            if (list.length) {
                await this.rejectDiffs(list, back);
            }
        },

        async checkTakeSelected() {
            const list = this.checkSelDiffs.slice();
            this.closeMenus();
            const ok = await this.confirmDialog("Взять из сканера " + list.length + " " + this.scanPlural(list.length, "значение", "значения", "значений") +
                " у " + this.checkSelectedRows.length + " ПК? Они запишутся в таблицу (с отметкой в Истории).", { okText: "Взять" });
            if (ok) {
                await this.checkTake(list);
            }
        },

        async checkLeaveSelected() {
            const list = this.checkSelDiffs.slice();
            this.closeMenus();
            const ok = await this.confirmDialog("Оставить как есть " + list.length + " " + this.scanPlural(list.length, "значение", "значения", "значений") +
                "? Пока сканер видит то же, они не предлагаются (вернуть — фильтр «Отклонённые»).", { okText: "Оставить" });
            if (ok) {
                await this.checkLeave(list);
            }
        },

        // «Да, это они»: у выбранных «привязать?» — привязать к предложенному ПК
        async checkConfirmSelected() {
            const rows = this.checkSelNames.slice();
            this.closeMenus();
            let done = 0;
            for (const row of rows) {
                try {
                    const response = await apiFetch("/api/scan/records/" + row.record.kind + "/" + row.record.source_id + "/link", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ computer_id: row.pcId })
                    });
                    if (!response.ok) {
                        throw new Error(await this.errorText(response));
                    }
                    done += 1;
                } catch (e) {
                    this.toastError(row.name + ": " + (e.message || e));
                }
            }
            if (done) {
                this.toast("Привязано: " + done, "success");
            }
            await this.loadCheck();
        },

        // Действия плашки у строки: { key, title, icon (внутренность svg), danger, run }
        checkActions(row) {
            const list = [];
            const host = row.name;
            if (row.diffs.length && this.canEdit) {
                list.push({ key: "take", title: "Взять из сканера всё предложенное (" + row.diffs.length + ")", icon: ICONS.ok, run: () => this.checkTake(row.diffs) });
                list.push({ key: "leave", title: "Оставить всё как есть — не предлагать, пока сканер видит то же", icon: ICONS.no, danger: true, run: () => this.checkLeave(row.diffs) });
            }
            if (this.isAdmin && row.record) {
                const r = row.record;
                if (r.state === "name" && row.pcId) {
                    list.push({ key: "yes", title: "Да, это " + host, icon: ICONS.ok, run: () => this.scanDecide(r, "link", row.pcId) });
                }
                if ((r.state === "name" || r.state === "key") && row.pcId) {
                    list.push({ key: "notthis", title: "Нет, это не " + host + " — больше не предлагать", icon: ICONS.no, danger: true, run: () => this.scanDecide(r, "reject", row.pcId) });
                }
                list.push({ key: "link", title: "Привязать к ПК… (выбрать вручную)", icon: ICONS.link, run: () => this.openScanLinkBar(r) });
            }
            if (this.isAdmin && !row.record) {
                // ПК, сопоставленный по признаку: если сканер ошибся — «это не он»
                CHECK_SOURCES.forEach((kind) => {
                    const r = row.recs[kind];
                    if (r && r.state === "key") {
                        list.push({ key: "unlink-" + kind, title: r.title + " №" + r.source_id + " — это не " + host + ": больше не сопоставлять", icon: ICONS.unlink, run: () => this.scanDecide(r, "reject", row.pcId) });
                    }
                });
            }
            if (this.isAdmin) {
                this.checkRowDecided(row).forEach((r) => {
                    list.push({ key: "reset-" + r.kind, title: "Забыть решения по " + r.title + " №" + r.source_id + ": снова сопоставлять по признакам", icon: ICONS.reset, run: () => this.scanDecide(r, "reset") });
                });
            }
            return list;
        },

        checkRowHasActions(row) {
            return this.checkActions(row).length > 0;
        },

        checkRowDecided(row) {
            return Object.values(row.recs).filter(function (r) { return r.decisions.length > 0; });
        }
    }
};
