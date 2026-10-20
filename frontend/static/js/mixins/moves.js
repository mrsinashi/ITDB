// Журналы (этап 66): вкладка «Движение» – получение и установка техники и компонентов.
// Таблица – та же, что у Компьютеров и Принтеров (tableKind = "moves", mixins/printers.js),
// строки – /api/moves (признак строки _move, ключ вспышки – «m» + id).
//
// Окно записи (добавить и изменить, просьба пользователя 15.10) – с затемнением; сворачивается
// в полоску заголовка, которую можно двигать мышью (видна на всех страницах), и разворачивается
// обратно по центру с затемнением. Пока тип не выбран – окно посередине экрана; с типом – выше и
// растёт вниз по мере содержимого. Тип – из справочника техники или компонентов (что выбрали в
// «Добавить») или новый. «Понятное название» – «Своё название (поля типа; …)» (moveTitle – так же,
// как move_title в api_moves.py; столбец – «Своё название»). Даты – частями
// (components/date-parts.js). Запись правится только в этом окне: клик по названию, двойной
// клик по любой ячейке строки (правки 2), Enter.
// Правки этапа 66: тело – как таблица карточки (значения прямо в ячейках); списки подсказок – по
// клику, вводу или ↓, не по фокусу; фокус после типа – на «Название по 1С». Правки 2: без
// анимаций; нажатие мимо окна – свернуть (есть несохранённое) или закрыть; копия записи.
// Этап 67: IP у компьютера, принтера и МФУ; «Установить» у записи – окошко поверх окна записи
// (кабинет, ПК или принтер – заменить или после него, дата, кто установил, «В архив»); у
// компьютера, принтера и МФУ после него – своя вкладка со строкой добавления из записи.

import { apiFetch, fixIpTyping, searchNorm, setIfChanged } from "../util.js";
import { keepSameRows, refreshDuplicates } from "../columns.js";

// Поля по виду типа – как FORM_FIELDS в api_moves.py (комплект и IP – не в названии, свои столбцы)
const FORM_FIELDS = {
    computer: ["pc_kind", "cpu", "ram", "disk_kind", "disk_size", "gpu", "kit", "move_ip"],
    monitor: ["diagonal", "resolution"],
    disk: ["disk_kind", "interface", "size"],
    ram: ["ram_kind", "freq", "size"],
    printer: ["move_ip"],
    info: ["info"]
};

// Строки окна для полей типа: подпись, поле (key2 – вторая часть той же ячейки), единица –
// сразу за числом
const FORM_ROWS = {
    computer: [
        { label: "Тип", key: "pc_kind" },
        { label: "Процессор", key: "cpu" },
        { label: "ОЗУ", key: "ram", unit: "Гб" },
        { label: "Диск", key: "disk_kind", key2: "disk_size", unit: "Гб" },
        { label: "Видеокарта", key: "gpu" },
        { label: "Комплект", key: "kit" }
    ],
    monitor: [
        { label: "Диагональ", key: "diagonal", unit: "дюйм." },
        { label: "Разрешение", key: "resolution" }
    ],
    disk: [
        { label: "Тип", key: "disk_kind" },
        { label: "Интерфейс", key: "interface" },
        { label: "Объём", key: "size", unit: "Гб" }
    ],
    ram: [
        { label: "Тип", key: "ram_kind" },
        { label: "Частота", key: "freq", unit: "Мгц" },
        { label: "Объём", key: "size", unit: "Гб" }
    ],
    printer: [],
    info: [{ label: "Информация", key: "info" }]
};

// Подсказки: готовые варианты (из журнала пользователя), потом – что уже вписывали
const PRESETS = {
    disk_kind: ["SSD", "HDD"],
    interface: ["SATA", "M2/NVME"],
    ram_kind: ["DDR3", "DDR4", "DDR5"],
    source: ["Склад"],
    kit: ["Мышь", "Клавиатура"]
};
// Подсказки только из записей того же типа (просьба пользователя: «Название по 1С» – по типу)
const SAME_TYPE = ["name_1c", "model"];
// Комплект – через запятую: список дописывает, а не заменяет (как картриджи, этап 47)
const KIT = "kit";
// IP (этап 67) – свой ключ: у ПК и принтеров «ip» оформляется подсетями
const IP = "move_ip";
// Что новый ПК берёт из записи («Установить», этап 67), кроме места и IP: поле ПК → как взять
const PC_FROM_MOVE = {
    inv_no: function (row) { return row.inv_no; },
    serial: function (row) { return row.serial; },
    type: function (row) { return row.specs.pc_kind; },
    model: function (row) { return row.model; },
    cpu: function (row) { return row.specs.cpu; },
    ram: function (row) { return row.specs.ram; },
    drive: function (row) { return [row.specs.disk_kind, row.specs.disk_size].filter(Boolean).join(" "); },
    gpu: function (row) { return row.specs.gpu; }
};
// У полей компьютера – ещё значения Таблицы ПК (справочник и данные)
const PC_FIELDS = { pc_kind: "type", cpu: "cpu", gpu: "gpu" };

// Даты записи: dmy – день, месяц, год; my – месяц и год
const DATE_PARTS = { made: "my", bought: "my", received: "dmy", installed: "dmy" };
const DATE_LABELS = { made: "Дата производства", bought: "Дата закупки", received: "Дата получения", installed: "Дата установки" };
const TEXT_FIELDS = ["name_1c", "model", "inv_no", "serial", "country", "supplier", "source", "move_status", "note"];

const NUMBER = /^\d+(?:[.,]\d+)?$/;

// Окно с типом – на этой высоте от верха экрана
const WIN_TOP = 56;

function withUnit(value, unit, space) {
    if (!value) {
        return "";
    }
    return NUMBER.test(value) ? value + (space === false ? "" : " ") + unit : value;
}

// «Понятное название» – как move_title в api_moves.py: своё название и в скобках поля типа
// (у принтера – модель из справочника)
export function moveTitle(form, model, specs, printerTitle) {
    const get = function (key) { return String((specs || {})[key] || "").trim(); };
    let parts;
    if (form === "printer") {
        parts = [printerTitle || ""];
    } else if (form === "computer") {
        parts = [get("pc_kind"), get("cpu"), withUnit(get("ram"), "Гб"), [get("disk_kind"), get("disk_size")].filter(Boolean).join(" "), get("gpu")];
    } else if (form === "monitor") {
        parts = [withUnit(get("diagonal"), "\"", false), get("resolution")];
    } else if (form === "disk") {
        parts = [get("disk_kind"), get("interface"), withUnit(get("size"), "Гб")];
    } else if (form === "ram") {
        parts = [get("ram_kind"), withUnit(get("freq"), "Мгц"), withUnit(get("size"), "Гб")];
    } else {
        parts = [get("info")];
    }
    const inner = parts.filter(Boolean).join("; ");
    const name = String(model || "").trim();
    if (name && inner) {
        return name + " (" + inner + ")";
    }
    return name || inner;
}

// «02.08.2026», «08.2025», «2026» → { d, m, y }
function dateParts(text) {
    const parts = String(text || "").split(".").filter(Boolean).map(Number);
    const y = parts.length ? parts[parts.length - 1] : null;
    const m = parts.length > 1 ? parts[parts.length - 2] : null;
    const d = parts.length > 2 ? parts[0] : null;
    return { d: d || null, m: m || null, y: y || null };
}

function todayParts() {
    const now = new Date();
    return { d: now.getDate(), m: now.getMonth() + 1, y: now.getFullYear() };
}

function pad(n) {
    return n < 10 ? "0" + n : String(n);
}

// { d, m, y } → «ДД.ММ.ГГГГ» / «ММ.ГГГГ» / «ГГГГ»; пусто – ""
function dateText(p) {
    if (!p || !p.y) {
        return "";
    }
    if (!p.m) {
        return String(p.y);
    }
    return (p.d ? pad(p.d) + "." : "") + pad(p.m) + "." + p.y;
}

// Чего не хватает дате: день без месяца, месяц без года
function dateProblem(p) {
    if (p && p.d && !p.m) {
        return "нет месяца";
    }
    if (p && (p.d || p.m) && !p.y) {
        return "нет года";
    }
    return "";
}

function emptyForm() {
    return {
        type_id: null, name_1c: "", model: "", printer_model_id: null, specs: {},
        inv_no: "", serial: "", country: "", supplier: "", source: "", move_status: "", note: "",
        made: dateParts(null), bought: dateParts(null), received: dateParts(null), installed: dateParts(null),
        dest: null, installer_user_id: null, installer: ""
    };
}

function formOf(row) {
    const form = emptyForm();
    form.type_id = row.type_id;
    TEXT_FIELDS.forEach(function (key) { form[key] = row[key] || ""; });
    form.printer_model_id = row.printer_model_id || null;
    form.specs = Object.assign({}, row.specs || {});
    // Несколько IP – в базе строками, в поле окна (одна строка) – через запятую
    if (form.specs[IP]) {
        form.specs[IP] = String(form.specs[IP]).split("\n").join(", ");
    }
    Object.keys(DATE_PARTS).forEach(function (key) { form[key] = dateParts(row[key]); });
    form.dest = row.dest_ref || null;
    form.installer_user_id = row.installer_user_id || null;
    form.installer = row.installer_user_id ? "" : (row.installer || "");
    return form;
}

export default {
    data() {
        return {
            journalTab: "moves",
            moveRows: [],
            movesLoaded: false,
            movesError: "",
            // Описание столбцов журнала – с сервера (GET /api/columns)
            moveColumns: [],
            moveHistoryLabels: {},
            // Типы техники и компонентов (/api/item-types)
            itemTypes: [],
            // Кого можно выбрать в «Установил» (/api/moves/installers, редактору)
            moveInstallers: [],
            // Окно записи: { mode: add / edit, kind: tech / part, id, version, archived, min, form,
            // orig, installerText, error, saving, many, newModel }
            moveWin: null,
            // «Установить» (этап 67): { place – id узла, device – id ПК или принтера, replace,
            // installed – { d, m, y }, installer_user_id, installer, installerText, archive, error, saving }
            moveInstall: null,
            // Где свёрнутое окно (перетащили – там и остаётся до перезагрузки страницы): { x, y }
            moveBarPos: null
        };
    },

    computed: {
        // Окно открыто и не свёрнуто – интерфейс за ним затемнён
        moveWinOpen() {
            return !!this.moveWin && !this.moveWin.min;
        },

        moveWinType() {
            const win = this.moveWin;
            const id = win ? win.form.type_id : null;
            return id ? this.itemTypes.find(function (t) { return t.id === id; }) || null : null;
        },

        moveWinForm() {
            const type = this.moveWinType;
            return type && FORM_FIELDS[type.form] ? type.form : "info";
        },

        moveFormRows() {
            return this.moveWinType ? FORM_ROWS[this.moveWinForm] : [];
        },

        // IP – у компьютера, принтера и МФУ (этап 67)
        moveWinHasIp() {
            return !!this.moveWinType && FORM_FIELDS[this.moveWinForm].indexOf(IP) !== -1;
        },

        // «Установить»: кроме кабинета – ПК (у компьютера и компонента) или принтер (у принтера и
        // МФУ); другая техника ставится только в узел
        moveInstallKind() {
            const type = this.moveWinType;
            if (!type) {
                return null;
            }
            if (type.kind === "part" || this.moveWinForm === "computer") {
                return "pc";
            }
            return this.moveWinForm === "printer" ? "printer" : null;
        },

        // «Заменить» – у компьютера, принтера и МФУ; компонент в ПК просто ставится. Заменённый
        // уходит в архив, потом – строка нового: нужна правка «Компьютеров» / «Принтеров» (этап 69)
        moveInstallCanReplace() {
            const kind = this.moveInstallKind;
            return !!this.moveWinType && this.moveWinType.kind === "tech" && !!kind && (kind === "pc" ? this.canEditPc : this.canEditPrinters);
        },

        // ПК или принтеры для «Установить»: рабочие, в выбранном узле и под ним – «№2 buh-3»; где
        // стоит – если не в самом выбранном узле
        moveInstallDevices() {
            const inst = this.moveInstall;
            const pc = this.moveInstallKind === "pc";
            if (!inst || !this.moveInstallKind) {
                return [];
            }
            const list = [];
            (pc ? this.rows : this.printerRows).forEach((row) => {
                if (row.archived || (inst.place && !this.inLocation(row.location_id, inst.place))) {
                    return;
                }
                const entry = this.treeIndex[row.location_id];
                const number = pc ? row.seat_no : row.number;
                const name = pc ? row.hostname || "ПК без имени" : row.name || row.model_title || "Принтер без имени";
                const path = (number ? "№" + number + " " : "") + name + (entry && row.location_id !== inst.place ? " – " + entry.path : "");
                list.push({ id: row.id, kind: pc ? "pc" : "printer", path: path, search: searchNorm([path, entry && entry.path, row.inv_no, row.ip].filter(Boolean).join(" ")) });
            });
            return list;
        },

        moveWinTitle() {
            const win = this.moveWin;
            if (!win) {
                return "";
            }
            if (win.mode === "add") {
                return win.kind === "part" ? "Новый компонент" : "Новая техника";
            }
            return "Запись журнала";
        },

        // «Понятное название» в окне – как получится в таблице
        moveTitlePreview() {
            const win = this.moveWin;
            if (!win || !this.moveWinType) {
                return "";
            }
            const model = win.form.printer_model_id ? this.printerModelById.get(win.form.printer_model_id) : null;
            return moveTitle(this.moveWinForm, win.form.model, win.form.specs, model ? model.title : "");
        },

        // Типы того же вида (техника или компоненты), что окно
        moveTypeOptions() {
            const kind = this.moveWin ? this.moveWin.kind : null;
            return this.itemTypes.filter(function (t) { return t.kind === kind; }).map(function (t) {
                return { id: t.id, kind: "type", path: t.name, search: searchNorm(t.name) };
            });
        },

        // «Куда»: узлы дерева; компоненту – ещё рабочие ПК
        moveDestOptions() {
            const list = this.locationOptions.map(function (o) {
                return Object.assign({}, o, { id: "l:" + o.id });
            });
            if (!this.moveWin || this.moveWin.kind !== "part") {
                return list;
            }
            this.rows.forEach((row) => {
                if (row.archived) {
                    return;
                }
                const entry = this.treeIndex[row.location_id];
                const path = (row.hostname || "ПК без имени") + (entry ? " – " + entry.path : "");
                list.push({ id: "c:" + row.id, kind: "pc", path: path, search: searchNorm([path, row.inv_no].filter(Boolean).join(" ")) });
            });
            return list;
        },

        // Окно с записью: на экране что-то поменяли (у новой записи один выбранный тип – не в счёт;
        // набранная новая модель принтера – в счёт)
        moveWinDirty() {
            const win = this.moveWin;
            if (!win) {
                return false;
            }
            if (win.newModel && (win.newModel.maker.trim() || win.newModel.model.trim())) {
                return true;
            }
            const form = win.mode === "add" ? Object.assign({}, win.form, { type_id: win.orig.type_id }) : win.form;
            return JSON.stringify(form) !== JSON.stringify(win.orig);
        },

        moveWinStyle() {
            const win = this.moveWin;
            if (!win) {
                return null;
            }
            if (win.min) {
                const pos = this.moveBarPos;
                // Окно браузера сузили – полоска не уходит за край
                return pos ? { left: "min(" + pos.x + "px, calc(100vw - 340px))", top: "min(" + pos.y + "px, calc(100vh - 40px))", bottom: "auto" } : null;
            }
            return win.form.type_id ? { top: WIN_TOP + "px", maxHeight: "calc(100vh - " + (WIN_TOP + 16) + "px)" } : null;
        }
    },

    methods: {
        // ---------- Загрузка ----------

        // Открыли «Журналы»: журнал, типы; редактору – модели принтеров и пользователи для окна
        openJournals() {
            this.loadMoves();
            this.loadItemTypes();
            if (this.canEdit) {
                if (!this.printerModels.length) {
                    this.loadPrinterModels();
                }
                this.loadMoveInstallers();
            }
        },

        async loadMoves() {
            this.startLoading();
            this.movesError = "";
            try {
                const response = await apiFetch("/api/moves?archived=all");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const rows = (await response.json()).rows || [];
                rows.forEach(function (row) { row._move = true; });
                // Неизменившиеся строки – прежние объекты (этап 59)
                const next = keepSameRows(this.moveRows, rows);
                if (next) {
                    this.moveRows = next;
                    if (refreshDuplicates(next, this.moveColumns, "moves")) {
                        this.dupVersion++;
                    }
                }
                this.movesLoaded = true;
                if (this.tableKind === "moves") {
                    this.recalcWidths();
                }
            } catch (e) {
                this.movesError = String(e.message || e);
            }
            this.finishLoading();
        },

        async loadItemTypes() {
            try {
                const response = await apiFetch("/api/item-types");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                setIfChanged(this, "itemTypes", (await response.json()).items || []);
            } catch (e) {
                this.toastError("Не удалось загрузить типы: " + (e.message || e));
            }
        },

        async loadMoveInstallers() {
            try {
                const response = await apiFetch("/api/moves/installers");
                if (response.ok) {
                    setIfChanged(this, "moveInstallers", (await response.json()).items || []);
                }
            } catch (e) {
                // список для выбора – не главное: вписать имя можно и так
            }
        },

        // ---------- Окно записи ----------

        // «Добавить» → «Техника» / «Компонент». Окно уже открыто (свёрнуто) – развернуть его
        openMoveAdd(kind) {
            this.closeMenus();
            if (this.moveWin) {
                if (this.moveWin.mode === "add" && !this.moveWin.form.type_id) {
                    this.moveWin.kind = kind;
                }
                this.restoreMoveWin();
                return;
            }
            this.prepareMoveWin();
            this.moveWin = {
                mode: "add", kind: kind, id: null, version: null, min: false,
                form: emptyForm(), orig: emptyForm(), installerText: "", error: "", saving: false, many: false, newModel: null
            };
            this.$nextTick(() => this.focusMoveField("type"));
        },

        // Запись из таблицы (клик по названию, двойной клик по ячейке, Enter): field – что
        // правили, на нём – фокус. Читателю окно не нужно – всё видно в таблице
        openMoveRecord(row, field) {
            if (!this.canEdit) {
                return;
            }
            if (this.moveWin && this.moveWin.mode === "edit" && this.moveWin.id === row.id) {
                this.restoreMoveWin();
                return;
            }
            // Свёрнуто другое окно с правками – сначала его (несохранённое не теряется молча)
            if (this.moveWin && this.moveWinDirty) {
                this.toast("Сначала сохрани или закрой окно записи");
                this.restoreMoveWin();
                return;
            }
            this.prepareMoveWin();
            const form = formOf(row);
            this.moveWin = {
                mode: "edit", kind: row.type_kind || "tech", id: row.id, version: row.version, archived: !!row.archived, min: false,
                form: form, orig: formOf(row), installerText: row.installer || "", error: "", saving: false, many: false, newModel: null
            };
            this.$nextTick(() => this.focusMoveField(field));
        },

        prepareMoveWin() {
            this.cancelEdit();
            this.closeSuggest();
            this.ensureTree();
            if (!this.itemTypes.length) {
                this.loadItemTypes();
            }
            if (!this.printerModels.length) {
                this.loadPrinterModels();
            }
            if (!this.moveInstallers.length) {
                this.loadMoveInstallers();
            }
        },

        // Фокус на поле окна: type, model (своё название), printer_model, поле типа, kit, дата
        // (первая часть), dest, installer…; без поля – тип, пока его нет, а с типом – само окно
        // (развернули свёрнутое – Esc сразу закрывает окно, а не уходит в поле)
        focusMoveField(field) {
            const box = this.$refs.moveWinBody;
            if (!box || !this.moveWin) {
                return;
            }
            const first = this.moveWin.form.type_id ? "name_1c" : "type";
            if (!field && this.moveWin.form.type_id) {
                box.focus({ preventScroll: true });
                return;
            }
            const key = field === "item_type" ? "type" : (field === "title" ? "model" : field || first);
            let el = box.querySelector('[data-mf="' + key + '"]');
            if (!el || el.offsetParent === null) {
                el = box.querySelector('[data-mf="' + first + '"]');
            }
            const input = el && (el.matches("input, textarea, [tabindex]") ? el : el.querySelector("input, textarea, [tabindex]"));
            if (input) {
                input.focus({ preventScroll: true });
                if (input.scrollIntoView) {
                    input.scrollIntoView({ block: "nearest" });
                }
            }
        },

        async closeMoveWin() {
            const win = this.moveWin;
            if (!win || win.saving) {
                return;
            }
            if (this.moveWinDirty) {
                const wasMin = win.min;
                win.min = false;
                if (!(await this.confirmDialog("Закрыть без сохранения?", { okText: "Закрыть" }))) {
                    win.min = wasMin;
                    return;
                }
            }
            this.closeSuggest();
            this.moveWin = null;
        },

        // Нажатие мимо окна (по затемнению; правки 2 этапа 66): есть несохранённое – окно
        // сворачивается, нет – закрывается. Второе нажатие двойного клика, которым окно открыли
        // (клик по названию в таблице), – не в счёт
        onMoveOverlayDown(event) {
            const win = this.moveWin;
            if (!win || win.min || win.saving || event.button !== 0 || event.detail > 1) {
                return;
            }
            if (this.moveWinDirty) {
                this.toggleMoveWinMin();
            } else {
                this.closeSuggest();
                this.moveWin = null;
            }
        },

        // Копия записи (кнопка у «Отмены», правки 2 этапа 66): новая запись с теми же полями, что на
        // экране, без инвентарного и серийного номеров, IP, «Куда», даты установки и «Установил»
        async copyMoveWin() {
            const win = this.moveWin;
            if (!win || win.mode !== "edit" || win.saving) {
                return;
            }
            if (this.moveWinDirty && !(await this.confirmDialog("Правки записи не сохранятся. Скопировать?", { okText: "Скопировать" }))) {
                return;
            }
            if (this.moveWin !== win) {
                return;
            }
            const form = JSON.parse(JSON.stringify(win.form));
            Object.assign(form, { inv_no: "", serial: "", dest: null, installed: dateParts(null), installer_user_id: null, installer: "" });
            delete form.specs[IP];
            this.closeSuggest();
            this.moveWin = {
                mode: "add", kind: win.kind, id: null, version: null, min: false,
                form: form, orig: emptyForm(), installerText: "", error: "", saving: false, many: false, newModel: null
            };
            this.$nextTick(() => this.focusMoveField("inv_no"));
        },

        // Свернуть в полоску заголовка / развернуть по центру
        toggleMoveWinMin() {
            if (!this.moveWin) {
                return;
            }
            if (this.moveWin.min) {
                this.restoreMoveWin();
            } else {
                this.closeSuggest();
                if (document.activeElement && this.$refs.moveWin && this.$refs.moveWin.contains(document.activeElement)) {
                    document.activeElement.blur();
                }
                this.moveWin.min = true;
            }
        },

        restoreMoveWin() {
            if (this.moveWin && this.moveWin.min) {
                this.moveWin.min = false;
                this.$nextTick(() => this.focusMoveField(null));
            }
        },

        // Свёрнутое окно – тянуть за заголовок; без сдвига – это нажатие: развернуть
        onMoveBarDown(event) {
            const win = this.moveWin;
            const box = this.$refs.moveWin;
            // Значки шапки («Развернуть», ×) – свои нажатия, не перетаскивание
            if (!win || !win.min || !box || event.button !== 0 || event.target.closest("button, .vh-close")) {
                return;
            }
            event.preventDefault();
            const rect = box.getBoundingClientRect();
            const dx = event.clientX - rect.left;
            const dy = event.clientY - rect.top;
            const startX = event.clientX;
            const startY = event.clientY;
            let moved = false;
            const place = (e) => {
                const x = Math.max(0, Math.min(window.innerWidth - rect.width, e.clientX - dx));
                const y = Math.max(0, Math.min(window.innerHeight - rect.height, e.clientY - dy));
                return { x: Math.round(x), y: Math.round(y) };
            };
            const onMove = (e) => {
                if (!moved && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 4) {
                    return;
                }
                moved = true;
                // На каждое движение – прямо в стиль, в данные – итог (правило производительности)
                const p = place(e);
                box.style.left = p.x + "px";
                box.style.top = p.y + "px";
                box.style.bottom = "auto";
            };
            const onUp = (e) => {
                document.removeEventListener("mousemove", onMove, true);
                document.removeEventListener("mouseup", onUp, true);
                if (moved) {
                    this.moveBarPos = place(e);
                } else {
                    this.restoreMoveWin();
                }
            };
            document.addEventListener("mousemove", onMove, true);
            document.addEventListener("mouseup", onUp, true);
        },

        // ---------- Поля окна ----------

        onMoveType(typeId) {
            const win = this.moveWin;
            if (!win) {
                return;
            }
            const first = !win.form.type_id;
            win.form.type_id = typeId;
            win.error = "";
            win.newModel = null;
            // Тип выбрали – окно встаёт выше; фокус – на следующее поле
            if (first) {
                this.$nextTick(() => this.focusMoveField("name_1c"));
            }
        },

        // «＋ новый тип» в списке типов: набранное – название, поля – «Информация»
        async onMoveTypeAdd(text) {
            const win = this.moveWin;
            const name = String(text || "").trim();
            if (!win) {
                return;
            }
            if (!name) {
                win.error = "Впиши название нового типа.";
                this.$nextTick(() => this.focusMoveField("type"));
                return;
            }
            win.error = "";
            // Такой тип уже есть (набрали и нажали «＋») – он и выбирается
            const same = this.itemTypes.find(function (t) { return t.kind === win.kind && t.name.toLowerCase() === name.toLowerCase(); });
            if (same) {
                this.onMoveType(same.id);
                return;
            }
            try {
                const response = await this.apiSend("/api/item-types", "POST", { name: name, kind: win.kind });
                const created = await response.json();
                await this.loadItemTypes();
                this.toast("Новый тип: " + created.name, "success");
                this.onMoveType(created.id);
            } catch (e) {
                win.error = String(e.message || e);
            }
        },

        moveSpec(key) {
            return this.moveWin ? this.moveWin.form.specs[key] || "" : "";
        },

        setMoveSpec(key, value) {
            if (this.moveWin) {
                this.moveWin.form.specs = Object.assign({}, this.moveWin.form.specs, { [key]: value });
            }
        },

        setMoveDate(key, value) {
            if (this.moveWin) {
                this.moveWin.form[key] = value;
                this.moveWin.error = "";
            }
        },

        moveDateParts(key) {
            return DATE_PARTS[key];
        },

        onMoveDest(value) {
            if (this.moveWin) {
                this.moveWin.form.dest = value;
            }
        },

        onMovePrinterModel(id) {
            if (this.moveWin) {
                this.moveWin.form.printer_model_id = id;
                this.moveWin.newModel = null;
            }
        },

        // IP (этап 67): «ю», «/», «,» – точка; «15.12» – список полных адресов, как у нового ПК
        onMoveIpInput(event) {
            const el = event.target;
            const fixed = fixIpTyping(el, event);
            const value = fixed !== null ? fixed : el.value;
            this.setMoveSpec(IP, value);
            const options = this.ipFullOptions(value);
            if (!options.length) {
                this.closeIpSuggest();
                return;
            }
            this.openSuggestList(el, "ip-full", options, (picked) => {
                this.setMoveSpec(IP, picked);
                this.$nextTick(() => this.focusMoveField(IP));
            });
        },

        // «Установил» – в окне записи и в «Установить» (где: win / install): текст поля
        // (installerText) и что сохранится (installer_user_id или вписанное installer)
        moveInstallerTarget(where) {
            if (where === "install") {
                return this.moveInstall ? { box: this.moveInstall, form: this.moveInstall } : null;
            }
            return this.moveWin ? { box: this.moveWin, form: this.moveWin.form } : null;
        },

        // Набранное – вписанное имя (не пользователь)
        onMoveInstallerInput(event, where) {
            const target = this.moveInstallerTarget(where);
            if (!target) {
                return;
            }
            target.box.installerText = event.target.value;
            target.form.installer_user_id = null;
            target.form.installer = event.target.value;
            if (!this.suggest) {
                this.openMoveInstallerList(event.target, where);
            }
            this.onSuggestInput(event.target.value);
        },

        openMoveInstallerList(el, where) {
            const options = this.moveInstallers.map(function (u) {
                return { key: "u" + u.id, value: u.name, count: u.full_name && u.full_name !== u.name ? u.full_name : "", countTitle: "", userId: u.id };
            });
            this.openSuggestList(el, "installer", options, (value, option) => {
                const target = this.moveInstallerTarget(where);
                if (target && option) {
                    target.box.installerText = option.value;
                    target.form.installer_user_id = option.userId;
                    target.form.installer = "";
                }
            });
        },

        // Подсказки у текстового поля окна: готовые варианты, значения Таблицы ПК (у полей
        // компьютера), потом – что уже вписывали в журнал (с числом записей; название по 1С и
        // своё название – только у записей того же типа, комплект – по частям)
        moveSuggestOptions(key) {
            const counts = new Map();
            const spec = TEXT_FIELDS.indexOf(key) === -1;
            const typeId = this.moveWin ? this.moveWin.form.type_id : null;
            this.moveRows.forEach(function (row) {
                if (row.archived || (SAME_TYPE.indexOf(key) !== -1 && row.type_id !== typeId)) {
                    return;
                }
                const text = String((spec ? (row.specs || {})[key] : row[key]) || "");
                (key === KIT ? text.split(",") : [text]).forEach(function (part) {
                    const value = part.trim();
                    if (value) {
                        const k = value.toLowerCase();
                        const was = counts.get(k);
                        counts.set(k, { value: was ? was.value : value, n: (was ? was.n : 0) + 1 });
                    }
                });
            });
            const list = [];
            const seen = new Set();
            const add = function (value, n) {
                const k = String(value).toLowerCase();
                if (!seen.has(k)) {
                    seen.add(k);
                    const found = counts.get(k);
                    list.push({ key: k, value: found ? found.value : value, count: found ? found.n : (n || ""), countTitle: "Записей в журнале" });
                }
            };
            (PRESETS[key] || []).forEach(function (value) { add(value); });
            const pcField = PC_FIELDS[key];
            if (pcField) {
                (this.choicesByField[pcField] || []).forEach(function (ch) { add(ch.value); });
                this.rows.forEach(function (row) {
                    if (!row.archived && row[pcField]) {
                        add(String(row[pcField]).trim());
                    }
                });
            }
            Array.from(counts.keys()).sort().forEach(function (k) { add(counts.get(k).value); });
            return list.filter(function (o) { return o.value; });
        },

        openMoveSuggest(event, key) {
            const win = this.moveWin;
            if (!win) {
                return;
            }
            const el = event.target;
            const spec = TEXT_FIELDS.indexOf(key) === -1;
            if (key === KIT) {
                this.openTokenSuggest(el, key, this.moveSuggestOptions(key));
                return;
            }
            this.openSuggestList(el, key, this.moveSuggestOptions(key), (value) => {
                if (spec) {
                    this.setMoveSpec(key, value);
                } else {
                    win.form[key] = value;
                }
            });
        },

        onMoveSuggestInput(event, key) {
            if (!this.suggest) {
                this.openMoveSuggest(event, key);
            }
            this.onSuggestInput(event.target.value);
        },

        // Enter в поле окна – добавить / сохранить (открытый список забирает Enter себе); ↓ без
        // списка – открыть подсказки поля key
        onMoveFieldKeydown(event, key) {
            const listOpen = !!this.suggest;
            if (this.suggestKeydown(event)) {
                return;
            }
            if (event.key === "ArrowDown" && key && !listOpen) {
                event.preventDefault();
                if (key === "installer") {
                    this.openMoveInstallerList(event.target);
                } else {
                    this.openMoveSuggest(event, key);
                }
                return;
            }
            // Esc при открытом списке закрывает только список, не окно
            if (event.key === "Escape" && listOpen) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (event.key === "Enter" && !event.shiftKey && event.target.tagName !== "TEXTAREA") {
                event.preventDefault();
                this.submitMoveWin();
            }
        },

        // ---------- Новая модель принтера из окна ----------

        openMoveNewModel(text) {
            const win = this.moveWin;
            if (!win) {
                return;
            }
            const words = String(text || "").trim().split(/\s+/).filter(Boolean);
            const makers = new Set(this.printerModels.map(function (m) { return (m.maker || "").toLowerCase(); }).filter(Boolean));
            const maker = words.length > 1 && makers.has(words[0].toLowerCase()) ? words.shift() : "";
            const type = this.moveWinType;
            const kind = type && type.name.trim().toLowerCase() === "мфу" ? "mfu" : "printer";
            win.newModel = { kind: kind, maker: maker, model: words.join(" "), color: false, duplex: false, error: "", saving: false };
            this.$nextTick(() => this.focusMoveField(maker ? "nm-model" : "nm-maker"));
        },

        async submitMoveNewModel() {
            const win = this.moveWin;
            const form = win ? win.newModel : null;
            if (!form || form.saving) {
                return;
            }
            form.saving = true;
            form.error = "";
            try {
                const response = await this.apiSend("/api/printer-models", "POST", { kind: form.kind, maker: form.maker, model: form.model, color: form.color, duplex: form.duplex });
                const saved = await response.json();
                await this.loadPrinterModels();
                this.toast("Модель добавлена: " + saved.title, "success");
                this.onMovePrinterModel(saved.id);
            } catch (e) {
                form.error = String(e.message || e);
                form.saving = false;
            }
        },

        onMoveNewModelKeydown(event) {
            // Список производителей забирает ↑↓, Enter и Esc себе
            this.onMakerKeydown(event);
            if (event.defaultPrevented) {
                return;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                this.submitMoveNewModel();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                this.moveWin.newModel = null;
            }
        },

        // ---------- Сохранить ----------

        // Что отправить на сервер: поля окна по виду типа (у принтера – ещё модель справочника)
        movePayload(form, typeForm) {
            const payload = { type_id: form.type_id };
            TEXT_FIELDS.forEach(function (key) {
                payload[key] = String(form[key] || "").trim();
            });
            if (typeForm === "printer") {
                payload.printer_model_id = form.printer_model_id || null;
            }
            FORM_FIELDS[typeForm].forEach(function (key) {
                payload[key] = String(form.specs[key] || "").trim();
            });
            Object.keys(DATE_PARTS).forEach(function (key) {
                payload[key] = dateText(form[key]);
            });
            payload.dest = form.dest || "";
            if (form.installer_user_id) {
                payload.installer_user_id = form.installer_user_id;
            } else {
                payload.installer_user_id = null;
                payload.installer = String(form.installer || "").trim();
            }
            return payload;
        },

        // Правка записи: что в окне изменено (только это уходит на сервер)
        moveWinEdits(win) {
            const payload = this.movePayload(win.form, this.moveWinForm);
            const origType = this.itemTypes.find(function (t) { return t.id === win.orig.type_id; });
            const before = this.movePayload(win.orig, origType && FORM_FIELDS[origType.form] ? origType.form : "info");
            const changed = {};
            Object.keys(payload).forEach(function (key) {
                if (JSON.stringify(payload[key]) !== JSON.stringify(before[key])) {
                    changed[key] = payload[key];
                }
            });
            if ("installer" in changed || "installer_user_id" in changed) {
                changed.installer_user_id = payload.installer_user_id;
                if ("installer" in payload) {
                    changed.installer = payload.installer;
                }
            }
            return changed;
        },

        // Чего не хватает датам окна («Дата получения: нет месяца.»); всё хорошо – пусто. skip –
        // дата, которую не проверять (у «Установить» дата установки – своя, из окошка)
        moveWinDateError(win, skip) {
            for (const key of Object.keys(DATE_PARTS)) {
                const problem = key === skip ? null : dateProblem(win.form[key]);
                if (problem) {
                    return { key: key, text: DATE_LABELS[key] + ": " + problem + "." };
                }
            }
            return null;
        },

        async submitMoveWin() {
            const win = this.moveWin;
            if (!win || win.saving) {
                return;
            }
            const form = win.form;
            if (!form.type_id) {
                win.error = "Выбери тип.";
                this.focusMoveField("type");
                return;
            }
            const dateError = this.moveWinDateError(win);
            if (dateError) {
                win.error = dateError.text;
                this.focusMoveField(dateError.key);
                return;
            }
            let payload = this.movePayload(form, this.moveWinForm);
            if (win.mode === "edit") {
                // Только изменённое (и версия: правку другого пользователя не затереть)
                const changed = this.moveWinEdits(win);
                if (!Object.keys(changed).length) {
                    this.moveWin = null;
                    return;
                }
                payload = Object.assign(changed, { _version: win.version });
            }
            win.error = "";
            win.saving = true;
            try {
                const add = win.mode === "add";
                const response = await apiFetch(add ? "/api/moves" : "/api/moves/" + win.id, {
                    method: add ? "POST" : "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                if (response.status === 409) {
                    await this.loadMoves();
                    win.error = this.mergeFreshMove(win) ? "Запись изменили – значения обновлены, сохрани ещё раз." : "Записи больше нет.";
                    win.saving = false;
                    return;
                }
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                await this.loadMoves();
                this.afterMoveWinSave(win, add ? data.id : win.id, add ? null : data.changes);
            } catch (e) {
                win.error = String(e.message || e);
            }
            win.saving = false;
        },

        // Запись изменили, пока окно было открыто (409): то, что в окне не трогали, – свежее, свои
        // правки остаются; дальше сохранение – от новой версии. Записи нет – false
        mergeFreshMove(win) {
            const row = this.moveRows.find(function (r) { return r.id === win.id; });
            if (!row) {
                return false;
            }
            const fresh = formOf(row);
            const same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
            Object.keys(fresh).forEach(function (key) {
                if (key === "specs") {
                    const specs = Object.assign({}, win.form.specs);
                    const keys = new Set(Object.keys(specs).concat(Object.keys(win.orig.specs), Object.keys(fresh.specs)));
                    keys.forEach(function (k) {
                        if ((win.form.specs[k] || "") === (win.orig.specs[k] || "")) {
                            if (fresh.specs[k]) {
                                specs[k] = fresh.specs[k];
                            } else {
                                delete specs[k];
                            }
                        }
                    });
                    win.form.specs = specs;
                } else if (key !== "installer" && key !== "installer_user_id" && same(win.form[key], win.orig[key])) {
                    win.form[key] = fresh[key];
                }
            });
            // «Установил» – пользователь или имя – одним полем
            if (win.form.installer_user_id === win.orig.installer_user_id && win.form.installer === win.orig.installer) {
                win.form.installer_user_id = fresh.installer_user_id;
                win.form.installer = fresh.installer;
                win.installerText = row.installer || "";
            }
            win.orig = fresh;
            win.version = row.version;
            return true;
        },

        // Сохранили: строка – вспышкой (видна, если на экране журнал); «Несколько» – окно
        // остаётся с теми же полями, кроме инвентарного, серийного и IP
        afterMoveWinSave(win, id, changes) {
            const onPage = this.view === "journals";
            if (onPage) {
                if (changes) {
                    Object.keys(changes).forEach((field) => this.flashCell("m" + id, this.moveChangeColumn(field)));
                } else {
                    this.setArchiveView(false);
                    this.flashRow(id);
                    this.$nextTick(() => {
                        if (!this.scrollToRow(id)) {
                            this.toast("Запись добавлена, но скрыта поиском или фильтром");
                        }
                    });
                }
            }
            if (win.mode === "add") {
                const row = this.moveRows.find(function (r) { return r.id === id; });
                const name = (row && (row.title || row.item_type)) || "запись";
                this.toast((onPage ? "Добавлено: " : "Добавлено в журнал «Движение»: ") + name, "success");
                if (win.many) {
                    win.form.inv_no = "";
                    win.form.serial = "";
                    const specs = Object.assign({}, win.form.specs);
                    delete specs[IP];
                    win.form.specs = specs;
                    win.orig = JSON.parse(JSON.stringify(win.form));
                    this.$nextTick(() => this.focusMoveField("serial"));
                    return;
                }
            }
            if (this.moveWin === win) {
                this.moveWin = null;
            }
        },

        // ---------- «Установить» (этап 67) ----------

        // Кнопка внизу слева у записи: окошко поверх окна – кабинет (и ПК или принтер) из «Куда»,
        // дата установки (пусто – сегодня), кто установил (пусто – тот, кто ставит)
        openMoveInstall() {
            const win = this.moveWin;
            if (!win || win.mode !== "edit" || win.archived || win.saving || !this.moveWinType) {
                return;
            }
            this.closeSuggest();
            this.ensureTree();
            if (this.moveInstallKind === "printer" && !this.printerRows.length) {
                this.loadPrinters();
            }
            if (!this.moveInstallers.length) {
                this.loadMoveInstallers();
            }
            const form = win.form;
            const dest = String(form.dest || "");
            const id = Number(dest.slice(2));
            let place = dest.indexOf("l:") === 0 ? id : null;
            let device = null;
            if (dest.indexOf("c:") === 0) {
                const pc = this.rows.find(function (r) { return r.id === id; });
                if (pc) {
                    place = pc.location_id;
                    device = pc.archived ? null : pc.id;
                }
            }
            const own = !form.installer_user_id && !String(form.installer || "").trim();
            this.moveInstall = {
                place: place, device: device, replace: false,
                installed: form.installed && form.installed.y ? Object.assign({}, form.installed) : todayParts(),
                installer_user_id: own ? this.user.id : form.installer_user_id,
                installer: own ? "" : form.installer,
                installerText: own ? this.navUserName : win.installerText,
                archive: false, error: "", saving: false
            };
            this.$nextTick(() => this.focusMoveInstall(place ? null : "place"));
        },

        // Фокус в окошке: поле (place, device, installer) или – всё заполнено – «Установить» (Enter)
        focusMoveInstall(field) {
            const box = this.$refs.moveInstall;
            if (!box) {
                return;
            }
            const el = field ? box.querySelector('[data-mi="' + field + '"]') : this.$refs.moveInstallOk;
            const target = el && (el.matches("input, button") ? el : el.querySelector("input"));
            if (target) {
                target.focus({ preventScroll: true });
            }
        },

        closeMoveInstall() {
            if (!this.moveInstall || this.moveInstall.saving) {
                return;
            }
            this.closeSuggest();
            this.moveInstall = null;
            this.$nextTick(() => this.focusMoveField(null));
        },

        // Узел locationId – это nodeId или он под ним
        inLocation(locationId, nodeId) {
            for (let e = this.treeIndex[locationId]; e; e = this.treeIndex[e.node.parent_id]) {
                if (e.node.id === nodeId) {
                    return true;
                }
            }
            return false;
        },

        // Выбранный в «Установить» ПК или принтер
        moveInstallRow(id) {
            if (!id) {
                return null;
            }
            const rows = this.moveInstallKind === "printer" ? this.printerRows : this.rows;
            return rows.find(function (r) { return r.id === id; }) || null;
        },

        onMoveInstallPlace(id) {
            const inst = this.moveInstall;
            if (!inst) {
                return;
            }
            inst.place = id;
            inst.error = "";
            // Выбранный ПК или принтер не в этом узле – выбор снимается
            const row = this.moveInstallRow(inst.device);
            if (row && !(id && this.inLocation(row.location_id, id))) {
                inst.device = null;
                inst.replace = false;
            }
        },

        // ПК или принтер выбран – кабинет его
        onMoveInstallDevice(id) {
            const inst = this.moveInstall;
            if (!inst) {
                return;
            }
            inst.device = id;
            inst.error = "";
            const row = this.moveInstallRow(id);
            if (row) {
                inst.place = row.location_id;
            } else {
                inst.replace = false;
            }
        },

        // Enter в окошке – «Установить» (открытый список забирает Enter себе; на кнопке – её нажатие)
        onMoveInstallKeydown(event) {
            if (event.key === "Enter" && !event.defaultPrevented && !event.shiftKey && event.target.tagName !== "BUTTON") {
                event.preventDefault();
                this.submitMoveInstall();
            }
        },

        // «Установил» в окошке: ↓ – список, Esc при открытом списке закрывает только его
        onMoveInstallerKeydown(event) {
            const listOpen = !!this.suggest;
            if (this.suggestKeydown(event)) {
                return;
            }
            if (event.key === "ArrowDown" && !listOpen) {
                event.preventDefault();
                this.openMoveInstallerList(event.target, "install");
            } else if (event.key === "Escape" && listOpen) {
                event.preventDefault();
                event.stopPropagation();
            }
        },

        async submitMoveInstall() {
            const win = this.moveWin;
            const inst = this.moveInstall;
            if (!win || !inst || inst.saving) {
                return;
            }
            if (!inst.place) {
                inst.error = "Выбери кабинет.";
                this.focusMoveInstall("place");
                return;
            }
            const problem = dateProblem(inst.installed);
            const dateError = problem ? { text: "Дата установки: " + problem + "." } : this.moveWinDateError(win, "installed");
            if (dateError) {
                inst.error = dateError.text;
                return;
            }
            const kind = this.moveInstallKind;
            const device = this.moveInstallRow(inst.device);
            const replace = !!device && inst.replace && this.moveInstallCanReplace;
            const location = device ? device.location_id : inst.place;
            // Несохранённые правки окна – вместе с установкой; куда, когда и кто – из окошка
            const edits = this.moveWinEdits(win);
            ["dest", "installed", "installer", "installer_user_id", "move_status"].forEach(function (key) { delete edits[key]; });
            const body = {
                version: win.version,
                edits: edits,
                dest: device && this.moveWinType.kind === "part" ? "c:" + device.id : "l:" + location,
                installed: dateText(inst.installed) || dateText(todayParts()),
                installer_user_id: inst.installer_user_id || null,
                installer: inst.installer_user_id ? "" : String(inst.installer || "").trim(),
                replace_pc: replace && kind === "pc" ? device.id : null,
                replace_printer: replace && kind === "printer" ? device.id : null,
                archive: inst.archive
            };
            // Компьютер, принтер или МФУ – потом строка добавления на своей вкладке
            const ctx = { tech: this.moveInstallCanReplace ? this.moveWinForm : null, device: device, replace: replace, location: location };
            inst.saving = true;
            inst.error = "";
            try {
                const response = await apiFetch("/api/moves/" + win.id + "/install", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (response.status === 409) {
                    await this.loadMoves();
                    inst.error = this.mergeFreshMove(win) ? "Запись изменили – значения обновлены, нажми ещё раз." : "Записи больше нет.";
                    inst.saving = false;
                    return;
                }
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                await this.afterMoveInstall(await response.json(), ctx);
            } catch (e) {
                inst.error = String(e.message || e);
                inst.saving = false;
            }
        },

        // Установили: окна закрываются. Компьютер, принтер или МФУ – своя вкладка и строка
        // добавления с данными записи: место, № (вместо выбранного или после него), IP, ИНВ…
        async afterMoveInstall(data, ctx) {
            const row = data.updated;
            const title = (row && (row.title || row.item_type)) || "запись";
            const device = ctx.device;
            const pc = ctx.tech === "computer";
            this.closeSuggest();
            this.moveInstall = null;
            this.moveWin = null;
            await this.loadMoves();
            const gone = ctx.replace ? "; в архив: " + (pc ? device.hostname || "ПК без имени" : device.name || device.model_title || "принтер без имени") : "";
            this.toast("Установлено: " + title + gone, "success");
            if (!row || !ctx.tech) {
                if (row && !row.archived && this.view === "journals") {
                    Object.keys(data.changes || {}).forEach((field) => this.flashCell("m" + row.id, this.moveChangeColumn(field)));
                }
                return;
            }
            const ip = String(row[IP] || "").split("\n").join(", ");
            if (pc) {
                if (ctx.replace) {
                    await this.loadTable();
                }
                const fields = {};
                Object.keys(PC_FROM_MOVE).forEach(function (key) {
                    const value = String(PC_FROM_MOVE[key](row) || "").trim();
                    if (value) {
                        fields[key] = value;
                    }
                });
                const seat = device && device.seat_no ? Number(device.seat_no) + (ctx.replace ? 0 : 1) : null;
                this.setView("table");
                this.openNewComputer({ location_id: ctx.location, seat_no: seat, ip: ip, fields: fields, tip: this.moveFromTip(title, fields, this.builtinColumns) });
                return;
            }
            if (ctx.replace) {
                await this.loadPrinters();
            }
            const fields = {};
            ["inv_no", "serial"].forEach(function (key) {
                if (row[key]) {
                    fields[key] = row[key];
                }
            });
            // № – вместо выбранного или после него; у МФУ и принтеров свой счёт – другого вида не в счёт
            const model = row.printer_model_id ? this.printerModelById.get(row.printer_model_id) : null;
            const same = device && device.number && (device.kind_key || null) === (model ? model.kind : null);
            this.setView("printers");
            this.openNewPrinter({
                location_id: ctx.location, model_id: row.printer_model_id || null, ip: ip, fields: fields,
                number: same ? Number(device.number) + (ctx.replace ? 0 : 1) : null,
                tip: this.moveFromTip(title, fields, this.printerColumns)
            });
        },

        // Подсказка у строки «Новый компьютер / принтер из журнала»: что ещё запишется
        moveFromTip(title, fields, columns) {
            const lines = ["Запись журнала: " + title];
            Object.keys(fields).forEach(function (key) {
                const col = columns.find(function (c) { return c.field === key; });
                lines.push((col ? col.headerName : key) + ": " + fields[key]);
            });
            return lines.join("\n");
        },

        // Поле Истории → столбец журнала (для вспышки)
        moveChangeColumn(field) {
            if (field === KIT || field === IP) {
                return field;
            }
            if (FORM_FIELDS.computer.concat(FORM_FIELDS.monitor, FORM_FIELDS.disk, FORM_FIELDS.ram, FORM_FIELDS.info).indexOf(field) !== -1 ||
                field === "model" || field === "printer_model") {
                return "title";
            }
            return field;
        }
    }
};
