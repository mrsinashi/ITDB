// Выделения значений в Таблице (этап 26к): повтор, имя на ПК другое (по сканеру),
// логина нет в Jabber, логин давно не подключался, срок прошёл, ПК проверен (этапы 28б,
// 38: и сетью, и GLPI / GSIT или одним способом). Вид каждого –
// в Справочниках («Выделения в Таблице», GET / PATCH /api/table-marks); фон – всегда
// блочком у самого значения. Выделение кладётся поверх оформления из Справочников.

import { apiFetch } from "../util.js";
import { decoration } from "../columns.js";

// Порядок наложения, если у значения несколько выделений: следующее поверх
const MARK_ORDER = ["checked", "verified", "dup", "stale", "gone", "hostname", "overdue"];
const SAMPLES = { dup: "10.0.2.11", hostname: "ter-201-1", gone: "ivanov", stale: "petrova", overdue: "01.09.2026", verified: "ter-201-2", checked: "ter-201-3" };
// Пока настройки не загружены – вид по умолчанию (как на сервере)
const DEFAULTS = [
    { kind: "dup", label: "Повтор", bg_color: "#ffd6d6", chip: true },
    { kind: "hostname", label: "Имя на ПК другое", color: "#cc0000", bold: true },
    { kind: "gone", label: "Нет в Jabber", color: "#cc0000", bold: true },
    { kind: "stale", label: "Давно не подключался", color: "#b35c00", bold: true },
    { kind: "overdue", label: "Срок прошёл", color: "#cc0000", bold: true },
    { kind: "verified", label: "Проверен сетью и GLPI / GSIT" },
    { kind: "checked", label: "Проверен одним способом", bg_color: "#e3f1e3", chip: true }
];

export default {
    computed: {
        tableMarkList() {
            return this.tableMarks.length ? this.tableMarks : DEFAULTS;
        },

        tableMarkMap() {
            const map = {};
            this.tableMarkList.forEach(function (m) { map[m.kind] = m; });
            return map;
        },

        // Меняется вид выделений – пересчитать ширину столбцов (жирный, блочок)
        tableMarkVersion() {
            return this.tableMarkList.map(function (m) { return m.kind + (m.bold ? "b" : "") + (m.bg_color ? "c" : ""); }).join("|");
        },

        // Есть выделение с фоном «на всю ячейку» (обычно нет – тогда ячейки не проверяются)
        markFillOn() {
            return this.tableMarkList.some(function (m) { return !!m.bg_color && m.chip === false; });
        }
    },

    watch: {
        tableMarkVersion() {
            this.recalcWidths();
        }
    },

    methods: {
        async loadTableMarks() {
            try {
                const response = await apiFetch("/api/table-marks");
                if (response.ok) {
                    this.tableMarks = await response.json();
                }
            } catch (e) {
                // без настроек – вид по умолчанию
            }
        },

        async updateTableMark(kind, patch) {
            try {
                const response = await apiFetch("/api/table-marks/" + kind, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const saved = await response.json();
                this.tableMarks = this.tableMarkList.map(function (m) { return m.kind === kind ? saved : m; });
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        // Стиль для значения с такими выделениями (kinds – массив или один вид);
        // нечего менять – null. Задаёт только то, что в выделении указано
        markStyle(kinds) {
            const list = Array.isArray(kinds) ? kinds : [kinds];
            const map = this.tableMarkMap;
            let style = null;
            MARK_ORDER.forEach(function (kind) {
                const m = list.indexOf(kind) >= 0 ? map[kind] : null;
                if (!m) {
                    return;
                }
                style = style || {};
                if (m.color) style.color = m.color;
                if (m.bg_color) style.backgroundColor = m.bg_color;
                if (m.bold) style.fontWeight = "700";
                if (m.italic) style.fontStyle = "italic";
                if (m.underline || m.strike) style.textDecoration = decoration(m.underline, m.strike);
            });
            return style && Object.keys(style).length ? style : null;
        },

        // Фон этих выделений – блочком у значения (а не на всю ячейку): решает то
        // выделение, чей фон виден (последнее с фоном по порядку наложения)
        markChip(kinds) {
            const map = this.tableMarkMap;
            let chip = true;
            MARK_ORDER.forEach(function (kind) {
                const m = kinds.indexOf(kind) >= 0 ? map[kind] : null;
                if (m && m.bg_color) {
                    chip = m.chip !== false;
                }
            });
            return chip;
        },

        tableMarkSample(kind) {
            return SAMPLES[kind] || "…";
        }
    }
};
