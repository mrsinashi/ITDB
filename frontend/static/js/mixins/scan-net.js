// Вкладка «Сеть» «Сканера» (этап 28б): что собрали DHCP (аренды и резервы) и
// проход подсетей — по строке на адрес: MAC, имя машины, что сказал каждый
// источник и какой ПК таблицы на этом адресе (по IP из таблицы или по MAC).
// Данные — /api/scan/hosts; собирает сервер («Собрать» на «Проверке», расписание).

import { apiFetch, searchNorm, searchWords, matchesAllWords } from "../util.js";

export const NET_FILTERS = [
    { key: "all", label: "Все" },
    { key: "known", label: "В таблице", title: "На адресе — ПК таблицы" },
    { key: "unknown", label: "Нет в таблице" }
];

function inNetFilter(h, filter) {
    if (filter === "known") {
        return h.computers.length > 0;
    }
    if (filter === "unknown") {
        return h.computers.length === 0;
    }
    return true;
}

export default {
    computed: {
        netFilters() {
            return NET_FILTERS;
        },

        netHosts() {
            const data = this.net.data;
            if (!data) {
                return [];
            }
            return data.hosts.map(function (h) {
                const seen = [h.dhcp, h.net].filter(Boolean).map(function (s) { return s.seen_at; }).sort();
                return Object.assign({}, h, {
                    seen_at: seen[seen.length - 1] || null,
                    search: searchNorm([h.ip, h.mac.join(" "), h.name.join(" "), h.computers.map(function (c) { return (c.hostname || "") + " " + (c.place || ""); }).join(" ")].join(" "))
                });
            });
        },

        netCounts() {
            const counts = {};
            NET_FILTERS.forEach((f) => {
                counts[f.key] = this.netHosts.filter(function (h) { return inNetFilter(h, f.key); }).length;
            });
            return counts;
        },

        netShown() {
            const words = searchWords(this.scanMatchQuery);
            return this.netHosts.filter((h) => {
                return inNetFilter(h, this.net.filter) && (!words.length || matchesAllWords(h.search, words));
            });
        },

        netCountText() {
            const all = this.netHosts.length;
            const shown = this.netShown.length;
            return shown === all ? "Адресов: " + all : "Показано: " + shown + " из " + all;
        }
    },

    methods: {
        async loadNet() {
            this.net.loading = true;
            this.net.error = "";
            try {
                const response = await apiFetch("/api/scan/hosts");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.net.data = await response.json();
            } catch (e) {
                this.net.error = "Не удалось загрузить: " + (e.message || e);
            } finally {
                this.net.loading = false;
            }
        },

        netEmptyText() {
            if (this.net.loading && !this.net.data) {
                return "Загрузка…";
            }
            return this.netHosts.length ? "Ничего не найдено." : "Пока пусто — собери DHCP или Сеть.";
        },

        // Подсказка у ячейки источника: когда, MAC и имя по этому источнику, подробности
        netSeenTitle(s) {
            if (!s) {
                return null;
            }
            return [this.formatTime(s.seen_at), s.mac ? "MAC: " + s.mac : "", s.name ? "Имя: " + s.name : ""].concat(s.details || []).filter(Boolean).join("\n");
        },

        netPcTitle(c) {
            const by = c.by.map(function (b) { return b === "mac" ? "по MAC" : "по IP"; }).join(", ");
            return [c.place || "", by].filter(Boolean).join(" · ");
        }
    }
};
