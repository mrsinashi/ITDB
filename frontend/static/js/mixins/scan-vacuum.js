// «Сканирование» → вкладка «Vacuum» (значок лампочки, этап 26д): пользователи
// Jabber (VACUUM) из веб-админки ejabberd — группы, кто в сети, с какого IP и за
// каким ПК он сейчас (ПК таблицы с этим IP; если в таблице такого нет — как его
// называет GLPI / GSIT). У тех, кто не в сети, — последний известный IP.
//
// Данные — /api/scan/jabber (собирает сервер: «Собрать» у Jabber на «Подключениях»,
// «Собрать» на «Проверке» или кнопка обновления на панели этой вкладки).

import { apiFetch, searchNorm, searchWords, matchesAllWords } from "../util.js";

export const VACUUM_FILTERS = [
    { key: "all", label: "Все", title: "Все пользователи из групп Jabber и те, кого ITDB видел в сети" },
    { key: "online", label: "В сети", title: "Подключены к Jabber сейчас (на момент последнего сбора)" },
    { key: "offline", label: "Не в сети", title: "Не подключены: показан последний IP, с которого ITDB их видел" }
];

function inVacuumFilter(u, filter) {
    if (filter === "online") {
        return u.online;
    }
    if (filter === "offline") {
        return !u.online;
    }
    return true;
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
                    search: searchNorm([u.login, u.groups.join(" "), hosts.join(" "), u.addresses.map(function (a) { return a.ip || ""; }).join(" "), u.vacuum_pcs.join(" ")].join(" "))
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
            const words = searchWords(this.scanMatchQuery);
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

        // Кнопка на панели: администратор — собрать заново из Jabber, редактор — обновить список
        vacuumRefreshTitle() {
            if (!this.isAdmin) {
                return "Обновить список";
            }
            const block = this.scanCollectBlock("jabber");
            const info = this.scanRunInfo("jabber");
            const last = info ? "\nПоследний сбор: " + info.time + "\n" + info.text : "";
            return (block || "Обновить данные Vacuum: собрать из Jabber, кто в сети, с какого IP и в каких группах") + last;
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
                // Запуск сбора, который идёт, — следить (редактору сервер его тоже отдаёт)
                const run = this.vacuum.data.last_run;
                if (run && run.status === "running" && this.isAdmin) {
                    this.trackScanRun(run);
                }
            } catch (e) {
                this.vacuum.error = "Не удалось загрузить пользователей Jabber: " + (e.message || e);
            } finally {
                this.vacuum.loading = false;
            }
        },

        refreshVacuum() {
            if (this.isAdmin) {
                if (!this.scanCollectBlock("jabber")) {
                    this.collectScan("jabber");
                }
            } else {
                this.loadVacuum();
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
                return "Jabber не настроен: укажи веб-админку на вкладке «Подключения».";
            }
            return "Пользователей пока нет: собери данные кнопкой обновления на панели.";
        },

        // ПК на адресе: из таблицы — ссылкой на карточку, из GLPI / GSIT — курсивом
        vacuumHostTitle(u, h) {
            if (h.computer_id) {
                return (h.place || "") + "\n" + (h.vacuum ? "Логин записан в VACUUM этого ПК" : "В VACUUM этого ПК логина нет") +
                    "\nНажми — карточка ПК";
            }
            return "В таблице ПК с таким IP нет; так его называет " + h.source;
        },

        vacuumNoHostTitle(u) {
            if (!u.addresses.length) {
                return u.vacuum_pcs.length ? "ITDB ещё не видел этого пользователя в сети, IP не известен.\nПо таблице: логин записан в VACUUM этого ПК" : "IP не известен, и в VACUUM таблицы этого логина нет";
            }
            return "Ни в таблице, ни в GLPI / GSIT ПК с таким IP нет";
        },

        vacuumStatusTitle(u) {
            if (u.online) {
                return "В сети: " + u.addresses.map(function (a) { return (a.client || "клиент") + " — " + (a.ip || "IP не известен"); }).join("; ");
            }
            return u.last_seen_at ? "Последний раз ITDB видел в сети: " + this.formatTime(u.last_seen_at) : "ITDB ещё не видел этого пользователя в сети";
        },

        vacuumIpTitle(u, a) {
            const client = a.client ? "Клиент: " + a.client : "";
            return u.online ? client : ("Последний IP" + (u.last_seen_at ? " (" + this.formatTime(u.last_seen_at) + ")" : "") + (client ? "\n" + client : ""));
        }
    }
};
