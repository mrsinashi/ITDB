// Доступ к веб-странице принтера (этап 45) и логин и пароль ПК (этап 69, так же): столбец
// «Доступ» и строка карточки. Строка ПК и принтера – по признаку _printer (rowKey: id может
// совпасть). Заданные логин и пароль – точками одной строкой. Двойной клик – окошко пароля прямо под
// ячейкой (администратор вводит свой пароль, остальные – логин и пароль администратора);
// после него логин и пароль – в самой ячейке строками: Alt+клик (в карточке – клик)
// копирует, ✎ – изменить. Не заданы – двойной клик сразу открывает два поля (логин виден,
// пароль – точками); пока они открыты, столбец шире. Показанное прячут Esc и уход в другую
// часть интерфейса (правка другой ячейки, карточка, другая страница); клик мимо – нет.

import { maxTextWidth } from "../util.js";

// Логин и пароль заданы – столько точек, какой бы длины ни был пароль
export const SECRET_DOTS = "••••••";
// Ширина столбца, пока в ячейке два поля
const EDIT_WIDTH = 176;
// Справа от показанных значений – ✎ и поля ячейки
const SHOWN_PAD = 34;

export default {
    data() {
        return {
            webShown: null,     // показанные логин и пароль: { key, login, password, where }
            // Показаны в ячейке – по ключу строки (этап 69): строка таблицы читает только свой
            // ключ, показ и скрытие не перерисовывают остальные 600 строк
            webShownKeys: {},
            webAsk: null,       // окошко пароля под ячейкой
            webEdit: null,      // правка: { key, id, row, where, login, password, saving }
            cellWiden: {}       // поле → ширина столбца, пока ячейка шире обычного
        };
    },

    computed: {
        secretDots() {
            return SECRET_DOTS;
        }
    },

    methods: {
        webShownFor(row) {
            return !!row && !!this.webShown && this.webShown.key === this.rowKey(row);
        },

        // Показаны в ячейке строки: открытые в карточке – не в ячейке таблицы за ней (этап 69)
        webShownInCell(row) {
            return !!this.webShownKeys[this.rowKey(row)];
        },

        webEditIn(row, where) {
            return !!row && !!this.webEdit && this.webEdit.key === this.rowKey(row) && this.webEdit.where === where;
        },

        // Адрес «Доступа» строки: /api/computers/12/web-auth, /api/printers/3/web-auth
        webAuthUrl(row) {
            return (row._printer ? "/api/printers/" : "/api/computers/") + row.id + "/web-auth";
        },

        // Подсказка у ячейки и строки карточки: что сделает двойной клик
        webAccessTitle(row) {
            if (this.webEditIn(row, "cell") || this.webEditIn(row, "card")) {
                return null;
            }
            if (this.webShownFor(row)) {
                return this.canEditRow(row) ? "Двойной клик – изменить" : null;
            }
            if (row.web_auth) {
                return "Двойной клик – показать";
            }
            return this.canEditRow(row) ? "Двойной клик – задать" : null;
        },

        // Двойной клик по ячейке «Доступ» или строке карточки; el – под ним окошко пароля
        openWebAccess(row, el, where) {
            // Двойной клик выделил кусок точек – снять
            this.clearTextSelection();
            if (this.webShownFor(row)) {
                if (this.canEditRow(row)) {
                    this.startWebEdit(row, where);
                }
                return;
            }
            this.hideWebShown();
            if (row.web_auth) {
                this.openWebAsk(row, el, where);
            } else if (this.canEditRow(row)) {
                this.startWebEdit(row, where);
            }
        },

        // Столбец шире, пока в ячейке поля или показанные значения (0 – как был)
        setCellWiden(field, width) {
            const next = Object.assign({}, this.cellWiden);
            if (width) {
                next[field] = Math.ceil(width);
            } else {
                delete next[field];
            }
            this.cellWiden = next;
        },

        // ---------- Окошко пароля ----------

        openWebAsk(row, el, where) {
            this.closeWebAsk();
            const r = el.getBoundingClientRect();
            this.webAsk = {
                row: row,
                where: where,
                el: el,
                login: "",
                password: "",
                error: "",
                busy: false,
                left: Math.round(r.left),
                top: Math.round(r.bottom),
                placed: false
            };
            // Сначала встать на место (до этого окошко скрыто – поле фокус не примет)
            this.$nextTick(() => {
                this.placeWebAsk();
                this.$nextTick(() => {
                    const input = this.$refs[this.isAdmin ? "webAskPassword" : "webAskLogin"];
                    if (input) {
                        input.focus();
                    }
                });
            });
            const move = () => this.placeWebAsk();
            this.listenPop("webAsk", {
                mousedown: (e) => {
                    const box = this.$refs.webAsk;
                    if (this.webAsk && !(box && box.contains(e.target))) {
                        this.closeWebAsk();
                    }
                },
                scroll: move,
                resize: move
            });
        },

        placeWebAsk() {
            this.placeUnderPop("webAsk");
        },

        closeWebAsk() {
            this.closePop("webAsk");
        },

        onWebAskKeydown(event) {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                this.closeWebAsk();
            } else if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                if (!this.isAdmin && event.target === this.$refs.webAskLogin && !this.webAsk.password) {
                    this.$refs.webAskPassword.focus();
                } else {
                    this.submitWebAsk();
                }
            }
        },

        async submitWebAsk() {
            const ask = this.webAsk;
            if (!ask || ask.busy) {
                return;
            }
            if ((!this.isAdmin && !ask.login.trim()) || !ask.password) {
                ask.error = this.isAdmin ? "Введи пароль." : "Нужны логин и пароль администратора.";
                return;
            }
            ask.busy = true;
            ask.error = "";
            try {
                const response = await this.apiSend(this.webAuthUrl(ask.row) + "/show", "POST", { login: this.isAdmin ? null : ask.login, password: ask.password });
                const shown = await response.json();
                if (this.webAsk !== ask) {
                    return;
                }
                this.closeWebAsk();
                this.showWebValues(ask.row, shown.login || "", shown.password || "", ask.where, ask.el);
            } catch (e) {
                ask.busy = false;
                ask.error = String(e.message || e);
                ask.password = "";
                this.$nextTick(() => {
                    if (this.$refs.webAskPassword) {
                        this.$refs.webAskPassword.focus();
                    }
                });
            }
        },

        // ---------- Показанные логин и пароль ----------

        showWebValues(row, login, password, where, el) {
            if (this.webShown) {
                delete this.webShownKeys[this.webShown.key];
            }
            this.webShown = { key: this.rowKey(row), login: login, password: password, where: where };
            if (where === "cell") {
                this.webShownKeys[this.webShown.key] = true;
                const font = el && (el.querySelector(".cell-lines, span") || el);
                const w = maxTextWidth([login || "без логина", password || "без пароля"], font);
                this.setCellWiden("web_auth", w + SHOWN_PAD);
            }
        },

        hideWebShown() {
            if (this.webAsk) {
                this.closeWebAsk();
            }
            if (!this.webShown) {
                return;
            }
            delete this.webShownKeys[this.webShown.key];
            this.webShown = null;
            if (!this.webEdit) {
                this.setCellWiden("web_auth", 0);
            }
        },

        // ---------- Правка: два поля ----------

        startWebEdit(row, where) {
            if (!this.canEditRow(row)) {
                return;
            }
            const shown = this.webShownFor(row) ? this.webShown : null;
            this.closeWebAsk();
            this.closeSuggest();
            this.webEdit = {
                key: this.rowKey(row),
                id: row.id,
                row: row,
                where: where,
                login: shown ? shown.login : "",
                password: shown ? shown.password : "",
                saving: false
            };
            if (where === "cell") {
                this.editingRowId = row.id;
                this.editingField = "web_auth";
                this.setCellWiden("web_auth", Math.max(EDIT_WIDTH, this.cellWiden.web_auth || 0));
            } else if (row._printer) {
                this.pcardEditKey = "web_auth";
            } else {
                this.cardEditKey = "web_auth";
            }
            this.$nextTick(() => {
                const input = this.webEditLoginInput();
                if (input) {
                    input.focus({ preventScroll: true });
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            });
        },

        // Поле логина открытой правки: в карточке – ref, в ячейке – внутри строки таблицы
        // (компонент table-row, этап 52: её ref корню не виден)
        webEditLoginInput() {
            const ref = this.$refs.webEditLogin;
            return (Array.isArray(ref) ? ref[0] : ref) || document.querySelector(".data-table .secret-edit input");
        },

        closeWebEdit() {
            const ed = this.webEdit;
            if (!ed) {
                return;
            }
            this.webEdit = null;
            if (this.editingField === "web_auth") {
                this.editingRowId = null;
                this.editingField = null;
            }
            if (this.pcardEditKey === "web_auth") {
                this.pcardEditKey = null;
            }
            if (this.cardEditKey === "web_auth") {
                this.cardEditKey = null;
            }
            if (!this.webShown || this.webShown.where !== "cell") {
                this.setCellWiden("web_auth", 0);
            }
        },

        onWebEditKeydown(event) {
            if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                this.saveWebEdit();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                this.closeWebEdit();
                this.hideWebShown();
            }
        },

        // Фокус ушёл из обоих полей – сохранить (как у ячейки)
        onWebEditFocusOut(event) {
            const box = event.currentTarget;
            if (event.relatedTarget && box.contains(event.relatedTarget)) {
                return;
            }
            this.saveWebEdit();
        },

        async saveWebEdit() {
            const ed = this.webEdit;
            if (!ed || ed.saving) {
                return;
            }
            const printer = !!ed.row._printer;
            const row = (printer ? this.printerRows : this.rows).find(function (r) { return r.id === ed.id; }) || ed.row;
            const shown = this.webShownFor(row) ? this.webShown : { login: "", password: "" };
            const login = ed.login.trim();
            if (login === shown.login && ed.password === shown.password) {
                this.closeWebEdit();
                this.hideWebShown();
                return;
            }
            ed.saving = true;
            if (!login && !ed.password && row.web_auth) {
                const what = printer ? "Web у «" + (row.name || "принтера") + "»" : "у «" + (row.hostname || "компьютера") + "»";
                const yes = await this.confirmDialog("Удалить логин и пароль " + what + "?", { okText: "Удалить", danger: true });
                if (!yes) {
                    ed.saving = false;
                    this.$nextTick(() => {
                        const input = this.webEditLoginInput();
                        if (input) {
                            input.focus();
                        }
                    });
                    return;
                }
            }
            try {
                const response = await this.apiSend(this.webAuthUrl(row), "PUT", { login: login, password: ed.password });
                const data = await response.json();
                if (data.updated) {
                    row.web_auth = data.updated.web_auth;
                    row.version = data.updated.version;
                }
                if (this.webEdit === ed) {
                    this.closeWebEdit();
                }
                this.hideWebShown();
                this.flashCell(this.rowKey(row), "web_auth");
                this.reloadCardHistory(row.id, printer);
            } catch (e) {
                ed.saving = false;
                this.toastError("Не удалось сохранить: " + (e.message || e));
            }
        }
    }
};
