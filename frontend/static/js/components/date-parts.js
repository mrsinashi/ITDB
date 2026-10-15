// Дата блоками (этап 66, окно записи журнала «Движение», просьба пользователя): день, месяц и
// год – отдельными полями, без календаря и без стрелок. Пустые по умолчанию; нажатие на пустой
// блок ставит значение сегодняшнего дня и открывает список (длинный – с прокруткой), на
// заполненный – только список. Колёсико над блоком листает значения (вниз – дальше по списку,
// вверх – к «–» в его начале, это «пусто»); годы – с 1990 по нынешний. Клавиши на блоке: ↑↓ –
// соседнее значение, цифры – ввод (набрал – следующий блок), Backspace / Delete – очистить,
// Enter / Esc – закрыть список.
// value – { d, m, y } (числа или null), parts – "dmy" или "my" (месяц и год); событие update –
// новый { d, m, y }. Дни – по месяцу и году: 31 марта → февраль – станет 28 (29).

import { listPosStyle, pad2, placeList, scrollToItem } from "../util.js";

export const YEAR_MIN = 1990;
const TITLES = { d: "День", m: "Месяц", y: "Год" };
const HOLDERS = { d: "ДД", m: "ММ", y: "ГГГГ" };
// Набор цифр подряд – одно число, пока пауза меньше этого
const TYPE_PAUSE_MS = 1200;
const LIST_MIN_WIDTH = 60;
// Окно листали колёсиком только что – колёсико над блоком листает окно дальше, а не дату:
// курсор, проезжая над датой при прокрутке, её не меняет
const SCROLL_LATCH_MS = 400;
let lastScrollAt = 0;
window.addEventListener("scroll", function (event) {
    const target = event.target;
    if (!(target instanceof Element && target.closest(".dp-list"))) {
        lastScrollAt = Date.now();
    }
}, true);

export function daysIn(m, y) {
    // Год не знаем – февралю 29 дней
    return m ? new Date(y || 2000, m, 0).getDate() : 31;
}

export default {
    props: {
        value: { type: Object, default: null },
        parts: { type: String, default: "dmy" },
        disabled: Boolean
    },
    emits: ["update"],
    data() {
        return { open: null, pos: null, typed: "", typedAt: 0, typedKey: null };
    },
    computed: {
        keys() {
            return this.parts === "my" ? ["m", "y"] : ["d", "m", "y"];
        },
        cur() {
            const v = this.value || {};
            return { d: v.d || null, m: v.m || null, y: v.y || null };
        },
        listStyle() {
            return listPosStyle(this.pos);
        }
    },
    beforeUnmount() {
        this.unlisten();
    },
    methods: {
        today() {
            const t = new Date();
            return { d: t.getDate(), m: t.getMonth() + 1, y: t.getFullYear() };
        },
        // Значения блока: «–» (null), потом числа по порядку
        values(k) {
            let from = 1;
            let to = 12;
            if (k === "d") {
                to = daysIn(this.cur.m, this.cur.y);
            } else if (k === "y") {
                from = YEAR_MIN;
                to = Math.max(this.today().y, this.cur.y || 0);
            }
            const list = [null];
            for (let v = from; v <= to; v++) {
                list.push(v);
            }
            return list;
        },
        text(k, v) {
            if (v === null) {
                return "";
            }
            return k === "y" ? String(v) : pad2(v);
        },
        holder(k) {
            return HOLDERS[k];
        },
        partTitle(k) {
            return this.disabled ? null : TITLES[k];
        },
        set(k, v) {
            const next = Object.assign({}, this.cur, { [k]: v });
            // День за концом нового месяца – последний день месяца
            if (next.d && next.d > daysIn(next.m, next.y)) {
                next.d = daysIn(next.m, next.y);
            }
            this.$emit("update", next);
            if (this.open === k) {
                this.$nextTick(() => this.scrollList(false));
            }
        },
        // Пустой блок – сегодняшнее значение (день – не за концом выбранного месяца)
        fillToday(k) {
            const t = this.today();
            this.set(k, k === "d" ? Math.min(t.d, daysIn(this.cur.m, this.cur.y)) : t[k]);
        },
        step(k, dir) {
            if (this.cur[k] === null && dir > 0) {
                this.fillToday(k);
                return;
            }
            const list = this.values(k);
            const at = list.indexOf(this.cur[k]);
            const next = Math.max(0, Math.min(list.length - 1, (at === -1 ? 0 : at) + dir));
            if (next !== at) {
                this.set(k, list[next]);
            }
        },
        el(k) {
            const ref = this.$refs["p-" + k];
            return Array.isArray(ref) ? ref[0] : ref;
        },
        onPress(k, event) {
            if (this.disabled || event.button !== 0) {
                return;
            }
            const el = this.el(k);
            if (el) {
                el.focus({ preventScroll: true });
            }
            if (this.cur[k] === null) {
                this.fillToday(k);
                this.show(k);
            } else if (this.open === k) {
                this.hide();
            } else {
                this.show(k);
            }
        },
        onWheel(k, event) {
            if (this.disabled || !event.deltaY || Date.now() - lastScrollAt < SCROLL_LATCH_MS) {
                return;
            }
            event.preventDefault();
            this.step(k, event.deltaY > 0 ? 1 : -1);
        },
        onKey(k, event) {
            if (this.disabled) {
                return;
            }
            const key = event.key;
            if (key === "ArrowDown" || key === "ArrowUp") {
                event.preventDefault();
                this.step(k, key === "ArrowDown" ? 1 : -1);
            } else if (key === "Backspace" || key === "Delete") {
                event.preventDefault();
                this.typed = "";
                this.set(k, null);
            } else if ((key === "Enter" || key === "Escape") && this.open) {
                event.preventDefault();
                event.stopPropagation();
                this.hide();
            } else if (/^\d$/.test(key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
                event.preventDefault();
                this.typeDigit(k, key);
            }
        },
        // Цифры подряд: день и месяц – две (или одна, если второй уже не будет: «4» – 4-е),
        // год – четыре; набрал – следующий блок
        typeDigit(k, digit) {
            const now = Date.now();
            this.typed = now - this.typedAt < TYPE_PAUSE_MS && this.typedKey === k ? this.typed + digit : digit;
            this.typedAt = now;
            this.typedKey = k;
            const n = Number(this.typed);
            if (k === "y") {
                if (this.typed.length === 4) {
                    if (this.values("y").indexOf(n) !== -1) {
                        this.set("y", n);
                    }
                    this.typed = "";
                }
                return;
            }
            const max = k === "d" ? daysIn(this.cur.m, this.cur.y) : 12;
            if (n >= 1 && n <= max) {
                this.set(k, n);
            }
            if (this.typed.length >= 2 || n * 10 > max) {
                this.typed = "";
                this.focusNext(k);
            }
        },
        focusNext(k) {
            const next = this.keys[this.keys.indexOf(k) + 1];
            const el = next ? this.el(next) : null;
            if (el) {
                this.hide();
                el.focus({ preventScroll: true });
            }
        },
        show(k) {
            this.open = k;
            this.$nextTick(() => {
                this.place();
                this.$nextTick(() => this.scrollList(true));
            });
            this.listen();
        },
        hide() {
            this.open = null;
            this.pos = null;
            this.unlisten();
        },
        place() {
            const el = this.open ? this.el(this.open) : null;
            if (!el) {
                return;
            }
            // Не уже блока года: у узкого списка дня полоса прокрутки съела бы цифры
            this.pos = placeList(el, { width: Math.max(el.offsetWidth, LIST_MIN_WIDTH), room: 200, height: 240 });
        },
        scrollList(center) {
            const list = this.$refs.list;
            const at = this.open ? this.values(this.open).indexOf(this.cur[this.open]) : -1;
            scrollToItem(list, list && at >= 0 ? list.children[at] : null, center);
        },
        pick(v) {
            const k = this.open;
            if (k) {
                this.set(k, v);
                this.hide();
            }
        },
        onBlur() {
            this.typed = "";
            this.hide();
        },
        // Окно прокрутили – список уехал бы от блока: закрыть
        listen() {
            if (!this._onMove) {
                this._onMove = (event) => {
                    if (!this.$refs.list || !this.$refs.list.contains(event.target)) {
                        this.hide();
                    }
                };
                window.addEventListener("scroll", this._onMove, true);
                window.addEventListener("resize", this._onMove);
            }
        },
        unlisten() {
            if (this._onMove) {
                window.removeEventListener("scroll", this._onMove, true);
                window.removeEventListener("resize", this._onMove);
                this._onMove = null;
            }
        }
    },
    template: `
        <span class="dp" :class="{ disabled: disabled }">
            <template v-for="(k, i) in keys" :key="k">
                <span v-if="i" class="dp-dot">.</span>
                <span :ref="'p-' + k" class="dp-part" :class="['dp-' + k, { empty: cur[k] === null, open: open === k }]"
                    :tabindex="disabled ? -1 : 0" :title="partTitle(k)"
                    @mousedown.prevent="onPress(k, $event)" @wheel="onWheel(k, $event)" @keydown="onKey(k, $event)" @blur="onBlur">{{ cur[k] === null ? holder(k) : text(k, cur[k]) }}</span>
            </template>
            <teleport to="body">
                <div v-if="open && pos" ref="list" class="loc-list dp-list" :class="{ up: pos.up }" :style="listStyle" @mousedown.prevent>
                    <div v-for="v in values(open)" :key="v === null ? 'none' : v" class="ll-item"
                        :class="{ current: v === cur[open], 'dp-none': v === null }" @click="pick(v)">{{ v === null ? "–" : text(open, v) }}</div>
                </div>
            </teleport>
        </span>
    `
};
