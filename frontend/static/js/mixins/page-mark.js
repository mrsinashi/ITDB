// Полоска нажатой строки на «GLPI / GSIT», «Сети» и «Vacuum» (этап 43) – как в Таблице:
// по строке нажали мышью (без Ctrl / Shift / Alt) – полоска у её левого края; Enter –
// VNC, Alt+P – ping, Alt+R – RDP. «GLPI / GSIT» – к ПК строки (ПК в таблице нет – к адресу
// записи), «Сеть» – к адресу строки (VNC – какой записан у ПК на нём), «Vacuum» – к
// последнему IP пользователя. Нажатие мимо строк таблицы и Enter в другой ситуации
// (поле, кнопка, меню, карточка) полоску снимают.
// Полоска – атрибут data-mark у строки (вид – app.css): данные Vue не меняются, страница
// на клик не перерисовывается. Vue пересоздал строку – атрибут ставится снова (updated);
// строку скрыли фильтром или поиском, ушли со страницы – полоска забыта.

import { isTypingTarget } from "../util.js";

// Таблица каждой страницы
const PAGE_TABLES = { check: ".ck-table", net: ".net-table", vacuum: ".vacuum-table" };

export default {
    mounted() {
        this._pageMark = null;     // { page, key }
        this._pageMarkEl = null;
        document.addEventListener("mousedown", this.onPageMarkMouseDown, true);
    },

    updated() {
        if (this._pageMark || this._pageMarkEl) {
            this.syncPageMark();
        }
    },

    methods: {
        // Страница, где работает полоска (check / net / vacuum), иначе null
        pageMarkPage() {
            if (this.view === "vacuum") {
                return "vacuum";
            }
            if (this.view === "scan" && (this.scanTab === "check" || this.scanTab === "net")) {
                return this.scanTab;
            }
            return null;
        },

        // Нажатие по строке: по ссылке или кнопке в ней – полоску снять, иначе – на эту строку
        onPageRowMouseDown(event, page, key) {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
                return;
            }
            const inner = event.target.closest("a, button, input, textarea, select, .act-ico");
            this._pageMark = inner ? null : { page: page, key: String(key) };
            this.syncPageMark();
        },

        // Нажатие мимо строк таблицы страницы – полоска снимается (полоса прокрутки – не в счёт)
        onPageMarkMouseDown(event) {
            const mark = this._pageMark;
            if (!mark) {
                return;
            }
            const target = event.target;
            const table = document.querySelector(PAGE_TABLES[mark.page]);
            const tr = target.closest ? target.closest("tr[data-key]") : null;
            if ((tr && table && table.contains(tr)) || (target.classList && target.classList.contains("history-scroll"))) {
                return;
            }
            this.clearPageMark();
        },

        clearPageMark() {
            this._pageMark = null;
            this.syncPageMark();
        },

        // Атрибут – у строки с полоской, и только у неё
        syncPageMark() {
            const mark = this._pageMark;
            let el = null;
            if (mark && mark.page === this.pageMarkPage()) {
                const table = document.querySelector(PAGE_TABLES[mark.page]);
                el = table ? table.querySelector('tbody tr[data-key="' + CSS.escape(mark.key) + '"]') : null;
            }
            if (!el) {
                this._pageMark = null;
            }
            if (this._pageMarkEl && this._pageMarkEl !== el) {
                this._pageMarkEl.removeAttribute("data-mark");
            }
            if (el && !el.hasAttribute("data-mark")) {
                el.setAttribute("data-mark", "");
            }
            this._pageMarkEl = el;
        },

        // Enter / Alt+P / Alt+R при полоске. Ответ – обработано ли
        onPageMarkKey(event) {
            if (!this._pageMark) {
                return false;
            }
            const plain = !event.ctrlKey && !event.metaKey && !event.shiftKey;
            const enter = event.key === "Enter" && plain && !event.altKey;
            const alt = plain && event.altKey;
            const what = enter ? "vnc" : (alt && event.code === "KeyP" ? "ping" : (alt && event.code === "KeyR" ? "rdp" : null));
            if (!what) {
                return false;
            }
            const target = event.target;
            const free = !event.defaultPrevented && !isTypingTarget(document.activeElement) &&
                !(target && target.closest && target.closest("button, .dropdown, .add-bar, .card-overlay")) &&
                !this.card && !this.openMenu && !this.valueEdit && !this.scanLinkBar && !this.dialog;
            if (!free) {
                if (enter) {
                    this.clearPageMark();
                }
                return false;
            }
            const pc = this.pageMarkTarget();
            if (!pc) {
                return false;
            }
            event.preventDefault();
            if (what === "vnc") {
                this.vncConnect(pc, null);
            } else {
                this.connectRow(pc, what);
            }
            return true;
        },

        // К чему подключаться: ПК таблицы или { ip, vnc, hostname } по строке
        pageMarkTarget() {
            const mark = this._pageMark;
            const pcOf = (id) => this.rows.find(function (r) { return r.id === id; }) || null;
            if (mark.page === "check") {
                const row = this.checkRows.find(function (r) { return r.key === mark.key; });
                if (!row) {
                    return null;
                }
                const pc = row.pcId ? pcOf(row.pcId) : null;
                const rec = Object.values(row.recs)[0];
                if ((pc && String(pc.ip || "").trim()) || !rec) {
                    return pc;
                }
                return { ip: rec.values.ip, vnc: (pc && pc.vnc) || rec.values.vnc, hostname: (pc && pc.hostname) || rec.name };
            }
            if (mark.page === "net") {
                const h = this.netHosts.find(function (x) { return x.ip === mark.key; });
                if (!h) {
                    return null;
                }
                const pc = h.computers.length ? pcOf(h.computers[0].computer_id) : null;
                return { ip: h.ip, vnc: pc ? pc.vnc : "", hostname: pc ? pc.hostname : (h.name.length ? h.name[0].value : "") };
            }
            const u = this.vacuumUsers.find(function (x) { return x.login === mark.key; });
            if (!u) {
                return null;
            }
            const a = u.addresses.find(function (x) { return x.ip; }) || { ip: "", hosts: [] };
            const host = a.hosts.find(function (x) { return x.computer_id; });
            const pc = host ? pcOf(host.computer_id) : null;
            return { ip: a.ip, vnc: pc ? pc.vnc : "", hostname: (pc && pc.hostname) || (a.hosts.length ? a.hosts[0].hostname : "") || u.login };
        },
    }
};
