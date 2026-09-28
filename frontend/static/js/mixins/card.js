// Карточка ПК слева: открытие, правка двойным кликом, история.

import { UI_OPTIONS } from "../settings.js";
import { apiFetch } from "../util.js";
import { CARD_EDIT_EXTRA } from "../columns.js";

export default {
    computed: {
        cardRoom() {
            if (!this.card) {
                return "";
            }
            const code = this.card.room_code;
            const name = this.card.room_name;
            // Номер и название в одной строке — номер в скобках: «[214] Процедурная»
            return code && name ? "[" + code + "] " + name : (code || name || "");
        },

        // Строки карточки ПК: [{ key, label, value, copy }] или { group }
        cardRows() {
            const c = this.card;
            if (!c) {
                return [];
            }
            // field — столбец таблицы, чьё оформление из Справочников показывать
            function F(key, label, value, copy, field) {
                return { key: key, label: label, value: value, copy: !!copy, field: field === undefined ? key : field };
            }
            const status = [F("status", "Статус", c.status)];
            const place = [
                F("building", "Адрес", c.building, true),
                F("department", "Отделение", c.department, true),
                F("floor", "Этаж", c.floor),
                F("room", "Кабинет", this.cardRoom, true, null),
                F("seat_no", "№ Места", c.seat_no)
            ];
            if (!c.location_id) {
                // Без расположения — строка есть, чтобы его можно было задать
                place.unshift(F("location", "Расположение", "не указано", false, null));
            }
            const net = [F("ip", "IP адрес", c.ip, true), F("mac", "MAC адрес", c.mac, true)];
            const ids = [F("inv_no", "Инвентарный номер", c.inv_no, true), F("serial", "Серийный", c.serial, true)];
            const hw = [
                F("type", "Тип компьютера", c.type),
                F("model", "Модель", c.model, true),
                F("os", "Операционная система", c.os, true),
                F("cpu", "Процессор", c.cpu, true),
                F("ram", "Оперативная память", c.ram),
                F("drive", "Дисковые накопители", c.drive, true),
                F("gpu", "Видеокарта", c.gpu, true)
            ];
            const marks = [F("gsit", "GSIT", c.gsit), F("state", "Сост.", c.state), F("label", "Метка", c.label)];
            const custom = this.tableFieldDefs.map(function (fd) {
                return F("x-" + fd.key, fd.label, c[fd.key], false, fd.key);
            });
            const note = [F("note", "Примечание", c.note)];

            function filled(list) {
                return list.filter(function (r) {
                    return r.value !== null && r.value !== undefined && r.value !== "";
                });
            }

            if (!UI_OPTIONS.cardGroups) {
                return filled([].concat(status, place, net, ids, hw, marks, custom, note));
            }
            const groups = [
                [null, status],
                ["Размещение", place],
                ["Сеть", net],
                ["Оборудование", hw],
                ["Учёт", ids.concat(marks)],
                ["Прочее", custom.concat(note)]
            ];
            const result = [];
            groups.forEach(function (g) {
                const rows = filled(g[1]);
                if (!rows.length) {
                    return;
                }
                if (g[0]) {
                    result.push({ key: "g-" + g[0], group: g[0] });
                }
                result.push.apply(result, rows);
            });
            return result;
        },
    },

    methods: {
        // ---------- Правка в карточке (двойной клик по строке) ----------

        cardEditCol(r) {
            if (!r || r.group) {
                return null;
            }
            if (CARD_EDIT_EXTRA[r.key]) {
                return CARD_EDIT_EXTRA[r.key];
            }
            const field = r.key.indexOf("x-") === 0 ? r.key.slice(2) : r.key;
            const col = this.allColumns.find(function (c) { return c.field === field; });
            return col && col.editable ? col : null;
        },

        isCardEditable(r) {
            return this.canEdit && !!this.cardEditCol(r);
        },

        onCardRowDblclick(event, r) {
            // Двойной клик по самому значению — это два копирования, не правка
            if (event.target.closest(".copy-val")) {
                return;
            }
            if (!this.isCardEditable(r) || this.cardEditKey === r.key) {
                return;
            }
            const sel = window.getSelection && window.getSelection();
            if (sel) {
                sel.removeAllRanges();
            }
            this.cardEditKey = r.key;
            if (this.cardEditCol(r).location) {
                this.ensureTree();
                return;
            }
            const value = this.card[this.cardEditCol(r).field];
            this.cardEditValue = value === null || value === undefined ? "" : String(value);
            this.$nextTick(() => {
                const el = this.$refs.cardEditor;
                const input = Array.isArray(el) ? el[0] : el;
                if (!input) {
                    return;
                }
                this.growCardEditor(input);
                input.focus({ preventScroll: true });
                const len = input.value.length;
                input.setSelectionRange(len, len);
            });
        },

        growCardEditor(el) {
            const td = el.closest("td");
            if (!td) {
                return;
            }
            el.style.width = td.clientWidth + "px";
            el.style.height = td.clientHeight + "px";
            if (el.scrollHeight > el.clientHeight) {
                el.style.height = el.scrollHeight + 2 + "px";
            }
        },

        onCardEditKeydown(event, r) {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                this.saveCardEdit(r);
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation(); // Esc отменяет правку, а не закрывает карточку
                this.cardEditKey = null;
            }
        },

        saveCardEdit(r) {
            if (this.cardEditKey !== r.key || !this.card) {
                return;
            }
            const col = this.cardEditCol(r);
            this.cardEditKey = null;
            if (!col) {
                return;
            }
            const row = this.rows.find((item) => item.id === this.card.id) || this.card;
            const old = row[col.field] === null || row[col.field] === undefined ? "" : String(row[col.field]);
            if (this.cardEditValue === old) {
                return;
            }
            this.saveCellValue(row, col, this.cardEditValue);
        },

        isCardFlash(r) {
            const col = this.cardEditCol(r);
            return !!(this.card && col && this.savedFlash[this.card.id + ":" + col.field]);
        },

        // ---------- Карточка ----------

        async openCard(row) {
            this.card = row;
            this.setHoverRow(null); // подсветка остаётся на строке карточки
            this.cardHistoryOpen = false;
            this.cardEditKey = null;
            this.cardHostname = row.hostname || "";
            this.editingHostname = false;
            this.cardLoading = true;
            this.startLoading();
            this.cardError = "";
            this.cardPeople = [];
            this.cardVacuum = [];
            this.cardHistory = [];
            try {
                const response = await apiFetch("/api/computers/" + row.id);
                const data = await response.json();
                this.cardPeople = data.people || [];
                this.cardVacuum = data.vacuum || [];
                this.cardHistory = data.history || [];
            } catch (e) {
                this.cardError = String(e);
            }
            this.finishLoading();
            this.cardLoading = false;
        },
    }
};
