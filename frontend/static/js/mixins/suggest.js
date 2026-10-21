// Подсказки при вводе (этап 17): выпадающий список значений под полем правки –
// ячейка таблицы, строка карточки, «Изменить поле…». Значения – из справочника
// и уже введённые в столбце, в порядке «Справочников», с числом ПК. Свой текст
// по-прежнему можно ввести: список только помогает.
//
// Список один на страницу (в body), поле правки остаётся своим – сохранение,
// Esc и уход фокуса работают как раньше. Поле передаёт в список:
//   openSuggest(el, col, onPick) – при начале правки;
//   onSuggestInput(text)         – на каждый ввод (фильтр по словам);
//   suggestKeydown(event)        – первым в своём keydown: ↑↓ выбирают,
//                                  Enter берёт выбранное (true – клавиша занята);
//   closeSuggest()               – при сохранении и отмене.

import { listPosStyle, matchesAllWords, placeList, scrollToItem, searchNorm, searchWords, searchWordsIn } from "../util.js";

// Высота строки списка (.loc-list .ll-item) – с запасом, для выбора «вниз или вверх»
const SUGGEST_ITEM_HEIGHT = 22;

export default {
    computed: {
        // Что показывать: пока не печатали – все значения, потом – по словам. По частям через
        // запятую (картриджи, этап 47) – по набираемой части, без уже вписанных
        suggestShown() {
            const s = this.suggest;
            if (!s) {
                return [];
            }
            let options = s.options;
            let query = s.query;
            if (s.tokens) {
                const parts = String(s.query).split(/[,;\n]/);
                query = parts.pop();
                const used = new Set(parts.map(function (part) { return part.trim().toLowerCase(); }).filter(Boolean));
                options = options.filter(function (o) { return !used.has(String(o.value).toLowerCase()); });
            } else if (!s.filtering) {
                return options;
            }
            if (!searchWords(query).length) {
                return options;
            }
            const texts = options.map(function (o) { return searchNorm(o.value); });
            const words = searchWordsIn(query, texts);
            return options.filter(function (o, i) {
                return matchesAllWords(texts[i], words);
            });
        },

        suggestListStyle() {
            return listPosStyle(this.suggest && this.suggest.pos);
        },
    },

    methods: {
        // rowId – ПК (принтер), чьё поле правится: значение сканера (этап 26б) – первым
        // вариантом; pcOnly – это ПК, а не строка таблицы на экране (карточка ПК, этап 47)
        openSuggest(el, col, onPick, rowId, pcOnly) {
            this.closeSuggest();
            if (!el || !col) {
                return;
            }
            // Принтер (этап 44): модель – из справочника, «Web» – есть / нет
            if (col.pick) {
                this.openSuggestList(el, col.field, this.pickOptions(col), onPick);
                return;
            }
            // Картриджи (этап 47): по частям через запятую, выбор не сохраняет – дописывает
            if (col.cartridges) {
                this.openTokenSuggest(el, col.field, this.cartridgeOptions());
                return;
            }
            const scan = rowId ? this.scanSuggestFor(rowId, col.field, pcOnly) : [];
            if (!col.suggest && !scan.length) {
                return;
            }
            // Журнал «IP» (этап 71): значения в ячейке строками – подсказки по строкам
            const values = col.suggest ? this.collectValues(col.field, !!col.ipCol, false) : [];
            const scanKeys = new Set(scan.map(function (o) { return o.value.toLowerCase(); }));
            const options = scan.concat(values.filter(function (o) { return !scanKeys.has(String(o.value).toLowerCase()); }));
            this.openSuggestList(el, col.field, options, onPick);
        },

        // Тот же список со своими вариантами [{ key, value, count }] (например, подсети,
        // которых нет в списке, – при добавлении подсети, этап 26д). tokens – значение
        // по частям через запятую (этап 47): список – к набираемой части
        openSuggestList(el, field, options, onPick, tokens) {
            this.closeSuggest();
            if (!el || !options.length) {
                return;
            }
            const current = tokens ? "" : String(el.value || "").trim().toLowerCase();
            this.suggest = {
                el: el,
                field: field,
                options: options,
                current: current,
                query: el.value || "",
                filtering: false,
                tokens: !!tokens,
                active: -1,
                pos: null,
                onPick: onPick
            };
            this._suggestMove = () => this.placeSuggest();
            window.addEventListener("scroll", this._suggestMove, true);
            window.addEventListener("resize", this._suggestMove);
            this.$nextTick(() => {
                this.placeSuggest();
                this.scrollSuggestTo(options.findIndex(function (o) { return o.key === current; }), true);
            });
        },

        closeSuggest() {
            if (this._suggestMove) {
                window.removeEventListener("scroll", this._suggestMove, true);
                window.removeEventListener("resize", this._suggestMove);
                this._suggestMove = null;
            }
            this.suggest = null;
        },

        onSuggestInput(text) {
            const s = this.suggest;
            if (!s) {
                return;
            }
            s.query = text;
            s.filtering = true;
            s.active = -1;
            this.$nextTick(() => this.placeSuggest());
        },

        // true – клавишу обработал список (полю её не отдавать)
        suggestKeydown(event) {
            const s = this.suggest;
            if (!s) {
                return false;
            }
            const list = this.suggestShown;
            const key = event.key;
            if ((key === "ArrowDown" || key === "ArrowUp") && list.length) {
                event.preventDefault();
                const n = list.length;
                if (s.active < 0) {
                    s.active = key === "ArrowDown" ? 0 : n - 1;
                } else {
                    s.active = (s.active + (key === "ArrowDown" ? 1 : -1) + n) % n;
                }
                this.$nextTick(() => this.scrollSuggestTo(s.active, false));
                return true;
            }
            if (key === "Enter" && !event.shiftKey && s.active >= 0 && list[s.active]) {
                event.preventDefault();
                event.stopPropagation();
                this.pickSuggest(list[s.active]);
                return true;
            }
            if (key === "Escape") {
                this.closeSuggest(); // саму правку отменяет поле
            }
            return false;
        },

        pickSuggest(option) {
            const s = this.suggest;
            if (!s) {
                return;
            }
            const onPick = s.onPick;
            this.closeSuggest();
            if (onPick) {
                // Сам вариант – вторым: у одинаковых подписей разное за ними (пользователь, этап 66)
                onPick(option.value, option);
            }
        },

        // Список под полем (или над ним, если снизу мало места); за краем окна не уходит.
        // Короткому списку хватает места по его высоте, а не по 200px (этап 61). В окне записи
        // журнала – шире 420px, если значение не влезает (правки 2 этапа 66: названия по 1С длинные)
        placeSuggest() {
            const s = this.suggest;
            if (!s || !s.el || !s.el.isConnected) {
                return;
            }
            const room = Math.min(200, this.suggestShown.length * SUGGEST_ITEM_HEIGHT + 8);
            s.pos = placeList(s.el, { width: 180, room: room, height: 300, maxWidth: s.el.closest(".mw, .mi") ? 0 : 420 });
        },

        scrollSuggestTo(index, center) {
            const list = this.$refs.suggestList;
            scrollToItem(list, list && index >= 0 ? list.children[index] : null, center);
        },

        // Значение в списке – в оформлении из Справочников (цвет, фон, Ж, К)
        suggestItemStyle(option) {
            const s = this.suggest;
            if (!s) {
                return null;
            }
            const choice = (this.choiceStyleMap[s.field] || {})[option.key] || null;
            const st = this.effectiveStyle(s.field, choice);
            return st.color || st.backgroundColor || st.fontWeight || st.fontStyle || st.textDecoration ? st : null;
        },
    }
};
