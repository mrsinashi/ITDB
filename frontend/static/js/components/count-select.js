// Выбор из списка со счётчиками (этап 28): как <select>, но число у пункта стоит
// справа серым, как в фильтре столбца, а не в скобках.
// options – [{ key, label, count }]; v-model – ключ выбранного.
// Стрелки ↑ ↓ меняют выбор, Enter и Esc закрывают открытый список.

export default {
    props: {
        modelValue: { default: "" },
        options: { type: Array, default: function () { return []; } },
        title: String
    },
    emits: ["update:modelValue"],
    data() {
        return { open: false };
    },
    computed: {
        current() {
            const value = this.modelValue;
            return this.options.find(function (o) { return o.key === value; }) || this.options[0] || { label: "", count: null };
        }
    },
    beforeUnmount() {
        this.close();
    },
    methods: {
        toggle() {
            if (this.open) {
                this.close();
                return;
            }
            this.open = true;
            document.addEventListener("mousedown", this.onDocDown, true);
        },

        close() {
            this.open = false;
            document.removeEventListener("mousedown", this.onDocDown, true);
        },

        onDocDown(event) {
            if (!this.$el.contains(event.target)) {
                this.close();
            }
        },

        pick(key) {
            this.$emit("update:modelValue", key);
            this.close();
            this.$refs.button.focus();
        },

        step(by) {
            const value = this.modelValue;
            const i = this.options.findIndex(function (o) { return o.key === value; });
            const next = this.options[Math.min(Math.max((i === -1 ? 0 : i) + by, 0), this.options.length - 1)];
            if (next && next.key !== value) {
                this.$emit("update:modelValue", next.key);
            }
        },

        onKeydown(event) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                this.step(event.key === "ArrowDown" ? 1 : -1);
            } else if (this.open && (event.key === "Escape" || event.key === "Enter")) {
                // Закрыть только список: строка действия остаётся
                event.preventDefault();
                event.stopPropagation();
                this.close();
            }
        }
    },
    template: `
        <span class="count-select" :class="{ open: open }">
            <button ref="button" type="button" class="input cs-btn" :title="title" @click="toggle" @keydown="onKeydown">
                <span class="cs-label">{{ current.label }}</span>
                <span v-if="current.count !== null && current.count !== undefined" class="cs-count">{{ current.count }}</span>
                <svg class="cs-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <div v-if="open" class="dropdown attached cs-menu">
                <button v-for="o in options" :key="o.key" type="button" :class="{ sel: o.key === modelValue }" @click="pick(o.key)">
                    <span class="cs-label">{{ o.label }}</span><span class="dd-count">{{ o.count }}</span>
                </button>
            </div>
        </span>`
};
