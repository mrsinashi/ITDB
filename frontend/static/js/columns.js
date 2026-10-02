import { splitMulti } from "./util.js";

export function normalizeKey(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value).trim().toLowerCase();
}

// Дубли: поле → множество значений, встречающихся больше одного раза.
// Какие поля проверять и какие из них многострочные — из описания столбцов.
let duplicateSets = {};

export function buildDuplicateSets(rows, columns) {
    const dupColumns = (columns || []).filter(function (col) { return col.dup; });
    const counters = {};
    dupColumns.forEach(function (col) { counters[col.field] = {}; });

    rows.forEach(function (row) {
        if (row.archived) {
            return; // ПК из архива дублей не создают
        }
        dupColumns.forEach(function (col) {
            const values = col.multiline ? splitMulti(row[col.field]) : [row[col.field]];
            values.forEach(function (value) {
                const key = normalizeKey(value);
                if (key) {
                    counters[col.field][key] = (counters[col.field][key] || 0) + 1;
                }
            });
        });
    });

    const sets = {};
    Object.keys(counters).forEach(function (field) {
        const counter = counters[field];
        sets[field] = new Set(Object.keys(counter).filter(function (key) { return counter[key] > 1; }));
    });
    return sets;
}

// Одно значение (строка многострочной ячейки) — повтор?
export function isDuplicateLine(line, field) {
    const set = duplicateSets[field];
    return !!set && set.has(normalizeKey(line));
}

// Пересчитать дубли (после загрузки и правки строк); columns — встроенные столбцы
export function refreshDuplicates(rows, columns) {
    duplicateSets = buildDuplicateSets(rows, columns);
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

// Встроенные столбцы описаны на сервере (backend/api_columns.py, GET /api/columns).
// Здесь описание переводится в вид, который ждут таблица, карточка и Справочники.
// values: false — значения почти всегда уникальны, в «Справочниках»
// у такого столбца настраивается только оформление столбца целиком.
export function toColumnDef(c) {
    const col = {
        field: c.key,
        headerName: c.short,
        cardLabel: c.card,
        center: c.center,
        sticky: c.sticky,
        bold: c.bold,
        link: c.link,
        note: c.note,
        multiline: c.multiline,
        // location: правка — выбор узла дерева (двойной клик)
        location: c.kind === "location",
        // scan: только из сканера (антивирусы, этап 26д) — не правится
        editable: c.kind !== "location" && c.kind !== "scan",
        scanOnly: c.kind === "scan",
        hiddenByDefault: c.hidden,
        dup: c.dup,
        bulk: c.bulk,
        cardCopy: c.card_copy,
        // Подсказки при вводе: значения справочника и столбца
        suggest: c.suggest,
        // В карточке всегда, даже пустое
        cardAlways: c.card_always,
        // Дата «ДД.ММ.ГГГГ»: сортировка по дате, просроченная — красным жирным
        date: c.kind === "date",
        // GSIT / Сост. / Метка лежат в computers.extra под русскими ключами
        extraKey: c.extra_key
    };
    if (c.title !== c.short) {
        col.fullName = c.title;
    }
    if (c.max_width) {
        col.maxWidth = c.max_width;
    }
    if (c.values === "no") {
        col.values = false;
    } else if (c.values === "subnet") {
        col.values = "subnet";
    }
    return col;
}

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

// Подчёркнутый и зачёркнутый — одним свойством CSS; ни того, ни другого — null
export function decoration(underline, strike) {
    return [underline ? "underline" : "", strike ? "line-through" : ""].filter(Boolean).join(" ") || null;
}

// Подписи полей в истории (ключ поля → как показывать): полные названия
// столбцов и подписи записей, которые не столбцы (с сервера)
// Подписи полей в Истории — как в карточке, без расшифровок в скобках (этап 19)
export function buildFieldLabels(columns, historyLabels) {
    return Object.assign(
        {},
        Object.fromEntries(columns.map(function (c) { return [c.field, c.cardLabel || columnTitle(c)]; })),
        historyLabels || {}
    );
}
// Этап 19б: справочники, польз. поля, оформление столбцов, пользователи системы
export const ENTITY_LABELS = {
    computers: "ПК",
    locations: "Расположение",
    choices: "Справочник",
    field_defs: "Поле",
    column_styles: "Оформление",
    users: "Пользователь",
    scan_sources: "Подключение",
    scan_subnets: "Подсеть",
    scan_records: "Запись",
    scan_aliases: "Название",
    scan_marks: "Пометка сканера",
    scan_antivirus: "Антивирусы",
    table_marks: "Выделение"
};
export const SIMPLE_FIELD_LABELS = {
    value: "Значение",
    color: "Цвет текста",
    bg_color: "Фон",
    bold: "Жирный",
    italic: "Курсив",
    underline: "Подчёркнутый",
    chip: "Фон блочком",
    label: "Название",
    archived: "Архив",
    role: "Роль",
    password: "Пароль",
    created: "Создано",
    deleted: "Удалено",
    login: "Логин",
    full_name: "ФИО",
    position: "Должность",
    // Сканирование (этап 24)
    enabled: "Включён",
    url: "Адрес сервера",
    domain: "Домен XMPP",
    user_token: "Токен пользователя",
    app_token: "Токен приложения",
    verify_tls: "Проверять сертификат",
    fresh_days: "Актуальны, дней",
    cidr: "Подсеть",
    purpose: "Назначение",
    building: "Адрес",
    scan: "Сканировать",
    note: "Примечание",
    // Сопоставление записей GLPI / GSIT с ПК (этап 25)
    link: "Это ПК",
    reject: "Не этот ПК",
    reset: "Решения забыты",
    // Соответствия названий (этап 25б)
    same: "Одно и то же",
    differ: "Разное",
    keep: "В таблице своё",
    board: "Материнская плата",
    // Пометки сканера (этап 26б)
    strike: "Зачёркнутый",
    frame: "Рамка",
    always: "Без кнопки",
    // Столбец «Антивирусы» (этап 26д)
    show: "Показывать",
    hidden: "Не показывать",
    name: "Название"   // своё название антивируса (этап 26е)
};
// Не отменяются и не открывают «Историю значения»
export const FIXED_HISTORY_FIELDS = ["created", "deleted", "password"];

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
// Столбцы, скрытые по умолчанию, которые уже были скрыты один раз: если
// пользователь их показал, при следующей загрузке они не прячутся снова
export const DEFAULT_HIDDEN_SEEN_KEY = "itdb.defaultHiddenSeen.v1";
export const SEARCH_HIDDEN_KEY = "itdb.searchHidden.v1";

// Поля карточки, которые можно править двойным кликом (ключ строки карточки → поле)
export const LOCATION_EDIT = { field: "location_id", headerName: "Расположение", location: true };
export const CARD_EDIT_EXTRA = {
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

// Рамка ячейки под курсором для залитой ячейки — в тон заливки: тот же
// оттенок темнее и чуть спокойнее (как бежевая рамка на бежевой строке).
// fill — «#rrggbb» из Справочников или «var(--имя)» (дубль). Не цвет — null.
const frameCache = new Map();

export function frameColorFor(fill) {
    if (frameCache.has(fill)) {
        return frameCache.get(fill);
    }
    let hex = String(fill || "").trim();
    const v = /^var\((--[\w-]+)\)$/.exec(hex);
    if (v) {
        hex = getComputedStyle(document.documentElement).getPropertyValue(v[1]).trim();
    }
    let m = /^#([0-9a-f]{3})$/i.exec(hex);
    if (m) {
        hex = "#" + m[1].split("").map(function (c) { return c + c; }).join("");
    }
    m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    let result = null;
    if (m) {
        const r = parseInt(m[1], 16) / 255;
        const g = parseInt(m[2], 16) / 255;
        const b = parseInt(m[3], 16) / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const l = (max + min) / 2;
        const d = max - min;
        let h = 0;
        let s = 0;
        if (d) {
            s = d / (1 - Math.abs(2 * l - 1));
            if (max === r) {
                h = ((g - b) / d + 6) % 6;
            } else if (max === g) {
                h = (b - r) / d + 2;
            } else {
                h = (r - g) / d + 4;
            }
            h *= 60;
        }
        result = "hsl(" + Math.round(h) + " " + Math.round(s * 70) + "% " + Math.round(Math.max(0, l - 0.13) * 100) + "%)";
    }
    frameCache.set(fill, result);
    return result;
}

// «15.10.2026» → 20261015 (для сравнения); не дата — null
export function dateKey(value) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value || "").trim());
    return m ? Number(m[3] + m[2] + m[1]) : null;
}

// Дата уже прошла (сегодняшняя — ещё не просрочена)
export function isOverdue(value) {
    const key = dateKey(value);
    if (key === null) {
        return false;
    }
    const d = new Date();
    return key < d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function compareCellValues(a, b, col) {
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
    if (col && col.date) {
        return (dateKey(a) || 0) - (dateKey(b) || 0);
    }
    const sa = String(a).split("\n")[0];
    const sb = String(b).split("\n")[0];
    return sa.localeCompare(sb, "ru", { numeric: true, sensitivity: "base" });
}
