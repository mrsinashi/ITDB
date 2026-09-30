// Интерфейс ITDB: Vue 3 без сборки, модули браузера (import/export).
//
//   main.js            — приложение: общее состояние (data), запуск, компоненты
//   settings.js        — переключатели UI_OPTIONS, цветовые схемы, роли
//   util.js            — запросы к API, localStorage, поиск по словам
//   columns.js         — столбцы с сервера (GET /api/columns) в вид для таблицы, подписи полей, дубли
//   widths.js          — автоширина столбцов
//   tree-utils.js      — значки и ширина колонки дерева
//   shortcuts.js       — сочетания клавиш (Ctrl+F, Ctrl+A, Esc, Alt)
//   mixins/            — методы и вычисляемые значения по разделам:
//                        auth, table, table-actions, card, tree, history, choices, common,
//                        suggest (подсказки при вводе), users (пользователи системы),
//                        history-undo (отмена и возврат из Истории, фильтры Истории),
//                        col-filters (фильтры по столбцам в шапке таблицы),
//                        scan (Сканирование: подключения к источникам, подсети),
//                        scan-match (сбор из GLPI / GSIT, вкладка «Сопоставление»)
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
import suggest from "./mixins/suggest.js";
import users from "./mixins/users.js";
import historyUndo from "./mixins/history-undo.js";
import colFilters from "./mixins/col-filters.js";
import scan from "./mixins/scan.js";
import scanMatch from "./mixins/scan-match.js";

import treeNode from "./components/tree-node.js";
import styleControls from "./components/style-controls.js";
import treeForm from "./components/tree-form.js";
import locationPicker from "./components/location-picker.js";

const app = Vue.createApp({
    mixins: [common, auth, table, tableActions, card, tree, history, choices, suggest, users, historyUndo, colFilters, scan, scanMatch],

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
            accentHeaders: { tree: true, history: true, choices: true, users: true, scan: true },

            // Таблица
            tableLoading: true,
            tableError: "",
            quickFilter: "",
            // Таблица показывает архив (кнопка «Архив» на панели)
            showArchive: false,
            archiveSaving: false,
            rows: [],
            // Подсказки при вводе: открытый список под полем правки (mixins/suggest.js)
            suggest: null,
            // Карточка: показаны и пустые поля (кнопка в шапке, не запоминается)
            cardShowEmpty: false,
            // Описание встроенных столбцов с сервера (GET /api/columns)
            builtinColumns: [],
            cardGroups: [],
            historyLabels: {},
            hiddenColumns: loadJson(HIDDEN_COLUMNS_KEY, []),
            searchHidden: loadJson(SEARCH_HIDDEN_KEY, false),
            locationFilter: null,
            // Фильтры по столбцам: поле → { exclude, keys, labels } (mixins/col-filters.js)
            colFilters: {},
            // Открытый список значений под шапкой столбца
            colFilterMenu: null,
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
            // Всего записей и записей по дням (с сервера, точные, даже если
            // загружена только часть — сначала 200, остальное по кнопке)
            historyTotal: 0,
            historyDayCounts: {},
            historyLoadingMore: false,
            // Отменённые изменения: по умолчанию скрыты и не считаются (глаз в шапке)
            historyShowCancelled: false,
            // Фильтр: кто менял и что (вид объекта или один объект)
            historyFilter: { user: null, entity: null, entityId: null, entityKey: null, title: "" },
            historyUsers: [],
            historySelected: [],    // выбранные записи (Ctrl/Shift+клик)
            historyAnchor: null,
            // Окно «История значения» (двойной клик по полю в записи)
            valueDialog: null,

            // Пользователи системы (только admin)
            users: [],
            usersLoading: false,
            usersError: "",
            userBar: null,       // строка под панелью: новый / изменить
            usersHover: null,    // строка под курсором — плашка действий
            ownPassword: null,   // форма смены своего пароля в меню пользователя
            ownProfile: null,    // форма «Редактировать» (логин, ФИО, должность) там же
            ownMenu: false,      // открыт список ✎ ▾ в меню пользователя

            scanSources: [],     // источники: GLPI, GSIT, Jabber (с сервера)
            scanForms: {},       // формы источников: kind → поля формы
            scanKeyReady: true,  // есть ли ключ шифрования паролей в .env
            scanError: "",
            scanSubnets: [],
            scanUncovered: [],   // подсети /24 с ПК из базы, которых нет в списке
            scanBuildings: [],
            scanPurposes: {},
            subnetBar: null,     // строка под панелью: новая подсеть / изменить
            subnetHover: null,   // подсеть под курсором — плашка действий
            // Этап 25: вкладки страницы, сбор и сопоставление
            scanTab: "settings", // settings — подключения и подсети, match — сопоставление
            scanRuns: {},        // kind → запуск сбора, за которым следим
            scanPollTimer: null,
            scanMatch: {
                source: "glpi",
                data: null,      // ответ /api/scan/records
                loading: false,
                error: "",
                filter: "all",   // all / matched / name / conflict / none / dup
                open: {},        // source_id → раскрыта подробность
                hover: null      // запись под курсором — плашка действий
            },
            scanMatchQuery: "",
            scanLinkBar: null,   // «Привязать запись к ПК:» — строка под панелью

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
            await Promise.all([this.loadColumns(), this.loadChoices(), this.loadColumnStyles(), this.loadFieldDefs()]);
            await this.loadTable();
        }
    }
});

app.component("tree-node", treeNode);
app.component("style-controls", styleControls);
app.component("tree-form", treeForm);
app.component("location-picker", locationPicker);

app.mount("#app");
