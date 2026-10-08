// Страница «Vacuum» (этап 26д; с 26ж – вкладка верхнего меню): пользователи Jabber
// (VACUUM) из веб-админки ejabberd – группы, когда подключались, с какого IP и
// какой ПК на этом IP (ПК таблицы; если в таблице такого нет – как его называет
// GLPI / GSIT). ПК ищется только по IP. Красным – пользователя уже нет, а в группе
// он остался; оранжевым – не входит ни в одну группу.
//
// Данные – /api/scan/jabber (собирает сервер: «Сканировать» над таблицей (admin),
// «Собрать» у Jabber на «Подключениях» или «Собрать» на «Проверке»). Пока идёт
// сбор – полоса «просмотрено из» над таблицей. Кнопка на панели – перечитать страницу.
// Этап 31: давно не подключавшиеся (stale) и давний последний IP (ip_stale) – серым.

import { apiFetch, searchNorm, searchWordsIn, matchesAllWords } from "../util.js";

export const VACUUM_FILTERS = [
    { key: "all", label: "Все" },
    { key: "online", label: "В сети" },
    { key: "offline", label: "Не в сети" },
    { key: "gone", label: "Убрать из групп", title: "Пользователя нет, а в группе остался", optional: true },
    { key: "nogroup", label: "Без группы", optional: true }
];

function inVacuumFilter(u, filter) {
    switch (filter) {
    case "online":
        return u.online;
    case "offline":
        return !u.online && !u.gone;
    case "gone":
        return u.gone;
    case "nogroup":
        return u.no_group;
    default:
        return true;
    }
}

export default {
    computed: {
        vacuumFilters() {
            return VACUUM_FILTERS;
        },

        vacuumUsers() {
            const data = this.vacuum.data;
            if (!data) {
                return [];
            }
            return data.users.map(function (u) {
                const hosts = [];
                u.addresses.forEach(function (a) {
                    a.hosts.forEach(function (h) { hosts.push(h.hostname || ""); });
                });
                return Object.assign({}, u, {
                    search: searchNorm([u.login, u.groups.join(" "), hosts.join(" "), u.addresses.map(function (a) { return a.ip || ""; }).join(" ")].join(" "))
                });
            }).sort(function (a, b) {
                return (b.online - a.online) || a.login.localeCompare(b.login, "ru", { numeric: true });
            });
        },

        vacuumCounts() {
            const counts = {};
            VACUUM_FILTERS.forEach((f) => {
                counts[f.key] = this.vacuumUsers.filter(function (u) { return inVacuumFilter(u, f.key); }).length;
            });
            return counts;
        },

        vacuumShown() {
            const words = searchWordsIn(this.vacuumQuery, this.vacuumUsers.map(function (u) { return u.search; }));
            return this.vacuumUsers.filter((u) => {
                return inVacuumFilter(u, this.vacuum.filter) && (!words.length || matchesAllWords(u.search, words));
            });
        },

        vacuumCountText() {
            const all = this.vacuumUsers.length;
            const shown = this.vacuumShown.length;
            if (shown !== all) {
                return "Показано: " + shown + " из " + all;
            }
            return "Пользователей: " + all + ", в сети: " + this.vacuumCounts.online;
        },

        // Идёт сбор из Jabber: { percent, text } – полоса над таблицей
        vacuumProgress() {
            const run = this.scanRuns.jabber || (this.vacuum.data && this.vacuum.data.last_run);
            if (!run || run.status !== "running") {
                return null;
            }
            const p = (run.stats && run.stats.progress) || {};
            if (!p.total) {
                return { percent: 0, text: "Собираю…" };
            }
            return { percent: Math.round(p.done / p.total * 100), text: p.done + " из " + p.total };
        },

        vacuumRefreshTitle() {
            if (this.vacuumProgress) {
                return "Сканирую…";
            }
            const block = this.scanCollectBlock("jabber");
            const info = this.scanRunInfo("jabber");
            return (block || "Собрать из Jabber") + (info ? "\nПоследний сбор: " + info.time : "");
        },

        // Логины VACUUM из таблицы, которых нет в Jabber (строчными) – в ячейках красным
        vacuumMissingSet() {
            return new Set(this.diffs.vacuumMissing || []);
        },

        // Логины VACUUM из таблицы, давно не подключавшиеся: логин → дней (null – никогда)
        vacuumStale() {
            return this.diffs.vacuumStale || {};
        }
    },

    methods: {
        async loadVacuum() {
            this.vacuum.loading = true;
            this.vacuum.error = "";
            try {
                const response = await apiFetch("/api/scan/jabber");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.vacuum.data = await response.json();
                // Сбор уже идёт – следить (номер запуска редактору не отдаётся – просто перечитаем позже)
                const run = this.vacuum.data.last_run;
                if (run && run.status === "running") {
                    if (this.isAdmin) {
                        this.trackScanRun(run);
                    } else {
                        setTimeout(() => this.view === "vacuum" && this.loadVacuum(), 3000);
                    }
                }
            } catch (e) {
                this.vacuum.error = "Не удалось загрузить: " + (e.message || e);
            } finally {
                this.vacuum.loading = false;
            }
        },

        // «Сканировать»: собрать из Jabber заново (admin)
        refreshVacuum() {
            if (this.isAdmin && !this.scanCollectBlock("jabber")) {
                this.collectScan("jabber");
            }
        },

        setVacuumFilter(key) {
            this.vacuum.filter = key;
        },

        vacuumEmptyText() {
            const data = this.vacuum.data;
            if (this.vacuum.loading && !data) {
                return "Загрузка…";
            }
            if (data && data.users.length) {
                return "Ничего не найдено.";
            }
            if (data && !data.configured) {
                return "Jabber не настроен.";
            }
            return "Пользователей пока нет.";
        },

        // «в сети» / когда подключался / «никогда»; удалённый – «удалён»
        vacuumStatusText(u) {
            if (u.online) {
                return "в сети";
            }
            if (u.gone) {
                return "удалён";
            }
            const last = u.last_login_at || u.last_seen_at;
            // «никогда» – только если список пользователей получен (иначе просто не знаем)
            return last ? this.formatTime(last) : (this.vacuum.data.listed ? "никогда" : "–");
        },

        vacuumIpTitle(u, a) {
            const parts = [a.client || "", !u.online && u.last_seen_at ? this.formatTime(u.last_seen_at) : "", u.ip_stale ? "давно" : ""].filter(Boolean);
            return parts.join(" · ") || null;
        }
    }
};
