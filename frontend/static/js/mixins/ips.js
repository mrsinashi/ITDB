// Журналы (этап 71): вкладка «IP» – занятые и свободные адреса. Таблица – та же, что у Компьютеров,
// Принтеров и «Движения» (tableKind = "ips", mixins/printers.js), строки – /api/ips (признак _ip, ключ
// вспышки – «i» + id; id строки – адрес числом, у записи из архива – минус номер записи).
//
// Строка – адрес (ответ пользователя: «один IP и все источники в строку»): источники короткими
// названиями через запятую (полное, дата – в подсказке), тип и имя – значения источников строками
// (откуда – в подсказке), имя ПК, принтера, записи «Движения» – ссылкой на карточку, при наведении –
// «Показать в таблице». «Актуальность» – дата, когда значение последний раз проверяли или меняли.
// Правка в ячейке: описание – у всех строк; тип, IP, имя, «Добавил» – у записей журнала (источник
// «IP»), остальное – в своей таблице (просьба пользователя).
// «Свободные» – меню подсетей из «Подключений» (по умолчанию ни одной): отмечены – в таблице
// свободные адреса этих подсетей; заполненный свободный адрес становится записью, но из списка не
// пропадает, пока «Свободные» не выключили. «Добавить» – пустая строка сверху: источник «IP»,
// «Актуальность» и «Добавил» уже стоят; запись появляется, когда вписан адрес. «Сканировать» –
// меню источников, которые приносят адреса (галочки – при каждом заходе на вкладку снова все).

import { apiFetch } from "../util.js";
import { keepSameRows } from "../columns.js";
import { pageLink } from "../route.js";
import { cellOverhead, ensureWidthProbe, measureTextWidth } from "../widths.js";

// Источники строки: ключ → коротко (в ячейке) и полностью (в подсказке) – как SOURCES в api_ips.py
const SOURCES = {
    pc: ["Компьютеры", "Таблица – Компьютеры"],
    printer: ["Принтеры", "Таблица – Принтеры"],
    move: ["Движение", "Журнал – Движение"],
    own: ["IP", "Журнал – IP"],
    net: ["Сканер", "Сканер – проход подсетей"],
    dhcp: ["DHCP Leases", "Сканер – DHCP Leases"],
    conf: ["DHCP Config", "Сканер – DHCP Config"],
    rec: ["GSIT / GLPI", "Сканер – GSIT / GLPI"],
    jabber: ["Vacuum", "Vacuum"]
};
// Своя запись журнала – источник «IP»
const OWN = "own";
// Чья страница запускает сбор источника (как COLLECT_PAGES в api_scan_records.py); ещё можно с
// «Расписания» и «Подключений»
const COLLECT_PAGES = { net: "scan/net", dhcp: "scan/net", glpi: "scan/check", gsit: "scan/check", jabber: "vacuum" };
// Подсеть больше – свободные адреса не перебираются (строк было бы слишком много)
const FREE_MAX = 4096;
// id строки «Добавить»: не адрес (числа ≥ 0) и не запись из архива (целые < 0); не 0 – правка
// ячейки проверяется как «есть ли editingRowId»
const DRAFT_ID = -0.5;
// Ссылка имени: карточка ПК, принтера или окно записи «Движения»
const OBJ_TABLE_TITLES = { pc: "Показать в Компьютерах", printer: "Показать в Принтерах", move: "Показать в Движении" };
const OBJ_TITLES = { pc: "Карточка ПК", printer: "Карточка принтера", move: "Запись журнала" };
// Промежуток между источниками в ячейке (.ip-src, --ip-src-gap)
const SRC_GAP = 4;
// Поле записи журнала → что в ячейке у своей записи (правка)
const OWN_ITEMS = { ip_type: "types", ip_name: "names", ip_added: "added" };

export function ipNumber(ip) {
    const parts = String(ip || "").split(".");
    if (parts.length !== 4 || !parts.every(function (p) { return /^\d{1,3}$/.test(p) && Number(p) < 256; })) {
        return null;
    }
    return parts.reduce(function (n, p) { return n * 256 + Number(p); }, 0);
}

function ipText(n) {
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

// Адреса подсети «10.0.5.0/24» без адреса сети и широковещательного (у /31 и /32 – все); больше
// FREE_MAX – пусто
function subnetHosts(cidr) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr || "").trim());
    const base = m ? ipNumber(m[1]) : null;
    const bits = m ? Number(m[2]) : NaN;
    if (base === null || !(bits >= 0 && bits <= 32)) {
        return [];
    }
    const size = Math.pow(2, 32 - bits);
    if (size > FREE_MAX) {
        return [];
    }
    const start = base - (base % size);
    const list = [];
    const edge = size > 2 ? 1 : 0;
    for (let n = start + edge; n < start + size - edge; n++) {
        list.push(ipText(n));
    }
    return list;
}

function freeRow(ip) {
    return {
        id: ipNumber(ip), _ip: true, _free: true, archived: false, ip_addr: ip,
        ip_sources: null, sources: [], ip_type: null, types: [], ip_name: null, names: [],
        ip_note: null, checked_at: null, ip_checked: null, ip_added: null, added: [], entry: null
    };
}

function ownItems(value) {
    return value ? [{ value: value, from: [OWN] }] : [];
}

function sourceLabel(key) {
    return (SOURCES[key] || [key])[0];
}

export default {
    data() {
        return {
            // Строки с сервера: рабочие адреса (по порядку адресов) и записи из архива
            ipRows: [],
            ipLoaded: false,
            ipError: "",
            // Описание столбцов журнала – с сервера (GET /api/columns)
            ipColumns: [],
            ipHistoryLabels: {},
            // Подсети из «Подключений»: [{ cidr, scan, note, size }]
            ipSubnets: [],
            // «Свободные»: отмеченные подсети; пусто – занятые адреса
            ipFree: [],
            // Заполненные в «Свободных» – остаются в списке, пока «Свободные» не выключили (ip → true)
            ipFreeKeep: {},
            // «Добавить»: строка сверху, пока в ней нет адреса; добавленные – сверху до перечитывания
            ipDraft: null,
            ipTop: [],
            // Меню «Сканировать»: снятые части и подсети (при каждом заходе на вкладку – снова все)
            ipScanOff: [],
            ipScanSubnetsOff: []
        };
    },

    computed: {
        ipByAddr() {
            const map = new Map();
            this.ipRows.forEach(function (row) {
                if (!row.archived) {
                    map.set(row.ip_addr, row);
                }
            });
            return map;
        },

        // Подсети для «Свободных»: большие – серым (перебирать нечего)
        ipFreeOptions() {
            return this.ipSubnets.map((sn) => ({
                cidr: sn.cidr,
                checked: this.ipFree.indexOf(sn.cidr) !== -1,
                big: sn.size > FREE_MAX,
                title: sn.size > FREE_MAX ? "Подсеть больше " + FREE_MAX + " адресов" : [sn.note, "адресов: " + sn.size].filter(Boolean).join(" · ")
            }));
        },

        // Строки «Свободных»: свободные адреса отмеченных подсетей и заполненные за это время.
        // Строка свободного адреса – одна и та же, пока он свободен (не перерисовывается)
        ipFreeRows() {
            if (!this.ipFree.length) {
                return null;
            }
            const cache = this._ipFreeCache || (this._ipFreeCache = new Map());
            const seen = new Set();
            const rows = [];
            this.ipSubnets.forEach((sn) => {
                if (this.ipFree.indexOf(sn.cidr) === -1) {
                    return;
                }
                subnetHosts(sn.cidr).forEach((ip) => {
                    if (seen.has(ip)) {
                        return;
                    }
                    seen.add(ip);
                    // Адрес без источников, но с описанием, – свободный (со своим описанием)
                    const busy = this.ipByAddr.get(ip);
                    if (busy) {
                        if (!busy.sources.length || this.ipFreeKeep[ip]) {
                            rows.push(busy);
                        }
                        return;
                    }
                    let row = cache.get(ip);
                    if (!row) {
                        row = freeRow(ip);
                        cache.set(ip, row);
                    }
                    rows.push(row);
                });
            });
            return rows.sort(function (a, b) { return a.id - b.id; });
        },

        // Свободных адресов в «Свободных» (заполненные за это время – уже не свободные)
        ipFreeCount() {
            return (this.ipFreeRows || []).filter(function (row) { return !row.sources.length; }).length;
        },

        // Строки таблицы: рабочие адреса или свободные, записи из архива; строка «Добавить» – первой
        ipTableRows() {
            const free = this.ipFreeRows;
            const base = free ? free.concat(this.ipRows.filter(function (row) { return row.archived; })) : this.ipRows;
            return this.ipDraft ? [this.ipDraft].concat(base) : base;
        },

        // «Сканировать» – у кого есть запуск хоть одного источника (права – как в Сканере)
        ipCanScan() {
            return Object.keys(COLLECT_PAGES).some((kind) => this.ipCanCollect(kind));
        },

        // Меню «Сканировать»: всё, что приносит адреса; нельзя – серым, причина в подсказке
        ipScanOptions() {
            const list = [];
            const add = (key, label, kind, extraBlock) => {
                const s = this.scanSource(kind);
                if (!s) {
                    return;
                }
                const running = this.scanCollecting(kind);
                const block = (this.ipCanCollect(kind) ? "" : "Нет прав на сбор") || this.scanCollectBlock(kind) || extraBlock || "";
                list.push({
                    key: key, label: label, kind: kind, block: block, running: running,
                    checked: !block && this.ipScanOff.indexOf(key) === -1,
                    title: block && !running ? block : this.scanCollectTitle(kind)
                });
            };
            const dhcp = this.scanSource("dhcp");
            add("net", "Сканер", "net");
            add("leases", "DHCP Leases", "dhcp");
            add("configs", "DHCP Config", "dhcp", dhcp && !(dhcp.configs || []).length ? "Файлы настроек не указаны" : "");
            add("glpi", "GLPI", "glpi");
            add("gsit", "GSIT", "gsit");
            add("jabber", "Vacuum", "jabber");
            return list;
        },

        ipScanOn() {
            const on = {};
            this.ipScanOptions.forEach(function (o) { on[o.key] = o.checked; });
            return on;
        },

        // Подсети со «Сканировать: да» – для сканера
        ipScanSubnets() {
            return this.ipSubnets.filter(function (sn) { return sn.scan; }).map((sn) => ({
                cidr: sn.cidr,
                checked: this.ipScanSubnetsOff.indexOf(sn.cidr) === -1,
                title: [sn.note, "адресов: " + sn.size].filter(Boolean).join(" · ")
            }));
        },

        ipScanReady() {
            const on = this.ipScanOn;
            return Object.keys(on).some((key) => on[key] && (key !== "net" || this.ipScanSubnets.some(function (sn) { return sn.checked; })));
        },

        ipCollecting() {
            return this.ipScanOptions.some(function (o) { return o.running; });
        }
    },

    watch: {
        // Поиск или фильтры сменили – только что добавленные больше не держатся сверху и на виду
        quickFilter() {
            if (this.tableKind === "ips" && this.ipTop.length) {
                this.ipTop = [];
            }
        },

        colFilters: {
            handler() {
                if (this.tableKind === "ips" && this.ipTop.length) {
                    this.ipTop = [];
                }
            },
            deep: true
        }
    },

    methods: {
        // ---------- Вкладки «Журналов» ----------

        // Вкладка «Журналов»: Движение или IP (своя таблица, tableKind)
        setJournalTab(tab) {
            const next = tab === "ips" && this.canPage("journals/ips") ? "ips" : "moves";
            if (this.view !== "journals") {
                this.journalTab = next;
                this.setView("journals");
                return;
            }
            if (this.journalTab !== next) {
                this.closeMenus();
                this.switchTableKind(next);
                this.journalTab = next;
            }
            if (next === "ips") {
                this.openIps();
            } else {
                this.openJournals();
            }
            this.syncHash();
        },

        // Запуск сбора источника – с его страницы, «Расписания» или «Подключений» (как на сервере)
        ipCanCollect(kind) {
            return this.canPage(COLLECT_PAGES[kind], "run") || this.canPage("scan/schedule", "run") || this.canPage("scan/settings", "run");
        },

        // Зашли на вкладку «IP»: занятые адреса, все галочки «Сканировать»
        openIps() {
            this.ipFree = [];
            this.ipFreeKeep = {};
            this._ipFreeCache = null;
            this.ipDraft = null;
            this.ipTop = [];
            this.ipScanOff = [];
            this.ipScanSubnetsOff = [];
            this.loadIps();
            if (this.canPage("journals/ips", "edit") && !this.moveInstallers.length) {
                this.loadMoveInstallers();      // «Добавил» – пользователи программы
            }
            if (this.ipCanScan && !this.scanSources.length) {
                this.loadScanSources();         // «Сканировать»
            }
        },

        // ---------- Загрузка ----------

        async loadIps() {
            this.startLoading();
            this.ipError = "";
            try {
                const response = await apiFetch("/api/ips?archived=all");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                const rows = (data.rows || []).map((row) => this.prepIpRow(row));
                this.ipTop = [];
                const next = keepSameRows(this.ipRows, rows);
                if (next) {
                    this.ipRows = next;
                }
                if (JSON.stringify(this.ipSubnets) !== JSON.stringify(data.subnets || [])) {
                    this.ipSubnets = data.subnets || [];
                }
                this.ipLoaded = true;
                if (this.tableKind === "ips") {
                    this.recalcWidths();
                }
            } catch (e) {
                this.ipError = String(e.message || e);
            }
            this.finishLoading();
        },

        // Строка с сервера – для таблицы: «Актуальность» датой (по часам браузера)
        prepIpRow(row) {
            row._ip = true;
            row.ip_checked = this.formatDate(row.checked_at) || null;
            return row;
        },

        // Строки адресов ips после правки – из ответа сервера (адрес, у которого никого не осталось,
        // уходит); порядок – по адресам, записи из архива – после
        mergeIpRows(ips, rows) {
            const drop = new Set(ips);
            const next = this.ipRows.filter(function (row) { return row.archived || !drop.has(row.ip_addr); });
            (rows || []).forEach((row) => next.push(this.prepIpRow(row)));
            next.sort(function (a, b) {
                if (a.archived !== b.archived) {
                    return a.archived ? 1 : -1;
                }
                return a.archived ? 0 : a.id - b.id;
            });
            const kept = keepSameRows(this.ipRows, next);
            if (kept) {
                this.ipRows = kept;
            }
            this.recalcWidths();
        },

        // ---------- Порядок, видимость, ширина ----------

        // Строка «Добавить» и только что добавленные – сверху (до перечитывания таблицы)
        ipPinTop(rows) {
            if (!this.ipDraft && !this.ipTop.length) {
                return rows;
            }
            const top = this.ipTop;
            const pinned = rows.filter(function (row) { return row._draft || (!row.archived && top.indexOf(row.ip_addr) !== -1); });
            if (!pinned.length) {
                return rows;
            }
            const rank = function (row) { return row._draft ? -1 : top.indexOf(row.ip_addr); };
            pinned.sort(function (a, b) { return rank(a) - rank(b); });
            const set = new Set(pinned);
            return pinned.concat(rows.filter(function (row) { return !set.has(row); }));
        },

        // Строка «Добавить», добавленные и заполненные в «Свободных» видны и при поиске и фильтрах
        ipKeepShown(rows) {
            const top = this.ipTop;
            const free = this.ipFree.length > 0;
            const keep = this.modeRows.filter((row) => row._draft || top.indexOf(row.ip_addr) !== -1 || (free && this.ipFreeKeep[row.ip_addr]));
            if (!keep.length) {
                return rows;
            }
            const ids = new Set(rows.map(function (row) { return row.id; }));
            const add = keep.filter(function (row) { return !ids.has(row.id); });
            return add.length ? rows.concat(add) : rows;
        },

        // Ширина «Источников» (просьба пользователя): длинный список переносится, но два любых
        // источника помещаются в строку; base – по самому длинному названию и шапке
        ipSourcesWidth(base) {
            ensureWidthProbe().style.fontWeight = "400";
            const labels = new Set();
            let full = 0;
            this.tableRows.forEach(function (row) {
                const list = row.sources || [];
                let width = 0;
                list.forEach(function (s, i) {
                    const label = sourceLabel(s.key);
                    labels.add(label);
                    width += measureTextWidth(label + (i < list.length - 1 ? "," : "")) + (i ? SRC_GAP : 0);
                });
                full = Math.max(full, width);
            });
            const widths = Array.from(labels).map(function (label) { return measureTextWidth(label + ","); }).sort(function (a, b) { return b - a; });
            const pair = widths.length > 1 ? widths[0] + SRC_GAP + widths[1] : (widths[0] || 0);
            return Math.max(base, Math.ceil(Math.min(full, pair)) + cellOverhead());
        },

        // ---------- Ячейки ----------

        // Значения ячейки: источники – через запятую (перенос – между ними), тип, имя, «Добавил» –
        // строками с подсказкой «откуда», имя ПК, принтера, записи – ссылкой; «Актуальность» – датой
        // с подсказкой по источникам. Нечего показывать – null (обычный текст ячейки)
        ipCellParts(row, col) {
            if (this.isPending(row, col)) {
                return null;
            }
            if (row._draft) {
                return this.ipBuildParts(row, col);
            }
            // Строка с сервера не меняется (правка приносит новую) – части ячейки считаются один раз:
            // строк тысячи, и перерисовка строки (выделение, правка в ней) не считает их заново
            const cache = this._ipParts || (this._ipParts = new WeakMap());
            const raw = Vue.toRaw(row);
            let byField = cache.get(raw);
            if (!byField) {
                byField = {};
                cache.set(raw, byField);
            }
            if (!(col.field in byField)) {
                byField[col.field] = this.ipBuildParts(row, col);
            }
            return byField[col.field];
        },

        ipBuildParts(row, col) {
            if (col.ipCol === "isrc") {
                const last = row.sources.length - 1;
                return row.sources.length ? row.sources.map((s, i) => ({
                    text: sourceLabel(s.key),
                    sep: i < last ? "," : "",
                    title: this.ipSourceTitle(s),
                    cls: { "ip-stale": !!s.stale }
                })) : null;
            }
            if (col.ipCol === "iday") {
                return row.ip_checked ? [{ text: row.ip_checked, title: this.ipDatesTitle(row), cls: {} }] : null;
            }
            const items = row[OWN_ITEMS[col.field]] || [];
            if (!items.length) {
                return null;
            }
            return items.map((item) => {
                // card – принтер открывается карточкой, а не окошком (как у ссылок Компьютеров)
                const obj = col.ipCol === "iname" && item.obj ? Object.assign({ card: true }, item.obj) : null;
                return {
                    text: item.value,
                    title: (obj ? OBJ_TITLES[obj.kind] + "\n" : "") + "Источник: " + item.from.map(sourceLabel).join(", "),
                    obj: obj,
                    href: obj ? this.ipObjHref(obj) : null,
                    tblTitle: obj ? OBJ_TABLE_TITLES[obj.kind] : null,
                    cls: { "ip-stale": !!item.stale }
                };
            });
        },

        ipSourceTitle(s) {
            return [(SOURCES[s.key] || [s.key, s.key])[1], s.at ? this.formatTime(s.at) : ""].concat(s.details || [], s.stale ? ["Давно"] : []).filter(Boolean).join("\n");
        },

        // Подсказка «Актуальности»: когда каждый источник проверял или менял значение
        ipDatesTitle(row) {
            return row.sources.filter(function (s) { return s.at; }).map((s) => sourceLabel(s.key) + ": " + this.formatTime(s.at)).join("\n") || null;
        },

        ipObjHref(obj) {
            if (obj.kind === "pc") {
                return pageLink("table", { pc: obj.id });
            }
            return obj.kind === "printer" ? pageLink("printers", { pr: obj.id }) : pageLink("journals/moves");
        },

        // Можно править ячейку: описание – у всех строк, остальное – у записи журнала, свободного
        // адреса и строки «Добавить» (IP – не у свободного: это сам адрес)
        ipCellEditable(row, col) {
            if (!this.canEdit || row.archived || !col.editable) {
                return false;
            }
            if (col.field === "ip_note") {
                return true;
            }
            if (row._draft || row.entry) {
                return true;
            }
            // Свободный адрес (и адрес с одним описанием, без источников) – заполнение даёт запись
            return !row.sources.length && col.field !== "ip_addr";
        },

        // Что в поле правки: своё значение записи (в ячейке оно могло слиться с чужим – тип ПК, имя
        // из сети – и правка не должна подменить его чужим; ревью этапа 71)
        ipEditValue(row, col) {
            const field = col.field;
            if (row._draft) {
                return row.form[field] || "";
            }
            if (field === "ip_addr" || field === "ip_note") {
                return row[field] || "";
            }
            const entry = row.entry;
            if (!entry) {
                return "";
            }
            return (field === "ip_type" ? entry.ip_type : (field === "ip_name" ? entry.name : entry.added)) || "";
        },

        // Сохранить ячейку: описание занятого адреса – описание (PUT note); у записи – её правка
        // (PATCH); у свободного адреса любое значение – новая запись (с описанием – и оно)
        async saveIpCell(row, col, value) {
            const field = col.field;
            if (row._draft) {
                return this.saveIpDraft(field, value);
            }
            const pendingKey = this.rowKey(row) + ":" + field;
            this.pendingCells[pendingKey] = value;
            const clearPending = () => {
                delete this.pendingCells[pendingKey];
            };
            const free = !row.sources.length;
            let url = "/api/ips";
            let method = "POST";
            let body = { ip_addr: row.ip_addr, [field]: value };
            if (field === "ip_note" && !free) {
                url = "/api/ips/note";
                method = "PUT";
                body = { ip: row.ip_addr, ip_note: value, _version: row.note_version || 0 };
            } else if (row.entry) {
                url = "/api/ips/" + row.entry.id;
                method = "PATCH";
                body = { [field]: value, _version: row.entry.version };
            }
            if (free) {
                this.ipFreeKeep[row.ip_addr] = true;
            }
            try {
                const response = await apiFetch(url, {
                    method: method,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (response.status === 409) {
                    clearPending();
                    this.toastError(await this.errorText(response));
                    await this.loadIps();
                    return false;
                }
                if (!response.ok) {
                    clearPending();
                    if (free) {
                        delete this.ipFreeKeep[row.ip_addr];
                    }
                    this.toastError("Не удалось сохранить: " + (await this.errorText(response)));
                    return false;
                }
                const data = await response.json();
                clearPending();
                const rows = data.rows || [];
                this.mergeIpRows([row.ip_addr].concat(rows.map(function (r) { return r.ip_addr; })), rows);
                // Сменили адрес записи – строка теперь там (в «Свободных» – тоже остаётся видна)
                const moved = field === "ip_addr" ? rows.find(function (r) { return r.ip_addr !== row.ip_addr; }) : null;
                if (moved && this.ipFree.length) {
                    this.ipFreeKeep[moved.ip_addr] = true;
                }
                this.flashCell("i" + (moved ? moved.id : row.id), field);
                return true;
            } catch (e) {
                clearPending();
                this.toastError("Не удалось сохранить: " + e);
                return false;
            }
        },

        // ---------- «Добавить» ----------

        openIpAdd() {
            this.closeMenus();
            if (this.showArchive) {
                this.setArchiveView(false);
            }
            const name = this.navUserName;
            if (!this.ipDraft) {
                const now = new Date().toISOString();
                this.ipDraft = {
                    id: DRAFT_ID, _ip: true, _draft: true, archived: false, ip_addr: null,
                    ip_sources: sourceLabel(OWN), sources: [{ key: OWN, at: now }],
                    ip_type: null, types: [], ip_name: null, names: [], ip_note: null,
                    checked_at: now, ip_checked: this.formatDate(now),
                    ip_added: name, added: ownItems(name), entry: null,
                    form: { ip_added: name }
                };
            }
            const wrap = this.$refs.tableWrap;
            if (wrap) {
                wrap.scrollTop = 0;
            }
            const col = this.allColumns.find(function (c) { return c.field === "ip_addr"; });
            this.$nextTick(() => {
                if (this.ipDraft && col) {
                    this.startEdit(this.ipDraft, col);
                }
            });
        },

        // Значение строки «Добавить»: пока нет адреса – только на экране; адрес есть – запись на сервер.
        // Что вписали, пока она сохранялась, – следом правкой записи (ревью этапа 71: терялось)
        async saveIpDraft(field, value) {
            const draft = this.ipDraft;
            if (!draft) {
                return false;
            }
            const text = String(value || "").trim();
            draft.form[field] = text;
            if (OWN_ITEMS[field]) {
                draft[field] = text || null;
                draft[OWN_ITEMS[field]] = ownItems(text);
            } else {
                draft[field] = text || null;
            }
            if (!draft.form.ip_addr || draft.saving) {
                return true;
            }
            draft.saving = true;
            const sent = Object.assign({}, draft.form);
            try {
                const body = Object.assign({}, sent);
                const response = await apiFetch("/api/ips", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                const rows = data.rows || [];
                const row = rows[0];
                this.mergeIpRows(rows.map(function (r) { return r.ip_addr; }), rows);
                if (row) {
                    this.ipTop = [row.ip_addr].concat(this.ipTop.filter(function (ip) { return ip !== row.ip_addr; }));
                    if (this.ipFree.length) {
                        this.ipFreeKeep[row.ip_addr] = true;
                    }
                }
                this.ipDraft = null;
                // Правка следующей ячейки (Tab) началась в строке «Добавить» – продолжить в записи
                if (row && this.editingRowId === draft.id) {
                    this.editingRowId = row.id;
                    this.$nextTick(() => this.focusIpEdit(row));
                }
                if (row) {
                    this.flashCell("i" + row.id, field);
                    await this.sendIpDraftRest(row, draft.form, sent);
                }
                return true;
            } catch (e) {
                draft.saving = false;
                this.toastError("Не удалось добавить: " + (e.message || e));
                return false;
            }
        },

        // Поля строки «Добавить», вписанные во время её сохранения, – правкой новой записи по одному
        async sendIpDraftRest(row, form, sent) {
            for (const field of Object.keys(form)) {
                if (form[field] === sent[field] || field === "ip_addr") {
                    continue;
                }
                const fresh = this.ipByAddr.get(row.ip_addr) || row;
                const col = this.allColumns.find(function (c) { return c.field === field; });
                if (col) {
                    await this.saveIpCell(fresh, col, form[field]);
                }
            }
        },

        // Поле правки, перешедшее из строки «Добавить» в запись, – снова в фокусе
        focusIpEdit(row) {
            const tr = this.$refs.table && this.$refs.table.querySelector('tbody tr[data-id="' + row.id + '"]');
            const el = tr && tr.querySelector("td.editing .cell-edit");
            if (el) {
                el.focus({ preventScroll: true });
            }
        },

        // Esc в пустом адресе строки «Добавить» – убрать её (без адреса запись не сохранить)
        dropIpDraft() {
            this.ipDraft = null;
        },

        // ---------- «Свободные» ----------

        toggleIpFree(cidr) {
            const on = this.ipFree.indexOf(cidr) === -1;
            this.setIpFree(on ? this.ipFree.concat([cidr]) : this.ipFree.filter(function (c) { return c !== cidr; }));
        },

        // «только» – одна подсеть, как в фильтре столбца
        onlyIpFree(cidr) {
            this.setIpFree([cidr]);
        },

        setIpFree(list) {
            this.ipFree = list;
            if (!list.length) {
                this.ipFreeKeep = {};
                this._ipFreeCache = null;
            }
            this.cancelEdit();
            this.selectedRows = [];
            this.selectAnchorId = null;
            this.$nextTick(() => this.recalcWidths());
        },

        // ---------- «Сканировать» ----------

        toggleIpScanMenu() {
            if (this.openMenu !== "ipScan") {
                this.ipScanSubnetsOff = [];
                if (!this.scanSources.length) {
                    this.loadScanSources();
                }
            }
            this.toggleMenu("ipScan");
        },

        toggleIpScanPart(key) {
            const off = this.ipScanOff;
            this.ipScanOff = off.indexOf(key) === -1 ? off.concat([key]) : off.filter(function (k) { return k !== key; });
        },

        toggleIpScanSubnet(cidr) {
            const off = this.ipScanSubnetsOff;
            this.ipScanSubnetsOff = off.indexOf(cidr) === -1 ? off.concat([cidr]) : off.filter(function (c) { return c !== cidr; });
        },

        onlyIpScanSubnet(cidr) {
            this.ipScanSubnetsOff = this.ipScanSubnets.map(function (sn) { return sn.cidr; }).filter(function (c) { return c !== cidr; });
        },

        // «Сканировать» в меню: отмеченное (у сканера – отмеченные подсети, у DHCP – аренды и / или
        // привязки)
        collectIpChosen() {
            const on = this.ipScanOn;
            const subnets = this.ipScanSubnets.filter(function (sn) { return sn.checked; }).map(function (sn) { return sn.cidr; });
            const jobs = [];
            if (on.net && subnets.length) {
                jobs.push({ kind: "net", only: subnets.length < this.ipScanSubnets.length ? { subnets: subnets } : null });
            }
            if (on.leases || on.configs) {
                jobs.push({ kind: "dhcp", only: on.leases && on.configs ? null : { leases: !!on.leases, configs: !!on.configs } });
            }
            ["glpi", "gsit", "jabber"].forEach(function (kind) {
                if (on[kind]) {
                    jobs.push(kind);
                }
            });
            this.closeMenus();
            this.collectKinds(jobs);
        },

        // ---------- Ссылки имени ----------

        // Запись «Движения» – её окно (журнал мог ещё не загрузиться)
        async openMoveById(id) {
            if (!this.canPage("journals/moves", "edit")) {
                this.toast(this.canPage("journals/moves") ? "Запись правит только редактор" : "Нет доступа к «Движению»");
                return;
            }
            if (!this.moveRows.length) {
                await this.loadMoves();
                this.loadItemTypes();
                if (!this.printerModels.length) {
                    this.loadPrinterModels();
                }
            }
            const row = this.moveRows.find(function (r) { return r.id === id; });
            if (row) {
                this.openMoveRecord(row, null);
            } else {
                this.toast("Этой записи нет в журнале");
            }
        },

        // «Показать в Движении»: вкладка «Движение», строка записи
        async showMoveInTable(id) {
            if (!this.canPage("journals/moves")) {
                this.toast("Нет доступа к «Движению»");
                return;
            }
            this.setJournalTab("moves");
            if (!this.moveRows.length) {
                await this.loadMoves();
            }
            const row = this.moveRows.find(function (r) { return r.id === id; });
            if (!row) {
                this.toast("Этой записи нет в журнале");
                return;
            }
            this.quickFilter = "";
            this.colFilters = {};
            this.setArchiveView(!!row.archived);
            this.$nextTick(() => {
                this.scrollToRow(row.id);
                this.setActiveRow(row);
            });
        },

        // ---------- Выбранные строки ----------

        // Записи журнала у выбранных строк (архив, удаление): номера записей
        ipEntryIds(ids) {
            const set = new Set(ids);
            return this.ipRows.filter(function (row) { return set.has(row.id) && row.entry; }).map(function (row) { return row.entry.id; });
        },

        ipAddrOf(id) {
            const row = this.ipTableRows.find(function (r) { return r.id === id; });
            return row ? row.ip_addr : null;
        }
    }
};
