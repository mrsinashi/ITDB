// Карточка ПК слева: открытие, правка двойным кликом, история. Здесь же – общее у карточек
// ПК и принтера (этап 50): редактор строки, Enter / Esc, кабинет, фон, история (признак printer).

import { UI_OPTIONS } from "../settings.js";
import { apiFetch } from "../util.js";
import { CARD_EDIT_EXTRA } from "../columns.js";

// Разделы карточки ПК под таблицей, которые правятся как её строки (этап 62): ФИО – поле, как
// в ячейке; VACUUM – логины строками. sec – редактор раздела, а не строки таблицы
const CARD_SECTIONS = {
    user: { key: "user", sec: true },
    vacuum: { key: "vacuum", sec: true }
};

export default {
    computed: {
        cardSec() {
            return CARD_SECTIONS;
        },

        cardRoom() {
            if (!this.card) {
                return "";
            }
            const code = this.card.room_code;
            const name = this.card.room_name;
            // Номер и название в одной строке – номер в скобках: «[214] Процедурная»
            return code && name ? "[" + code + "] " + name : (code || name || "");
        },

        // Строки карточки ПК: [{ key, label, value, copy }] или { group }
        cardRows() {
            const c = this.card;
            if (!c) {
                return [];
            }
            // field – столбец таблицы, чьё оформление из Справочников показывать
            function F(key, label, value, copy, field) {
                return { key: key, label: label, value: value, copy: !!copy, field: field === undefined ? key : field };
            }
            const columns = {};
            this.builtinColumns.forEach(function (col) { columns[col.field] = col; });
            const custom = this.tableFieldDefs.map(function (fd) {
                return F("x-" + fd.key, fd.label, c[fd.key], false, fd.key);
            });
            const cardRoom = this.cardRoom;
            // Группы и порядок строк – из описания столбцов (сервер, CARD_GROUPS)
            const groupRows = this.cardGroups.map(function (g) {
                const rows = [];
                g.fields.forEach(function (field) {
                    const col = columns[field];
                    if (field === "user_fields") {
                        rows.push.apply(rows, custom);
                    } else if (field === "room_code") {
                        // Номер и название кабинета – одной строкой
                        const room = F("room", "Кабинет", cardRoom, col && col.cardCopy, null);
                        room.always = !!(col && col.cardAlways);
                        rows.push(room);
                    } else if (col && col.secret) {
                        // «Доступ» (этап 69) – как у принтера: точки, показ по паролю
                        const auth = F(field, col.cardLabel, c[field], false, null);
                        auth.auth = true;
                        auth.always = true;
                        rows.push(auth);
                    } else if (col) {
                        const r = F(field, col.cardLabel, c[field], col.cardCopy);
                        r.always = !!col.cardAlways;
                        r.date = !!col.date;
                        rows.push(r);
                    }
                });
                if (!c.location_id && g.fields.indexOf("building") !== -1) {
                    // Без расположения – строка есть, чтобы его можно было задать
                    rows.unshift(F("location", "Расположение", "не указано", false, null));
                }
                return [g.title, rows];
            });

            // Пустые поля – только основные (always) или если развёрнуто
            // кнопкой в шапке карточки; пустое показывается серым «–»
            const showEmpty = this.cardShowEmpty;
            // Сканер предлагает значение для пустого поля – строку показать (этап 26б)
            const scanFields = this.pcDiffIndex.get(c.id) || {};
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
            // Столбцы ПК – и когда таблица показывает принтеры (этап 44)
            const col = this.pcColumnDefs.find(function (c) { return c.field === field; });
            return col && col.editable ? col : null;
        },

        isCardEditable(r) {
            return this.canEditPc && !!this.cardEditCol(r);
        },

        onCardRowDblclick(event, r) {
            // Двойной клик по самому значению – это два копирования, не правка (по ссылке на
            // принтер – два нажатия на неё)
            if (event.target.closest(".copy-val, a.obj-link, .obj-tbl")) {
                return;
            }
            // «Доступ» (этап 69, как у принтера): показать по паролю – окошком под строкой, задать,
            // изменить
            if (r.auth) {
                const td = event.currentTarget.querySelector("td.ct-value");
                if (td && !event.target.closest("input, .secret-pen") && !this.webEditIn(this.card, "card")) {
                    this.cardEditKey = null;
                    this.openWebAccess(this.card, td, "card");
                }
                return;
            }
            this.hideWebShown();
            if (!this.isCardEditable(r) || this.cardEditKey === r.key) {
                return;
            }
            // Принтеры ПК – окошко с поиском и галочками (этап 45)
            if (this.cardEditCol(r).links) {
                const row = this.rows.find((item) => item.id === this.card.id) || this.card;
                this.openLinkPick(row, this.cardEditCol(r), event.currentTarget.querySelector("td.ct-value"));
                return;
            }
            this.clearTextSelection();
            this.cardEditKey = r.key;
            const col = this.cardEditCol(r);
            if (col.location) {
                this.ensureTree();
                return;
            }
            const value = this.card[col.field];
            this.cardEditValue = value === null || value === undefined ? "" : String(value);
            this.focusCardEditor(r.sec ? "cardSecEditor" : "cardEditor", col.multiline ? null : (input) => {
                this.openSuggest(input, col, (value) => {
                    this.cardEditValue = value;
                    this.saveCardEdit(r);
                }, this.card.id, true);
            });
        },

        // ---------- Общее у карточек ПК и принтера (printer – карточка принтера) ----------

        // Редактор строки карточки: по высоте ячейки, фокус, курсор в конец;
        // suggest(input) – открыть подсказки
        focusCardEditor(refName, suggest) {
            this.$nextTick(() => {
                const el = this.$refs[refName];
                const input = Array.isArray(el) ? el[0] : el;
                if (!input) {
                    return;
                }
                this.growCardEditor(input);
                input.focus({ preventScroll: true });
                const len = input.value.length;
                input.setSelectionRange(len, len);
                if (suggest) {
                    suggest(input);
                }
            });
        },

        growCardEditor(el) {
            const td = el.closest("td");
            // Раздел «Пользователи» / «VACUUM» (этап 62): редактор выше на 4px – текст в нём там же,
            // где текст раздела
            const sec = td ? null : el.closest(".card-sec-body");
            if (!td && !sec) {
                return;
            }
            // Ширина – ровно по ячейке: clientWidth округляется вверх, и на
            // дробном масштабе (125%) редактор вылезал на 1px – снизу
            // появлялась полоса прокрутки
            el.style.width = "100%";
            el.style.height = (td ? td.clientHeight : sec.clientHeight + 4) + "px";
            if (el.scrollHeight > el.clientHeight) {
                el.style.height = el.scrollHeight + 2 + "px";
            }
        },

        onCardEditKeydown(event, r, printer) {
            if (this.suggestKeydown(event)) {
                return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (printer) {
                    this.savePcardEdit(r);
                } else {
                    this.saveCardEdit(r);
                }
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation(); // Esc отменяет правку, а не закрывает карточку
                this.closeSuggest();
                if (printer) {
                    this.pcardEditKey = null;
                } else {
                    this.cardEditKey = null;
                }
            }
        },

        onCardLocationPick(locationId, printer) {
            if (printer) {
                this.pcardEditKey = null;
                if (this.pcard) {
                    this.saveLocation(this.pcard, locationId);
                }
                return;
            }
            this.cardEditKey = null;
            if (!this.card) {
                return;
            }
            const row = this.rows.find((item) => item.id === this.card.id) || this.card;
            this.saveLocation(row, locationId);
        },

        // Второй щелчок двойного клика по HOSTNAME (имени принтера) приходится уже на фон
        // открывшейся карточки – он не должен её закрывать
        onCardOverlayClick(event, printer) {
            if (event.detail > 1) {
                return;
            }
            if (printer) {
                this.closePrinterCard();
            } else {
                this.closeCard();
            }
        },

        // История карточки: отменённые целиком записи – только с глазом
        visibleHistory(list) {
            if (this.historyShowCancelled) {
                return list;
            }
            return list.filter(function (item) { return !item.cancelled; });
        },

        // Открыта карточка этого ПК (принтера) – перечитать её историю после правки, у ПК – и
        // разделы «Пользователи» и «VACUUM» (их правят и в карточке, и в таблице, этап 62)
        async reloadCardHistory(id, printer) {
            const open = () => {
                const card = printer ? this.pcard : this.card;
                return !!card && card.id === id;
            };
            if (!open()) {
                return;
            }
            try {
                const response = await apiFetch((printer ? "/api/printers/" : "/api/computers/") + id);
                if (!response.ok || !open()) {
                    return;
                }
                const data = await response.json();
                const history = data.history || [];
                if (printer) {
                    this.pcardHistory = history;
                } else {
                    this.cardHistory = history;
                    this.cardPeople = data.people || [];
                    this.cardVacuum = data.vacuum || [];
                }
            } catch (e) {
                // не страшно: история обновится при следующем открытии
            }
        },

        // После перечитывания таблицы (принтеров) карточка показывает новую строку
        refreshCardRow(printer) {
            const card = printer ? this.pcard : this.card;
            if (!card) {
                return;
            }
            const row = (printer ? this.printerRows : this.rows).find((item) => item.id === card.id);
            if (!row) {
                return;
            }
            if (printer) {
                this.pcard = row;
            } else {
                this.card = row;
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
            // Показанные логин и пароль принтера (этап 45) – прячутся
            this.closeWebEdit();
            this.hideWebShown();
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
            // Пока ждали ответа, карточку закрыли или открыли заново – ответ уже не для неё (этап 51)
            const seq = this._cardSeq = (this._cardSeq || 0) + 1;
            const open = () => this._cardSeq === seq && !!this.card && this.card.id === row.id;
            try {
                const response = await apiFetch("/api/computers/" + row.id);
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                if (open()) {
                    this.cardPeople = data.people || [];
                    this.cardVacuum = data.vacuum || [];
                    this.cardHistory = data.history || [];
                }
            } catch (e) {
                if (open()) {
                    this.cardError = String(e.message || e);
                }
            }
            this.finishLoading();
            if (!this.card || open()) {
                this.cardLoading = false;
            }
        },
    }
};
