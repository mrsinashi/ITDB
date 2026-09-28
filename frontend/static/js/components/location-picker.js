// Выбор расположения ПК: поле поиска и список узлов дерева путями
// («ул. Ленина, 1 → Терапия → 201»). Слова ищутся в любом месте пути.
// editor — редактор поверх ячейки: открыт сразу, Esc и уход фокуса — отмена.
// Список выносится в body: таблица и карточка обрезают всё, что за краем.

import { searchWords } from "../util.js";

export default {
    props: {
        value: { default: null },
        options: { type: Array, default: function () { return []; } },
        editor: Boolean,
        placeholder: { type: String, default: "" },
        inputClass: { default: "" },
        emptyText: { type: String, default: "Загрузка дерева…" }
    },
    emits: ["pick", "cancel"],
    data() {
        return { open: false, query: "", active: 0, pos: null };
    },
    computed: {
        current() {
            const value = this.value;
            return this.options.find(function (o) { return o.id === value; }) || null;
        },
        filtered() {
            const words = searchWords(this.query);
            if (!words.length) {
                return this.options;
            }
            return this.options.filter(function (o) {
                return words.every(function (w) { return o.search.indexOf(w) !== -1; });
            });
        },
        shownText() {
            return this.open ? this.query : (this.current ? this.current.path : "");
        },
        listStyle() {
            const p = this.pos;
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
        }
    },
    watch: {
        query() {
            this.active = 0;
        },
        // Дерево догрузилось, пока список открыт, — встать на текущий узел
        options() {
            if (this.open && !this.query) {
                this.activateCurrent();
            }
        }
    },
    mounted() {
        this._onMove = () => this.place();
        window.addEventListener("scroll", this._onMove, true);
        window.addEventListener("resize", this._onMove);
        if (this.editor) {
            const input = this.$refs.input;
            const td = this.$el.closest("td");
            if (td) {
                input.style.width = Math.max(td.clientWidth, 260) + "px";
                input.style.height = td.clientHeight + "px";
            }
            input.focus({ preventScroll: true });
            this.show();
        }
    },
    beforeUnmount() {
        window.removeEventListener("scroll", this._onMove, true);
        window.removeEventListener("resize", this._onMove);
    },
    methods: {
        show() {
            if (this.open) {
                return;
            }
            this.open = true;
            this.query = "";
            this.activateCurrent();
            this.$nextTick(() => this.place());
        },
        hide() {
            this.open = false;
            this.query = "";
        },
        activateCurrent() {
            const value = this.value;
            const i = this.filtered.findIndex(function (o) { return o.id === value; });
            this.active = i >= 0 ? i : 0;
            this.$nextTick(() => this.scrollActive(true));
        },
        place() {
            if (!this.open || !this.$refs.input) {
                return;
            }
            const r = this.$refs.input.getBoundingClientRect();
            const minWidth = Math.max(Math.round(r.width), 420);
            const left = Math.max(4, Math.min(Math.round(r.left), window.innerWidth - minWidth - 4));
            const below = window.innerHeight - r.bottom;
            const up = below < 220 && r.top > below;
            this.pos = {
                up: up,
                left: left,
                top: Math.round(r.bottom),
                bottom: Math.round(window.innerHeight - r.top),
                minWidth: minWidth,
                maxWidth: window.innerWidth - left - 8,
                maxHeight: Math.min(360, Math.round((up ? r.top : below) - 8))
            };
        },
        scrollActive(center) {
            const list = this.$refs.list;
            const item = list && list.children[this.active];
            if (!item || !item.classList.contains("ll-item")) {
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
        onInput(event) {
            this.query = event.target.value;
            if (!this.open) {
                this.open = true;
                this.$nextTick(() => this.place());
            }
        },
        onFocus() {
            if (!this.editor) {
                this.show();
            }
        },
        onBlur() {
            if (this.editor) {
                this.$emit("cancel");
            } else {
                this.hide();
            }
        },
        onKeydown(event) {
            const key = event.key;
            if (key === "ArrowDown" || key === "ArrowUp") {
                event.preventDefault();
                if (!this.open) {
                    this.show();
                    return;
                }
                const n = this.filtered.length;
                if (n) {
                    this.active = (this.active + (key === "ArrowDown" ? 1 : -1) + n) % n;
                    this.$nextTick(() => this.scrollActive(false));
                }
            } else if (key === "Enter") {
                if (!this.open) {
                    return; // в форме Enter без открытого списка — дальше, к форме
                }
                event.preventDefault();
                event.stopPropagation();
                const option = this.filtered[this.active];
                if (option) {
                    this.pick(option);
                }
            } else if (key === "Escape") {
                if (this.editor) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.$emit("cancel");
                } else if (this.open) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.hide();
                }
            } else if (key === "Tab" && !this.editor) {
                this.hide();
            }
        },
        pick(option) {
            this.hide();
            this.$emit("pick", option.id);
        }
    },
    template: `
        <span class="loc-pick">
            <input ref="input" :class="inputClass" :value="shownText" autocomplete="off" spellcheck="false"
                :placeholder="open && current ? current.path : placeholder"
                :title="!open && current ? current.path : null"
                @input="onInput" @focus="onFocus" @blur="onBlur" @keydown="onKeydown" @click="show">
            <teleport to="body">
                <div v-if="open && pos" ref="list" class="loc-list" :class="{ up: pos.up }" :style="listStyle" @mousedown.prevent>
                    <div v-if="!options.length" class="ll-empty">{{ emptyText }}</div>
                    <div v-else-if="!filtered.length" class="ll-empty">Ничего не найдено</div>
                    <div v-for="(o, i) in filtered" :key="o.id" class="ll-item"
                        :class="['kind-' + o.kind, { active: i === active, current: o.id === value }]"
                        @mousemove="active = i" @click="pick(o)">{{ o.path }}</div>
                </div>
            </teleport>
        </span>
    `
};
