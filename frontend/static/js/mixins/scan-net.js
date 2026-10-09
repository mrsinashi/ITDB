// Вкладка «Сеть» «Сканера» (этап 28б): что собрали DHCP (аренды и привязки из
// настроек) и проход подсетей – по строке на адрес: MAC, имя машины, что сказал
// каждый источник, открытые порты и какой ПК таблицы на этом адресе (по IP из
// таблицы или по MAC). Источники называют разный MAC или имя – значения строками,
// откуда каждое – в подсказке (28в). Этап 31: фильтры по источникам (Сканер – проход
// подсетей, Leases – аренды DHCP, DHCP Config – привязки), у каждого значения в
// подсказке – «Источник: …»; то, что видели давно (старше срока «Актуальны»), не
// удаляется, а показывается серым. Данные – /api/scan/hosts; собирает сервер
// («Сканировать» над фильтрами, «Собрать» на «GLPI / GSIT», расписание). Этап 43: фильтр
// по давности – «Актуальные» / «Неактуальные» (серые строки).

import { apiFetch, searchNorm, searchWordsIn, matchesAllWords } from "../util.js";

export const NET_FILTERS = [
    { key: "all", label: "Все" },
    { key: "known", label: "В таблице", title: "На адресе – ПК таблицы" },
    { key: "unknown", label: "Нет в таблице" },
    { key: "differ", label: "Расхождения", title: "Источники называют разный MAC или имя", optional: true }
];

// Фильтры по источникам: адреса, о которых источник что-то знает. Нажатие на
// включённый – снять
export const NET_SOURCES = [
    { key: "net", label: "Сканер", title: "Ответили при проходе подсетей" },
    { key: "dhcp", label: "Leases", title: "Есть аренда DHCP" },
    { key: "conf", label: "DHCP Config", title: "Есть привязка в настройках DHCP" }
];

// По давности (этап 43): адрес видели в сроке «Актуальны» или давно (строка серым).
// Нажатие на включённый – снять
export const NET_AGES = [
    { key: "fresh", label: "Актуальные", title: "Видели в сроке «Актуальны»" },
    { key: "stale", label: "Неактуальные", title: "Давно не видели" }
];

const PORT_NAMES = { 22: "SSH", 80: "HTTP", 135: "RPC", 139: "NetBIOS", 443: "HTTPS", 445: "SMB", 3389: "RDP", 5900: "VNC", 8080: "HTTP" };
const BY_TEXT = { ip: "по IP из таблицы", mac: "по MAC", conf: "по MAC из DHCP Config" };

function inNetFilter(h, filter) {
    if (filter === "known") {
        return h.computers.length > 0;
    }
    if (filter === "unknown") {
        return h.computers.length === 0;
    }
    if (filter === "differ") {
        return h.differ;
    }
    return true;
}

function inNetAge(h, age) {
    return !age || (age === "stale" ? !!h.stale : !h.stale);
}

function fromText(sources) {
    return "Источник: " + sources.join(", ");
}

export default {
    computed: {
        netFilters() {
            return NET_FILTERS;
        },

        // «Расхождения» – только когда они есть
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

        netSources() {
            return NET_SOURCES;
        },

        netAges() {
            return NET_AGES;
        },

        // Числа на кнопках: у каждой группы – с учётом того, что выбрано в остальных
        netCounts() {
            const counts = {};
            const source = this.net.source;
            const filter = this.net.filter;
            const age = this.net.age;
            NET_FILTERS.forEach((f) => {
                counts[f.key] = this.netHosts.filter(function (h) { return inNetFilter(h, f.key) && (!source || h[source]) && inNetAge(h, age); }).length;
            });
            NET_SOURCES.forEach((s) => {
                counts[s.key] = this.netHosts.filter(function (h) { return inNetFilter(h, filter) && h[s.key] && inNetAge(h, age); }).length;
            });
            NET_AGES.forEach((a) => {
                counts[a.key] = this.netHosts.filter(function (h) { return inNetFilter(h, filter) && (!source || h[source]) && inNetAge(h, a.key); }).length;
            });
            return counts;
        },

        netShown() {
            const words = searchWordsIn(this.scanMatchQuery, this.netHosts.map(function (h) { return h.search; }));
            const source = this.net.source;
            const age = this.net.age;
            return this.netHosts.filter((h) => {
                return inNetFilter(h, this.net.filter) && (!source || h[source]) && inNetAge(h, age) && (!words.length || matchesAllWords(h.search, words));
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
            return this.netHosts.length ? "Ничего не найдено." : "Пока пусто – собери DHCP или Сеть.";
        },

        setNetSource(key) {
            this.net.source = this.net.source === key ? null : key;
        },

        setNetAge(key) {
            this.net.age = this.net.age === key ? null : key;
        },

        // Подсказка у значения MAC / имени: откуда оно
        netValueTitle(v) {
            return fromText(v.sources) + (v.stale ? "\nДавно" : "");
        },

        // Подсказка у IP: кто знает этот адрес
        netIpTitle(h) {
            const who = NET_SOURCES.filter(function (s) { return h[s.key]; }).map(function (s) { return s.label; });
            return fromText(who);
        },

        // Подсказка у «Когда»: кто видел последним и когда видел каждый
        netWhenTitle(h) {
            if (!h.seen_at) {
                return null;
            }
            const lines = [fromText([h.seen_by])];
            if (h.net && h.dhcp) {
                lines.push("Сканер: " + this.formatTime(h.net.seen_at), "Leases: " + this.formatTime(h.dhcp.seen_at));
            }
            if (h.stale) {
                lines.push("Давно");
            }
            return lines.join("\n");
        },

        // Подсказка у ячейки источника: кто, когда, MAC и имя по этому источнику, подробности
        netSeenTitle(s, who) {
            if (!s) {
                return null;
            }
            return [who ? fromText([who]) : "", this.formatTime(s.seen_at) + (s.stale ? " – давно" : ""), s.mac ? "MAC: " + s.mac : "", s.name ? "Имя: " + s.name : ""].concat(s.details || []).filter(Boolean).join("\n");
        },

        // Столбец «DHCP»: аренда и (или) привязка из настроек
        netDhcpText(h) {
            return [h.dhcp, h.conf].filter(Boolean).map(function (s) { return s.text; }).join(", ");
        },

        netDhcpTitle(h) {
            const lease = h.dhcp ? this.netSeenTitle(h.dhcp, "Leases") : null;
            // У привязки времени нет: это настройка, а не наблюдение
            const conf = h.conf ? [fromText(["DHCP Config"]), h.conf.mac ? "MAC: " + h.conf.mac : ""].concat(h.conf.details || []).filter(Boolean).join("\n") : null;
            return [lease, conf].filter(Boolean).join("\n\n") || null;
        },

        netPortsTitle(h) {
            if (!h.ports) {
                return null;
            }
            if (!h.ports.length) {
                return fromText(["Сканер"]) + "\nОткрытых нет";
            }
            return [fromText(["Сканер"])].concat(h.ports.map(function (port) {
                const name = PORT_NAMES[port] || "";
                return port + (name ? " – " + name : "") + (port === 5900 && h.rfb ? " (RFB " + h.rfb + ")" : "");
            })).join("\n");
        },

        netPcTitle(c) {
            const by = c.by.map(function (b) { return BY_TEXT[b] || b; }).join(", ");
            return [c.place || "", by].filter(Boolean).join(" · ");
        }
    }
};
