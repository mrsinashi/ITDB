// Сканер, этап 25: сбор из GLPI / GSIT (с этапа 26д – и Jabber, с 28 – DHCP и сеть), вкладка
// «Названия» и общее для записей источников (с этапа 26г записи показывает вкладка
// «Проверка», scan-check.js; пользователей Jabber – страница «Vacuum», scan-vacuum.js).
//
// Сбор идёт на сервере в фоне; страница спрашивает запуск раз в 1,5 с, пока он
// идёт, и по окончании обновляет итог в блоке источника и «Проверку».
// В таблицу ПК сбор ничего не пишет. Сопоставление записи с ПК считается на
// сервере по текущим данным таблицы: по признаку, вручную, «привязать?»,
// конфликт, нет в ITDB, дубль. Решения администратора: «это этот ПК», «не этот
// ПК», «забыть».

import { apiFetch, searchNorm, searchWordsIn, matchesAllWords } from "../util.js";

const POLL_MS = 1000;
const COLLECT_KINDS = ["glpi", "gsit", "jabber", "dhcp", "net"];
// Что считает полоса сбора: «20 из 155 ПК»
const PROGRESS_UNITS = { jabber: " пользователей", net: " адресов", dhcp: "" };
const KEY_LABELS = { id: "ID", mac: "MAC", serial: "серийному" };
// Поля, у которых названия сопоставляются по смыслу и словарю (этап 25б)
const NAME_FIELDS = ["model", "motherboard", "os", "cpu", "gpu", "vnc", "drive"];
const MARK_TITLES = {
    "=": "Совпадает",
    "≈": "В таблице часть",
    "≠": "Отличается"
};
const MANUAL_TITLES = {
    same: "Одно и то же (вручную)",
    differ: "Разное (вручную)",
    keep: "В таблице своё (вручную)"
};
const MANUAL_NEXT = {
    same: "одно и то же",
    differ: "разное",
    keep: "в таблице своё"
};
const HOW_TITLES = {
    manual: "названо вручную",
    learned: "так названо у других ПК",
    table: "так названо в таблице",
    same: "названо по-разному"
};
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
        scanCollectSources() {
            return this.scanSources.filter(function (s) { return COLLECT_KINDS.includes(s.kind); });
        },

        // «Собрать» на «Проверке» (этап 26д): из всех включённых источников разом
        checkCollecting() {
            return this.scanCollectSources.some((s) => this.scanCollecting(s.kind));
        },

        checkCollectBlock() {
            const ready = this.scanCollectSources.filter(function (s) { return s.enabled && s.ready; });
            if (!ready.length) {
                return "Нет включённых источников";
            }
            if (ready.every((s) => this.scanCollecting(s.kind))) {
                return "Сбор уже идёт";
            }
            return "";
        },

        checkCollectTitle() {
            const lines = [];
            this.scanCollectSources.forEach((s) => {
                if (!s.enabled || !s.ready) {
                    return;
                }
                const info = this.scanRunInfo(s.kind);
                lines.push(s.title + ": " + (!info ? "ещё не собирали" : (info.running ? info.text : "собрано " + info.time + "\n    " + info.text)));
            });
            const block = this.checkCollectBlock;
            if (block && !lines.length) {
                return block;
            }
            return (block || "Собрать из всех включённых источников") + (lines.length ? "\n\n" + lines.join("\n") : "");
        },

        // Полоса сбора на «Проверке»: по всем источникам, из которых сейчас собирается
        checkProgress() {
            const running = this.scanCollectSources.filter((s) => this.scanCollecting(s.kind));
            if (!running.length) {
                return null;
            }
            let done = 0;
            let total = 0;
            const lines = [];
            running.forEach((s) => {
                const p = this.scanProgress(s.kind);
                const run = this.scanRunOf(s.kind);
                const st = (run.stats && run.stats.progress) || {};
                done += st.total ? st.done : 0;
                total += st.total || 0;
                lines.push(s.title + ": " + p.text);
            });
            return {
                percent: total ? Math.round(done / total * 100) : 0,
                text: running.length === 1 ? lines[0] : (total ? done + " из " + total : "Собираю…"),
                title: lines.join("\n")
            };
        },

        scanNamesShown() {
            const texts = this.scanNames.items.map((n) => searchNorm([this.scanFieldLabel(n.field), n.source, n.table].join(" ")));
            const words = searchWordsIn(this.scanMatchQuery, texts);
            return this.scanNames.items.filter(function (n, i) {
                return !words.length || matchesAllWords(texts[i], words);
            });
        },

        scanSearchPlaceholder() {
            if (this.scanTab === "names") {
                return "Поиск по названиям: поле, значение";
            }
            if (this.scanTab === "net") {
                return "Поиск: IP, MAC, имя, ПК";
            }
            return "Поиск: ПК, расположение, имя в GLPI, IP, MAC, серийный, значение";
        },

        scanNamesCountText() {
            const all = this.scanNames.items.length;
            const shown = this.scanNamesShown.length;
            return shown === all ? "Соответствий: " + all : "Показано: " + shown + " из " + all;
        },

        // ПК для «Привязать к…»: имя – расположение, № места (как в «Заменить…»)
        scanComputerOptions() {
            return this.activeRows.map((row) => {
                const room = [row.room_code, row.room_name].filter(Boolean).join(" ");
                const path = [row.building, row.department, room].filter(Boolean).join(" / ");
                const place = [path, row.seat_no ? "№ " + row.seat_no : ""].filter(Boolean).join(", ");
                const title = (row.hostname || "без имени") + (place ? " – " + place : "");
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
            if (this.scanTab !== tab) {
                this.scanMatchQuery = "";   // у вкладок разный поиск
            }
            this.scanTab = tab;
            this.scanLinkBar = null;
            this.closeMenus();
            this.watchSchedule(tab === "schedule");
            if (tab === "names") {
                this.loadScanNames();
            }
            if (tab === "schedule") {
                this.schedule.hover = null;
                this.loadSchedule();
            }
            if (tab === "check") {
                this.check.hover = null;
                this.loadCheck();
            }
            if (tab === "net") {
                this.loadNet();
            }
            this.syncHash();
        },

        reloadScanTab() {
            if (this.scanTab === "names") {
                this.loadScanNames();
            } else if (this.scanTab === "schedule") {
                this.loadSchedule();
            } else if (this.scanTab === "net") {
                this.loadNet();
            } else {
                this.loadCheck();
            }
        },

        // ---------- Сбор ----------

        // Полоса сбора источника: { percent, text }; не собирается – null
        scanProgress(kind) {
            const run = this.scanRunOf(kind);
            if (!run || run.status !== "running") {
                return null;
            }
            const p = (run.stats && run.stats.progress) || {};
            if (!p.total) {
                return { percent: 0, text: "Собираю…" };
            }
            return { percent: Math.round(p.done / p.total * 100), text: p.done + " из " + p.total };
        },

        // Запуск, о котором страница узнала не от своей кнопки (сбор по расписанию)
        noteScanRun(run) {
            const known = this.scanRunOf(run.source);
            if (known && known.id === run.id && known.status === run.status) {
                return;
            }
            if (run.status === "running") {
                this.trackScanRun(run);
                return;
            }
            const fresh = !known || known.id !== run.id;
            this.scanRuns = Object.assign({}, this.scanRuns, { [run.source]: run });
            const s = this.scanSource(run.source);
            if (s) {
                s.last_run = run;
            }
            if (fresh && known) {
                this.loadDiffs();
            }
        },

        scanRunOf(kind) {
            const s = this.scanSource(kind);
            return this.scanRuns[kind] || (s ? s.last_run : null);
        },

        scanCollecting(kind) {
            const run = this.scanRunOf(kind);
            return !!run && run.status === "running";
        },

        // Подсказка у «Собрать»: почему недоступна, идёт ли сбор, когда собирали и что
        scanCollectTitle(kind) {
            const block = this.scanCollectBlock(kind);
            if (block) {
                return block;
            }
            const s = this.scanSource(kind);
            const what = "Собрать из " + (s ? s.title : kind);
            const info = this.scanRunInfo(kind);
            if (!info) {
                return what + "\nЕщё не собирали";
            }
            return what + "\nПоследний сбор: " + info.time + "\n" + info.text + (info.note ? "\n" + info.note : "");
        },

        // Почему «Собрать» недоступна (пусто – можно)
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
            if (!s.ready) {
                return s.form === "net" ? "Нет подсетей для сканирования" : "Сначала укажи и сохрани адрес";
            }
            if (!s.enabled) {
                return "Источник выключен";
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

        async collectAllScan() {
            if (this.checkCollectBlock) {
                return;
            }
            const kinds = this.scanCollectSources
                .filter((s) => s.enabled && s.ready && !this.scanCollecting(s.kind))
                .map(function (s) { return s.kind; });
            for (const kind of kinds) {
                try {
                    const response = await apiFetch("/api/scan/sources/" + kind + "/collect", { method: "POST" });
                    if (!response.ok) {
                        throw new Error(await this.errorText(response));
                    }
                    this.trackScanRun(await response.json());
                } catch (e) {
                    this.toastError(this.scanSource(kind).title + ": " + (e.message || e));
                }
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
                    // сеть моргнула – спросим в следующий раз
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
            if (run.status === "ok" && run.source === "jabber") {
                const st = run.stats;
                this.toast(title + ": собрано – пользователей " + st.total + ", в сети " + st.online, "success");
            } else if (run.status === "ok" && run.source === "dhcp") {
                this.toast(title + ": собрано – аренд " + (run.stats.total - run.stats.fixed) + ", действуют " + run.stats.active, "success");
            } else if (run.status === "ok" && run.source === "net") {
                this.toast(title + ": адресов " + run.stats.total + ", ответили " + run.stats.alive, "success");
            } else if (run.status === "ok") {
                const st = run.stats;
                this.toast(title + ": собрано – свежих " + st.fresh + "; сопоставлено " + ((st.key || 0) + (st.link || 0)) +
                    ", привязать? " + (st.name || 0) + ", конфликтов " + (st.conflict || 0) + ", нет в ITDB " + (st.none || 0), "success");
            } else {
                this.toastError(title + ": " + (run.message || "сбор не удался"));
            }
            if (run.source === "jabber" && this.view === "vacuum") {
                this.loadVacuum();
            }
            if (this.view === "scan" && this.scanTab === "schedule") {
                this.loadSchedule(true);
            }
            if (this.view === "scan" && this.scanTab === "check") {
                this.loadCheck();
            } else {
                this.loadDiffs();
            }
        },

        // После загрузки настроек: идущие запуски – следить
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
            const took = durationText(run);
            const result = this.scanRunText(run);
            result.time = run.status === "running"
                ? this.formatTime(run.started_at)
                : this.formatTime(run.finished_at || run.started_at) + (took ? " · " + took : "") + (run.user_name ? " · " + run.user_name : "");
            return result;
        },

        scanRunDuration(run) {
            return durationText(run);
        },

        // Что собрано в запуске: { text, note, bad, running } (и для журнала расписания)
        scanRunText(run) {
            const kind = run.source;
            const s = this.scanSource(kind);
            const title = s ? s.title : kind;
            if (run.status === "running") {
                const p = (run.stats && run.stats.progress) || {};
                const unit = kind in PROGRESS_UNITS ? PROGRESS_UNITS[kind] : " ПК";
                return { text: p.total ? "Собираю: " + p.done + " из " + p.total + unit + "…" : "Собираю…", bad: false, running: true };
            }
            if (run.status !== "ok") {
                return { text: run.message || "Сбор не удался", bad: true, running: false };
            }
            const st = run.stats || {};
            if (kind === "jabber") {
                const groups = st.groups ? ", групп: " + st.groups : "";
                return { text: "Пользователей: " + st.total + ", в сети: " + st.online + groups, note: run.message || "", bad: false, running: false };
            }
            if (kind === "dhcp") {
                const parts = ["Аренд: " + (st.total - st.fixed), "действуют: " + st.active];
                if (st.fixed) {
                    parts.push("привязок: " + st.fixed);
                }
                if (st.stale) {
                    parts.push("старше " + st.fresh_days + " дн.: " + st.stale);
                }
                return { text: parts.join(", "), note: run.message || "", bad: false, running: false };
            }
            if (kind === "net") {
                return {
                    text: "Адресов: " + st.total + ", ответили: " + st.alive + ", с MAC: " + st.mac + ", с именем: " + st.names,
                    note: run.message || "", bad: false, running: false
                };
            }
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
            return { text: parts.join(", "), note: run.message || "", bad: false, running: false };
        },

        // ---------- Записи ----------

        scanComputer(id) {
            return this.checkComputers[id] || null;
        },

        // ПК ITDB у записи: сопоставленный или предлагаемые
        scanRecordHosts(r) {
            const ids = r.computer_id ? [r.computer_id] : r.candidates;
            return ids.map((id) => this.scanComputer(id)).filter(Boolean);
        },

        // «ПК в ITDB»: сопоставленный или предлагаемый; при конфликте – все, на кого указывает
        scanHostsText(r) {
            if (r.state === "none" || r.state === "dup") {
                return "";
            }
            return this.scanRecordHosts(r).map(function (c) { return c.hostname || "без имени"; }).join(", ");
        },

        scanStateText(r) {
            if (r.state === "key") {
                return "по " + r.by.map(function (k) { return k === "id" ? r.title + " ID" : KEY_LABELS[k]; }).join(", ");
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
                return null;
            }
            if (r.state === "link") {
                const d = r.decisions.find(function (x) { return x.action === "link"; });
                return d ? "Привязал " + (d.user_name || "") + " " + this.formatTime(d.at) : "Привязана вручную";
            }
            if (r.state === "name") {
                return "Совпало только имя";
            }
            if (r.state === "dup") {
                return "То же железо, что у №" + r.dup_of;
            }
            return null;
        },

        // Строки «поле | источник | ITDB» для раскрытой записи. Сравнивает сервер
        // (scan_values.py): значение источника – уже в названиях таблицы, raw – как в источнике
        scanCompareRows(r) {
            return (r.compare || []).map((c) => {
                const col = this.builtinColumns.find(function (x) { return x.field === c.field; });
                const renamed = c.raw && c.source !== c.raw;
                const hows = (c.how || "").split(",").filter(Boolean).map(function (h) { return HOW_TITLES[h]; }).filter(Boolean);
                // Двойной клик по отметке – у однострочных полей-названий, когда есть оба значения
                const cycle = NAME_FIELDS.includes(c.field) && c.manual !== undefined;
                const next = cycle ? this.scanNextMark(c) : null;
                return Object.assign({}, c, {
                    label: col ? col.headerName : c.field,
                    rawText: renamed ? c.raw.split("\n").join(", ") : "",
                    symbol: c.manual === "keep" ? "⇐" : c.mark,
                    cycle: cycle,
                    next: next,
                    markTitle: (c.manual ? MANUAL_TITLES[c.manual] : (MARK_TITLES[c.mark] || "")) +
                        (!c.manual && hows.length ? " – " + hows.join("; ") : "") +
                        (cycle ? "\nДвойной клик – " + (next ? MANUAL_NEXT[next] : "сбросить") : "")
                });
            });
        },

        // Круг решений по паре: как решит сравнение → «одно и то же» (или «разное»,
        // если и так совпало) → «в таблице своё» → снова как решит сравнение
        scanNextMark(c) {
            const order = c.auto_equal ? [null, "differ", "keep"] : [null, "same", "keep"];
            const i = order.indexOf(c.manual || null);
            return order[(i + 1) % order.length];
        },

        async scanCycleMark(c) {
            if (!c.cycle) {
                return;
            }
            try {
                const response = await apiFetch("/api/scan/names", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ field: c.field, source: c.raw, table: c.itdb, kind: c.next || "auto" })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.toast(c.label + ": «" + c.raw.split("\n").join(", ") + "» и «" + c.itdb + "» – " + (c.next ? MANUAL_NEXT[c.next] : "решение сброшено"), "success");
                await this.loadCheck();
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        // Табличка сравнения не до низа подробностей (пояснения справа выше её) – у неё
        // своя нижняя линия и скруглённый угол; до низа – линию даёт разделитель строки
        scanFitCompare() {
            this.$nextTick(() => {
                document.querySelectorAll(".sm-compare").forEach(function (table) {
                    const box = table.closest("td") || table.parentElement;
                    table.classList.toggle("short", table.offsetHeight < box.clientHeight - 1);
                });
            });
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

        scanNameKindTitle(n) {
            return { differ: "Разное", keep: "В таблице своё", board: "Материнская плата" }[n.kind] || "Одно и то же";
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
            try {
                const response = await apiFetch("/api/scan/names", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ field: n.field, source: n.source, table: n.table, kind: "differ" })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.toast(this.scanFieldLabel(n.field) + ": «" + n.source + "» и «" + n.table + "» – разное", "success");
                await this.loadScanNames();
            } catch (e) {
                this.toastError(e.message || e);
            }
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
            return a.name + (a.version ? " " + a.version : "") + " – " + parts.join(", ");
        },

        // Строки под табличкой: { label, text } – подпись полужирным
        scanDetailLines(r) {
            const f = r.full || {};
            const lines = [];
            const add = function (label, text, bad) {
                if (text) {
                    lines.push({ label: label, text: text, bad: !!bad });
                }
            };
            add(r.state === "conflict" ? "Конфликт:" : "Пояснение:", r.note, r.state === "conflict");
            add("Антивирусы:", (r.antivirus || []).map(this.scanAntivirusText).join("; "));
            add("ОС:", f.os);
            add("ЦП:", (f.cpu || []).join(", "));
            add("ОЗУ:", f.memory_mb ? f.memory_mb + " МБ" : "");
            // Объём – как прислал агент: в «двоичных» МБ (128 ГБ = 122 070 МБ), в столбце DRIVE – как на наклейке
            add("Диски:", (f.disks || []).map(function (d) { return (d.name || "?") + " (" + Number(d.mb || 0).toLocaleString("ru-RU") + " МБ)"; }).join(", "));
            add("Видео:", (f.gpus || []).join(", "));
            add("Модель:", [f.manufacturer, f.model].filter(Boolean).join(" "));
            if (f.serial && f.serial !== r.values.serial) {
                add("Серийный в источнике:", f.serial + " (не признак)");
            }
            add("UUID:", f.uuid);
            add("Тег агента:", f.tag);
            (r.decisions || []).forEach((d) => add("Решение:", this.scanDecisionText(d)));
            return lines;
        },

        scanDecisionText(d) {
            return this.formatTime(d.at) + " · " + (d.user_name || "") + " · " + (d.action === "link" ? "это " : "не ") + (d.hostname || "ПК №" + d.computer_id);
        },

        // ---------- Решения ----------

        async scanDecide(r, action, computerId) {
            const url = "/api/scan/records/" + r.kind + "/" + r.source_id + "/" + (action === "reset" ? "decisions" : action);
            const options = action === "reset"
                ? { method: "DELETE" }
                : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ computer_id: computerId }) };
            this.check.hover = null;
            try {
                const response = await apiFetch(url, options);
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const pc = computerId ? this.scanComputer(computerId) : null;
                const host = pc ? pc.hostname : (this.scanLinkBar && this.scanLinkBar.pickedName) || "";
                const name = r.title + " №" + r.source_id;
                if (action === "link") {
                    this.toast(name + " – это " + host, "success");
                } else if (action === "reject") {
                    this.toast(name + " – не " + host, "success");
                } else {
                    this.toast(name + ": решения забыты", "success");
                }
                this.scanLinkBar = null;
                await this.loadCheck();
            } catch (e) {
                if (this.scanLinkBar) {
                    this.scanLinkBar.error = e.message || String(e);
                } else {
                    this.toastError(e.message || e);
                }
            }
        },

        openScanLinkBar(r) {
            this.check.hover = null;
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
