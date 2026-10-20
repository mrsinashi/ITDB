// Карточка принтера (этап 44) – как карточка ПК: слева, правка двойным кликом, история (общее –
// в card.js); строки и группы – с сервера (printer_card_groups). Своё: ссылка Web (в таблице её нет),
// «Доступ» – логин и пароль Web (как в ячейке таблицы, mixins/web-access.js), ПК, к
// которым принтер подключён (ссылки, как в таблице; подключить – mixins/link-picker.js).

import { apiFetch } from "../util.js";
import { LOCATION_EDIT, roomText } from "../columns.js";
import { splitTokens } from "./cartridges.js";

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
            pcardNameEdit: null     // правка имени в шапке: { value }
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
                        r = { key: "web_auth", label: col ? col.cardLabel : "Доступ", value: p.web_auth, auth: true, always: true, field: null };
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
            return this.visibleHistory(this.pcardHistory);
        }
    },

    methods: {
        // ---------- Открыть / закрыть ----------

        async openPrinterCard(row) {
            this.closeCard();
            this.closePrinterPop();
            this.closeWebEdit();
            this.hideWebShown();
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
            // Пока ждали ответа, карточку закрыли или открыли заново – ответ уже не для неё (этап 51)
            const seq = this._pcardSeq = (this._pcardSeq || 0) + 1;
            const open = () => this._pcardSeq === seq && !!this.pcard && this.pcard.id === row.id;
            try {
                const response = await apiFetch("/api/printers/" + row.id);
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const history = (await response.json()).history || [];
                if (open()) {
                    this.pcardHistory = history;
                }
            } catch (e) {
                if (open()) {
                    this.pcardError = String(e.message || e);
                }
            }
            this.finishLoading();
            if (!this.pcard || open()) {
                this.pcardLoading = false;
            }
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
            // Логин и пароль, показанные в карточке, уходят вместе с ней
            if (this.webEdit && this.webEdit.where === "card") {
                this.closeWebEdit();
            }
            this.hideWebShown();
            this.pcard = null;
            this.pcardEditKey = null;
            this.pcardNameEdit = null;
            this.setHoverRow(null);
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
            return this.canEditPrinters && !!this.pcardEditCol(r);
        },

        pcardRowTitle(r) {
            if (r.fromModel) {
                return "Из справочника моделей";
            }
            if (r.auth) {
                return this.webAccessTitle(this.pcard);
            }
            return this.isPcardEditable(r) && this.pcardEditKey !== r.key ? "Двойной клик – изменить" : null;
        },

        onPcardRowDblclick(event, r) {
            if (event.target.closest(".copy-val, a, input, .secret-pen")) {
                return;
            }
            const td = event.currentTarget.querySelector("td.ct-value");
            // «Доступ» (этап 45): показать по паролю – окошком под строкой, задать, изменить
            if (r.auth) {
                if (td && !this.webEditIn(this.pcard, "card")) {
                    this.pcardEditKey = null;
                    this.openWebAccess(this.pcard, td, "card");
                }
                return;
            }
            const col = this.pcardEditCol(r);
            if (!this.canEditPrinters || !col || this.pcardEditKey === r.key) {
                return;
            }
            this.hideWebShown();
            // Компьютеры принтера – окошко с поиском и галочками (этап 45)
            if (col.links) {
                this.openLinkPick(this.pcard, col, td);
                return;
            }
            this.clearTextSelection();
            this.pcardEditKey = r.key;
            if (col.location) {
                this.ensureTree();
                return;
            }
            // Ссылка Web: пустая – правится предлагаемая по IP, а не пустое поле (этап 45)
            const value = r.key === "web_url" ? this.printerWebUrl(this.pcard) : this.pcard[col.field];
            this.pcardEditValue = value === null || value === undefined ? "" : String(value);
            // Картриджи (этап 47): в поле – через запятую
            if (col.cartridges) {
                this.pcardEditValue = splitTokens(this.pcardEditValue).join(", ");
            }
            this.focusCardEditor("pcardEditor", col.multiline && !col.cartridges ? null : (input) => {
                this.openSuggest(input, col, (value) => {
                    this.pcardEditValue = value;
                    this.savePcardEdit(r);
                });
            });
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
            const shown = r.key === "web_url" ? this.printerWebUrl(row) : row[col.field];
            const old = shown === null || shown === undefined ? "" : String(shown);
            // Картриджи (этап 47): в поле – через запятую, в таблице – строками
            const value = col.cartridges ? splitTokens(this.pcardEditValue).join("\n") : this.pcardEditValue;
            if (value === old) {
                return;
            }
            this.saveCellValue(row, col, value);
        },

        isPcardFlash(r) {
            const col = this.pcardEditCol(r);
            const field = r.auth ? "web_auth" : (col ? col.field : null);
            return !!(this.pcard && field && this.savedFlash["p" + this.pcard.id + ":" + field]);
        },

        // Имя – в шапке, как HOSTNAME у ПК
        startPcardName() {
            if (!this.canEditPrinters || !this.pcard) {
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
        }
    }
};
