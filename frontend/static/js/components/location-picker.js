// Выбор расположения ПК: поле поиска и список узлов дерева путями
// («ул. Ленина, 1 → Терапия → 201»). Слова ищутся в любом месте пути.
// editor – редактор поверх ячейки: открыт сразу, Esc и уход фокуса – отмена.
// Список выносится в body: таблица и карточка обрезают всё, что за краем.
// can-add-room – внизу списка «＋ новый кабинет» в найденном отделении или этаже
// (у отделения и этажа под курсором – тоже; у кабинета – новый после него, этап 37):
// событие add-room { parentId, afterId, code, name }.
// add-text – последним пунктом всегда «＋ <add-text>» (этап 43: «новый компьютер» в
// «Привязать … к:»; виден и при длинном списке – прилипает к низу): событие add с
// набранным текстом.
// move-room – кабинет ПК или принтера при правке ячейки «Кабинет» (этап 58, схема пользователя
// 14.10: { label, code, name, what }): у отделения или этажа под курсором, если в отделении
// такого кабинета нет, – кнопка «＋ <кабинет>» (клик по строке – как всегда, просто в отделение).
// Кнопка – окошко «Что перенести?» (только ПК / весь кабинет), у всего кабинета – «Удалить
// старый кабинет?»: событие move-room { parentId, whole, keepOld }.
// quiet – список не открывается на фокусе, только по клику, вводу или ↓ (окно записи журнала,
// правки этапа 66); fit – список шириной ровно с поле.

import { listPosStyle, placeList, scrollToItem, searchWordsIn } from "../util.js";

const ROOM_PARENTS = ["department", "floor"];
// Сколько мест для нового кабинета предлагать
const ADD_MAX = 3;

function isRoomParent(o) {
    return ROOM_PARENTS.indexOf(o.kind) !== -1;
}

// Тот же кабинет – как повтор на сервере (check_duplicate): с номером – по номеру, без – по названию
function sameRoom(o, room) {
    return o.kind === "room" && (room.code ? o.code === room.code : o.name === room.name);
}

// Слова, которых нет в пути узла, – номер и название нового кабинета:
// первое слово с цифрой – номер, остальные – название (с прописной)
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
        canAddRoom: Boolean,
        addText: { type: String, default: "" },
        moveRoom: { type: Object, default: null },
        quiet: Boolean,
        fit: Boolean
    },
    emits: ["pick", "cancel", "add-room", "add", "move-room"],
    data() {
        // ask – окошко переноса кабинета: { id (отделение или этаж), step: 1 – что, 2 – старый кабинет }
        return { open: false, query: "", active: 0, pos: null, ask: null };
    },
    computed: {
        current() {
            const value = this.value;
            return this.options.find(function (o) { return o.id === value; }) || null;
        },
        // Слово, которого нет ни в одном пути, – в другой раскладке
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
        // Кабинета среди найденного нет – новый кабинет: в отделениях и этажах, где
        // нашлось больше всего слов поиска; остальные слова – номер и название.
        // Нигде не нашлось – один пункт без места (выбрать в строке нового кабинета)
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
            // Отделение с этажами – кабинет на этаж: отделение, у которого нашлись этажи, не предлагать
            const deepest = found.filter(function (o) {
                return !found.some(function (x) { return x !== o && x.path.indexOf(o.path + " → ") === 0; });
            });
            return deepest.slice(0, ADD_MAX).map(function (o) {
                const room = roomFromTokens(tokens.filter(function (t, i) { return o.search.indexOf(words[i]) === -1; }));
                return { add: true, key: "add-" + o.id, parent: o, code: room.code, name: room.name, label: [room.code, room.name].filter(Boolean).join(" ") };
            });
        },
        // Список целиком: найденные узлы, потом «＋ новый кабинет» / «＋ <add-text>»
        items() {
            const items = this.addItems.length ? this.filtered.concat(this.addItems) : this.filtered;
            return this.addText ? items.concat([{ addNew: true, key: "add-new" }]) : items;
        },
        shownText() {
            return this.open ? this.query : (this.current ? this.current.path : "");
        },
        listStyle() {
            return listPosStyle(this.pos);
        }
    },
    watch: {
        query() {
            this.active = 0;
            this.ask = null;
        },
        // Дерево догрузилось, пока список открыт, – встать на текущий узел
        options() {
            if (this.open && !this.query) {
                this.activateCurrent();
            }
        }
    },
    mounted() {
        // Прокрутка уводит кнопку из-под окошка переноса – окошко закрывается
        this._onMove = () => {
            this.ask = null;
            this.place();
        };
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
            this.ask = null;
        },
        activateCurrent() {
            const value = this.value;
            const i = this.items.findIndex(function (o) { return !o.add && !o.addNew && o.id === value; });
            this.active = i >= 0 ? i : 0;
            this.$nextTick(() => this.scrollActive(true));
        },
        place() {
            if (!this.open || !this.$refs.input) {
                return;
            }
            this.pos = placeList(this.$refs.input, this.fit ? { width: 0, maxWidth: 1, room: 220, height: 360 } : { width: 420, room: 220, height: 360 });
        },
        scrollActive(center) {
            const list = this.$refs.list;
            scrollToItem(list, list && list.querySelectorAll(".ll-item")[this.active], center);
        },
        onInput(event) {
            this.query = event.target.value;
            if (!this.open) {
                this.open = true;
                this.$nextTick(() => this.place());
            }
        },
        onFocus() {
            if (!this.editor && !this.quiet) {
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
            // Окошко переноса: Esc закрывает только его, Enter строку не выбирает
            if (this.ask && (key === "Escape" || key === "Enter")) {
                event.preventDefault();
                event.stopPropagation();
                if (key === "Escape") {
                    this.ask = null;
                }
                return;
            }
            if (key === "ArrowDown" || key === "ArrowUp" || key === "Tab") {
                this.ask = null;
            }
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
                    return; // в форме Enter без открытого списка – дальше, к форме
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
            if (option.addNew) {
                const text = this.query.trim();
                this.hide();
                this.$emit("add", text);
                return;
            }
            this.hide();
            this.$emit("pick", option.id);
        },
        // «＋ кабинет» у отделения или этажа под курсором – кабинет в нём, у кабинета –
        // рядом, сразу после него; номер и название – из слов поиска, которых нет в пути
        addHere(option) {
            const words = this.words;
            const tokens = this.query.trim().split(/\s+/).filter(Boolean);
            const room = roomFromTokens(tokens.filter(function (t, i) { return option.search.indexOf(words[i]) === -1; }));
            if (option.kind === "room") {
                this.hide();
                this.$emit("add-room", { parentId: option.parentId, afterId: option.id, code: room.code, name: room.name });
                return;
            }
            this.addRoom(option, room.code, room.name);
        },
        addRoom(parent, code, name) {
            this.hide();
            this.$emit("add-room", { parentId: parent ? parent.id : null, code: code, name: name });
        },
        canAddHere(option) {
            return this.canAddRoom && (isRoomParent(option) || (option.kind === "room" && !!option.parentId));
        },
        // «＋ <кабинет>» – у отделения или этажа, если во всём отделении (на всех этажах) такого
        // кабинета нет; у текущего отделения он есть – там кнопки нет
        canMoveHere(option) {
            const room = this.moveRoom;
            if (!room || !isRoomParent(option) || !option.dept) {
                return false;
            }
            return !this.options.some(function (o) { return o.dept === option.dept && sameRoom(o, room); });
        },
        askMove(option, event) {
            if (this.ask && this.ask.id === option.id) {
                this.ask = null;
                return;
            }
            this._askRow = event.currentTarget.closest(".ll-item");
            this.ask = { id: option.id, step: 1, left: 0, top: 0, placed: false };
            this.$nextTick(() => this.placeAsk());
        },
        // Справа от списка по высоте строки с кнопкой; справа не помещается – слева
        placeAsk() {
            const box = this.$refs.ask;
            const list = this.$refs.list;
            const row = this._askRow;
            if (!this.ask || !box || !list || !row || !row.isConnected) {
                return;
            }
            const l = list.getBoundingClientRect();
            const r = row.getBoundingClientRect();
            const w = box.offsetWidth;
            let left = l.right + 4;
            if (left + w > window.innerWidth - 4) {
                left = Math.max(4, l.left - w - 4);
            }
            this.ask.left = Math.round(left);
            this.ask.top = Math.round(Math.max(4, Math.min(r.top - 4, window.innerHeight - box.offsetHeight - 4)));
            this.ask.placed = true;
        },
        // whole – весь кабинет: сначала вопрос о старом (keepOld ещё не задан)
        moveAnswer(whole, keepOld) {
            const ask = this.ask;
            if (!ask) {
                return;
            }
            if (whole && keepOld === undefined) {
                ask.step = 2;
                this.$nextTick(() => this.placeAsk());
                return;
            }
            this.hide();
            this.$emit("move-room", { parentId: ask.id, whole: whole, keepOld: !!keepOld });
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
                    <div v-if="!options.length && !addText" class="ll-empty">{{ emptyText }}</div>
                    <div v-else-if="!filtered.length && !addItems.length" class="ll-empty">{{ options.length ? "Ничего не найдено" : emptyText }}</div>
                    <template v-for="(o, i) in items" :key="o.add || o.addNew ? o.key : o.id">
                        <div v-if="o.add" class="ll-item ll-new" :class="{ active: i === active, 'll-first': i === filtered.length }"
                            title="Новый кабинет" @mousemove="active = i" @click="pick(o)"><template v-if="o.parent">{{ o.parent.path }} → </template><b>＋ {{ o.label || "новый кабинет" }}</b></div>
                        <div v-else-if="o.addNew" class="ll-item ll-new ll-sticky" :class="{ active: i === active, 'll-first': i === filtered.length }"
                            @mousemove="active = i" @click="pick(o)"><b>＋ {{ addText }}</b></div>
                        <div v-else class="ll-item"
                            :class="['kind-' + o.kind, { active: i === active, current: o.id === value }]"
                            @mousemove="active = i" @click="pick(o)"><span v-if="i === active && canAddHere(o)" class="ll-add" :title="o.kind === 'room' ? 'Новый кабинет после этого' : 'Новый кабинет здесь'" @click.stop="addHere(o)">＋ кабинет</span><span
                                v-else-if="(i === active || (ask && ask.id === o.id)) && canMoveHere(o)" class="ll-add" :class="{ open: ask && ask.id === o.id }"
                                title="Перенести сюда" @click.stop="askMove(o, $event)">＋ {{ moveRoom.label }}</span>{{ o.path }}</div>
                    </template>
                </div>
                <div v-if="open && pos && ask" ref="ask" class="loc-ask" :class="{ placed: ask.placed }" :style="{ left: ask.left + 'px', top: ask.top + 'px' }" @mousedown.prevent>
                    <div class="la-q">{{ ask.step === 1 ? "Что перенести?" : "Удалить старый кабинет?" }}</div>
                    <div v-if="ask.step === 1" class="la-btns">
                        <button type="button" class="btn" @click="moveAnswer(false)">Только {{ moveRoom.what }}</button>
                        <button type="button" class="btn" @click="moveAnswer(true)">Весь кабинет</button>
                    </div>
                    <div v-else class="la-btns">
                        <button type="button" class="btn" @click="moveAnswer(true, false)">Удалить</button>
                        <button type="button" class="btn" @click="moveAnswer(true, true)">Оставить</button>
                    </div>
                </div>
            </teleport>
        </span>
    `
};
