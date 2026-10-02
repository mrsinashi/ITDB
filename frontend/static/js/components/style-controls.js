// Кнопки оформления: цвет текста, цвет фона, жирный, курсив; с extra — ещё
// «фон блочком» (у текста, а не заливкой ячейки), подчёркнутый, зачёркнутый.
// Отдаёт наружу только изменённое свойство: { color: "#aa0000" } и т. п.
// Ctrl + клик по кнопке цвета — сбросить этот цвет: { color: "" } или { bg_color: "" }.

export default {
    props: {
        value: Object,
        disabled: Boolean,
        extra: Boolean,
        noChip: Boolean   // с extra: без «фон блочком» (там, где фон и так блочком)
    },
    emits: ["change"],
    computed: {
        s() {
            return this.value || {};
        }
    },
    methods: {
        emit(patch) {
            if (!this.disabled) {
                this.$emit("change", patch);
            }
        },

        // Ctrl + клик по кнопке цвета — сбросить его (окно выбора не открывается)
        onColorClick(event, key) {
            if (!event.ctrlKey && !event.metaKey) {
                return;
            }
            event.preventDefault();
            if (this.s[key]) {
                this.emit({ [key]: "" });
            }
        },

        colorTitle(value, name) {
            return value ? name + " " + value + "\nCtrl + клик — сбросить" : name + " не задан";
        }
    },
    template: `
        <span class="sc" :class="{ disabled: disabled }">
            <label class="sc-btn sc-color" :class="{ set: !!s.color }" :title="colorTitle(s.color, 'Цвет текста')" @click.capture="onColorClick($event, 'color')">
                <span class="sc-letter" :style="{ color: s.color || null }">A</span>
                <span class="sc-bar" :style="{ background: s.color || null }"></span>
                <input type="color" :value="s.color || '#222222'" :disabled="disabled" @change="emit({ color: $event.target.value })">
            </label>
            <label class="sc-btn sc-color sc-bg" :class="{ set: !!s.bg_color }" :title="colorTitle(s.bg_color, 'Цвет фона')" @click.capture="onColorClick($event, 'bg_color')">
                <span class="sc-swatch" :style="{ background: s.bg_color || null }"></span>
                <input type="color" :value="s.bg_color || '#ffffff'" :disabled="disabled" @change="emit({ bg_color: $event.target.value })">
            </label>
            <button v-if="extra && !noChip" type="button" class="sc-btn sc-chip" :class="{ on: s.chip }" :disabled="disabled" :title="s.chip ? 'Фон блочком' : 'Фон на всю ячейку'" @click="emit({ chip: !s.chip })"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="1.6" y="3.6" width="10.8" height="6.8" rx="2"/><path d="M4.5 7h5"/></svg></button>
            <button type="button" class="sc-btn" :class="{ on: s.bold }" :disabled="disabled" title="Жирный" @click="emit({ bold: !s.bold })"><b>Ж</b></button>
            <button type="button" class="sc-btn" :class="{ on: s.italic }" :disabled="disabled" title="Курсив" @click="emit({ italic: !s.italic })"><i>К</i></button>
            <template v-if="extra">
                <button type="button" class="sc-btn" :class="{ on: s.underline }" :disabled="disabled" title="Подчёркнутый" @click="emit({ underline: !s.underline })"><u>Ч</u></button>
                <button type="button" class="sc-btn" :class="{ on: s.strike }" :disabled="disabled" title="Зачёркнутый" @click="emit({ strike: !s.strike })"><s>З</s></button>
            </template>
        </span>
    `
};
