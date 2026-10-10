// Карточка принтера (этап 44) – как карточка ПК: слева, правка двойным кликом, история;
// строки и группы – с сервера (printer_card_groups). Своё: ссылка Web (в таблице её нет),
// логин и пароль Web, ПК, к которым принтер подключён (ссылки, как в таблице).
//
// Логин и пароль Web – окно посередине: показать – по логину и паролю администратора
// ITDB (кто бы ни смотрел), задать – редактор и администратор.

import { apiFetch } from "../util.js";
import { LOCATION_EDIT, roomText } from "../columns.js";

// Ссылка Web – не столбец таблицы: правится только в карточке
const WEB_URL_COL = { field: "web_url", headerName: "Ссылка Web", editable: true };

export default {
    data() {
        return {
            pcard: null,            // строка принтера в карточке
            pcardLoading: false,
            pcardError: "",
            pcardHistory: [],
            pcardHistoryOpen: false,
            pcardShowEmpty: false,
            pcardEditKey: null,
            pcardEditValue: "",
            pcardNameEdit: null,    // правка имени в шапке: { value }
            webAuth: null           // окно «Логин и пароль Web»
        };
    },

    computed: {
        // Строки карточки принтера: [{ key, label, value, copy, always }] или { group }
        pcardRows() {
            const p = this.pcard;
            if (!p) {
                return [];
            }
            const cols = {};
            this.printerColumns.forEach(function (col) { cols[col.field] = col; });
            const showEmpty = this.pcardShowEmpty;
            const result = [];
            this.printerCardGroups.forEach((g) => {
                const rows = [];
                g.fields.forEach((field) => {
                    const col = cols[field];
                    let r;
                    if (field === "room_code") {
                        r = { key: "room", label: "Кабинет", value: roomText(p), copy: true, always: true, field: null };
                    } else if (field === "web_url") {
                        // Ссылка – только когда страница есть (или не указано)
                        if (p.web === "нет") {
                            return;
                        }
                        r = { key: "web_url", label: "Ссылка", value: this.printerWebUrl(p), link: true, own: !!p.web_url, always: false, field: null };
                    } else if (field === "web_auth") {
                        r = { key: "web_auth", label: "Логин и пароль", value: p.web_auth, auth: true, always: true, field: null };
                    } else if (col) {
                        r = { key: field, label: col.cardLabel, value: p[field], copy: !!col.cardCopy, always: !!col.cardAlways, field: field, links: col.links, fromModel: ["kind", "maker", "color", "duplex"].indexOf(field) !== -1 };
                    } else {
                        return;
                    }
                    const empty = r.value === null || r.value === undefined || r.value === "";
                    if (empty && !r.always && !showEmpty) {
                        return;
                    }
                    rows.push(Object.assign(r, { empty: empty }));
                });
                if (rows.length) {
                    result.push({ key: "g-" + g.title, group: g.title });
                    result.push.apply(result, rows);
                }
            });
            return result;
        },

        pcardHistoryShown() {
            if (this.historyShowCancelled) {
                return this.pcardHistory;
            }
            return this.pcardHistory.filter(function (item) { return !item.cancelled; });
        }
    },

    methods: {
        // ---------- Открыть / закрыть ----------

        async openPrinterCard(row) {
            this.closeCard();
            this.closePrinterPop();
            this.pcard = row;
            this.setHoverRow(null);
            this.pcardHistoryOpen = false;
            this.pcardShowEmpty = false;
            this.pcardEditKey = null;
            this.pcardNameEdit = null;
            this.pcardHistory = [];
            this.pcardError = "";
            this.pcardLoading = true;
            this.startLoading();
            try {
                const response = await apiFetch("/api/printers/" + row.id);
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.pcardHistory = (await response.json()).history || [];
            } catch (e) {
                this.pcardError = String(e.message || e);
            }
            this.finishLoading();
            this.pcardLoading = false;
        },

        openPrinterCardById(id) {
            const row = this.printerRows.find(function (r) { return r.id === id; });
            if (row) {
                this.openPrinterCard(row);
            } else {
                this.toast("Этого принтера нет в таблице");
            }
        },

        closePrinterCard() {
            if (!this.pcard) {
                return;
            }
            this.pcard = null;
            this.pcardEditKey = null;
            this.pcardNameEdit = null;
            this.setHoverRow(null);
        },

        onPrinterCardOverlayClick(event) {
            if (event.detail > 1) {
                return;
            }
            this.closePrinterCard();
        },

        // После перечитывания принтеров карточка показывает новую строку
        refreshPrinterCard() {
            if (!this.pcard) {
                return;
            }
            const id = this.pcard.id;
            const row = this.printerRows.find(function (r) { return r.id === id; });
            if (row) {
                this.pcard = row;
            }
        },

        async reloadPrinterCardHistory(id) {
            if (!this.pcard || this.pcard.id !== id) {
                return;
            }
            try {
                const response = await apiFetch("/api/printers/" + id);
                if (response.ok && this.pcard && this.pcard.id === id) {
                    this.pcardHistory = (await response.json()).history || [];
                }
            } catch (e) {
                // история обновится при следующем открытии
            }
        },

        togglePrinterCardHistory() {
            this.pcardHistoryOpen = !this.pcardHistoryOpen;
        },

        // ---------- Правка в карточке ----------

        pcardEditCol(r) {
            if (!r || r.group || r.auth || r.fromModel) {
                return null;
            }
            if (r.key === "building" || r.key === "department" || r.key === "floor" || r.key === "room") {
                return LOCATION_EDIT;
            }
            if (r.key === "web_url") {
                return WEB_URL_COL;
            }
            const col = this.printerColumns.find(function (c) { return c.field === r.key; });
            return col && col.editable ? col : null;
        },

        isPcardEditable(r) {
            return this.canEdit && !!this.pcardEditCol(r);
        },

        pcardRowTitle(r) {
            if (r.fromModel) {
                return "Из справочника моделей";
            }
            return this.isPcardEditable(r) && this.pcardEditKey !== r.key ? "Двойной клик – изменить" : null;
        },

        onPcardRowDblclick(event, r) {
            if (event.target.closest(".copy-val, a")) {
                return;
            }
            const col = this.pcardEditCol(r);
            if (!this.canEdit || !col || this.pcardEditKey === r.key) {
                return;
            }
            const sel = window.getSelection && window.getSelection();
            if (sel) {
                sel.removeAllRanges();
            }
            this.pcardEditKey = r.key;
            if (col.location) {
                this.ensureTree();
                return;
            }
            const value = this.pcard[col.field];
            this.pcardEditValue = value === null || value === undefined ? "" : String(value);
            this.$nextTick(() => {
                const el = this.$refs.pcardEditor;
                const input = Array.isArray(el) ? el[0] : el;
                if (!input) {
                    return;
                }
                this.growCardEditor(input);
                input.focus({ preventScroll: true });
                const len = input.value.length;
                input.setSelectionRange(len, len);
                if (!col.multiline) {
                    this.openSuggest(input, col, (value) => {
                        this.pcardEditValue = value;
                        this.savePcardEdit(r);
                    });
                }
            });
        },

        onPcardEditKeydown(event, r) {
            if (this.suggestKeydown(event)) {
                return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                this.savePcardEdit(r);
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                this.closeSuggest();
                this.pcardEditKey = null;
            }
        },

        savePcardEdit(r) {
            if (this.pcardEditKey !== r.key || !this.pcard) {
                return;
            }
            const col = this.pcardEditCol(r);
            this.pcardEditKey = null;
            this.closeSuggest();
            if (!col) {
                return;
            }
            const row = this.pcard;
            const old = row[col.field] === null || row[col.field] === undefined ? "" : String(row[col.field]);
            if (this.pcardEditValue === old) {
                return;
            }
            this.saveCellValue(row, col, this.pcardEditValue);
        },

        onPcardLocationPick(locationId) {
            this.pcardEditKey = null;
            if (this.pcard) {
                this.saveLocation(this.pcard, locationId);
            }
        },

        isPcardFlash(r) {
            const col = this.pcardEditCol(r);
            return !!(this.pcard && col && this.savedFlash["p" + this.pcard.id + ":" + col.field]);
        },

        // Имя – в шапке, как HOSTNAME у ПК
        startPcardName() {
            if (!this.canEdit || !this.pcard) {
                return;
            }
            this.pcardNameEdit = { value: this.pcard.name || "" };
            this.$nextTick(() => {
                const input = this.$refs.pcardNameInput;
                if (input) {
                    input.focus();
                    input.select();
                }
            });
        },

        async savePcardName() {
            const edit = this.pcardNameEdit;
            if (!edit || !this.pcard) {
                return;
            }
            this.pcardNameEdit = null;
            if (edit.value.trim() === (this.pcard.name || "")) {
                return;
            }
            const col = this.printerColumns.find(function (c) { return c.field === "name"; });
            await this.saveCellValue(this.pcard, col, edit.value);
        },

        cancelPcardName() {
            this.pcardNameEdit = null;
        },

        // ---------- Логин и пароль Web ----------

        // mode: check – спросить пароль администратора и показать; edit – задать новые
        openWebAuth(row, mode) {
            this.closePrinterPop();
            this.webAuth = {
                row: row,
                mode: mode || (row.web_auth ? "check" : "edit"),
                login: "",          // администратор ITDB
                password: "",
                shown: null,        // { login, password } – показанные
                newLogin: "",
                newPassword: "",
                show: false,        // глаз: пароль виден
                error: "",
                busy: false
            };
            this.$nextTick(() => {
                const el = this.$refs[this.webAuth.mode === "check" ? "waLogin" : "waNewLogin"];
                if (el) {
                    el.focus();
                }
            });
        },

        closeWebAuth() {
            this.webAuth = null;
        },

        async showWebAuth() {
            const wa = this.webAuth;
            if (!wa || wa.busy) {
                return;
            }
            if (!wa.login.trim() || !wa.password) {
                wa.error = "Нужны логин и пароль администратора.";
                return;
            }
            wa.busy = true;
            wa.error = "";
            try {
                const response = await apiFetch("/api/printers/" + wa.row.id + "/web-auth/show", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ login: wa.login, password: wa.password })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                wa.shown = await response.json();
                wa.mode = "show";
                wa.password = "";
            } catch (e) {
                wa.error = String(e.message || e);
                wa.password = "";
            }
            wa.busy = false;
        },

        // Изменить: показанные значения – в поля (пустое поле – не менять)
        editWebAuth() {
            const wa = this.webAuth;
            if (!wa) {
                return;
            }
            wa.newLogin = wa.shown ? wa.shown.login || "" : "";
            wa.newPassword = wa.shown ? wa.shown.password || "" : "";
            wa.mode = "edit";
            wa.error = "";
            this.$nextTick(() => {
                if (this.$refs.waNewLogin) {
                    this.$refs.waNewLogin.focus();
                }
            });
        },

        // clear – удалить оба; иначе пустое поле не меняется (кроме показанного и стёртого)
        async saveWebAuth(clear) {
            const wa = this.webAuth;
            if (!wa || wa.busy) {
                return;
            }
            const body = {};
            if (clear) {
                body.login = "";
                body.password = "";
            } else {
                if (wa.newLogin.trim() || (wa.shown && wa.shown.login)) {
                    body.login = wa.newLogin;
                }
                if (wa.newPassword || (wa.shown && wa.shown.password)) {
                    body.password = wa.newPassword;
                }
                if (!Object.keys(body).length) {
                    wa.error = "Введи логин или пароль.";
                    return;
                }
            }
            if (clear && !(await this.confirmDialog("Удалить логин и пароль Web у «" + (wa.row.name || "принтера") + "»?", { okText: "Удалить", danger: true }))) {
                return;
            }
            wa.busy = true;
            wa.error = "";
            try {
                const response = await apiFetch("/api/printers/" + wa.row.id + "/web-auth", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                const row = this.printerRows.find(function (r) { return r.id === wa.row.id; });
                if (row && data.updated) {
                    row.web_auth = data.updated.web_auth;
                    row.version = data.updated.version;
                }
                this.flashCell("p" + wa.row.id, "web_auth");
                this.reloadPrinterCardHistory(wa.row.id);
                this.webAuth = null;
                this.toast(clear ? "Логин и пароль Web удалены" : "Логин и пароль Web сохранены", "success");
            } catch (e) {
                wa.error = String(e.message || e);
            }
            if (this.webAuth) {
                wa.busy = false;
            }
        },

        onWebAuthKeydown(event) {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                this.closeWebAuth();
            } else if (event.key === "Enter" && event.target.tagName === "INPUT") {
                event.preventDefault();
                if (this.webAuth.mode === "check") {
                    this.showWebAuth();
                } else if (this.webAuth.mode === "edit") {
                    this.saveWebAuth(false);
                }
            }
        }
    }
};
