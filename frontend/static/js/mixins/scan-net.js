// Вкладка «Сеть» «Сканера» (этап 28б): что собрали DHCP (аренды и привязки из
// настроек) и проход подсетей — по строке на адрес: MAC, имя машины, что сказал
// каждый источник, открытые порты и какой ПК таблицы на этом адресе (по IP из
// таблицы или по MAC). Источники называют разный MAC или имя — значения строками,
// откуда каждое — в подсказке (28в). Данные — /api/scan/hosts; собирает сервер
// («Собрать» на «Проверке», расписание).

import { apiFetch, searchNorm, searchWords, matchesAllWords } from "../util.js";

export const NET_FILTERS = [
    { key: "all", label: "Все" },
    { key: "known", label: "В таблице", title: "На адресе — ПК таблицы" },
    { key: "unknown", label: "Нет в таблице" },
    { key: "differ", label: "Расхождения", title: "Источники называют разный MAC или имя", optional: true }
];

const PORT_NAMES = { 22: "SSH", 80: "HTTP", 135: "RPC", 139: "NetBIOS", 443: "HTTPS", 445: "SMB", 3389: "RDP", 5900: "VNC", 8080: "HTTP" };
const BY_TEXT = { ip: "по IP", mac: "по MAC", conf: "по MAC из привязки DHCP" };

function inNetFilter(h, filter) {
    if (filter === "known") {
        return h.computers.length > 0;
    }
    if (filter === "unknown") {
        return h.computers.length === 0;
    }
    if (filter === "differ") {
        return h.mac.length > 1 || h.name.length > 1;
    }
    return true;
}

export default {
    computed: {
        netFilters() {
            return NET_FILTERS;
        },

        // «Расхождения» — только когда они есть
        netFiltersShown() {
            return NET_FILTERS.filter((f) => !f.optional || this.netCounts[f.key] || this.net.filter === f.key);
        },

        netHosts() {
            const data = this.net.data;
            if (!data) {
                return [];
            }
            const values = function (list) { return list.map(function (v) { return v.value; }).join(" "); };
            return data.hosts.map(function (h) {
                return Object.assign({}, h, {
                    search: searchNorm([h.ip, values(h.mac), values(h.name), h.computers.map(function (c) { return (c.hostname || "") + " " + (c.place || ""); }).join(" ")].join(" "))
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

        // Столбец «DHCP»: аренда и (или) привязка из настроек
        netDhcpText(h) {
            return [h.dhcp, h.conf].filter(Boolean).map(function (s) { return s.text; }).join(", ");
        },

        netDhcpTitle(h) {
            const lease = h.dhcp ? this.netSeenTitle(h.dhcp) : null;
            // У привязки времени нет: это настройка, а не наблюдение
            const conf = h.conf ? ["Привязка", h.conf.mac ? "MAC: " + h.conf.mac : ""].concat(h.conf.details || []).filter(Boolean).join("\n") : null;
            return [lease, conf].filter(Boolean).join("\n\n") || null;
        },

        netPortsTitle(h) {
            if (!h.ports) {
                return null;
            }
            if (!h.ports.length) {
                return "Открытых нет";
            }
            return h.ports.map(function (port) {
                const name = PORT_NAMES[port] || "";
                return port + (name ? " — " + name : "") + (port === 5900 && h.rfb ? " (RFB " + h.rfb + ")" : "");
            }).join("\n");
        },

        netPcTitle(c) {
            const by = c.by.map(function (b) { return BY_TEXT[b] || b; }).join(", ");
            return [c.place || "", by].filter(Boolean).join(" · ");
        }
    }
};
