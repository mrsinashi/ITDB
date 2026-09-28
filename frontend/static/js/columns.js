import { splitMulti } from "./util.js";

export function normalizeKey(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value).trim().toLowerCase();
}

let duplicateSets = {
    ip: new Set(),
    mac: new Set(),
    hostname: new Set(),
    inv_no: new Set(),
    vacuum: new Set()
};

export function buildDuplicateSets(rows) {
    const counters = {
        ip: {},
        mac: {},
        hostname: {},
        inv_no: {},
        vacuum: {}
    };

    function add(field, value) {
        const key = normalizeKey(value);
        if (!key) {
            return;
        }
        counters[field][key] = (counters[field][key] || 0) + 1;
    }

    rows.forEach(function (row) {
        if (row.archived) {
            return; // ПК из архива дублей не создают
        }
        splitMulti(row.ip).forEach(function (value) { add("ip", value); });
        splitMulti(row.mac).forEach(function (value) { add("mac", value); });
        if (row.hostname) add("hostname", row.hostname);
        if (row.inv_no) add("inv_no", row.inv_no);
        splitMulti(row.vacuum).forEach(function (value) { add("vacuum", value); });
    });

    function makeSet(counter) {
        return new Set(
            Object.keys(counter).filter(function (key) {
                return counter[key] > 1;
            })
        );
    }

    return {
        ip: makeSet(counters.ip),
        mac: makeSet(counters.mac),
        hostname: makeSet(counters.hostname),
        inv_no: makeSet(counters.inv_no),
        vacuum: makeSet(counters.vacuum)
    };
}

export function hasDuplicateValue(value, field) {
    if (value === null || value === undefined || value === "") {
        return false;
    }
    const set = duplicateSets[field];
    if (!set) {
        return false;
    }
    const multiFields = ["ip", "mac", "vacuum"];
    let values;
    if (multiFields.indexOf(field) !== -1) {
        values = splitMulti(value);
    } else {
        values = [String(value)];
    }
    return values.some(function (item) {
        return set.has(normalizeKey(item));
    });
}

// Пересчитать дубли (после загрузки и правки строк)
export function refreshDuplicates(rows) {
    duplicateSets = buildDuplicateSets(rows);
}

export const kindLabels = {
    building: "Адрес",
    department: "Отделение",
    floor: "Этаж",
    room: "Кабинет"
};

// ============================================================
// Определения столбцов таблицы
// ============================================================

// values: false — значения почти всегда уникальны, в «Справочниках»
// у такого столбца настраивается только оформление столбца целиком.
export const COLUMN_DEFS = [
    { field: "user", headerName: "ФИО", editable: true, values: false },
    // location: правка — выбор узла дерева (двойной клик в режиме правки)
    { field: "building", headerName: "Адрес", location: true },
    { field: "department", headerName: "Отделение", location: true },
    { field: "floor", headerName: "Эт.", fullName: "Этаж", center: true, location: true },
    { field: "room_code", headerName: "Каб", fullName: "№ Кабинета", center: true, values: false, location: true },
    { field: "room_name", headerName: "Кабинет", location: true },
    { field: "seat_no", headerName: "№", fullName: "№ Места", center: true, editable: true, values: false },
    { field: "hostname", headerName: "HOSTNAME", link: true, sticky: true, bold: true, editable: true, values: false },
    { field: "ip", headerName: "IP", fullName: "IP адрес", sticky: true, editable: true, multiline: true, values: "subnet" },
    { field: "vacuum", headerName: "VACUUM", fullName: "Vacuum", editable: true, multiline: true, values: false },
    { field: "os", headerName: "OS", fullName: "Операционная система (ОС / OS)", center: true, editable: true  },
    { field: "type", headerName: "ТИП", fullName: "Тип компьютера", center: true, editable: true },
    { field: "model", headerName: "Модель", center: true, editable: true },
    { field: "cpu", headerName: "CPU", fullName: "Процессор (ЦП / CPU)", center: true, editable: true },
    { field: "ram", headerName: "RAM", fullName: "Оперативная память (ОЗУ / RAM)", center: true, editable: true },
    { field: "drive", headerName: "DRIVE", fullName: "Дисковые накопители (DRIVE)", center: true, editable: true, multiline: true },
    { field: "gpu", headerName: "GPU", fullName: "Видеокарта (ГП / GPU)", center: true, editable: true },
    { field: "mac", headerName: "MAC", fullName: "MAC адрес", editable: true, multiline: true, values: false },
    { field: "inv_no", headerName: "ИНВ", fullName: "Инвентарный номер", editable: true, values: false },
    { field: "gsit", headerName: "GSIT", center: true, editable: true },
    { field: "state", headerName: "Сост.", center: true, editable: true },
    { field: "label", headerName: "Метка", center: true, editable: true },
    { field: "status", headerName: "Статус", center: true, editable: true },
    { field: "note", headerName: "Примечание", note: true, maxWidth: 200, editable: true, multiline: true, values: false }
];

// Название столбца вне самой таблицы (меню, карточка, история, справочники)
export function columnTitle(col) {
    return col.fullName || col.headerName;
}

// Ключ оформления для строки значения. У IP оформляется подсеть /24:
// «10.0.5.17» → «10.0.5.0/24», цвет применяется ко всему адресу.
export function ipSubnetKey(text) {
    const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?(?:\/\d{1,2})?\s*$/.exec(String(text || ""));
    if (!m || [m[1], m[2], m[3]].some(function (n) { return Number(n) > 255; })) {
        return null;
    }
    return Number(m[1]) + "." + Number(m[2]) + "." + Number(m[3]) + ".0/24";
}

export function styleKey(field, line) {
    if (field === "ip") {
        return ipSubnetKey(line);
    }
    return String(line).trim().toLowerCase();
}

// Нельзя менять сразу у нескольких ПК (как BULK_EXCLUDED на сервере)
export const BULK_EXCLUDED = ["location_id", "seat_no", "hostname", "ip", "mac", "inv_no", "serial", "vacuum"];

// Поля, дубли в которых подсвечиваются красным
export const DUP_FIELDS = ["ip", "mac", "hostname", "inv_no", "vacuum"];

// Подписи полей в истории (ключ поля → как показывать)
export const FIELD_LABELS = Object.assign(
    {},
    Object.fromEntries(COLUMN_DEFS.map(function (c) { return [c.field, columnTitle(c)]; })),
    {
        serial: "Серийный",
        vnc: "VNC",
        glpi_id: "GLPI",
        temp_note: "Врем. примечание",
        location_id: "Расположение",
        seat_sort: "Порядок строки",
        archived: "Архив",
        replaced: "Заменил",
        replaced_by: "Заменён на",
        created: "Создан"
    }
);
export const LOCATION_FIELD_LABELS = {
    name: "Название",
    code: "Код",
    sort: "Порядок",
    kind: "Тип",
    parent_id: "Родитель",
    archived: "Архив",
    created: "Создан"
};

export const HIDDEN_COLUMNS_KEY = "itdb.hiddenColumns.v1";
export const SEARCH_HIDDEN_KEY = "itdb.searchHidden.v1";

// Поля карточки, которые можно править двойным кликом (ключ строки карточки → поле)
export const LOCATION_EDIT = { field: "location_id", headerName: "Расположение", location: true };
export const CARD_EDIT_EXTRA = {
    serial: { field: "serial", headerName: "Серийный", editable: true },
    building: LOCATION_EDIT,
    department: LOCATION_EDIT,
    floor: LOCATION_EDIT,
    room: LOCATION_EDIT,
    location: LOCATION_EDIT
};

// Столбцы таблицы, которые показывают расположение ПК
export const LOCATION_FIELDS = ["building", "department", "floor", "room_code", "room_name"];

// ============================================================
// Сортировка значений
// ============================================================

export function compareCellValues(a, b) {
    const aEmpty = a === null || a === undefined || a === "";
    const bEmpty = b === null || b === undefined || b === "";
    if (aEmpty && bEmpty) {
        return 0;
    }
    if (aEmpty) {
        return 1; // пустые всегда внизу
    }
    if (bEmpty) {
        return -1;
    }
    const sa = String(a).split("\n")[0];
    const sb = String(b).split("\n")[0];
    return sa.localeCompare(sb, "ru", { numeric: true, sensitivity: "base" });
}
