// Пометки сканера в Таблице и список расхождений (этапы 26, 26б).
//
// Сервер (/api/scan/diffs) считает для ПК, сопоставленных с записями включённых
// источников, поля, где сканер предлагает другое: diff — отличается, fill — в
// таблице пусто, unsure — неточно (источники расходятся, VNC-серверов
// несколько), partial — в таблице часть (не расхождение). В Таблице такие
// ячейки помечаются: вид и «показывать и без кнопки» — у каждой ситуации свои
// (/api/scan/marks, блок «Пометки сканера» в Справочниках); кнопка на панели
// Таблицы включает пометки, у которых «без кнопки» не отмечено. При наведении —
// что предлагает сканер; при правке ячейки — первой подсказкой; в карточке —
// строкой с «Принять / Отклонить».
//
// Список расхождений — вкладка «Расхождения» на «Сканировании»: ПК группами,
// «Почему можно верить» (как сопоставлен, согласны ли источники, когда
// проверен), правка «В таблице» двойным кликом, «Принять», «Отклонить»,
// «⇐ в таблице своё», «ещё у N ПК».

import { apiFetch, searchNorm, searchWords, matchesAllWords } from "../util.js";

const KEY_TEXT = { id: "GLPI ID", mac: "MAC", serial: "серийному" };
const LIST_KINDS = ["diff", "fill", "unsure"];

export default {
    computed: {
        diffCountBadge() {
            return this.diffs.count > 99 ? "99" : String(this.diffs.count);
        },

        scanMarkByKind() {
            const map = {};
            this.scanMarks.forEach(function (m) { map[m.kind] = m; });
            return map;
        },

        // Все расхождения по ПК: id ПК → { поле → расхождение } (без отклонённых)
        diffIndex() {
            const map = new Map();
            this.diffs.items.forEach(function (d) {
                if (d.rejected_by) {
                    return;
                }
                let entry = map.get(d.computer_id);
                if (!entry) {
                    map.set(d.computer_id, entry = {});
                }
                entry[d.field] = d;
            });
            return map;
        },

        // Какие пометки видны сейчас: ситуация включена и (кнопка нажата или «без кнопки»)
        scanShownKinds() {
            const kinds = new Set();
            this.scanMarks.forEach((m) => {
                if (m.enabled && (this.scanOverlay || m.always)) {
                    kinds.add(m.kind);
                }
            });
            return kinds;
        },

        // ---------- Список на вкладке «Расхождения» ----------

        diffFields() {
            const counts = {};
            this.diffBase.forEach(function (d) { counts[d.field] = (counts[d.field] || 0) + 1; });
            return this.builtinColumns
                .filter(function (c) { return counts[c.field]; })
                .map(function (c) { return { field: c.field, label: c.headerName, count: counts[c.field] }; });
        },

        diffKindCounts() {
            const counts = { diff: 0, fill: 0, unsure: 0 };
            this.diffs.items.forEach(function (d) {
                if (!d.rejected_by && counts[d.kind] !== undefined) {
                    counts[d.kind] += 1;
                }
            });
            return counts;
        },

        // Отклонённые или нет, вид, пара «ещё у N ПК», поиск — без фильтра по полю
        diffBase() {
            const f = this.diffs;
            const words = searchWords(this.scanMatchQuery);
            return f.items.filter((d) => {
                if (!LIST_KINDS.includes(d.kind) || !!d.rejected_by !== f.showRejected) {
                    return false;
                }
                if (f.kind !== "all" && d.kind !== f.kind) {
                    return false;
                }
                if (f.pair && !(d.field === f.pair.field && d.table.toLowerCase() === f.pair.table.toLowerCase() && d.raw.toLowerCase() === f.pair.raw.toLowerCase())) {
                    return false;
                }
                return !words.length || matchesAllWords(searchNorm([d.hostname, d.place, d.table, d.proposed, d.raw].filter(Boolean).join(" ")), words);
            });
        },

        diffShown() {
            const field = this.diffs.field;
            return field === "all" ? this.diffBase : this.diffBase.filter(function (d) { return d.field === field; });
        },

        // ПК строками-группами, как дни в Истории
        diffGroups() {
            const groups = [];
            const byId = {};
            this.diffShown.forEach(function (d) {
                let g = byId[d.computer_id];
                if (!g) {
                    g = byId[d.computer_id] = { computer_id: d.computer_id, hostname: d.hostname, place: d.place, items: [] };
                    groups.push(g);
                }
                g.items.push(d);
            });
            return groups;
        },

        // На панели рядом с вкладками места мало: число расхождений — на «Все», здесь — ПК
        diffCountText() {
            if (this.diffs.showRejected) {
                return "Отклонено: " + this.diffShown.length;
            }
            return "ПК: " + this.diffGroups.length;
        }
    },

    methods: {
        async loadDiffs() {
            if (!this.user) {
                return;
            }
            this.diffs.loading = true;
            this.diffs.error = "";
            try {
                const response = await apiFetch("/api/scan/diffs?rejected=true");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                this.diffs.items = data.items;
                this.diffs.count = data.items.filter(function (d) { return !d.rejected_by && d.kind !== "partial"; }).length;
                this.diffs.rejected = data.rejected;
                this.diffs.sources = data.sources;
            } catch (e) {
                this.diffs.error = "Не удалось загрузить расхождения: " + (e.message || e);
            } finally {
                this.diffs.loading = false;
            }
        },

        async loadScanMarks() {
            try {
                const response = await apiFetch("/api/scan/marks");
                if (response.ok) {
                    this.scanMarks = await response.json();
                }
            } catch (e) {
                // без пометок таблица работает как раньше
            }
        },

        toggleScanOverlay() {
            this.scanOverlay = !this.scanOverlay;
            if (this.scanOverlay) {
                this.loadDiffs();
            }
        },

        diffFieldLabel(field) {
            const col = this.builtinColumns.find(function (c) { return c.field === field; });
            return col ? col.headerName : field;
        },

        // ---------- Пометки в ячейках Таблицы ----------

        scanCellDiff(row, col) {
            const entry = this.diffIndex.get(row.id);
            return entry ? entry[col.field] || null : null;
        },

        // Пометка ячейки: вид ситуации, если она сейчас показывается
        scanCellMark(row, col) {
            if (row.archived) {
                return null;
            }
            const d = this.scanCellDiff(row, col);
            if (!d || !this.scanShownKinds.has(d.kind)) {
                return null;
            }
            return this.scanMarkByKind[d.kind] || null;
        },

        scanCellTitle(row, col) {
            if (!this.scanCellMark(row, col)) {
                return null;
            }
            const d = this.scanCellDiff(row, col);
            const mark = this.scanMarkByKind[d.kind];
            const lines = [(mark ? mark.label : "Сканер") + ": " + this.diffSourceShort(d) + " — " + d.proposed.split("\n").join(", ") +
                (d.raw !== d.proposed ? " (" + d.raw.split("\n").join(", ") + ")" : "")];
            lines.push(this.diffTrust(d).map(function (t) { return t.text; }).join(" · "));
            if (this.canEdit && d.kind !== "partial") {
                lines.push("Двойной клик — значение сканера первым в подсказках; принять или отклонить — в карточке ПК");
            }
            return lines.join("\n");
        },

        // Подсказка при правке ячейки / строки карточки: значение сканера первым
        scanSuggestFor(rowId, field) {
            const entry = this.diffIndex.get(rowId);
            const d = entry ? entry[field] : null;
            if (!d || d.kind === "partial" || d.proposed.includes("\n")) {
                return [];
            }
            return [{ key: "scan:" + d.proposed.toLowerCase(), value: d.proposed, count: this.diffSourceShort(d), scan: true }];
        },

        // Строка карточки: что предлагает сканер (кроме «в таблице часть»)
        cardScanDiff(r) {
            if (!this.card || !r.field) {
                return null;
            }
            const entry = this.diffIndex.get(this.card.id);
            const d = entry ? entry[r.field] : null;
            return d && d.kind !== "partial" ? d : null;
        },

        // ---------- Почему можно верить ----------

        diffSourceShort(d) {
            return d.sources.map(function (s) { return s.title + " №" + s.source_id; }).join(", ");
        },

        // Части текста «почему можно верить»: как сопоставлен, согласие источников, когда проверен
        diffTrust(d) {
            const parts = [];
            const by = new Set();
            let manual = false;
            d.sources.forEach(function (s) {
                if (s.state === "link") {
                    manual = true;
                }
                (s.by || []).forEach(function (k) { by.add(k); });
            });
            if (manual) {
                parts.push({ text: "ПК привязан вручную" });
            }
            if (by.size) {
                parts.push({ text: "ПК опознан по " + ["mac", "serial", "id"].filter(function (k) { return by.has(k); }).map(function (k) { return KEY_TEXT[k]; }).join(" и ") });
            }
            if (d.sources.length > 1) {
                parts.push(d.kind === "unsure" && d.unsure.startsWith("источники")
                    ? { text: "источники расходятся", bad: true }
                    : { text: "источников согласны: " + d.sources.length });
            }
            if (d.kind === "unsure" && !d.unsure.startsWith("источники")) {
                parts.push({ text: "неточно: " + d.unsure, bad: true });
            }
            const dates = d.sources.map(function (s) { return s.checked_at; }).filter(Boolean).sort();
            if (dates.length) {
                parts.push({ text: "проверен " + this.formatDate(dates[dates.length - 1]) });
            }
            return parts;
        },

        diffSourceTitle(d) {
            return d.sources.map((s) => s.title + " №" + s.source_id + " — проверен " + this.formatTime(s.checked_at) + ", предлагает: " + s.value.split("\n").join(", ")).join("\n");
        },

        diffPairText(p) {
            return this.diffFieldLabel(p.field) + ": " + (p.table || "пусто") + " ← " + p.raw;
        },

        setDiffPair(d) {
            this.diffs.pair = { field: d.field, table: d.table, raw: d.raw };
            this.diffs.field = "all";
        },

        setDiffField(field) {
            this.diffs.field = field;
        },

        setDiffKind(kind) {
            this.diffs.kind = kind;
            this.diffs.field = "all";
        },

        toggleDiffRejected() {
            this.diffs.showRejected = !this.diffs.showRejected;
            this.diffs.pair = null;
            this.diffs.field = "all";
            this.diffs.hover = null;
        },

        // ---------- Решения ----------

        async diffPost(url, body) {
            const response = await apiFetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            if (!response.ok) {
                throw new Error(await this.errorText(response));
            }
            return response.json();
        },

        async afterDiffChange() {
            await Promise.all([this.loadDiffs(), this.loadTable()]);
            this.refreshCardRow();
        },

        async acceptDiffs(list) {
            this.diffs.hover = null;
            try {
                const result = await this.diffPost("/api/scan/diffs/accept", {
                    items: list.map((d) => ({
                        computer_id: d.computer_id, field: d.field, value: d.proposed, table: d.table,
                        source: this.diffSourceShort(d)
                    }))
                });
                let text = "Принято: " + result.accepted;
                if (result.skipped.length) {
                    text += ". Уже изменено в таблице, пропущено: " + result.skipped.length;
                }
                this.toast(text, result.skipped.length ? undefined : "success");
                await this.afterDiffChange();
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        async rejectDiffs(list, back) {
            this.diffs.hover = null;
            try {
                const result = await this.diffPost("/api/scan/diffs/" + (back ? "unreject" : "reject"), {
                    items: list.map(function (d) { return { computer_id: d.computer_id, field: d.field, raw: d.raw }; })
                });
                this.toast(back ? "Возвращено: " + result.returned : "Отклонено: " + result.rejected, "success");
                await this.loadDiffs();
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        // «В таблице своё»: эта пара значений — не расхождение ни у одного ПК
        async keepDiff(d) {
            this.diffs.hover = null;
            try {
                await this.diffPost("/api/scan/names", { field: d.field, source: d.raw, table: d.table, kind: "keep" });
                this.toast(this.diffFieldLabel(d.field) + ": «" + d.table + "» при «" + d.raw + "» — оставлено как в таблице", "success");
                await this.loadDiffs();
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        async acceptShownDiffs() {
            const list = this.diffShown.slice();
            const ok = await this.confirmDialog("Принять значения сканера: " + list.length + " у " + this.diffGroups.length + " ПК? Они запишутся в таблицу (с отметкой в Истории).", { okText: "Принять" });
            if (ok) {
                await this.acceptDiffs(list);
            }
        },

        async rejectShownDiffs() {
            const list = this.diffShown.slice();
            const back = this.diffs.showRejected;
            const ok = await this.confirmDialog(
                back ? "Вернуть отклонённые: " + list.length + "?" : "Отклонить: " + list.length + " у " + this.diffGroups.length + " ПК? Пока источник отдаёт те же значения, они не предлагаются.",
                { okText: back ? "Вернуть" : "Отклонить" }
            );
            if (ok) {
                await this.rejectDiffs(list, back);
            }
        },

        setDiffHover(d, rowEl) {
            const wrap = rowEl.closest(".users-wrap");
            if (!wrap) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const rect = rowEl.getBoundingClientRect();
            this.diffs.hover = { item: d, top: rect.top - w.top, height: rect.height };
        },

        // ---------- Правка значения таблицы прямо из списка / подробностей записи ----------

        // Своё значение в ПК (как правка ячейки): например, объединить таблицу и сканер
        async saveComputerValue(computerId, field, value) {
            const row = this.rows.find(function (r) { return r.id === computerId; });
            const col = this.allColumns.find(function (c) { return c.field === field; });
            if (!row || !col) {
                this.toastError("ПК не найден в таблице — обнови страницу.");
                return false;
            }
            if (String(value) === String(row[field] || "")) {
                return false;
            }
            await this.saveCellValue(row, col, value);
            return true;
        },

        startValueEdit(key, computerId, field, value) {
            const col = this.allColumns.find(function (c) { return c.field === field; });
            if (!this.canEdit || !col || !col.editable) {
                return;
            }
            this.valueEdit = { key: key, computerId: computerId, field: field, value: value || "", multiline: !!col.multiline };
            this.$nextTick(() => {
                const el = document.querySelector(".value-edit");
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },

        onValueEditKeydown(event) {
            if (event.key === "Escape") {
                event.preventDefault();
                this.valueEdit = null;
            } else if (event.key === "Enter" && !(this.valueEdit.multiline && event.shiftKey)) {
                event.preventDefault();
                this.finishValueEdit();
            }
        },

        async finishValueEdit() {
            const edit = this.valueEdit;
            if (!edit || edit.saving) {
                return;
            }
            edit.saving = true;
            try {
                const changed = await this.saveComputerValue(edit.computerId, edit.field, edit.value);
                this.valueEdit = null;
                if (changed) {
                    await this.loadDiffs();
                    if (this.view === "scan" && this.scanTab === "match") {
                        await this.loadScanRecords();
                    }
                }
            } finally {
                if (this.valueEdit === edit) {
                    this.valueEdit = null;
                }
            }
        },

        // ---------- Вид пометок (Справочники) ----------

        async updateScanMark(kind, patch) {
            try {
                const response = await apiFetch("/api/scan/marks/" + kind, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const saved = await response.json();
                this.scanMarks = this.scanMarks.map(function (m) { return m.kind === kind ? saved : m; });
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        // Образец пометки: как ячейка будет выглядеть
        scanMarkSample(m) {
            const style = {};
            if (m.color) {
                style.color = m.color;
            }
            if (m.bg_color) {
                style.backgroundColor = m.bg_color;
            }
            if (m.bold) {
                style.fontWeight = "700";
            }
            if (m.italic) {
                style.fontStyle = "italic";
            }
            if (m.strike) {
                style.textDecoration = "line-through";
            }
            if (m.frame) {
                style.boxShadow = "inset 0 0 0 1px " + m.frame;
            }
            return style;
        },

        scanMarkHint(kind) {
            return {
                diff: "В таблице одно, сканер предлагает другое",
                fill: "В таблице пусто, сканер знает значение",
                unsure: "Сканер не уверен: источники предлагают разное или значений несколько (например, два VNC)",
                partial: "В таблице только часть того, что знает сканер (например, один IP из двух) — не расхождение"
            }[kind] || "";
        },

        scanMarkHasStyle(m) {
            return !!(m.color || m.bg_color || m.bold || m.italic || m.strike || m.frame);
        }
    }
};
