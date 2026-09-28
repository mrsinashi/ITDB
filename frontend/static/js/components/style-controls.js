// Кнопки оформления: цвет текста, цвет фона, жирный, курсив.
// Отдаёт наружу только изменённое свойство: { color: "#aa0000" } и т. п.

export default {
    props: {
        value: Object,
        disabled: Boolean
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
        }
    },
    template: `
        <span class="sc" :class="{ disabled: disabled }">
            <label class="sc-btn sc-color" :class="{ set: !!s.color }" :title="s.color ? 'Цвет текста ' + s.color : 'Цвет текста не задан'">
                <span class="sc-letter" :style="{ color: s.color || null }">A</span>
                <span class="sc-bar" :style="{ background: s.color || null }"></span>
                <input type="color" :value="s.color || '#222222'" :disabled="disabled" @change="emit({ color: $event.target.value })">
            </label>
            <label class="sc-btn sc-color sc-bg" :class="{ set: !!s.bg_color }" :title="s.bg_color ? 'Цвет фона ' + s.bg_color : 'Цвет фона не задан'">
                <span class="sc-swatch" :style="{ background: s.bg_color || null }"></span>
                <input type="color" :value="s.bg_color || '#ffffff'" :disabled="disabled" @change="emit({ bg_color: $event.target.value })">
            </label>
            <button type="button" class="sc-btn" :class="{ on: s.bold }" :disabled="disabled" title="Жирный" @click="emit({ bold: !s.bold })"><b>Ж</b></button>
            <button type="button" class="sc-btn" :class="{ on: s.italic }" :disabled="disabled" title="Курсив" @click="emit({ italic: !s.italic })"><i>К</i></button>
        </span>
    `
};
