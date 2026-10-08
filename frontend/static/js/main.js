// Интерфейс ITDB: Vue 3 без сборки, модули браузера (import/export).
//
//   main.js            – приложение: общее состояние (data), запуск, компоненты
//   settings.js        – переключатели UI_OPTIONS, цветовые схемы, роли
//   util.js            – запросы к API, localStorage, поиск по словам
//   columns.js         – столбцы с сервера (GET /api/columns) в вид для таблицы, подписи полей, дубли
//   widths.js          – автоширина столбцов
//   tree-utils.js      – значки и ширина колонки дерева
//   naming.js          – имена ПК по правилам узлов дерева: проверка, новое имя, «по таблице»
//   shortcuts.js       – сочетания клавиш (Ctrl+F, Ctrl+A, Esc, Alt)
//   alt-copy.js        – Alt + клик: копирование значения во всех таблицах, кроме главной
//   mixins/            – методы и вычисляемые значения по разделам:
//                        auth, table, table-actions, card, tree, history, choices, common,
//                        suggest (подсказки при вводе), users (пользователи системы),
//                        history-undo (отмена и возврат из Истории, фильтры Истории),
//                        col-filters (фильтры по столбцам в шапке таблицы),
//                        scan (Сканирование: подключения к источникам, подсети),
//                        scan-match (сбор из GLPI / GSIT, вкладка «Названия», общее для записей),
//                        scan-check (вкладка «Проверка»: сопоставление и предложения сканера),
//                        scan-diffs (значения сканера в Таблице, решения по ним, столбец «Антивирусы»),
//                        scan-vacuum (страница «Vacuum»: пользователи Jabber),
//                        scan-schedule (вкладка «Расписание»: когда собирать, журнал запусков),
//                        table-marks (выделения значений в Таблице: повтор, «нет в Jabber»…),
//                        scan-net (вкладка «Сеть»: что собрали DHCP и проход подсетей),
//                        nav (адреса страниц, Ctrl+Z / Ctrl+Y),
//                        vnc (подключение к ПК через внешнее приложение, itdb://vnc/…),
//                        print (печать Таблицы: окно с настройками и листом),
//                        table-fit (масштаб по ширине окна), col-order (порядок столбцов перетаскиванием),
//                        naming (имена ПК по правилам: вкладка Справочников, проверка в Таблице)
//   route.js           – адреса страниц после «#» (ссылки открываются в новой вкладке)
//   components/        – tree-node, tree-form, style-controls, location-picker, count-select
//
// Шаблоны разметки – в index.html.

import "./settings.js";
import { loadJson } from "./util.js";
import { COLUMN_ORDER_KEY, COLUMN_ORDER2_KEY, HIDDEN_COLUMNS_KEY, HIDDEN_COLUMNS2_KEY, PINNED_COLUMNS_KEY, SEARCH_HIDDEN_KEY, TABLE_FIT_KEY, TABLE_VIEW_KEY, mergeRoomHidden } from "./columns.js";
import { loadManualWidths } from "./widths.js";
import "./shortcuts.js";
import "./alt-copy.js";

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
import scanDiffs from "./mixins/scan-diffs.js";
import scanCheck from "./mixins/scan-check.js";
import scanVacuum from "./mixins/scan-vacuum.js";
import scanSchedule from "./mixins/scan-schedule.js";
import tableMarks from "./mixins/table-marks.js";
import scanNet from "./mixins/scan-net.js";
import nav from "./mixins/nav.js";
import vnc from "./mixins/vnc.js";
import print from "./mixins/print.js";
import tableFit from "./mixins/table-fit.js";
import colOrder from "./mixins/col-order.js";
import naming from "./mixins/naming.js";

import treeNode from "./components/tree-node.js";
import styleControls from "./components/style-controls.js";
import treeForm from "./components/tree-form.js";
import locationPicker from "./components/location-picker.js";
import countSelect from "./components/count-select.js";

const app = Vue.createApp({
    mixins: [common, auth, table, tableActions, card, tree, history, choices, suggest, users, historyUndo, colFilters, scan, scanMatch, scanDiffs, scanCheck, scanVacuum, scanSchedule, tableMarks, scanNet, nav, vnc, print, tableFit, colOrder, naming],

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
            // цветная шапка таблиц – отдельно для каждой страницы
            accentBorders: false,
            noRadius: document.documentElement.classList.contains("no-radius"),   // без закруглений
            buttonCounts: true,   // счётчики на кнопках панели
            accentHeaders: { tree: true, history: true, choices: true, users: true, scan: true, vacuum: true },

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
            hiddenColumns: mergeRoomHidden(loadJson(HIDDEN_COLUMNS_KEY, [])),
            // Второй вид таблицы (кнопка справа от поиска): 1 – основной, 2 – второй;
            // его скрытые столбцы (null – ещё не меняли: столбцы по умолчанию)
            tableView: loadJson(TABLE_VIEW_KEY, 1) === 2 ? 2 : 1,
            hiddenColumns2: loadJson(HIDDEN_COLUMNS2_KEY, null),
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
            // Закреплённый столбец, у правого края которого сейчас тень (под него уехали соседи),
            // и прилипший к правому краю окна, у которого тень слева (этап 41)
            stuckEdge: null,
            stuckEdgeRight: null,
            // Закреплённые столбцы: список полей; null – как в описании столбцов (HOSTNAME, IP)
            pinnedColumns: loadJson(PINNED_COLUMNS_KEY, null),
            // Порядок столбцов основного и второго вида: список полей; null – как с сервера
            columnOrder: loadJson(COLUMN_ORDER_KEY, null),
            columnOrder2: loadJson(COLUMN_ORDER2_KEY, null),
            // Масштаб таблицы по ширине окна: включён ли, сам масштаб и отступ слева
            tableFit: loadJson(TABLE_FIT_KEY, false) === true,
            tableZoom: 1,
            tableFitMargin: 0,
            tableFitScroll: false,
            editingRowId: null,
            editingField: null,
            editValue: "",
            autoWidths: {},
            manualWidths: loadManualWidths(),
            sortField: null,
            sortDir: null,
            // Форма «+ Компьютер» под панелью
            newComputer: null,
            // Новый кабинет из списка расположений нового ПК: { parent_id, code, name, error, saving } (этап 36)
            newRoom: null,
            // Строка действия с выбранными: переместить / заменить / изменить поле
            actionBar: null,
            // Окно печати таблицы (mixins/print.js): строки, столбцы и настройки листа
            printDlg: null,
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
            // Справочники: вкладка «Оформление» (styles) или «Имена ПК» (names, этап 35)
            choicesTab: "styles",
            namesQuery: "",
            namesHover: null,    // строка «Имён ПК» под курсором – плашка действий
            nameDraft: null,     // часть имени, которую сейчас вводят: { id узла, raw, part }
            nameSaving: false,
            nameKeep: {},        // «своё имя»: id ПК → { name, location_id, by, at }
            nameSelId: null,     // узел, выбранный на вкладке «Имена ПК»: справа – его ПК (этап 36)
            treeWidth: 480,
            treeHover: null,
            treeScrollbar: 0,

            // История
            historyLoading: false,
            historyError: "",
            historyItems: [],
            historyQuery: "",
            // Всего записей и записей по дням (с сервера, точные, даже если
            // загружена только часть – сначала 200, остальное по кнопке)
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
            usersHover: null,    // строка под курсором – плашка действий
            ownPassword: null,   // форма смены своего пароля в меню пользователя
            ownProfile: null,    // форма «Редактировать» (логин, ФИО, должность) там же
            ownMenu: false,      // открыт список ✎ ▾ в меню пользователя

            scanSources: [],     // источники: GLPI, GSIT, Jabber, DHCP, Сеть (с сервера)
            scanForms: {},       // формы источников: kind → поля формы
            scanKeyReady: true,  // есть ли ключ шифрования паролей в .env
            scanError: "",
            scanSubnets: [],
            scanUncovered: [],   // подсети /24 с ПК из базы, которых нет в списке
            scanBuildings: [],
            scanPurposes: {},
            subnetBar: null,     // строка под панелью: новая подсеть / изменить
            subnetHover: null,   // подсеть под курсором – плашка действий
            // Этап 25: вкладки страницы, сбор и сопоставление
            // check – проверка, names – названия, schedule – расписание, settings – подключения и подсети
            scanTab: "check",
            scanRuns: {},        // kind → запуск сбора, за которым следим
            scanPollTimer: null,
            // Этап 26г: «Проверка» – записи GLPI и GSIT по ПК и предложения сканера
            check: {
                data: null,      // { glpi, gsit } – ответы /api/scan/records
                loading: false,
                error: "",
                filter: "all",   // all / todo / unknown / diff / ok / none / rejected
                fields: [],      // «Фильтр»: только строки с предложениями по этим полям
                pair: null,      // «ещё у N ПК»: { field, table, raw }
                open: null,      // ключ раскрытой строки (одна)
                hover: null,     // строка под курсором – плашка действий
                selected: [],    // ключи выделенных строк
                anchor: null     // строка, от которой идёт Shift+клик
            },
            scanMatchQuery: "",  // поиск на «Проверке» и «Названиях»
            // Страница «Vacuum» – пользователи Jabber (/api/scan/jabber)
            vacuum: { data: null, loading: false, error: "", filter: "all" },
            // Вкладка «Сеть»: адреса из DHCP и прохода подсетей (/api/scan/hosts)
            net: { data: null, loading: false, error: "", filter: "all", source: null },
            // Общие настройки (/api/settings): VNC по умолчанию
            appSettings: { vnc_default: "tight" },
            undone: [],          // что отменил Ctrl+Z – для возврата Ctrl+Y
            undoBusy: false,
            vacuumQuery: "",
            scanNames: { items: [], loading: false, error: "", hover: null },
            // «Расписание»: настройка каждого источника и журнал запусков (/api/scan/schedule, /api/scan/runs)
            schedule: { items: [], minutes: [], runs: [], loading: false, error: "", hover: null },
            // Этапы 26б–26г: значения сканера в Таблице (кнопка на панели)
            scanOverlay: false,
            scanLegend: false,   // подсказка «что значат цвета» у включённой кнопки
            scanPop: null,       // карточка действий у блочка значения сканера
            scanMarks: [],       // /api/scan/marks – вид пометок по ситуациям
            tableMarks: [],      // /api/table-marks – вид выделений значений в Таблице (этап 26к)
            scanOnlyRows: false, // воронка у кнопки «Значения сканера»: только строки с предложениями
            // Этап 35: имена по правилам в Таблице (кнопка на панели)
            nameCheck: false,
            nameOnlyRows: false, // воронка у кнопки: только ПК с именем не по правилу
            namePop: null,       // карточка у блочка с именем по правилу
            valueEdit: null,     // правка значения ПК в подробностях «Проверки»
            diffs: {
                items: [],          // /api/scan/diffs (и отклонённые – с rejected_by)
                count: 0,           // расхождений без отклонённых – на кнопке
                rejected: 0,
                sources: [],
                antivirus: {},      // столбец «Антивирусы»: id ПК → [{ name, status, version, source }]
                links: {},          // столбец с номером записи (glpi_id, gsit_id) → начало ссылки
                vacuumMissing: [],  // логины VACUUM из таблицы, которых нет в Jabber
                vacuumStale: {},    // давно не подключавшиеся: логин → сколько дней (null – никогда)
                jabber: {},         // кого Jabber видит с адреса ПК: id ПК → логины
                net: {},            // что о ПК видно в сети (DHCP, проход подсетей): id ПК → { ip, mac, hostname }
                verified: {},       // ПК, проверенные и GLPI / GSIT, и сетью: id ПК → чем
                checked: {},        // …проверенные одним из них (этап 38)
                loading: false,
                error: "",
            },
            avSettings: null,    // /api/scan/antivirus – вид и что показывать в столбце «Антивирусы»
            avRename: null,      // правка своего названия антивируса в Справочниках: { key, source, value }
            scanLinkBar: null,   // «Привязать запись к ПК:» – строка под панелью

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
            activeRowId: null,      // последняя нажатая строка: Enter – VNC, Alt+P – ping, Alt+R – RDP
            dupVersion: 0,          // пересчитаны дубли – пересчитать заливку ячеек
            altDown: false,         // зажат Alt – клик копирует значение
            copyHint: null,         // подсветка значения под курсором при Alt
            newFieldDef: { key: "", label: "", field_type: "text" }
        };
    },

    async mounted() {
        window.itdbTable = this;
        this.hoverRowEl = null;
        this.activeRowEl = null;
        this.lastMouseX = undefined;
        this.lastMouseY = undefined;
        this.rafId = null;
        await this.checkAuth();
        this.authChecked = true;
        if (this.user) {
            await this.$nextTick();
            this.snapNavUser();
            window.addEventListener("resize", () => { this.snapNavUser(); this.updateStickyShadow(); });
            window.addEventListener("resize", () => { this.scanFitCompare(); this.placeCheckPlate(); });
            await Promise.all([this.loadColumns(), this.loadChoices(), this.loadColumnStyles(), this.loadFieldDefs()]);
            await this.loadTable();
            this.watchTableFit();
            this.loadDiffs();
            this.loadScanMarks();
            this.loadAvSettings();
            this.loadTableMarks();
            this.loadAppSettings();
            // Страница из адреса (#scan/net, #table?pc=12): ссылки открываются в новой вкладке
            window.addEventListener("hashchange", () => this.applyHash());
            this.applyHash();
        }
    }
});

app.component("tree-node", treeNode);
app.component("style-controls", styleControls);
app.component("tree-form", treeForm);
app.component("location-picker", locationPicker);
app.component("count-select", countSelect);

app.mount("#app");
