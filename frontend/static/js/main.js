// Интерфейс ITDB: Vue 3 без сборки, модули браузера (import/export).
//
//   main.js            — приложение: общее состояние (data), запуск, компоненты
//   settings.js        — переключатели UI_OPTIONS, цветовые схемы, роли
//   util.js            — запросы к API, localStorage, поиск по словам
//   columns.js         — описание столбцов таблицы, подписи полей, дубли
//   widths.js          — автоширина столбцов
//   tree-utils.js      — значки и ширина колонки дерева
//   shortcuts.js       — сочетания клавиш (Ctrl+F, Ctrl+A, Esc, Alt)
//   mixins/            — методы и вычисляемые значения по разделам:
//                        auth, table, table-actions, card, tree, history, choices, common
//   components/        — tree-node, tree-form, style-controls, location-picker
//
// Шаблоны разметки — в index.html.

import "./settings.js";
import { loadJson } from "./util.js";
import { HIDDEN_COLUMNS_KEY, SEARCH_HIDDEN_KEY } from "./columns.js";
import { loadManualWidths } from "./widths.js";
import "./shortcuts.js";

import common from "./mixins/common.js";
import auth from "./mixins/auth.js";
import table from "./mixins/table.js";
import tableActions from "./mixins/table-actions.js";
import card from "./mixins/card.js";
import tree from "./mixins/tree.js";
import history from "./mixins/history.js";
import choices from "./mixins/choices.js";

import treeNode from "./components/tree-node.js";
import styleControls from "./components/style-controls.js";
import treeForm from "./components/tree-form.js";
import locationPicker from "./components/location-picker.js";

const app = Vue.createApp({
    mixins: [common, auth, table, tableActions, card, tree, history, choices],

    // Дерево получает корень через inject, а не через window
    provide() {
        return { root: this };
    },

    data() {
        return {
            authChecked: false,
            user: null,
            view: "table",
            theme: document.documentElement.dataset.theme || "red",
            // Акценты (личные настройки): границы блоков цветом схемы и
            // цветная шапка таблиц — отдельно для каждой страницы
            accentBorders: false,
            accentHeaders: { tree: true, history: true, choices: true },

            // Таблица
            tableLoading: true,
            tableError: "",
            quickFilter: "",
            // Таблица показывает архив (кнопка «Архив» на панели)
            showArchive: false,
            archiveSaving: false,
            rows: [],
            hiddenColumns: loadJson(HIDDEN_COLUMNS_KEY, []),
            searchHidden: loadJson(SEARCH_HIDDEN_KEY, false),
            locationFilter: null,
            savedFlash: {},
            pendingCells: {},
            openMenu: null,
            noteTooltip: { visible: false, text: "", top: 0, left: 0, width: 0 },
            stickyStuck: false,
            editingRowId: null,
            editingField: null,
            editValue: "",
            autoWidths: {},
            manualWidths: loadManualWidths(),
            sortField: null,
            sortDir: null,
            // Форма «+ Компьютер» под панелью
            newComputer: null,
            // Строка действия с выбранными: переместить / заменить / изменить поле
            actionBar: null,
            newComputerError: "",
            newComputerSaving: false,

            // Дерево
            treeLoading: false,
            treeError: "",
            treeRoots: [],
            unlocated: 0,
            treeForm: null,
            treeFormError: "",
            treeIndex: {},
            treeOpenState: {},
            treeQuery: "",
            choicesQuery: "",
            choicesPos: 0,
            treeWidth: 480,
            treeHover: null,
            treeScrollbar: 0,

            // История
            historyLoading: false,
            historyError: "",
            historyItems: [],
            historyQuery: "",

            // Карточка
            card: null,
            cardLoading: false,
            cardError: "",
            cardHostname: "",
            editingHostname: false,
            cardPeople: [],
            cardVacuum: [],
            cardHistory: [],
            cardHistoryOpen: false,
            cardEditKey: null,
            cardEditValue: "",
            // Диалог и сообщения
            dialog: null,
            toasts: [],
            // Справочники
            choicesLoading: false,
            choicesItems: [],
            newChoiceValue: {},
            columnStyles: {},
            fieldDefEdit: null,
            // Пользовательские поля
            fieldDefs: [],
            fieldDefsLoading: false,
            selectedRows: [],
            selectAnchorId: null,   // строка, от которой идёт Shift+клик
            dupVersion: 0,          // пересчитаны дубли — пересчитать заливку ячеек
            altDown: false,         // зажат Alt — клик копирует значение
            copyHint: null,         // подсветка значения под курсором при Alt
            newFieldDef: { key: "", label: "", field_type: "text" }
        };
    },

    async mounted() {
        window.itdbTable = this;
        this.hoverRowEl = null;
        this.lastMouseX = undefined;
        this.lastMouseY = undefined;
        this.rafId = null;
        await this.checkAuth();
        this.authChecked = true;
        if (this.user) {
            await this.$nextTick();
            this.snapNavUser();
            window.addEventListener("resize", () => this.snapNavUser());
            await Promise.all([this.loadChoices(), this.loadColumnStyles(), this.loadFieldDefs()]);
            await this.loadTable();
        }
    }
});

app.component("tree-node", treeNode);
app.component("style-controls", styleControls);
app.component("tree-form", treeForm);
app.component("location-picker", locationPicker);

app.mount("#app");
