// Форма добавления/правки узла – прямо в дереве, под узлом. Раскладка одна (этап 62):
// подпись, место (список с поиском, как в «Новый компьютер»), код и название с кнопками –
// одной строкой; колонка дерева на это время не уже, чем нужно полям (treeBoxWidth)

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
        },
        // Место: с панели – куда добавить; у кабинета в правке – где он (этап 58)
        placeOptions() {
            const f = this.form;
            if (f.top && f.kind !== "building") {
                return this.root.treeParentOptions(f.kind);
            }
            if (f.action === "edit" && f.kind === "room") {
                return this.root.treeParentOptions("room");
            }
            return null;
        },
        // У кабинета код – его номер
        codeHint() {
            return this.form.kind === "room" ? { short: "№ каб.", title: "Номер кабинета" } : { short: "Код", title: "Код" };
        }
    },
    mounted() {
        // Фокус: место, пока не выбрано; у нового кабинета – номер; иначе – название
        const f = this.form;
        if (f && this.placeOptions && !f.parentId) {
            const place = this.$refs.place && this.$refs.place.$refs.input;
            if (place) {
                place.focus();
            }
        } else {
            this.focusField();
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
        focusField() {
            const f = this.form;
            const input = f && f.action === "add" && f.kind === "room" && this.$refs.code ? this.$refs.code : this.$refs.name;
            if (input) {
                input.focus();
            }
        },
        onPlace(id) {
            this.form.parentId = id;
            this.$nextTick(() => this.focusField());
        },
        // Enter на кнопке – это её нажатие, не отправка формы второй раз
        onEnter(event) {
            if (event.target.tagName !== "BUTTON") {
                event.preventDefault();
                this.submit();
            }
        },
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
    // Enter – у всей формы: открытый список места забирает его себе
    template: `
        <div class="tree-form" v-if="form" :class="{ 'tf-top': form.top }" :style="{ '--lvl': level }" @keydown.esc.stop="cancel" @keydown.enter="onEnter">
            <span class="tf-head">
                <span class="tf-title" :title="titleHint">{{ title }}</span>
                <select v-if="form.kinds.length > 1" class="input" v-model="form.kind" title="Что добавить" @change="form.top && (form.parentId = null)">
                    <option v-for="k in form.kinds" :key="k" :value="k">{{ kindLabel(k) }}</option>
                </select>
            </span>
            <location-picker v-if="placeOptions" ref="place" class="tf-place" input-class="input" :value="form.parentId" :options="placeOptions"
                :placeholder="form.action === 'add' ? 'Куда' : 'Где'" @pick="onPlace"></location-picker>
            <span class="tf-fields">
                <input v-if="form.kind !== 'floor'" ref="code" class="input tf-code" v-model="form.code" :placeholder="codeHint.short" :title="codeHint.title" spellcheck="false">
                <input ref="name" class="input tf-name" v-model="form.name" placeholder="Название" title="Название" spellcheck="false">
                <button class="btn btn-primary icon-only" @click="submit" :title="form.action === 'add' ? 'Добавить (Enter)' : 'Сохранить (Enter)'"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></button>
                <button class="btn icon-only" @click="cancel" title="Отмена (Esc)"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
            </span>
            <span v-if="root.treeFormError" class="tf-error">{{ root.treeFormError }}</span>
        </div>
    `
};
