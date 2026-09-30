// Режим «Расхождения» на странице «Таблица» (этап 26, editor и admin).
//
// Кнопка на панели со счётчиком (до «99+») переключает таблицу в список
// расхождений: ПК строками-группами, под ними поля, где данные сканера
// (GLPI / GSIT) отличаются от таблицы или в таблице пусто. Считает сервер
// (/api/scan/diffs). Решения: «Принять» — значение в ПК (История с пометкой
// источника), «Отклонить» — не предлагать, пока источник отдаёт то же,
// «В таблице своё» — эта пара значений не расхождение ни у одного ПК.
// «Ещё у N ПК» — показать только такую же пару, чтобы решить разом.

import { apiFetch, searchNorm, searchWords, matchesAllWords } from "../util.js";

export default {
    computed: {
        diffCountBadge() {
            return this.diffs.count > 99 ? "99+" : String(this.diffs.count);
        },

        diffFields() {
            const counts = {};
            this.diffBase.forEach(function (d) { counts[d.field] = (counts[d.field] || 0) + 1; });
            return this.builtinColumns
                .filter(function (c) { return counts[c.field]; })
                .map(function (c) { return { field: c.field, label: c.headerName, count: counts[c.field] }; });
        },

        // Отклонённые или нет, пара «ещё у N ПК», поиск — без фильтра по полю
        diffBase() {
            const f = this.diffs;
            const words = searchWords(this.quickFilter);
            return f.items.filter((d) => {
                if (!!d.rejected_by !== f.showRejected) {
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

        diffCountText() {
            const shown = this.diffShown.length;
            const pcs = this.diffGroups.length;
            if (this.diffs.showRejected) {
                return "Отклонено: " + shown;
            }
            return "Расхождений: " + shown + " у " + pcs + " ПК";
        }
    },

    methods: {
        async loadDiffs() {
            if (!this.canEdit) {
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
                this.diffs.count = data.items.filter(function (d) { return !d.rejected_by; }).length;
                this.diffs.rejected = data.rejected;
                this.diffs.sources = data.sources;
            } catch (e) {
                this.diffs.error = "Не удалось загрузить расхождения: " + (e.message || e);
            } finally {
                this.diffs.loading = false;
            }
        },

        toggleDiffMode() {
            this.diffMode = !this.diffMode;
            this.diffs.hover = null;
            if (this.diffMode) {
                this.closeCard();
                this.clearSelection();
                this.loadDiffs();
            }
        },

        diffFieldLabel(field) {
            const col = this.builtinColumns.find(function (c) { return c.field === field; });
            return col ? col.headerName : field;
        },

        diffSourceText(d) {
            return d.sources.map((s) => s.title + " №" + s.source_id).join(", ");
        },

        diffSourceTitle(d) {
            return d.sources.map((s) => s.title + " №" + s.source_id + " — проверен " + this.formatTime(s.checked_at)).join("\n");
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

        toggleDiffRejected() {
            this.diffs.showRejected = !this.diffs.showRejected;
            this.diffs.pair = null;
            this.diffs.field = "all";
            this.diffs.hover = null;
        },

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

        async acceptDiffs(list) {
            this.diffs.hover = null;
            try {
                const result = await this.diffPost("/api/scan/diffs/accept", {
                    items: list.map((d) => ({
                        computer_id: d.computer_id, field: d.field, value: d.proposed, table: d.table,
                        source: d.sources.map(function (s) { return s.title + " №" + s.source_id; }).join(", ")
                    }))
                });
                let text = "Принято: " + result.accepted;
                if (result.skipped.length) {
                    text += ". Уже изменено в таблице, пропущено: " + result.skipped.length;
                }
                this.toast(text, result.skipped.length ? undefined : "success");
                await Promise.all([this.loadDiffs(), this.loadTable()]);
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
        }
    }
};
