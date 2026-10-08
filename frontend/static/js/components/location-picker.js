// Выбор расположения ПК: поле поиска и список узлов дерева путями
// («ул. Ленина, 1 → Терапия → 201»). Слова ищутся в любом месте пути.
// editor — редактор поверх ячейки: открыт сразу, Esc и уход фокуса — отмена.
// Список выносится в body: таблица и карточка обрезают всё, что за краем.
// can-add-room — внизу списка «＋ новый кабинет» в найденном отделении или этаже
// (у отделения и этажа под курсором — тоже): событие add-room { parentId, code, name }.

import { searchWordsIn } from "../util.js";

const ROOM_PARENTS = ["department", "floor"];
// Сколько мест для нового кабинета предлагать
const ADD_MAX = 3;

function isRoomParent(o) {
    return ROOM_PARENTS.indexOf(o.kind) !== -1;
}

// Слова, которых нет в пути узла, — номер и название нового кабинета:
// первое слово с цифрой — номер, остальные — название (с прописной)
function roomFromTokens(tokens) {
    let code = "";
    const rest = [];
    tokens.forEach(function (t) {
        if (!code && /\d/.test(t)) {
            code = t;
        } else {
            rest.push(t);
        }
    });
    const name = rest.join(" ");
    return { code: code, name: name ? name.charAt(0).toUpperCase() + name.slice(1) : "" };
}

export default {
    props: {
        value: { default: null },
        options: { type: Array, default: function () { return []; } },
        editor: Boolean,
        placeholder: { type: String, default: "" },
        inputClass: { default: "" },
        emptyText: { type: String, default: "Загрузка дерева…" },
        canAddRoom: Boolean
    },
    emits: ["pick", "cancel", "add-room"],
    data() {
        return { open: false, query: "", active: 0, pos: null };
    },
    computed: {
        current() {
            const value = this.value;
            return this.options.find(function (o) { return o.id === value; }) || null;
        },
        // Слово, которого нет ни в одном пути, — в другой раскладке
        words() {
            return searchWordsIn(this.query, this.options.map(function (o) { return o.search; }));
        },
        filtered() {
            const words = this.words;
            if (!words.length) {
                return this.options;
            }
            return this.options.filter(function (o) {
                return words.every(function (w) { return o.search.indexOf(w) !== -1; });
            });
        },
        // Кабинета среди найденного нет — новый кабинет: в отделениях и этажах, где
        // нашлось больше всего слов поиска; остальные слова — номер и название.
        // Нигде не нашлось — один пункт без места (выбрать в строке нового кабинета)
        addItems() {
            const words = this.words;
            if (!this.canAddRoom || !words.length || this.filtered.some(function (o) { return o.kind === "room"; })) {
                return [];
            }
            const tokens = this.query.trim().split(/\s+/).filter(Boolean);
            let best = 0;
            const found = [];
            this.options.forEach(function (o) {
                if (!isRoomParent(o)) {
                    return;
                }
                const hits = words.filter(function (w) { return o.search.indexOf(w) !== -1; }).length;
                if (hits && hits >= best) {
                    if (hits > best) {
                        found.length = 0;
                        best = hits;
                    }
                    found.push(o);
                }
            });
            if (!found.length) {
                const room = roomFromTokens(tokens);
                return [{ add: true, key: "add", parent: null, code: room.code, name: room.name, label: [room.code, room.name].filter(Boolean).join(" ") }];
            }
            // Отделение с этажами — кабинет на этаж: отделение, у которого нашлись этажи, не предлагать
            const deepest = found.filter(function (o) {
                return !found.some(function (x) { return x !== o && x.path.indexOf(o.path + " → ") === 0; });
            });
            return deepest.slice(0, ADD_MAX).map(function (o) {
                const room = roomFromTokens(tokens.filter(function (t, i) { return o.search.indexOf(words[i]) === -1; }));
                return { add: true, key: "add-" + o.id, parent: o, code: room.code, name: room.name, label: [room.code, room.name].filter(Boolean).join(" ") };
            });
        },
        // Список целиком: найденные узлы, потом «＋ новый кабинет»
        items() {
            return this.addItems.length ? this.filtered.concat(this.addItems) : this.filtered;
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
            const i = this.items.findIndex(function (o) { return !o.add && o.id === value; });
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
            const item = list && list.querySelectorAll(".ll-item")[this.active];
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
                const n = this.items.length;
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
                const option = this.items[this.active];
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
            if (option.add) {
                this.addRoom(option.parent, option.code, option.name);
                return;
            }
            this.hide();
            this.$emit("pick", option.id);
        },
        // «＋ кабинет» у отделения или этажа под курсором: номер и название — из слов
        // поиска, которых нет в его пути
        addHere(option) {
            const words = this.words;
            const tokens = this.query.trim().split(/\s+/).filter(Boolean);
            const room = roomFromTokens(tokens.filter(function (t, i) { return option.search.indexOf(words[i]) === -1; }));
            this.addRoom(option, room.code, room.name);
        },
        addRoom(parent, code, name) {
            this.hide();
            this.$emit("add-room", { parentId: parent ? parent.id : null, code: code, name: name });
        },
        canAddHere(option) {
            return this.canAddRoom && isRoomParent(option);
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
                    <div v-else-if="!items.length" class="ll-empty">Ничего не найдено</div>
                    <template v-for="(o, i) in items" :key="o.add ? o.key : o.id">
                        <div v-if="o.add" class="ll-item ll-new" :class="{ active: i === active, 'll-first': i === filtered.length }"
                            title="Новый кабинет" @mousemove="active = i" @click="pick(o)"><template v-if="o.parent">{{ o.parent.path }} → </template><b>＋ {{ o.label || "новый кабинет" }}</b></div>
                        <div v-else class="ll-item"
                            :class="['kind-' + o.kind, { active: i === active, current: o.id === value }]"
                            @mousemove="active = i" @click="pick(o)"><span v-if="i === active && canAddHere(o)" class="ll-add" title="Новый кабинет здесь" @click.stop="addHere(o)">＋ кабинет</span>{{ o.path }}</div>
                    </template>
                </div>
            </teleport>
        </span>
    `
};
