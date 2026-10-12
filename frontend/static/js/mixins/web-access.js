// Доступ к веб-странице принтера (этап 45): столбец «Доступ» и строка карточки принтера.
// Заданные логин и пароль – точками одной строкой. Двойной клик – окошко пароля прямо под
// ячейкой (администратор вводит свой пароль, остальные – логин и пароль администратора);
// после него логин и пароль – в самой ячейке строками: Alt+клик (в карточке – клик)
// копирует, ✎ – изменить. Не заданы – двойной клик сразу открывает два поля (логин виден,
// пароль – точками); пока они открыты, столбец шире. Показанное прячут Esc и уход в другую
// часть интерфейса (правка другой ячейки, карточка, другая страница); клик мимо – нет.

import { apiFetch } from "../util.js";

// Логин и пароль заданы – столько точек, какой бы длины ни был пароль
export const SECRET_DOTS = "••••••";
// Ширина столбца, пока в ячейке два поля
const EDIT_WIDTH = 176;
// Справа от показанных значений – ✎ и поля ячейки
const SHOWN_PAD = 34;

let measureCtx = null;

function textWidth(text, el) {
    if (!measureCtx) {
        measureCtx = document.createElement("canvas").getContext("2d");
    }
    const style = window.getComputedStyle(el || document.body);
    measureCtx.font = style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
    return measureCtx.measureText(String(text || "")).width;
}

export default {
    data() {
        return {
            webShown: null,     // показанные логин и пароль: { id, login, password, where }
            webAsk: null,       // окошко пароля под ячейкой
            webEdit: null,      // правка: { id, row, where, login, password, saving }
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
            return !!row && !!this.webShown && this.webShown.id === row.id;
        },

        webEditIn(row, where) {
            return !!row && !!this.webEdit && this.webEdit.id === row.id && this.webEdit.where === where;
        },

        // Подсказка у ячейки и строки карточки: что сделает двойной клик
        webAccessTitle(row) {
            if (this.webEditIn(row, "cell") || this.webEditIn(row, "card")) {
                return null;
            }
            if (this.webShownFor(row)) {
                return this.canEdit ? "Двойной клик – изменить" : null;
            }
            if (row.web_auth) {
                return "Двойной клик – показать";
            }
            return this.canEdit ? "Двойной клик – задать" : null;
        },

        // Двойной клик по ячейке «Доступ» или строке карточки; el – под ним окошко пароля
        openWebAccess(row, el, where) {
            // Двойной клик выделил кусок точек – снять
            const sel = window.getSelection && window.getSelection();
            if (sel) {
                sel.removeAllRanges();
            }
            if (this.webShownFor(row)) {
                if (this.canEdit) {
                    this.startWebEdit(row, where);
                }
                return;
            }
            this.hideWebShown();
            if (row.web_auth) {
                this.openWebAsk(row, el, where);
            } else if (this.canEdit) {
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
            this._webAskDown = (e) => {
                const box = this.$refs.webAsk;
                if (this.webAsk && !(box && box.contains(e.target))) {
                    this.closeWebAsk();
                }
            };
            this._webAskMove = () => this.placeWebAsk();
            window.addEventListener("mousedown", this._webAskDown, true);
            window.addEventListener("scroll", this._webAskMove, true);
            window.addEventListener("resize", this._webAskMove);
        },

        // Под ячейкой, по её левому краю; снизу мало места – над ней
        placeWebAsk() {
            const ask = this.webAsk;
            const box = this.$refs.webAsk;
            if (!ask || !box || !ask.el.isConnected) {
                return;
            }
            const r = ask.el.getBoundingClientRect();
            const w = box.offsetWidth;
            const h = box.offsetHeight;
            ask.left = Math.max(4, Math.min(Math.round(r.left), window.innerWidth - w - 4));
            ask.top = r.bottom + h + 4 > window.innerHeight ? Math.max(4, Math.round(r.top - h)) : Math.round(r.bottom);
            ask.placed = true;
        },

        closeWebAsk() {
            this.webAsk = null;
            if (this._webAskDown) {
                window.removeEventListener("mousedown", this._webAskDown, true);
                window.removeEventListener("scroll", this._webAskMove, true);
                window.removeEventListener("resize", this._webAskMove);
                this._webAskDown = null;
                this._webAskMove = null;
            }
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
                const response = await apiFetch("/api/printers/" + ask.row.id + "/web-auth/show", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ login: this.isAdmin ? null : ask.login, password: ask.password })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
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
            this.webShown = { id: row.id, login: login, password: password, where: where };
            if (where === "cell") {
                const font = el && (el.querySelector(".cell-lines, span") || el);
                const w = Math.max(textWidth(login || "без логина", font), textWidth(password || "без пароля", font));
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
            this.webShown = null;
            if (!this.webEdit) {
                this.setCellWiden("web_auth", 0);
            }
        },

        // ---------- Правка: два поля ----------

        startWebEdit(row, where) {
            if (!this.canEdit) {
                return;
            }
            const shown = this.webShownFor(row) ? this.webShown : null;
            this.closeWebAsk();
            this.closeSuggest();
            this.webEdit = {
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
            } else {
                this.pcardEditKey = "web_auth";
            }
            this.$nextTick(() => {
                const ref = this.$refs.webEditLogin;
                const input = Array.isArray(ref) ? ref[0] : ref;
                if (input) {
                    input.focus({ preventScroll: true });
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            });
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
            const row = this.printerRows.find(function (r) { return r.id === ed.id; }) || ed.row;
            const shown = this.webShownFor(row) ? this.webShown : { login: "", password: "" };
            const login = ed.login.trim();
            if (login === shown.login && ed.password === shown.password) {
                this.closeWebEdit();
                this.hideWebShown();
                return;
            }
            ed.saving = true;
            if (!login && !ed.password && row.web_auth) {
                const yes = await this.confirmDialog("Удалить логин и пароль Web у «" + (row.name || "принтера") + "»?", { okText: "Удалить", danger: true });
                if (!yes) {
                    ed.saving = false;
                    this.$nextTick(() => {
                        const ref = this.$refs.webEditLogin;
                        const input = Array.isArray(ref) ? ref[0] : ref;
                        if (input) {
                            input.focus();
                        }
                    });
                    return;
                }
            }
            try {
                const response = await apiFetch("/api/printers/" + row.id + "/web-auth", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ login: login, password: ed.password })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                if (data.updated) {
                    row.web_auth = data.updated.web_auth;
                    row.version = data.updated.version;
                }
                if (this.webEdit === ed) {
                    this.closeWebEdit();
                }
                this.hideWebShown();
                this.flashCell("p" + row.id, "web_auth");
                this.reloadPrinterCardHistory(row.id);
            } catch (e) {
                ed.saving = false;
                this.toastError("Не удалось сохранить: " + (e.message || e));
            }
        }
    }
};
