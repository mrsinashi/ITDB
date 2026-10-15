// Кнопки оформления: цвет текста, цвет фона, жирный, курсив; с extra – ещё
// «фон блочком» (у текста, а не заливкой ячейки), подчёркнутый, зачёркнутый; с frame
// (значения сканера, этап 63) – цвет рамки блочка на месте «блочком» и «З» последней –
// порядок кнопок везде один: A, фон, блочок / рамка, Ж, К, Ч, З.
// Отдаёт наружу только изменённое свойство: { color: "#aa0000" } и т. п.
// Ctrl + клик по кнопке цвета – сбросить этот цвет: { color: "" }, { bg_color: "" }, { frame: "" }.

export default {
    props: {
        value: Object,
        disabled: Boolean,
        extra: Boolean,
        frame: Boolean
    },
    emits: ["change"],
    computed: {
        s() {
            return this.value || {};
        },
        isChip() {
            return !!this.s.chip;
        }
    },
    methods: {
        emit(patch) {
            if (!this.disabled) {
                this.$emit("change", patch);
            }
        },

        // Ctrl + клик по кнопке цвета – сбросить его (окно выбора не открывается)
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
            return value ? name + " " + value + "\nCtrl + клик – сбросить" : name + " не задан";
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
            <label v-if="frame" class="sc-btn sc-color sc-bg" :class="{ set: !!s.frame }" :title="s.frame ? 'Рамка блочка ' + s.frame + '\\nCtrl + клик – убрать' : 'Рамка блочка – в тон фона'" @click.capture="onColorClick($event, 'frame')">
                <span class="sc-swatch sc-frame" :style="{ borderColor: s.frame || null }"></span>
                <input type="color" :value="s.frame || '#9db4cc'" :disabled="disabled" @change="emit({ frame: $event.target.value })">
            </label>
            <button v-if="extra" type="button" class="sc-btn sc-chip" :class="{ on: isChip }" :disabled="disabled" :title="isChip ? 'Фон блочком' : 'Фон на всю ячейку'" @click="emit({ chip: !isChip })"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="1.6" y="3.6" width="10.8" height="6.8" rx="2"/><path d="M4.5 7h5"/></svg></button>
            <button type="button" class="sc-btn" :class="{ on: s.bold }" :disabled="disabled" title="Жирный" @click="emit({ bold: !s.bold })"><b>Ж</b></button>
            <button type="button" class="sc-btn" :class="{ on: s.italic }" :disabled="disabled" title="Курсив" @click="emit({ italic: !s.italic })"><i>К</i></button>
            <template v-if="extra">
                <button type="button" class="sc-btn" :class="{ on: s.underline }" :disabled="disabled" title="Подчёркнутый" @click="emit({ underline: !s.underline })"><u>Ч</u></button>
                <button type="button" class="sc-btn" :class="{ on: s.strike }" :disabled="disabled" title="Зачёркнутый" @click="emit({ strike: !s.strike })"><s>З</s></button>
            </template>
            <button v-if="frame" type="button" class="sc-btn" :class="{ on: s.strike }" :disabled="disabled" title="Зачёркивать значение таблицы" @click="emit({ strike: !s.strike })"><s>З</s></button>
        </span>
    `
};
