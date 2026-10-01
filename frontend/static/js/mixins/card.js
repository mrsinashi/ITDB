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
            const columns = {};
            this.builtinColumns.forEach(function (col) { columns[col.field] = col; });
            const custom = this.tableFieldDefs.map(function (fd) {
                return F("x-" + fd.key, fd.label, c[fd.key], false, fd.key);
            });
            const cardRoom = this.cardRoom;
            // Группы и порядок строк — из описания столбцов (сервер, CARD_GROUPS)
            const groupRows = this.cardGroups.map(function (g) {
                const rows = [];
                g.fields.forEach(function (field) {
                    const col = columns[field];
                    if (field === "user_fields") {
                        rows.push.apply(rows, custom);
                    } else if (field === "room_code") {
                        // Номер и название кабинета — одной строкой
                        const room = F("room", "Кабинет", cardRoom, col && col.cardCopy, null);
                        room.always = !!(col && col.cardAlways);
                        rows.push(room);
                    } else if (col) {
                        const r = F(field, col.cardLabel, c[field], col.cardCopy);
                        r.always = !!col.cardAlways;
                        r.date = !!col.date;
                        rows.push(r);
                    }
                });
                if (!c.location_id && g.fields.indexOf("building") !== -1) {
                    // Без расположения — строка есть, чтобы его можно было задать
                    rows.unshift(F("location", "Расположение", "не указано", false, null));
                }
                return [g.title, rows];
            });

            // Пустые поля — только основные (always) или если развёрнуто
            // кнопкой в шапке карточки; пустое показывается серым «—»
            const showEmpty = this.cardShowEmpty;
            // Сканер предлагает значение для пустого поля — строку показать (этап 26б)
            const scanFields = this.diffIndex.get(c.id) || {};
            const shownKinds = this.scanShownKinds;
            function filled(list) {
                return list.filter(function (r) {
                    const empty = r.value === null || r.value === undefined || r.value === "";
                    return !empty || r.always || showEmpty || (r.field && scanFields[r.field] && scanFields[r.field].kind !== "partial" && shownKinds.has(scanFields[r.field].kind));
                }).map(function (r) {
                    const empty = r.value === null || r.value === undefined || r.value === "";
                    return empty ? Object.assign({}, r, { empty: true, copy: false }) : r;
                });
            }

            if (!UI_OPTIONS.cardGroups) {
                return filled([].concat.apply([], groupRows.map(function (g) { return g[1]; })));
            }
            const groups = groupRows;
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
                const col = this.cardEditCol(r);
                if (col && !col.multiline) {
                    this.openSuggest(input, col, (value) => {
                        this.cardEditValue = value;
                        this.saveCardEdit(r);
                    }, this.card.id);
                }
            });
        },

        growCardEditor(el) {
            const td = el.closest("td");
            if (!td) {
                return;
            }
            // Ширина — ровно по ячейке: clientWidth округляется вверх, и на
            // дробном масштабе (125%) редактор вылезал на 1px — снизу
            // появлялась полоса прокрутки
            el.style.width = "100%";
            el.style.height = td.clientHeight + "px";
            if (el.scrollHeight > el.clientHeight) {
                el.style.height = el.scrollHeight + 2 + "px";
            }
        },

        onCardEditKeydown(event, r) {
            if (this.suggestKeydown(event)) {
                return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                this.saveCardEdit(r);
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation(); // Esc отменяет правку, а не закрывает карточку
                this.closeSuggest();
                this.cardEditKey = null;
            }
        },

        saveCardEdit(r) {
            if (this.cardEditKey !== r.key || !this.card) {
                return;
            }
            const col = this.cardEditCol(r);
            this.cardEditKey = null;
            this.closeSuggest();
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
            this.cardShowEmpty = false; // пустые поля всегда свёрнуты при открытии
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
