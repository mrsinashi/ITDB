// Доступ к веб-странице принтера (этап 45) и пароли ПК (этап 69, так же; с этапа 70 – столбец
// «Пароль», записей несколько: учётная запись и / или пароль): столбец и строка карточки.
// Строка ПК и принтера – по признаку _printer (rowKey: id может совпасть). Заданные – точками
// одной строкой. Двойной клик – окошко пароля прямо под ячейкой (администратор вводит свой
// пароль, остальные – логин и пароль администратора); после него записи – в самой ячейке
// строками (у каждой – учётная запись и пароль): Alt+клик (в карточке – клик) копирует, ✎ –
// изменить, у ПК ＋ справа от пароля – ещё запись. Не заданы – двойной клик сразу открывает
// два поля (учётная запись видна, пароль – точками); у ПК ＋ справа от заполненного пароля –
// ещё два поля; пока поля открыты, столбец шире. Показанное прячут Esc и уход в другую часть
// интерфейса (правка другой ячейки, карточка, другая страница); клик мимо – нет. У принтера
// запись одна (логин и пароль Web).

import { apiFetch, maxTextWidth } from "../util.js";

// Логин и пароль заданы – столько точек, какой бы длины ни был пароль
export const SECRET_DOTS = "••••••";
// Ширина столбца, пока в ячейке два поля
const EDIT_WIDTH = 176;
// …у ПК справа ещё ＋ (этап 70)
const PLUS_WIDTH = 18;
// Справа от показанных значений – ✎ и поля ячейки
const SHOWN_PAD = 34;

export default {
    data() {
        return {
            webShown: null,     // показанные записи: { key, entries: [{ login, password }], where }
            // Показаны в ячейке – по ключу строки (этап 69): строка таблицы читает только свой
            // ключ, показ и скрытие не перерисовывают остальные 600 строк
            webShownKeys: {},
            webAsk: null,       // окошко пароля под ячейкой
            webEdit: null,      // правка: { key, id, row, where, entries: [{ login, password }], saving }
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

        // У ПК – «Учётная запись» (этап 70, слова пользователя), у принтера – логин Web
        webLoginLabel(row) {
            return row && row._printer ? "Логин" : "Учётная запись";
        },

        webNoLogin(row) {
            return row && row._printer ? "без логина" : "без учётной записи";
        },

        // ＋ справа от последнего пароля в правке – у ПК, когда в последней записи что-то есть
        webEditCanAdd(row) {
            const ed = this.webEdit;
            if (!ed || row._printer) {
                return false;
            }
            const last = ed.entries[ed.entries.length - 1];
            return !!(last.login.trim() || last.password);
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
                // У ПК – записи (этап 70), у принтера – одна пара
                const entries = (shown.entries || [shown]).map(function (e) { return { login: e.login || "", password: e.password || "" }; });
                this.showWebValues(ask.row, entries, ask.where, ask.el);
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

        // ---------- Показанные записи ----------

        showWebValues(row, entries, where, el) {
            if (this.webShown) {
                delete this.webShownKeys[this.webShown.key];
            }
            this.webShown = { key: this.rowKey(row), entries: entries, where: where };
            if (where === "cell") {
                this.webShownKeys[this.webShown.key] = true;
                const font = el && (el.querySelector(".cell-lines, span") || el);
                const lines = [];
                entries.forEach((e) => lines.push(e.login || this.webNoLogin(row), e.password || "без пароля"));
                this.setCellWiden("web_auth", maxTextWidth(lines, font) + SHOWN_PAD);
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

        // ---------- Правка: по два поля на запись ----------

        // add – ＋ у показанных (этап 70): к записям – ещё одна пустая, фокус в неё
        startWebEdit(row, where, add) {
            if (!this.canEditRow(row)) {
                return;
            }
            const shown = this.webShownFor(row) ? this.webShown : null;
            const entries = shown ? shown.entries.map(function (e) { return { login: e.login, password: e.password }; }) : [];
            if (!entries.length || add) {
                entries.push({ login: "", password: "" });
            }
            this.closeWebAsk();
            this.closeSuggest();
            this.webEdit = {
                key: this.rowKey(row),
                id: row.id,
                row: row,
                where: where,
                entries: entries,
                saving: false
            };
            if (where === "cell") {
                this.editingRowId = row.id;
                this.editingField = "web_auth";
                const width = EDIT_WIDTH + (row._printer ? 0 : PLUS_WIDTH);
                this.setCellWiden("web_auth", Math.max(width, this.cellWiden.web_auth || 0));
            } else if (row._printer) {
                this.pcardEditKey = "web_auth";
            } else {
                this.cardEditKey = "web_auth";
            }
            this.focusWebEntry(add ? entries.length - 1 : 0);
        },

        // ＋ справа от пароля в правке (этап 70): ещё два поля, фокус – в учётную запись
        addWebEntry() {
            const ed = this.webEdit;
            if (!ed || ed.saving) {
                return;
            }
            ed.entries.push({ login: "", password: "" });
            this.focusWebEntry(ed.entries.length - 1);
        },

        focusWebEntry(index) {
            this.$nextTick(() => {
                const box = this.webEditBox();
                const input = box && box.querySelectorAll("input")[index * 2];
                if (input) {
                    input.focus({ preventScroll: true });
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            });
        },

        // Поля открытой правки: в карточке – ref, в ячейке – внутри строки таблицы
        // (компонент table-row, этап 52: её ref корню не виден)
        webEditBox() {
            const ref = this.$refs.webEditBox;
            return (Array.isArray(ref) ? ref[0] : ref) || document.querySelector(".data-table .secret-edit");
        },

        webEditLoginInput() {
            const box = this.webEditBox();
            return box ? box.querySelector("input") : null;
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
            // Пустые записи не в счёт; сравнение – с показанными (не показаны – их нет)
            const filled = function (list) {
                return list.map(function (e) { return { login: e.login.trim(), password: e.password }; }).filter(function (e) { return e.login || e.password; });
            };
            const entries = filled(ed.entries);
            const before = filled(this.webShownFor(row) ? this.webShown.entries : []);
            if (JSON.stringify(entries) === JSON.stringify(before)) {
                this.closeWebEdit();
                this.hideWebShown();
                return;
            }
            ed.saving = true;
            if (!entries.length && row.web_auth) {
                const question = printer ? "Удалить логин и пароль Web у «" + (row.name || "принтера") + "»?" : "Удалить пароли у «" + (row.hostname || "компьютера") + "»?";
                const yes = await this.confirmDialog(question, { okText: "Удалить", danger: true });
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
                // У ПК (этап 70) – и то, что было видно: записи успели изменить – 409, как у ячейки
                const first = entries[0] || { login: "", password: "" };
                const body = printer ? first : { entries: entries, before: before };
                const response = await apiFetch(this.webAuthUrl(row), {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (response.status === 409) {
                    if (this.webEdit === ed) {
                        this.closeWebEdit();
                    }
                    this.hideWebShown();
                    this.toastError(await this.errorText(response));
                    await this.loadTable();
                    return;
                }
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
                this.flashCell(this.rowKey(row), "web_auth");
                this.reloadCardHistory(row.id, printer);
            } catch (e) {
                ed.saving = false;
                this.toastError("Не удалось сохранить: " + (e.message || e));
            }
        }
    }
};
