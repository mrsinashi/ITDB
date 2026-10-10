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

import { matchesAllWords, searchNorm, searchWords, searchWordsIn } from "../util.js";

export default {
    computed: {
        // Что показывать: пока не печатали – все значения, потом – по словам
        suggestShown() {
            const s = this.suggest;
            if (!s) {
                return [];
            }
            if (!s.filtering || !searchWords(s.query).length) {
                return s.options;
            }
            const texts = s.options.map(function (o) { return searchNorm(o.value); });
            const words = searchWordsIn(s.query, texts);
            return s.options.filter(function (o, i) {
                return matchesAllWords(texts[i], words);
            });
        },

        suggestListStyle() {
            const p = this.suggest && this.suggest.pos;
            if (!p) {
                return null;
            }
            const style = {
                left: p.left + "px",
                minWidth: p.minWidth + "px",
                maxWidth: p.maxWidth + "px",
                maxHeight: p.maxHeight + "px"
            };
            if (p.up) {
                style.bottom = p.bottom + "px";
            } else {
                style.top = p.top + "px";
            }
            return style;
        },
    },

    methods: {
        // rowId – ПК, чьё поле правится: значение сканера (этап 26б) – первым вариантом
        openSuggest(el, col, onPick, rowId) {
            this.closeSuggest();
            if (!el || !col) {
                return;
            }
            // Принтер (этап 44): модель – из справочника, «Web» – есть / нет
            if (col.pick) {
                this.openSuggestList(el, col.field, this.pickOptions(col), onPick);
                return;
            }
            const scan = rowId ? this.scanSuggestFor(rowId, col.field) : [];
            if (!col.suggest && !scan.length) {
                return;
            }
            const values = col.suggest ? this.collectValues(col.field, false, false) : [];
            const scanKeys = new Set(scan.map(function (o) { return o.value.toLowerCase(); }));
            const options = scan.concat(values.filter(function (o) { return !scanKeys.has(String(o.value).toLowerCase()); }));
            this.openSuggestList(el, col.field, options, onPick);
        },

        // Тот же список со своими вариантами [{ key, value, count }] (например, подсети,
        // которых нет в списке, – при добавлении подсети, этап 26д)
        openSuggestList(el, field, options, onPick) {
            this.closeSuggest();
            if (!el || !options.length) {
                return;
            }
            const current = String(el.value || "").trim().toLowerCase();
            this.suggest = {
                el: el,
                field: field,
                options: options,
                current: current,
                query: el.value || "",
                filtering: false,
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
                onPick(option.value);
            }
        },

        // Список под полем (или над ним, если снизу мало места); за краем окна не уходит
        placeSuggest() {
            const s = this.suggest;
            if (!s || !s.el || !s.el.isConnected) {
                return;
            }
            const r = s.el.getBoundingClientRect();
            const minWidth = Math.max(Math.round(r.width), 180);
            const left = Math.max(4, Math.min(Math.round(r.left), window.innerWidth - minWidth - 4));
            const below = window.innerHeight - r.bottom;
            const up = below < 200 && r.top > below;
            s.pos = {
                up: up,
                left: left,
                top: Math.round(r.bottom),
                bottom: Math.round(window.innerHeight - r.top),
                minWidth: minWidth,
                maxWidth: Math.max(minWidth, Math.min(420, window.innerWidth - left - 8)),
                maxHeight: Math.min(300, Math.round((up ? r.top : below) - 8))
            };
        },

        scrollSuggestTo(index, center) {
            const list = this.$refs.suggestList;
            const item = list && index >= 0 ? list.children[index] : null;
            if (!item) {
                return;
            }
            if (center) {
                list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2;
            } else if (item.offsetTop < list.scrollTop) {
                list.scrollTop = item.offsetTop;
            } else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
                list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
            }
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
