// Сканирование, этап 25: сбор из GLPI / GSIT и вкладка «Сопоставление».
//
// Сбор идёт на сервере в фоне; страница спрашивает запуск раз в 1,5 с, пока он
// идёт, и по окончании обновляет итог в блоке источника и записи на вкладке.
// В таблицу ПК сбор ничего не пишет. Вкладка «Сопоставление» — записи последнего
// сбора и с каким ПК ITDB каждая сопоставлена (считается на сервере сейчас, по
// текущим данным таблицы): по признаку, вручную, «привязать?», конфликт, нет в
// ITDB, дубль. Решения администратора: «это этот ПК», «не этот ПК», «забыть».

import { apiFetch, searchNorm, searchWords, matchesAllWords } from "../util.js";

const POLL_MS = 1500;
const COLLECT_KINDS = ["glpi", "gsit"];
const KEY_LABELS = { id: "GLPI ID", mac: "MAC", serial: "серийному" };
// Поля, у которых названия сопоставляются по смыслу и словарю (этап 25б)
const NAME_FIELDS = ["model", "os", "cpu", "gpu", "vnc", "drive"];
const MARK_TITLES = {
    "=": "Совпадает",
    "≈": "В таблице записана часть того, что видит источник",
    "≠": "Отличается"
};
const HOW_TITLES = {
    manual: "так названо вручную (вкладка «Названия»)",
    learned: "так это названо у других ПК в таблице",
    table: "так это называется в Справочнике или в таблице",
    same: "одно и то же, названо по-разному"
};
export const MATCH_FILTERS = [
    { key: "all", label: "Все", title: "Все записи последнего сбора" },
    { key: "matched", label: "Сопоставлены", title: "Сопоставлены с ПК по признаку (GLPI ID, MAC, серийный) или вручную" },
    { key: "name", label: "Привязать?", title: "Совпало только имя (или только GLPI ID): подтверди, что это тот ПК" },
    { key: "conflict", label: "Конфликты", title: "Признаки противоречат: значения этой записи не предлагаются, пока не решишь вручную" },
    { key: "none", label: "Нет в ITDB", title: "Такого ПК в таблице не нашлось" },
    { key: "dup", label: "Дубли", title: "Дубль другой записи того же источника (то же железо): не используется" }
];

function stateGroup(state) {
    return state === "key" || state === "link" ? "matched" : state;
}

function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) {
        return one;
    }
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) {
        return few;
    }
    return many;
}

function durationText(run) {
    if (!run.finished_at) {
        return "";
    }
    const s = Math.max(0, Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000));
    return s < 60 ? s + " с" : Math.floor(s / 60) + " мин " + (s % 60) + " с";
}

export default {
    computed: {
        scanMatchFilters() {
            return MATCH_FILTERS;
        },

        // У записи под курсором есть что делать (у дубля без решений — нечего)
        scanHoverActions() {
            const h = this.scanMatch.hover;
            return !!h && (h.record.state !== "dup" || h.record.decisions.length > 0);
        },

        scanCollectSources() {
            return this.scanSources.filter(function (s) { return COLLECT_KINDS.includes(s.kind); });
        },

        // Источники на вкладке «Сопоставление»: настроенные или с прошлым сбором
        scanMatchSources() {
            return this.scanCollectSources.filter(function (s) { return s.url || s.last_run; });
        },

        scanMatchRecords() {
            const data = this.scanMatch.data;
            if (!data || data.source !== this.scanMatch.source) {
                return [];
            }
            const filter = this.scanMatch.filter;
            const words = searchWords(this.scanMatchQuery);
            return data.records.filter((r) => {
                if (filter !== "all" && stateGroup(r.state) !== filter) {
                    return false;
                }
                if (!words.length) {
                    return true;
                }
                const hosts = this.scanRecordHosts(r).map(function (h) { return h.hostname; });
                return matchesAllWords(searchNorm([
                    r.source_id, r.name, r.values.ip, r.values.mac, r.values.serial, hosts.join(" ")
                ].filter(Boolean).join(" ")), words);
            });
        },

        scanMatchCounts() {
            const counts = { all: 0, matched: 0, name: 0, conflict: 0, none: 0, dup: 0 };
            const data = this.scanMatch.data;
            if (data && data.source === this.scanMatch.source) {
                data.records.forEach(function (r) {
                    counts.all += 1;
                    counts[stateGroup(r.state)] += 1;
                });
            }
            return counts;
        },

        scanNamesShown() {
            const words = searchWords(this.scanMatchQuery);
            return this.scanNames.items.filter((n) => {
                return !words.length || matchesAllWords(searchNorm([this.scanFieldLabel(n.field), n.source, n.table].join(" ")), words);
            });
        },

        scanMatchCountText() {
            if (this.scanTab === "names") {
                const all = this.scanNames.items.length;
                const shown = this.scanNamesShown.length;
                return shown === all ? "Соответствий: " + all : "Показано: " + shown + " из " + all;
            }
            const all = this.scanMatchCounts.all;
            const shown = this.scanMatchRecords.length;
            return shown === all ? "Записей: " + all : "Показано: " + shown + " из " + all;
        },

        scanMatchTitle() {
            const s = this.scanSource(this.scanMatch.source);
            return s ? s.title : "";
        },

        // ПК для «Привязать к…»: имя — расположение, № места (как в «Заменить…»)
        scanComputerOptions() {
            return this.activeRows.map((row) => {
                const room = [row.room_code, row.room_name].filter(Boolean).join(" ");
                const path = [row.building, row.department, room].filter(Boolean).join(" / ");
                const place = [path, row.seat_no ? "№ " + row.seat_no : ""].filter(Boolean).join(", ");
                const title = (row.hostname || "без имени") + (place ? " — " + place : "");
                return {
                    id: row.id,
                    kind: "pc",
                    path: title,
                    search: searchNorm([title, row.inv_no, row.ip, row.mac].filter(Boolean).join(" "))
                };
            });
        }
    },

    methods: {
        setScanTab(tab) {
            this.scanTab = tab;
            this.scanLinkBar = null;
            if (tab === "names") {
                this.loadScanNames();
            }
            if (tab === "match") {
                if (!this.scanMatchSources.some((s) => s.kind === this.scanMatch.source) && this.scanMatchSources.length) {
                    this.scanMatch.source = this.scanMatchSources[0].kind;
                }
                this.loadScanRecords();
            }
        },

        setScanMatchSource(kind) {
            if (this.scanMatch.source === kind) {
                return;
            }
            this.scanMatch.source = kind;
            this.scanMatch.open = {};
            this.scanLinkBar = null;
            this.loadScanRecords();
        },

        async loadScanRecords() {
            const kind = this.scanMatch.source;
            this.scanMatch.loading = true;
            this.scanMatch.error = "";
            try {
                const response = await apiFetch("/api/scan/records?source=" + encodeURIComponent(kind));
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                if (kind === this.scanMatch.source) {
                    this.scanMatch.data = data;
                }
            } catch (e) {
                this.scanMatch.error = "Не удалось загрузить записи: " + (e.message || e);
            } finally {
                this.scanMatch.loading = false;
            }
        },

        // ---------- Сбор ----------

        scanRunOf(kind) {
            const s = this.scanSource(kind);
            return this.scanRuns[kind] || (s ? s.last_run : null);
        },

        scanCollecting(kind) {
            const run = this.scanRunOf(kind);
            return !!run && run.status === "running";
        },

        // Почему «Собрать» недоступна (пусто — можно)
        scanCollectBlock(kind) {
            const s = this.scanSource(kind);
            if (!s) {
                return "";
            }
            if (this.scanCollecting(kind)) {
                return "Сбор уже идёт";
            }
            if (this.scanForms[kind] && this.scanDirty(kind)) {
                return "Сначала сохрани настройки";
            }
            if (!s.url) {
                return "Сначала укажи и сохрани адрес";
            }
            if (!s.enabled) {
                return "Источник выключен: отметь «Включён» и сохрани";
            }
            return "";
        },

        async collectScan(kind) {
            if (this.scanCollectBlock(kind)) {
                return;
            }
            try {
                const response = await apiFetch("/api/scan/sources/" + kind + "/collect", { method: "POST" });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.trackScanRun(await response.json());
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        trackScanRun(run) {
            this.scanRuns = Object.assign({}, this.scanRuns, { [run.source]: run });
            if (run.status === "running" && !this.scanPollTimer) {
                this.scanPollTimer = setTimeout(() => this.pollScanRuns(), POLL_MS);
            }
        },

        async pollScanRuns() {
            this.scanPollTimer = null;
            const running = Object.values(this.scanRuns).filter(function (r) { return r.status === "running"; });
            for (const old of running) {
                try {
                    const response = await apiFetch("/api/scan/runs/" + old.id);
                    if (!response.ok) {
                        continue;
                    }
                    const run = await response.json();
                    this.scanRuns = Object.assign({}, this.scanRuns, { [run.source]: run });
                    if (run.status !== "running") {
                        this.onScanRunDone(run);
                    }
                } catch (e) {
                    // сеть моргнула — спросим в следующий раз
                }
            }
            if (Object.values(this.scanRuns).some(function (r) { return r.status === "running"; })) {
                this.scanPollTimer = setTimeout(() => this.pollScanRuns(), POLL_MS);
            }
        },

        onScanRunDone(run) {
            const s = this.scanSource(run.source);
            if (s) {
                s.last_run = run;
            }
            const title = s ? s.title : run.source;
            if (run.status === "ok") {
                const st = run.stats;
                this.toast(title + ": собрано — свежих " + st.fresh + "; сопоставлено " + ((st.key || 0) + (st.link || 0)) +
                    ", привязать? " + (st.name || 0) + ", конфликтов " + (st.conflict || 0) + ", нет в ITDB " + (st.none || 0), "success");
            } else {
                this.toastError(title + ": " + (run.message || "сбор не удался"));
            }
            if (this.scanTab === "match" && this.scanMatch.source === run.source) {
                this.loadScanRecords();
            }
        },

        // После загрузки настроек: идущие запуски — следить
        resumeScanRuns() {
            this.scanCollectSources.forEach((s) => {
                if (s.last_run && s.last_run.status === "running") {
                    this.trackScanRun(s.last_run);
                }
            });
        },

        // Итог сбора одной строкой: { time, text, bad, running }
        scanRunInfo(kind) {
            const run = this.scanRunOf(kind);
            if (!run) {
                return null;
            }
            const s = this.scanSource(kind);
            const title = s ? s.title : kind;
            if (run.status === "running") {
                const p = (run.stats && run.stats.progress) || {};
                const text = p.total ? "Собираю: " + p.done + " из " + p.total + " ПК…" : "Собираю: список ПК…";
                return { time: this.formatTime(run.started_at), text: text, bad: false, running: true };
            }
            const time = this.formatTime(run.finished_at || run.started_at) + (durationText(run) ? " · " + durationText(run) : "") +
                (run.user_name ? " · " + run.user_name : "");
            if (run.status !== "ok") {
                return { time: time, text: run.message || "Сбор не удался", bad: true, running: false };
            }
            const st = run.stats || {};
            const parts = [
                "ПК в " + title + ": " + st.total,
                "свежих: " + st.fresh + " (не старше " + st.fresh_days + " дн.)"
            ];
            if (st.stale) {
                parts.push("устарели: " + st.stale);
            }
            if (st.no_date) {
                parts.push("без даты проверки: " + st.no_date);
            }
            if (st.dup) {
                parts.push("дублей: " + st.dup);
            }
            return { time: time, text: parts.join(", "), note: run.message || "", bad: false, running: false };
        },

        // ---------- Записи ----------

        scanComputer(id) {
            const data = this.scanMatch.data;
            return data && data.computers ? data.computers[id] : null;
        },

        // ПК ITDB у записи: сопоставленный или предлагаемые
        scanRecordHosts(r) {
            const ids = r.computer_id ? [r.computer_id] : r.candidates;
            return ids.map((id) => this.scanComputer(id)).filter(Boolean);
        },

        // «ПК в ITDB»: сопоставленный или предлагаемый; при конфликте — все, на кого указывает
        scanHostsText(r) {
            if (r.state === "none" || r.state === "dup") {
                return "";
            }
            return this.scanRecordHosts(r).map(function (c) { return c.hostname || "без имени"; }).join(", ");
        },

        scanStateText(r) {
            if (r.state === "key") {
                return "по " + r.by.map(function (k) { return KEY_LABELS[k]; }).join(", ");
            }
            if (r.state === "link") {
                return "вручную";
            }
            if (r.state === "name") {
                return "привязать?";
            }
            if (r.state === "conflict") {
                return "конфликт";
            }
            if (r.state === "dup") {
                return "дубль №" + r.dup_of;
            }
            return "нет в ITDB";
        },

        scanStateTitle(r) {
            if (r.note) {
                return r.note;
            }
            if (r.state === "key") {
                return "Сопоставлена по признаку: " + this.scanStateText(r);
            }
            if (r.state === "link") {
                const d = r.decisions.find(function (x) { return x.action === "link"; });
                return d ? "Привязал " + (d.user_name || "") + " " + this.formatTime(d.at) : "Привязана вручную";
            }
            if (r.state === "name") {
                return "Совпадает только имя: подтверди, что это тот ПК";
            }
            if (r.state === "dup") {
                return "То же железо, что у записи №" + r.dup_of + " (она свежее): эта не используется";
            }
            return "Такого ПК в таблице не нашлось";
        },

        scanSourceLink(r) {
            const data = this.scanMatch.data;
            return data && data.web_url ? data.web_url + "/front/computer.form.php?id=" + r.source_id : null;
        },

        toggleScanRecord(r) {
            const open = Object.assign({}, this.scanMatch.open);
            if (open[r.source_id]) {
                delete open[r.source_id];
            } else {
                open[r.source_id] = true;
            }
            this.scanMatch.open = open;
            this.scanMatch.hover = null;
        },

        // Строки «поле | источник | ITDB» для раскрытой записи. Сравнивает сервер
        // (scan_values.py): значение источника — уже в названиях таблицы, raw — как в источнике
        scanCompareRows(r) {
            const title = this.scanMatchTitle;
            return (r.compare || []).map((c) => {
                const col = this.builtinColumns.find(function (x) { return x.field === c.field; });
                const single = !String(c.raw || "").includes("\n") && !String(c.itdb || "").includes("\n");
                const renamed = c.raw && c.source !== c.raw;
                const hows = (c.how || "").split(",").filter(Boolean).map(function (h) { return HOW_TITLES[h]; });
                return Object.assign({}, c, {
                    label: col ? col.headerName : c.field,
                    rawText: renamed ? "в " + title + ": " + c.raw.split("\n").join(", ") : "",
                    markTitle: (MARK_TITLES[c.mark] || "") + (hows.length ? " — " + hows.join("; ") : ""),
                    // «Одно и то же» — отличается, но это одно значение, названное иначе
                    canSame: NAME_FIELDS.includes(c.field) && single && c.mark === "≠",
                    // «Это разное» — сочтено одинаковым, хотя написано иначе
                    canDiffer: NAME_FIELDS.includes(c.field) && single && c.mark === "=" && c.raw.toLowerCase() !== c.itdb.toLowerCase()
                });
            });
        },

        async scanSetName(c, kind) {
            try {
                const response = await apiFetch("/api/scan/names", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ field: c.field, source: c.raw, table: c.itdb, kind: kind })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.toast(c.label + ": «" + c.raw + "» — " + (kind === "same" ? "то же, что «" : "не то же, что «") + c.itdb + "»", "success");
                await this.loadScanRecords();
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        // ---------- Вкладка «Названия» ----------

        async loadScanNames() {
            this.scanNames.loading = true;
            this.scanNames.error = "";
            try {
                const response = await apiFetch("/api/scan/names");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.scanNames.items = await response.json();
            } catch (e) {
                this.scanNames.error = "Не удалось загрузить названия: " + (e.message || e);
            } finally {
                this.scanNames.loading = false;
            }
        },

        scanFieldLabel(field) {
            const col = this.builtinColumns.find(function (x) { return x.field === field; });
            return col ? col.headerName : field;
        },

        scanNameOrigin(n) {
            if (n.origin === "learned") {
                return "по таблице · " + n.count + " ПК";
            }
            return "вручную · " + (n.user_name || "") + " · " + this.formatTime(n.at);
        },

        async deleteScanName(n) {
            this.scanNames.hover = null;
            try {
                const response = await apiFetch("/api/scan/names/" + n.id, { method: "DELETE" });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.toast(this.scanFieldLabel(n.field) + ": соответствие «" + n.source + "» удалено", "success");
                await this.loadScanNames();
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        async differScanName(n) {
            this.scanNames.hover = null;
            await this.scanSetName({ field: n.field, raw: n.source, itdb: n.table, label: this.scanFieldLabel(n.field) }, "differ");
            await this.loadScanNames();
        },

        setScanNameHover(n, rowEl) {
            const wrap = rowEl.closest(".users-wrap");
            if (!wrap) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const rect = rowEl.getBoundingClientRect();
            this.scanNames.hover = { name: n, top: rect.top - w.top, height: rect.height };
        },

        scanAntivirusText(a) {
            const parts = [a.active ? "включён" : "выключен"];
            if (!a.uptodate) {
                parts.push("базы устарели");
            }
            return a.name + (a.version ? " " + a.version : "") + " — " + parts.join(", ");
        },

        scanFullText(r) {
            const f = r.full || {};
            const parts = [];
            if (f.os) {
                parts.push("ОС: " + f.os);
            }
            if (f.cpu && f.cpu.length) {
                parts.push("ЦП: " + f.cpu.join(", "));
            }
            if (f.memory_mb) {
                parts.push("ОЗУ: " + f.memory_mb + " МБ");
            }
            if (f.disks && f.disks.length) {
                parts.push("Диски: " + f.disks.map(function (d) { return (d.name || "?") + " (" + Math.round(d.mb / 1000) + " ГБ)"; }).join(", "));
            }
            if (f.gpus && f.gpus.length) {
                parts.push("Видео: " + f.gpus.join(", "));
            }
            if (f.manufacturer || f.model) {
                parts.push("Модель: " + [f.manufacturer, f.model].filter(Boolean).join(" "));
            }
            if (f.serial && f.serial !== r.values.serial) {
                parts.push("Серийный в источнике: " + f.serial + " (не признак)");
            }
            if (f.uuid) {
                parts.push("UUID: " + f.uuid);
            }
            if (f.tag) {
                parts.push("Тег агента: " + f.tag);
            }
            return parts;
        },

        scanDecisionText(d) {
            return this.formatTime(d.at) + " · " + (d.user_name || "") + " · " + (d.action === "link" ? "это " : "не ") + (d.hostname || "ПК №" + d.computer_id);
        },

        setScanRecordHover(r, rowEl) {
            const wrap = rowEl.closest(".users-wrap");
            if (!wrap) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const rect = rowEl.getBoundingClientRect();
            this.scanMatch.hover = { id: r.source_id, record: r, top: rect.top - w.top, height: rect.height };
        },

        // ---------- Решения ----------

        async scanDecide(r, action, computerId) {
            const url = "/api/scan/records/" + this.scanMatch.source + "/" + r.source_id + "/" + (action === "reset" ? "decisions" : action);
            const options = action === "reset"
                ? { method: "DELETE" }
                : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ computer_id: computerId }) };
            this.scanMatch.hover = null;
            try {
                const response = await apiFetch(url, options);
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const pc = computerId ? this.scanComputer(computerId) : null;
                const host = pc ? pc.hostname : (this.scanLinkBar && this.scanLinkBar.pickedName) || "";
                const name = this.scanMatchTitle + " №" + r.source_id;
                if (action === "link") {
                    this.toast(name + " — это " + host, "success");
                } else if (action === "reject") {
                    this.toast(name + " — не " + host, "success");
                } else {
                    this.toast(name + ": решения забыты", "success");
                }
                this.scanLinkBar = null;
                await this.loadScanRecords();
            } catch (e) {
                if (this.scanLinkBar) {
                    this.scanLinkBar.error = e.message || String(e);
                } else {
                    this.toastError(e.message || e);
                }
            }
        },

        openScanLinkBar(r) {
            this.scanMatch.hover = null;
            this.scanLinkBar = { source_id: r.source_id, record: r, error: "", pickedName: "" };
            this.$nextTick(() => {
                const picker = this.$refs["sl-picker"];
                const input = picker && picker.$el ? picker.$el.querySelector("input") : null;
                if (input) {
                    input.focus();
                }
            });
        },

        onScanLinkPick(computerId) {
            const bar = this.scanLinkBar;
            if (!bar) {
                return;
            }
            const row = this.activeRows.find(function (x) { return x.id === computerId; });
            bar.pickedName = row ? row.hostname || "" : "";
            this.scanDecide(bar.record, "link", computerId);
        },

        scanPlural: plural
    }
};
