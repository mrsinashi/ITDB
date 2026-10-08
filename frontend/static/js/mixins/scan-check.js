// «Сканирование» → «Проверка» (этап 26г): вместо вкладок «Сопоставление» и
// «Расхождения» – один список того, что сканер (GLPI, GSIT) знает о ПК.
//
// Строка – ПК, с которым сопоставлены записи источников (по признаку или вручную),
// или запись, которую не удалось уверенно связать с ПК («привязать?», конфликт,
// нет в таблице). Фильтры: «Все» (по умолчанию, этап 38 – как в «Сети»), «Нужно
// решить», «Не узнал ПК», «Предлагает другое», «В порядке», «Нет в таблице», «Отклонённые».
// Клик по строке – подробности: поле | в таблице | GLPI | GSIT | что предлагается,
// у каждого предложения ✓ / ✕, «ещё у N ПК» – такие же пары разом. Выделение – как
// в Таблице (Ctrl / Shift + клик, Ctrl+A, Esc), «Выбрано: N ▾» – действия над
// выбранными. Плашка действий у открытой строки идёт за строкой при прокрутке,
// не выходя за поле таблицы (двигает браузер, без перерисовки Vue; этап 41).
// Этап 26е: ПК, о которых говорит только Jabber (VACUUM), – тоже строки;
// HOSTNAME из источника только сообщается – «взять» его нельзя (d.can_take).
// Этап 26ж: в подробностях – и «Мат. плата», и номера записей GLPI / GSIT.
// Этап 28: кнопка «Фильтр» – по атрибутам (у каких полей есть предложения);
// в подробностях – столбец «Сеть» (что видно по DHCP и проходу подсетей).

import { apiFetch, searchNorm, searchWordsIn, matchesAllWords, clickSelect } from "../util.js";

export const CHECK_SOURCES = ["glpi", "gsit"];
const COMPARE_FIELDS = ["hostname", "ip", "vacuum", "mac", "serial", "model", "motherboard", "os", "cpu", "ram", "drive", "gpu", "vnc", "glpi_id", "gsit_id"];
const STATE_ORDER = { name: 0, conflict: 0, diff: 1, ok: 2, none: 3 };
// Анимации по прокрутке (плашка открытой строки, этап 41); нет – плашка по событию прокрутки
const SCROLL_TIMELINE = typeof CSS !== "undefined" && !!CSS.supports &&
    CSS.supports("animation-timeline: --a") && CSS.supports("timeline-scope: --a");
let plateFrames = 0;

// Ключевые кадры плашки – свой элемент <style>
function plateStyle() {
    let el = document.getElementById("ck-plate-frames");
    if (!el) {
        el = document.createElement("style");
        el.id = "ck-plate-frames";
        document.head.appendChild(el);
    }
    return el;
}
// Значки плашки (Lucide): галочка, крестик, звено, «вернуть»
const ICONS = {
    ok: '<path d="M20 6 9 17l-5-5"/>',
    no: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>',
    reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    unlink: '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/>'
};

export const CHECK_FILTERS = [
    { key: "all", label: "Все" },
    { key: "todo", label: "Нужно решить" },
    { key: "unknown", label: "Не узнал ПК", title: "Совпало только имя или IP, или признаки противоречат" },
    { key: "diff", label: "Предлагает другое" },
    { key: "ok", label: "В порядке" },
    { key: "none", label: "Нет в таблице" },
    { key: "rejected", label: "Отклонённые", title: "Оставлено как в таблице" }
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

// Поля, по которым у строки есть предложения (и отклонённые – для их фильтра)
function rowFields(row) {
    return row.diffs.concat(row.rejected).map(function (d) { return d.field; });
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
            // ПК, о которых знает только Jabber (VACUUM, IP по адресу). «Привязать?» (link,
            // этап 38) – это строка самой записи, не ПК
            this.diffAllIndex.forEach(function (fields, pcId) {
                if (!byPc.has(pcId) && Object.values(fields).some(function (d) { return d.kind !== "link"; })) {
                    const d = Object.values(fields)[0];
                    const row = { key: "pc:" + pcId, pcId: pcId, recs: {}, state: "ok", record: null, brief: { hostname: d.hostname, place: d.place } };
                    byPc.set(pcId, row);
                    rows.push(row);
                }
            });
            rows.forEach((row) => {
                const pc = row.pcId ? this.checkComputers[row.pcId] || row.brief || null : null;
                const fields = row.record ? {} : (this.diffAllIndex.get(row.pcId) || {});
                row.pc = pc;
                row.diffs = [];
                row.rejected = [];
                Object.keys(fields).forEach(function (field) {
                    const d = fields[field];
                    if (d.kind !== "partial" && d.kind !== "link") {
                        (d.rejected_by ? row.rejected : row.diffs).push(d);
                    }
                });
                if (row.state === "ok" && row.diffs.length) {
                    row.state = "diff";
                }
                const recs = Object.values(row.recs);
                row.name = pc ? pc.hostname || "без имени" : ((recs[0] && recs[0].name) || "без имени");
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
            const words = searchWordsIn(this.scanMatchQuery, this.checkRows.map(function (row) { return row.search; }));
            const pair = this.check.pair;
            const fields = this.check.fields;
            return this.checkRows.filter((row) => {
                if (pair) {
                    if (!row.diffs.some(function (d) { return samePair(d, pair); })) {
                        return false;
                    }
                } else if (!inFilter(row, this.check.filter)) {
                    return false;
                } else if (fields.length && !rowFields(row).some(function (f) { return fields.includes(f); })) {
                    return false;
                }
                return !words.length || matchesAllWords(row.search, words);
            });
        },

        // «Фильтр»: атрибуты, по которым сканер что-то предлагает строкам выбранного
        // фильтра, с числом строк; отмеченные остаются в списке, даже если строк уже нет
        checkFieldOptions() {
            const counts = {};
            this.checkRows.forEach((row) => {
                if (inFilter(row, this.check.filter)) {
                    new Set(rowFields(row)).forEach(function (f) { counts[f] = (counts[f] || 0) + 1; });
                }
            });
            const chosen = this.check.fields;
            return COMPARE_FIELDS.filter(function (f) { return counts[f] || chosen.includes(f); })
                .map((f) => ({ key: f, label: this.diffFieldLabel(f), count: counts[f] || 0 }));
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

        // Что сделают действия над выбранными (с «ещё у N ПК» – только эта пара,
        // с фильтром по атрибутам – только отмеченные поля)
        checkSelDiffs() {
            const pair = this.check.pair;
            const fields = pair ? [] : this.check.fields;
            const list = [];
            this.checkSelectedRows.forEach(function (row) {
                row.diffs.forEach(function (d) {
                    if ((!pair || samePair(d, pair)) && (!fields.length || fields.includes(d.field))) {
                        list.push(d);
                    }
                });
            });
            return list;
        },

        // «Взять» – без имён ПК (их сканер только сообщает)
        checkSelTakeable() {
            return this.checkSelDiffs.filter(function (d) { return d.can_take; });
        },

        checkSelNames() {
            return this.checkSelectedRows.filter(function (r) { return r.state === "name" && r.pcId; });
        },

        // Jabber включён – в подробностях есть столбец «Vacuum»
        checkJabberOn() {
            return this.diffs.sources.indexOf("jabber") !== -1;
        },

        // DHCP или «Сеть» включены – в подробностях есть столбец «Сеть»
        checkNetOn() {
            return this.diffs.sources.indexOf("dhcp") !== -1 || this.diffs.sources.indexOf("net") !== -1;
        },

        checkOpenRow() {
            const key = this.check.open;
            return key ? this.checkRows.find(function (r) { return r.key === key; }) || null : null;
        },

        // Плашка у строки под курсором (у открытой – своя, она видна всегда)
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

        toggleCheckField(field) {
            const list = this.check.fields;
            this.check.fields = list.includes(field) ? list.filter(function (f) { return f !== field; }) : list.concat([field]);
            this.check.hover = null;
            this.afterCheckRender();
        },

        clearCheckFields() {
            this.check.fields = [];
            this.closeMenus();
            this.afterCheckRender();
        },

        // ---------- Строка: клик, выделение, подробности ----------

        // Нажатие мыши: с Ctrl / Shift – без выделения текста; Ctrl – выделение
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

        // Строка под курсором во время протягивания – по высоте, даже если курсор
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

        // У верхнего / нижнего края списка – прокрутка, пока держат мышь
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
            if (!SCROLL_TIMELINE) {
                this.placeCheckPlate();
            }
        },

        // После перерисовки: ширина таблички сравнения и место плашки открытой строки
        afterCheckRender() {
            this.$nextTick(() => {
                this.scanFitCompare();
                this.$nextTick(() => this.placeCheckPlate());
            });
        },

        // Плашка открытой строки (этап 41): идёт за строкой, пока видны подробности –
        // стоит у шапки, потом уходит под неё; выше шапки и ниже поля таблицы её обрезает
        // полоса (.ck-plate-rail). Сдвиг – функция прокрутки: y(t) = min(max(r0 - t, 0),
        // d0 - h - t), её изломы – ключевые кадры анимации по прокрутке таблицы, так
        // плашку двигает браузер вместе с таблицей. Здесь – только при перерисовке и смене
        // размеров; без анимаций по прокрутке (Firefox) – и на каждую прокрутку
        placeCheckPlate() {
            const rail = this.$refs.checkPlateRail;
            const el = this.$refs.checkOpenPlate;
            if (!rail || !el) {
                this.watchCheckPlate(null);
                return;
            }
            const key = this.check.open;
            const tr = key ? document.querySelector('.ck-table tr.ck-row[data-key="' + key + '"]') : null;
            const wrap = tr && tr.closest(".users-wrap");
            const scroll = tr && tr.closest(".history-scroll");
            if (!tr || !wrap || !scroll) {
                rail.style.display = "none";
                this.watchCheckPlate(null);
                return;
            }
            this.watchCheckPlate(scroll);
            const detail = tr.nextElementSibling && tr.nextElementSibling.classList.contains("sm-detail") ? tr.nextElementSibling : null;
            const s = scroll.getBoundingClientRect();
            const head = scroll.querySelector("thead");
            const headH = head ? head.offsetHeight : 0;
            const fieldTop = s.top + scroll.clientTop + headH;
            rail.style.display = "block";
            rail.style.top = (fieldTop - wrap.getBoundingClientRect().top) + "px";
            rail.style.height = Math.max(0, scroll.clientHeight - headH) + "px";
            const r = tr.getBoundingClientRect();
            const h = r.height;
            const t = scroll.scrollTop;
            // Строка и низ подробностей в поле при прокрутке 0
            const r0 = r.top - fieldTop + t;
            const d0 = (detail ? detail.getBoundingClientRect().bottom : r.bottom) - fieldTop + t;
            const y = function (at) { return Math.min(Math.max(r0 - at, 0), d0 - h - at); };
            el.style.height = h + "px";
            el.style.transform = "translateY(" + y(t) + "px)";
            const max = scroll.scrollHeight - scroll.clientHeight;
            if (!SCROLL_TIMELINE || max <= 0) {
                el.classList.remove("ck-plate-anim");
                return;
            }
            const points = [0, r0, d0 - h, max].filter(function (at) { return at >= 0 && at <= max; })
                .sort(function (a, b) { return a - b; });
            const frames = points.map(function (at) {
                return (at / max * 100).toFixed(4) + "% { transform: translateY(" + y(at).toFixed(2) + "px); }";
            }).join(" ");
            const name = "ck-plate-move-" + (++plateFrames);
            plateStyle().textContent = "@keyframes " + name + " { " + frames + " }";
            el.style.animationName = name;
            el.classList.add("ck-plate-anim");
        },

        // Строки и подробности поменяли высоту (своё значение, табличка сравнения, окно) –
        // плашку на место
        watchCheckPlate(scroll) {
            const table = scroll && scroll.querySelector(".ck-table");
            if (this._ckPlateWatch && this._ckPlateWatch.table === table) {
                return;
            }
            if (this._ckPlateWatch) {
                this._ckPlateWatch.observer.disconnect();
                this._ckPlateWatch = null;
            }
            if (!table || typeof ResizeObserver === "undefined") {
                return;
            }
            const observer = new ResizeObserver(() => this.placeCheckPlate());
            observer.observe(table);
            observer.observe(scroll);
            this._ckPlateWatch = { table: table, observer: observer };
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
                return { text: row.record.note || "признаки противоречат", cls: "ck-bad" };
            }
            if (row.state === "none") {
                return { text: "нет в таблице", cls: "ck-muted" };
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
            // Столбец «Vacuum»: кого Jabber видит с адреса этого ПК
            const seen = this.checkJabberOn && !row.record ? this.diffs.jabber[row.pcId] || [] : null;
            // Столбец «Сеть»: адрес, MAC и имя ПК по DHCP и проходу подсетей
            const net = this.checkNetOn && !row.record ? this.diffs.net[row.pcId] || {} : null;
            return COMPARE_FIELDS.map((field) => {
                const first = kinds.map(function (k) { return byKind[k][field]; }).find(Boolean);
                const itdb = live ? live[field] : (first ? first.itdb : "");
                const prop = props[field] && props[field].kind !== "partial" ? props[field] : null;
                return {
                    field: field,
                    label: this.diffFieldLabel(field),
                    itdb: itdb === null || itdb === undefined ? "" : String(itdb),
                    cells: kinds.map(function (k) { return { kind: k, c: byKind[k][field] || null }; })
                        .concat(seen ? [{ kind: "jabber", c: field === "vacuum" && seen.length ? this.checkJabberCell(seen, itdb) : null }] : [])
                        .concat(net ? [{ kind: "net", c: net[field] && net[field].length ? this.checkNetCell(field, net[field], itdb) : null }] : []),
                    prop: prop
                };
            });
        },

        // Ячейка «Vacuum» в строке VACUUM: логины с адреса ПК и отметка = / ≠
        checkJabberCell(logins, table) {
            const have = new Set(String(table || "").split("\n").map(function (l) { return l.trim().toLowerCase(); }).filter(Boolean));
            const mark = logins.every(function (l) { return have.has(l.toLowerCase()); }) ? "=" : "≠";
            return { source: logins.join("\n"), mark: mark, symbol: mark, markTitle: mark === "=" ? "Есть в таблице" : "В таблице нет", rawText: "" };
        },

        // Ячейка «Сеть»: что видно в сети и отметка = / ≠ (имя – без регистра и домена,
        // у адресов и MAC – есть ли в таблице)
        checkNetCell(field, values, table) {
            const norm = function (v) {
                const text = String(v).trim().toLowerCase();
                return field === "hostname" ? text.split(".")[0] : text;
            };
            const have = new Set(String(table || "").split("\n").map(norm).filter(Boolean));
            const mark = values.every(function (v) { return have.has(norm(v)); }) ? "=" : "≠";
            return { source: values.join("\n"), mark: mark, symbol: mark, markTitle: mark === "=" ? "Есть в таблице" : "В таблице нет", rawText: "" };
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

        // Когда источник проверял ПК – в подсказке у шапки (серые подписи убраны, 01.10)
        checkSourceHeadTitle(row, kind) {
            const r = row.recs[kind];
            return r && r.checked_at ? "Проверен " + this.formatTime(r.checked_at) : null;
        },

        checkSourceLink(r) {
            return r && r.webUrl ? r.webUrl + "/front/computer.form.php?id=" + r.source_id : null;
        },

        // «Ещё у N ПК»: показать только такие пары и выделить их – решить разом
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

        async checkTake(list, replace) {
            if (list.length) {
                await this.acceptDiffs(list, replace);
            }
        },

        async checkLeave(list, back) {
            if (list.length) {
                await this.rejectDiffs(list, back);
            }
        },

        async checkTakeSelected() {
            const list = this.checkSelTakeable.slice();
            this.closeMenus();
            const ok = await this.confirmDialog("Принять " + list.length + " " + this.scanPlural(list.length, "изменение", "изменения", "изменений") +
                " у " + this.checkSelectedRows.length + " ПК?", { okText: "Принять" });
            if (ok) {
                await this.checkTake(list);
            }
        },

        async checkLeaveSelected() {
            const list = this.checkSelDiffs.slice();
            this.closeMenus();
            const ok = await this.confirmDialog("Оставить как есть " + list.length + " " + this.scanPlural(list.length, "значение", "значения", "значений") +
                "?", { okText: "Оставить" });
            if (ok) {
                await this.checkLeave(list);
            }
        },

        // «Да, это они»: у выбранных «привязать?» – привязать к предложенному ПК
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
            const takeable = row.diffs.filter(function (d) { return d.can_take; });
            if (takeable.length && this.canEdit) {
                list.push({ key: "take", title: "Взять всё (" + takeable.length + ")", icon: ICONS.ok, run: () => this.checkTake(takeable) });
            }
            if (row.diffs.length && this.canEdit) {
                list.push({ key: "leave", title: "Оставить всё как есть", icon: ICONS.no, danger: true, run: () => this.checkLeave(row.diffs) });
            }
            if (this.isAdmin && row.record) {
                const r = row.record;
                if (r.state === "name" && row.pcId) {
                    list.push({ key: "yes", title: "Да, это " + host, icon: ICONS.ok, run: () => this.scanDecide(r, "link", row.pcId) });
                }
                if ((r.state === "name" || r.state === "key") && row.pcId) {
                    list.push({ key: "notthis", title: "Нет, это не " + host, icon: ICONS.no, danger: true, run: () => this.scanDecide(r, "reject", row.pcId) });
                }
                list.push({ key: "link", title: "Привязать к ПК…", icon: ICONS.link, run: () => this.openScanLinkBar(r) });
            }
            if (this.isAdmin && !row.record) {
                // ПК, сопоставленный по признаку: если сканер ошибся – «это не он»
                CHECK_SOURCES.forEach((kind) => {
                    const r = row.recs[kind];
                    if (r && r.state === "key") {
                        list.push({ key: "unlink-" + kind, title: r.title + " №" + r.source_id + " – это не " + host, icon: ICONS.unlink, run: () => this.scanDecide(r, "reject", row.pcId) });
                    }
                });
            }
            if (this.isAdmin) {
                this.checkRowDecided(row).forEach((r) => {
                    list.push({ key: "reset-" + r.kind, title: "Забыть решения по " + r.title + " №" + r.source_id, icon: ICONS.reset, run: () => this.scanDecide(r, "reset") });
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
