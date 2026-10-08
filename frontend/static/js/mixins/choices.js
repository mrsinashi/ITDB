// Страница «Справочники»: значения, оформление столбцов и значений, пользовательские поля.

import { apiFetch, matchesAllWords, searchNorm, searchWords, searchWordsIn, splitMulti } from "../util.js";
import { ROOM_COLUMN, ROOM_STYLE_FIELDS, columnTitle, decoration, ipSubnetKey, styleKey } from "../columns.js";

const NO_STYLE = {};
// «Сбросить оформление» значения или столбца
const STYLE_RESET = { color: "", bg_color: "", bold: false, italic: false, underline: false, strike: false, chip: false };

export default {
    computed: {
        // Поиск в Справочниках: «ЦП 101» – раздел по словам в названии,
        // значения – по остальным. Ничего не скрывается: совпавшие значения
        // подсвечены, страница переходит к разделу (Enter – к следующему).
        // Значение найдено, если все слова есть в «название раздела + значение»
        // и хотя бы одно – в самом значении.
        choicesMatch() {
            const texts = [];
            if (searchWords(this.choicesQuery).length) {
                this.styleBlocks.forEach(function (b) {
                    texts.push(searchNorm(b.label));
                    (b.values || []).forEach(function (v) { texts.push(searchNorm(v.value)); });
                });
            }
            const words = searchWordsIn(this.choicesQuery, texts);
            const res = { words: words, blocks: [], blockSet: new Set(), valueSet: new Set(), hits: 0, pos: 0, current: null };
            if (!words.length) {
                return res;
            }
            this.styleBlocks.forEach(function (b) {
                const label = searchNorm(b.label);
                let found = matchesAllWords(label, words);
                (b.values || []).forEach(function (v) {
                    const value = searchNorm(v.value);
                    if (matchesAllWords(label + " " + value, words) && words.some(function (w) { return value.indexOf(w) !== -1; })) {
                        res.valueSet.add(b.field + "|" + v.key);
                        res.hits++;
                        found = true;
                    }
                });
                if (found) {
                    res.blocks.push(b.field);
                    res.blockSet.add(b.field);
                }
            });
            if (res.blocks.length) {
                res.pos = this.choicesPos % res.blocks.length;
                res.current = res.blocks[res.pos];
            }
            return res;
        },

        choicesByField() {
            const result = {};
            this.choicesItems.forEach(function (item) {
                if (!result[item.field]) {
                    result[item.field] = [];
                }
                result[item.field].push(item);
            });
            ["gsit", "state", "label"].forEach(function (field) {
                if (!result[field]) {
                    result[field] = [];
                }
            });
            return result;
        },

        choiceStyleMap() {
            const map = {};
            this.choicesItems.forEach((item) => {
                if (!this.hasStyle(item)) {
                    return;
                }
                if (!map[item.field]) {
                    map[item.field] = {};
                }
                map[item.field][item.value.toLowerCase()] = {
                    color: item.color || null,
                    bg_color: item.bg_color || null,
                    bold: item.bold || false,
                    italic: item.italic || false,
                    underline: item.underline || false,
                    strike: item.strike || false,
                    chip: item.chip || false
                };
            });
            // Общий «Кабинет» Таблицы («[214] Процедурная») оформляется как его название
            const names = map[ROOM_STYLE_FIELDS[0]];
            if (names) {
                const room = {};
                this.rows.forEach(function (row) {
                    const st = row.room && row.room_name ? names[String(row.room_name).trim().toLowerCase()] : null;
                    if (st) {
                        room[String(row.room).trim().toLowerCase()] = st;
                    }
                });
                map[ROOM_COLUMN.field] = room;
            }
            return map;
        },

        // Оформление столбцов для Таблицы: у общего «Кабинета» – как у названия
        // кабинета (нет – как у номера)
        tableColumnStyles() {
            const field = ROOM_STYLE_FIELDS.find((f) => this.columnStyles[f]);
            if (!field) {
                return this.columnStyles;
            }
            return Object.assign({}, this.columnStyles, { [ROOM_COLUMN.field]: this.columnStyles[field] });
        },

        // Столбцы, где фон у значений может быть блочком (а не заливкой ячейки):
        // только их ячейки Таблица разбирает по строкам
        chipFields() {
            const set = new Set();
            Object.keys(this.tableColumnStyles).forEach((field) => {
                const st = this.tableColumnStyles[field];
                if (st.bg_color && st.chip) {
                    set.add(field);
                }
            });
            this.choicesItems.forEach(function (item) {
                if (item.bg_color && item.chip) {
                    set.add(item.field);
                    if (item.field === ROOM_STYLE_FIELDS[0]) {
                        set.add(ROOM_COLUMN.field);
                    }
                }
            });
            return set;
        },

        // «Справочники»: блок на каждый столбец таблицы, в том же порядке.
        // Значения – из справочника и из самих данных, с числом ПК.
        styleBlocks() {
            const collect = (field, multiline, subnet) => this.collectValues(field, multiline, subnet);
            const byField = this.choicesByField;
            const blocks = this.baseColumns.map((col) => {
                const valuesOn = col.values !== false;
                return {
                    field: col.field,
                    label: columnTitle(col),
                    extra: !!col.extra,
                    subnet: col.values === "subnet",
                    // «Антивирусы» (этап 26д): цвет по состоянию и что не показывать
                    av: col.field === "antivirus",
                    valuesOn: valuesOn,
                    values: valuesOn ? collect(col.field, !!col.multiline, col.values === "subnet") : []
                };
            });
            // Справочники полей, которых нет в таблице (например, VNC)
            const known = new Set(blocks.map(function (b) { return b.field; }));
            Object.keys(byField).forEach((field) => {
                if (!known.has(field) && byField[field].length) {
                    blocks.push({
                        field: field,
                        label: this.choiceFieldLabel(field),
                        extra: false,
                        orphan: true,
                        valuesOn: true,
                        values: collect(field, false)
                    });
                }
            });
            return blocks;
        },
    },

    watch: {
        choicesQuery() {
            this.choicesPos = 0;
            this.scrollToChoicesHit();
        },
    },

    methods: {
        // Значения столбца с числом ПК (рабочих): сначала из справочника в его
        // порядке, потом остальные из данных по алфавиту. Для «Справочников» и
        // подсказок при вводе. [{ key, value, choice, count }]
        collectValues(field, multiline, subnet) {
            const byField = this.choicesByField;
            const rows = this.activeRows;
            const map = new Map();
            (byField[field] || []).forEach(function (ch) {
                const key = ch.value.trim().toLowerCase();
                if (!map.has(key)) {
                    map.set(key, { key: key, value: ch.value, choice: ch, count: 0 });
                }
            });
            rows.forEach(function (row) {
                const raw = row[field];
                if (raw === null || raw === undefined || raw === "") {
                    return;
                }
                const lines = multiline ? splitMulti(raw) : [String(raw).trim()];
                lines.forEach(function (line) {
                    if (!line) {
                        return;
                    }
                    const key = subnet ? ipSubnetKey(line) : line.toLowerCase();
                    if (!key) {
                        return;
                    }
                    let entry = map.get(key);
                    if (!entry) {
                        entry = { key: key, value: subnet ? key : line, choice: null, count: 0 };
                        map.set(key, entry);
                    }
                    entry.count += 1;
                });
            });
            const list = Array.from(map.values());
            // Сначала значения справочника в его порядке, потом остальные по алфавиту
            list.sort(function (a, b) {
                if (a.choice && b.choice) {
                    return (a.choice.sort - b.choice.sort) || (a.choice.id - b.choice.id);
                }
                if (a.choice) return -1;
                if (b.choice) return 1;
                return a.value.localeCompare(b.value, "ru", { numeric: true, sensitivity: "base" });
            });
            return list;
        },

        // ---------- Справочники ----------
        async loadChoices() {
            this.choicesLoading = true;
            this.startLoading();
            try {
                const response = await apiFetch("/api/choices");
                const data = await response.json();
                this.choicesItems = data.items || [];
            } catch (e) {
                // тихо
            }
            this.finishLoading();
            this.choicesLoading = false;
        },

        choiceFieldLabel(field) {
            const labels = {
                status: "Статус",
                os: "OS",
                type: "ТИП",
                model: "Модель",
                cpu: "CPU",
                gpu: "GPU",
                drive: "DRIVE",
                vnc: "VNC",
                gsit: "GSIT",
                state: "Сост.",
                label: "Метка"
            };
            return labels[field] || field;
        },

        async addChoice(field) {
            let value = (this.newChoiceValue[field] || "").trim();
            if (!value) {
                return;
            }
            if (field === "ip") {
                const subnet = ipSubnetKey(value);
                if (!subnet) {
                    this.toastError("Подсеть: первые три числа адреса, например 10.0.5 или 10.0.5.0/24");
                    return;
                }
                value = subnet;
            }
            try {
                const response = await apiFetch("/api/choices", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ field: field, value: value })
                });
                if (!response.ok) {
                    const data = await response.json();
                    this.toastError(data.detail || "Ошибка");
                    return;
                }
                this.newChoiceValue[field] = "";
                await this.loadChoices();
            } catch (e) {
                this.toastError("Не удалось добавить: " + e);
            }
        },

        // ---------- Оформление столбцов и значений ----------

        async loadColumnStyles() {
            try {
                const response = await apiFetch("/api/column-styles");
                if (!response.ok) {
                    return;
                }
                const data = await response.json();
                const map = {};
                (data.items || []).forEach(function (item) {
                    map[item.field] = item;
                });
                this.columnStyles = map;
            } catch (e) {
                // тихо: без оформления столбцов таблица всё равно работает
            }
        },

        hasStyle(st) {
            return !!(st && (st.color || st.bg_color || st.bold || st.italic || st.underline || st.strike));
        },

        // Оформление строки значения как есть: значение поверх столбца. chip – фон
        // блочком у текста (решает тот, чей фон: значение или столбец)
        lineLook(field, line) {
            const col = this.tableColumnStyles[field] || NO_STYLE;
            const val = (this.choiceStyleMap[field] || NO_STYLE)[styleKey(field, line)] || NO_STYLE;
            const bg = val.bg_color || col.bg_color || null;
            return {
                color: val.color || col.color || null,
                bg_color: bg,
                chip: !!bg && !!(val.bg_color ? val.chip : col.chip),
                bold: !!(val.bold || col.bold),
                italic: !!(val.italic || col.italic),
                underline: !!(val.underline || col.underline),
                strike: !!(val.strike || col.strike)
            };
        },

        // Образец в Справочниках: фон блочком – по ширине текста, заливкой – во всю строку
        sampleClass(field, choice) {
            const col = this.columnStyles[field] || NO_STYLE;
            const val = choice || NO_STYLE;
            const bg = val.bg_color || col.bg_color;
            return { boxed: !!bg, fill: !!bg && !(val.bg_color ? val.chip : col.chip) };
        },

        // Как значение выглядит в таблице: столбец + значение поверх
        effectiveStyle(field, choice) {
            const col = this.columnStyles[field] || {};
            const val = choice || {};
            return {
                color: val.color || col.color || null,
                backgroundColor: val.bg_color || col.bg_color || null,
                fontWeight: (val.bold || col.bold) ? "700" : null,
                fontStyle: (val.italic || col.italic) ? "italic" : null,
                textDecoration: decoration(val.underline || col.underline, val.strike || col.strike)
            };
        },

        async setColumnStyle(field, patch) {
            try {
                const response = await apiFetch("/api/column-styles/" + encodeURIComponent(field), {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                const next = Object.assign({}, this.columnStyles);
                if (this.hasStyle(data.item)) {
                    next[field] = data.item;
                } else {
                    delete next[field];
                }
                this.columnStyles = next;
                if ("bold" in patch || "chip" in patch || "bg_color" in patch) {
                    this.recalcWidths();
                }
            } catch (e) {
                this.toastError("Не удалось сохранить оформление: " + (e.message || e));
            }
        },

        resetColumnStyle(field) {
            this.setColumnStyle(field, Object.assign({}, STYLE_RESET));
        },

        // Значение из данных, которого нет в справочнике, добавляется туда
        // при первом изменении оформления.
        async ensureChoice(field, entry) {
            if (entry.choice) {
                return entry.choice;
            }
            const response = await apiFetch("/api/choices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ field: field, value: entry.value })
            });
            if (!response.ok) {
                throw new Error(await this.errorText(response));
            }
            const data = await response.json();
            const maxSort = this.choicesItems
                .filter(function (c) { return c.field === field; })
                .reduce(function (m, c) { return Math.max(m, c.sort || 0); }, 0);
            this.choicesItems.push({
                id: data.id, field: field, value: entry.value, sort: maxSort + 1,
                color: null, bg_color: null, bold: false, italic: false, underline: false, strike: false, chip: false
            });
            return this.choicesItems[this.choicesItems.length - 1];
        },

        async setValueStyle(field, entry, patch) {
            try {
                const choice = await this.ensureChoice(field, entry);
                const response = await apiFetch("/api/choices/" + choice.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                Object.keys(patch).forEach(function (k) {
                    const v = patch[k];
                    choice[k] = (k === "color" || k === "bg_color") ? (v || null) : v;
                });
                if ("bold" in patch || "chip" in patch || "bg_color" in patch) {
                    this.recalcWidths();
                }
            } catch (e) {
                this.toastError("Не удалось сохранить оформление: " + (e.message || e));
            }
        },

        resetValueStyle(field, entry) {
            this.setValueStyle(field, entry, Object.assign({}, STYLE_RESET));
        },

        async deleteChoice(item) {
            if (!(await this.confirmDialog("Удалить значение «" + item.value + "» из справочника?", { okText: "Удалить", danger: true }))) {
                return;
            }
            try {
                const response = await apiFetch("/api/choices/" + item.id, {
                    method: "DELETE"
                });
                if (!response.ok) {
                    const data = await response.json();
                    this.toastError(data.detail || "Не удалось удалить");
                    return;
                }
                await this.loadChoices();
                this.recalcWidths();
            } catch (e) {
                this.toastError("Не удалось удалить: " + e);
            }
        },

        // ---------- Пользовательские поля ----------
        async loadFieldDefs() {
            this.fieldDefsLoading = true;
            this.startLoading();
            try {
                const response = await apiFetch("/api/field-defs");
                const data = await response.json();
                this.fieldDefs = data.items || [];
            } catch (e) {
                // тихо
            }
            this.finishLoading();
            this.fieldDefsLoading = false;
        },

        async addFieldDef() {
            const key = this.newFieldDef.key.trim();
            const label = this.newFieldDef.label.trim();
            if (!key || !label) {
                return;
            }
            try {
                const response = await apiFetch("/api/field-defs", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        key: key,
                        label: label,
                        field_type: this.newFieldDef.field_type
                    })
                });
                if (!response.ok) {
                    const data = await response.json();
                    this.toastError(data.detail || "Ошибка");
                    return;
                }
                this.newFieldDef = { key: "", label: "", field_type: "text" };
                await this.loadFieldDefs();
                this.recalcWidths();
            } catch (e) {
                this.toastError("Не удалось создать: " + e);
            }
        },

        startRenameFieldDef(fd) {
            this.fieldDefEdit = { id: fd.id, label: fd.label };
            this.$nextTick(() => {
                const el = document.querySelector(".fd-rename");
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },

        async saveRenameFieldDef(fd) {
            const edit = this.fieldDefEdit;
            if (!edit || edit.id !== fd.id) {
                return;
            }
            this.fieldDefEdit = null;
            const label = edit.label.trim();
            if (!label || label === fd.label) {
                return;
            }
            await this.patchFieldDef(fd, { label: label });
        },

        async patchFieldDef(fd, patch) {
            try {
                const response = await apiFetch("/api/field-defs/" + fd.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                return true;
            } catch (e) {
                this.toastError("Не удалось сохранить: " + (e.message || e));
                return false;
            } finally {
                await this.loadFieldDefs();
                this.recalcWidths();
            }
        },

        // Порядок пользовательских полей = порядок их столбцов в таблице
        async moveFieldDef(fd, dir) {
            const list = this.fieldDefs.slice();
            const index = list.findIndex(function (f) { return f.id === fd.id; });
            const target = list[index + dir];
            if (!target) {
                return;
            }
            list[index] = target;
            list[index + dir] = fd;
            // Перенумеровать подряд – у старых полей sort мог совпадать
            const changed = [];
            list.forEach(function (f, i) {
                if (f.sort !== i + 1) {
                    changed.push({ f: f, sort: i + 1 });
                }
            });
            try {
                for (const c of changed) {
                    const response = await apiFetch("/api/field-defs/" + c.f.id, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ sort: c.sort })
                    });
                    if (!response.ok) {
                        throw new Error(await this.errorText(response));
                    }
                }
            } catch (e) {
                this.toastError("Не удалось переместить: " + (e.message || e));
            }
            await this.loadFieldDefs();
        },

        async archiveFieldDef(item) {
            if (!(await this.confirmDialog("Архивировать поле «" + item.label + "»?\nОно исчезнет из таблицы.", { okText: "Архивировать", danger: true }))) {
                return;
            }
            try {
                const response = await apiFetch("/api/field-defs/" + item.id + "/archive", {
                    method: "POST"
                });
                if (!response.ok) {
                    this.toastError("Не удалось архивировать: " + (await this.errorText(response)));
                    return;
                }
                await this.loadFieldDefs();
            } catch (e) {
                this.toastError("Не удалось архивировать: " + e);
            }
        },
    }
};
