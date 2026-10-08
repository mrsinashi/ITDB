// Форма добавления/правки узла – прямо в дереве, под узлом

import { kindLabels } from "../columns.js";

// Что добавляется / что правится – подпись в начале формы (этап 22)
const NEW_LABELS = {
    building: "Новый адрес",
    department: "Новое отделение",
    floor: "Новый этаж",
    room: "Новый кабинет"
};
const EDIT_LABELS = {
    building: "Изменить адрес",
    department: "Изменить отделение",
    floor: "Изменить этаж",
    room: "Изменить кабинет"
};

export default {
    inject: ["root"],
    props: {
        level: { type: Number, default: 0 }
    },
    computed: {
        form() {
            return this.root.treeForm;
        },
        // «Новое отделение в:» (с панели, дальше – выбор, куда), «Новый кабинет:»
        // (под узлом), «Добавить: [Этаж ▾]» (под узлом, если можно разное),
        // «Изменить кабинет:»
        title() {
            const f = this.form;
            if (f.action !== "add") {
                return (EDIT_LABELS[f.kind] || "Изменить") + ":";
            }
            if (f.kinds.length > 1) {
                return "Добавить:";
            }
            const what = NEW_LABELS[f.kind] || "Добавить";
            return what + (f.top && f.kind !== "building" ? " в:" : ":");
        },
        // Подсказка у подписи: полный путь, куда добавляется
        titleHint() {
            const f = this.form;
            if (f.action === "add" && !f.top && f.path) {
                return "Внутри: " + f.path;
            }
            return f.action !== "add" && f.path ? f.path : null;
        }
    },
    mounted() {
        const input = this.$el.querySelector && this.$el.querySelector("input");
        if (input) {
            input.focus();
        }
        // Форма с панели прилипает под шапкой и не уезжает при прокрутке;
        // прилипший адрес встаёт под неё – ему нужна её высота (--tf-h)
        if (this.form && this.form.top && this.$el.nodeType === 1 && window.ResizeObserver) {
            const content = this.$el.parentElement;
            this._ro = new ResizeObserver(() => {
                content.style.setProperty("--tf-h", this.$el.offsetHeight + "px");
            });
            this._ro.observe(this.$el);
        }
    },
    beforeUnmount() {
        if (this._ro) {
            this._ro.disconnect();
            this.$el.parentElement && this.$el.parentElement.style.removeProperty("--tf-h");
        }
    },
    methods: {
        submit() {
            this.root.submitTreeForm();
        },
        cancel() {
            this.root.treeForm = null;
        },
        kindLabel(kind) {
            return kindLabels[kind] || kind;
        }
    },
    template: `
        <div class="tree-form" v-if="form" :class="{ 'tf-top': form.top }" :style="{ '--lvl': level }" @keydown.esc.stop="cancel">
            <span class="tf-title" :title="titleHint">{{ title }}</span>
            <select v-if="form.kinds.length > 1" class="input" v-model="form.kind" @change="form.top && (form.parentId = null)">
                <option v-for="k in form.kinds" :key="k" :value="k">{{ kindLabel(k) }}</option>
            </select>
            <select v-if="form.top && form.kind !== 'building'" class="input tf-parent" v-model="form.parentId" title="Куда добавить">
                <option :value="null" disabled>Куда…</option>
                <option v-for="o in root.treeParentOptions(form.kind)" :key="o.id" :value="o.id">{{ o.path }}</option>
            </select>
            <input v-if="form.kind !== 'floor'" class="input tf-code" v-model="form.code" @keydown.enter="submit" placeholder="Код"
                title="Необязательно. У кабинета – его номер">
            <input class="input tf-name" v-model="form.name" @keydown.enter="submit" placeholder="Название">
            <span class="tf-buttons">
                <button class="btn btn-primary icon-only" @click="submit" :title="form.action === 'add' ? 'Добавить (Enter)' : 'Сохранить (Enter)'"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></button>
                <button class="btn icon-only" @click="cancel" title="Отмена (Esc)"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
            </span>
            <span v-if="root.treeFormError" class="tf-error">{{ root.treeFormError }}</span>
        </div>
    `
};
