// Вкладка «Сеть» «Сканера» (этап 28б): что собрали DHCP (аренды и привязки из
// настроек) и проход подсетей – по строке на адрес: MAC, имя машины, что сказал
// каждый источник, открытые порты и какой ПК таблицы на этом адресе (по IP из
// таблицы или по MAC). Источники называют разный MAC или имя – значения строками,
// откуда каждое – в подсказке (28в). Этап 31: фильтры по источникам (Сканер – проход
// подсетей, Leases – аренды DHCP, DHCP Config – привязки), у каждого значения в
// подсказке – «Источник: …»; то, что видели давно (старше срока «Актуальны»), не
// удаляется, а показывается серым. Данные – /api/scan/hosts; собирает сервер
// («Сканировать» над фильтрами, «Собрать» на «GLPI / GSIT», расписание). Этап 43: фильтр
// по давности – «Актуальные» / «Неактуальные» (серые строки). Этап 47: фильтры по столбцам
// (воронка и правый клик по шапке – то же меню, что в Таблице, col-filters.js; у IP –
// подсети) и сортировка кликом по шапке; Shift+Enter – адрес строки в браузере.

import { apiFetch, searchNorm, searchWordsIn, matchesAllWords } from "../util.js";
import { activeFilters } from "./col-filters.js";

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

function ipNumber(ip) {
    const parts = String(ip || "").split(".");
    return parts.length === 4 && parts.every(function (p) { return /^\d+$/.test(p); })
        ? parts.reduce(function (n, p) { return n * 256 + Number(p); }, 0) : null;
}

const textOf = function (list) { return list.map(function (v) { return v.value; }); };

// Столбцы таблицы «Сети» (этап 47): lines – значения ячейки для фильтра (строками;
// у IP фильтр – по подсетям /24), sort – ключ сортировки (null – пусто, внизу)
function netColumns(vm) {
    return [
        { field: "ip", headerName: "IP", values: "subnet", lines: (h) => [h.ip], sort: (h) => ipNumber(h.ip) },
        { field: "mac", headerName: "MAC", lines: (h) => textOf(h.mac), sort: (h) => textOf(h.mac)[0] || null },
        { field: "name", headerName: "Имя", lines: (h) => textOf(h.name), sort: (h) => textOf(h.name)[0] || null },
        { field: "dhcp", headerName: "DHCP", lines: (h) => [h.dhcp, h.conf].filter(Boolean).map((s) => s.text), sort: (h) => vm.netDhcpText(h) || null },
        { field: "net", headerName: "Сеть", lines: (h) => (h.net ? [h.net.text] : []), sort: (h) => (h.net ? h.net.text : null) },
        {
            field: "ports", headerName: "Порты",
            lines: (h) => (h.ports ? (h.ports.length ? h.ports.map(String) : ["–"]) : []),
            sort: (h) => (h.ports && h.ports.length ? h.ports[0] : null)
        },
        // Когда: фильтр – по дням, сортировка – по времени
        { field: "when", headerName: "Когда", date: true, lines: (h) => (h.seen_at ? [vm.formatDate(h.seen_at)] : []), sort: (h) => h.seen_at || null },
        {
            field: "pc", headerName: "ПК в таблице", fullName: "ПК в таблице",
            lines: (h) => h.computers.map((c) => c.hostname || "без имени"),
            sort: (h) => (h.computers.length ? h.computers[0].hostname || "" : null)
        }
    ];
}

function compareKeys(a, b) {
    if (typeof a === "number" && typeof b === "number") {
        return a - b;
    }
    return String(a).localeCompare(String(b), "ru", { numeric: true, sensitivity: "base" });
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

        // Числа на кнопках: у каждой группы – с учётом того, что выбрано в остальных (и фильтров
        // по столбцам)
        netCounts() {
            const counts = {};
            const source = this.net.source;
            const filter = this.net.filter;
            const age = this.net.age;
            const hosts = this.applyColFilters(this.netHosts, null, "net");
            NET_FILTERS.forEach((f) => {
                counts[f.key] = hosts.filter(function (h) { return inNetFilter(h, f.key) && (!source || h[source]) && inNetAge(h, age); }).length;
            });
            NET_SOURCES.forEach((s) => {
                counts[s.key] = hosts.filter(function (h) { return inNetFilter(h, filter) && h[s.key] && inNetAge(h, age); }).length;
            });
            NET_AGES.forEach((a) => {
                counts[a.key] = hosts.filter(function (h) { return inNetFilter(h, filter) && (!source || h[source]) && inNetAge(h, a.key); }).length;
            });
            return counts;
        },

        // Столбцы таблицы (этап 47) – для фильтров и сортировки
        netColumns() {
            return netColumns(this);
        },

        // Активные фильтры по столбцам – плашками на панели, как в Таблице
        netActiveColFilters() {
            return activeFilters(this.netColumns, this.net.colFilters);
        },

        // Строки: кнопки-фильтры, поиск, фильтры по столбцам; сортировка – по шапке
        netShown() {
            const rows = this.netFilterRows(null);
            const col = this.net.sortField && this.netColumns.find((c) => c.field === this.net.sortField);
            if (!col) {
                return rows;
            }
            const dir = this.net.sortDir === "desc" ? -1 : 1;
            return rows.map(function (h) { return { h: h, key: col.sort(h) }; }).sort(function (a, b) {
                const ea = a.key === null || a.key === "";
                const eb = b.key === null || b.key === "";
                if (ea !== eb) {
                    return ea ? 1 : -1;   // пустые – внизу при любом порядке
                }
                return ea ? 0 : compareKeys(a.key, b.key) * dir;
            }).map(function (x) { return x.h; });
        },

        netCountText() {
            const all = this.netHosts.length;
            const shown = this.netShown.length;
            return shown === all ? "Адресов: " + all : "Показано: " + shown + " из " + all;
        }
    },

    methods: {
        // Строки для таблицы и для списка фильтра столбца except (как в Excel: по остальным
        // фильтрам и поиску)
        netFilterRows(except) {
            const words = searchWordsIn(this.scanMatchQuery, this.netHosts.map(function (h) { return h.search; }));
            const source = this.net.source;
            const age = this.net.age;
            const hosts = this.netHosts.filter((h) => {
                return inNetFilter(h, this.net.filter) && (!source || h[source]) && inNetAge(h, age) && (!words.length || matchesAllWords(h.search, words));
            });
            return this.applyColFilters(hosts, except, "net");
        },

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
            if (this.netHosts.length) {
                return "Ничего не найдено.";
            }
            // «Сканировать» – с «запуском» (этап 70)
            return this.canRun ? "Пока пусто – нажми «Сканировать»." : "Пока пусто.";
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
