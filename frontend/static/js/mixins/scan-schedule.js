// «Сканер» → «Расписание» (этап 28): когда программа сама собирает данные из
// каждого источника, и журнал запусков.
//
// Строка — источник: «Запуск» (вручную / каждые N / раз в день), «Время» (часы
// работы или время запуска), «Дни», последний сбор (пока идёт — полоса) и когда
// следующий. Изменение сохраняется сразу. Плашка у строки — «Собрать сейчас».
// Сам запуск делает сервер (scan_schedule.py); страница перечитывает расписание
// раз в 15 с, пока открыта, — чтобы увидеть сборы, начатые им.

import { apiFetch } from "../util.js";

const REFRESH_MS = 15000;
const MINUTES_LABELS = { 15: "каждые 15 мин", 30: "каждые 30 мин", 60: "каждый час", 120: "каждые 2 ч", 240: "каждые 4 ч", 480: "каждые 8 ч" };

export default {
    computed: {
        scheduleModeOptions() {
            return [{ key: "off", label: "вручную" }]
                .concat(this.schedule.minutes.map(function (m) { return { key: String(m), label: MINUTES_LABELS[m] || "каждые " + m + " мин" }; }))
                .concat([{ key: "daily", label: "раз в день" }]);
        },

        scheduleCountText() {
            const on = this.schedule.items.filter(function (it) { return it.mode !== "off"; }).length;
            return "По расписанию: " + on + " из " + this.schedule.items.length;
        }
    },

    methods: {
        async loadSchedule(quiet) {
            if (!quiet) {
                this.schedule.loading = true;
            }
            try {
                const [schedule, runs] = await Promise.all([apiFetch("/api/scan/schedule"), apiFetch("/api/scan/runs?limit=50")]);
                if (!schedule.ok) {
                    throw new Error(await this.errorText(schedule));
                }
                if (!runs.ok) {
                    throw new Error(await this.errorText(runs));
                }
                const data = await schedule.json();
                this.schedule.items = data.items;
                this.schedule.minutes = data.minutes;
                this.schedule.runs = await runs.json();
                this.schedule.error = "";
                // Сбор, начатый расписанием, — следить за ним, как за начатым кнопкой
                data.items.forEach((it) => {
                    if (it.last_run) {
                        this.noteScanRun(it.last_run);
                    }
                });
            } catch (e) {
                this.schedule.error = "Не удалось загрузить расписание: " + (e.message || e);
            } finally {
                this.schedule.loading = false;
            }
        },

        // Пока вкладка открыта — перечитывать
        watchSchedule(on) {
            if (this.scheduleTimer) {
                clearInterval(this.scheduleTimer);
                this.scheduleTimer = null;
            }
            if (on) {
                this.scheduleTimer = setInterval(() => {
                    if (this.view === "scan" && this.scanTab === "schedule") {
                        this.loadSchedule(true);
                    } else {
                        this.watchSchedule(false);
                    }
                }, REFRESH_MS);
            }
        },

        scheduleModeValue(it) {
            return it.mode === "every" ? String(it.minutes) : it.mode;
        },

        setScheduleMode(it, value) {
            if (value === "off" || value === "daily") {
                this.saveSchedule(it, { mode: value });
            } else {
                this.saveSchedule(it, { mode: "every", minutes: Number(value) });
            }
        },

        // Время — «8:05» или «08:05» (сутки — 24 часа); не время — поле возвращается к прежнему
        setScheduleTime(it, field, input) {
            const found = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(input.value);
            if (!found || Number(found[1]) > 23 || Number(found[2]) > 59) {
                input.value = it[field];
                this.toastError("Время — в виде ЧЧ:ММ");
                return;
            }
            const value = found[1].padStart(2, "0") + ":" + found[2];
            input.value = value;
            if (value !== it[field]) {
                this.saveSchedule(it, { [field]: value });
            }
        },

        async saveSchedule(it, body) {
            try {
                const response = await apiFetch("/api/scan/schedule/" + it.kind, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const saved = await response.json();
                this.schedule.items = this.schedule.items.map(function (x) { return x.kind === saved.kind ? saved : x; });
            } catch (e) {
                this.toastError(e.message || e);
                this.loadSchedule(true);
            }
        },

        scheduleNextText(it) {
            if (it.mode === "off" || !it.available || !it.next_at) {
                return "";
            }
            if (this.scanCollecting(it.kind)) {
                return "идёт";
            }
            return new Date(it.next_at) <= new Date() ? "сейчас" : this.formatTime(it.next_at);
        },

        scheduleLastTitle(it) {
            const info = this.scanRunInfo(it.kind);
            if (!info) {
                return "Ещё не собирали";
            }
            return info.running ? info.text : info.time + "\n" + info.text + (info.note ? "\n" + info.note : "");
        },

        scheduleRunTitle(r) {
            const it = this.schedule.items.find(function (x) { return x.kind === r.source; });
            return it ? it.title : r.source;
        },

        scheduleRunTook(r) {
            return this.scanRunDuration(r);
        },

        scheduleRunText(r) {
            return this.scanRunText(r).text;
        },

        setScheduleHover(it, rowEl) {
            const wrap = rowEl.closest(".users-wrap");
            if (!wrap) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const r = rowEl.getBoundingClientRect();
            this.schedule.hover = { kind: it.kind, top: r.top - w.top, height: r.height };
        }
    }
};
