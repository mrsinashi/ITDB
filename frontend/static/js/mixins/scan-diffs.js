// Значения сканера в Таблице и список расхождений (этапы 26, 26б, 26в).
//
// Сервер (/api/scan/diffs) считает для ПК, сопоставленных с записями включённых
// источников, поля, где сканер предлагает другое: diff – отличается, fill – в
// таблице пусто, unsure – неточно (источники расходятся, VNC-серверов
// несколько), partial – в таблице часть (не расхождение).
//
// Таблица: кнопка на панели (наведение – что значат цвета) дописывает в ячейки
// значения сканера блочками; цвет блочка – по ситуации (/api/scan/marks, блок
// «Значения сканера» в Справочниках, там же «показывать и без кнопки»). Клик по
// блочку – карточка рядом: взять, оставить (этому ПК или всем с такой парой),
// вписать своё; карточку можно двигать и закрыть. В карточке ПК – строкой с
// «принять / отклонить»; при правке ячейки – первой подсказкой.
//
// Решения по значениям сканера (взять, оставить, «в таблице своё») – общие для
// Таблицы, карточки ПК и вкладки «Проверка» (scan-check.js).
//
// Столбец «Антивирусы» (этап 26д): антивирусы ПК приходят вместе с расхождениями
// (/api/scan/diffs → antivirus) и дописываются в строки таблицы (row.antivirus –
// названия через перенос: так работают ширина, сортировка, фильтр и поиск); цвет
// каждого – по состоянию, что показывать – блок «Антивирусы» в Справочниках
// (/api/scan/antivirus), там же – своё короткое название вместо длинного из
// источника (этап 26е: names – название в источнике строчными → как показывать).
//
// Этап 26е: HOSTNAME в таблице – каким имя должно быть, поэтому другое имя у
// источника только сообщается (d.can_take = false: «взять» нет). Jabber
// предлагает VACUUM (у источника нет номера записи – source_id null).
//
// Этап 26ж: «Своё» в карточке у блочка – не просто правка: значение записывается
// как правильное для того, что предлагает сканер (название – «одно и то же» для
// всех ПК, остальное – «оставить как есть» этому ПК). «Это материнская плата» –
// название модели уходит в столбец «Мат. плата» (у этого ПК и у всех с таким
// названием). С расхождениями приходят ссылки на записи GLPI / GSIT (links) и
// логины VACUUM, которых нет в Jabber (vacuum_missing).
//
// Этап 38: запись, которую сопоставление только предлагает привязать к ПК, – блочок
// вида link (серый) с её номером в столбце GLPI / GSIT; в карточке у блочка – запись и
// ПК по полям (d.compare), «Привязать» (/link: это этот ПК + номер в столбец, дальше
// сканер предлагает остальное) и «Не этот ПК» (/not-this). Разом («Принять
// изменения…») не привязывается. Другое имя ПК (HOSTNAME в таблице есть) блочком не
// показывается: имя выделено, что на ПК – в подсказке.

import { decoration } from "../columns.js";
import { apiFetch } from "../util.js";

// Источник значения: «GLPI №12»; у Jabber номера записи нет
function sourceName(s) {
    return s.source_id === null || s.source_id === undefined ? s.title : s.title + " №" + s.source_id;
}

function avKey(name) {
    return String(name || "").split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

const KEY_TEXT = { id: "ID", mac: "MAC", serial: "серийному", ip: "IP", name: "имени", reserve: "привязке DHCP" };
const KEY_ORDER = ["mac", "serial", "id", "ip", "name", "reserve"];
// Поля-названия: «своё» значение – соответствие «одно и то же» (как NAME_FIELDS на сервере)
const NAME_FIELDS = ["model", "motherboard", "os", "cpu", "gpu", "vnc", "drive"];
const AV_TEXT = { on: "работает, базы актуальны", old: "работает, базы устарели", off: "выключен" };
// Типы предложений сканера – для выбора в «Принять изменения…» (названия – просьба 02.10)
const SCAN_KINDS = [
    { key: "diff", label: "Замена" },
    { key: "fill", label: "Новые значения" },
    { key: "unsure", label: "Неточно" },
    { key: "partial", label: "Добавление значений" }
];

export default {
    watch: {
        // Показались или скрылись блочки – пересчитать ширину столбцов
        scanChipVersion() {
            this.recalcWidths();
        },

        // Пришли антивирусы или поменялось, что показывать, – дописать в строки
        avIndex() {
            this.applyAntivirus();
        }
    },

    computed: {
        // Есть состояние антивируса с фоном «на всю ячейку»
        avFillOn() {
            return !!this.avSettings && this.avSettings.statuses.some(function (st) { return !!st.bg_color && st.chip === false; });
        },

        scanChipVersion() {
            return Array.from(this.scanShownKinds).sort().join(",") + "|" +
                (this.diffs.vacuumMissing || []).join(",") + "|" + Object.keys(this.diffs.vacuumStale || {}).join(",") + "|" +
                Object.keys(this.diffs.verified || {}).join(",") + "|" + Object.keys(this.diffs.checked || {}).join(",") + "|" +
                this.diffs.items.map(function (d) { return d.id + (d.rejected_by ? "-" : ":") + d.proposed; }).join("|");
        },

        // Скрытые столбцы, где виден блочок сканера у строк Таблицы (фильтр по дереву и
        // столбцам): при включённой кнопке «Значения сканера» они показываются, пока она
        // включена (этап 40). Набор скрытых при этом не меняется
        scanOpenFields() {
            const fields = new Set();
            const hidden = this.hiddenNow;
            if (!this.scanOverlay || this.showArchive || !hidden.length) {
                return fields;
            }
            const kinds = this.scanShownKinds;
            const found = this.diffs.items.filter((d) => {
                return !d.rejected_by && hidden.indexOf(d.field) !== -1 && kinds.has(d.kind) && !this.scanChipHidden(d);
            });
            if (!found.length) {
                return fields;
            }
            const ids = new Set(this.applyColFilters(this.locationRows, null).map(function (row) { return row.id; }));
            found.forEach(function (d) {
                if (ids.has(d.computer_id)) {
                    fields.add(d.field);
                }
            });
            return fields;
        },

        // Воронка у кнопки «Значения сканера»: в таблице только строки с предложениями
        scanOnlyOn() {
            return this.scanOnlyRows && this.scanOverlay;
        },

        // «Принять изменения…» у выбранных строк Таблицы: предложения выбранных ПК,
        // которые можно взять (без отклонённых и без имён ПК)
        scanBarAll() {
            const bar = this.actionBar;
            if (!bar || bar.kind !== "scan") {
                return [];
            }
            const list = [];
            bar.ids.forEach((id) => {
                const entry = this.diffIndex.get(id);
                Object.keys(entry || {}).forEach((field) => {
                    if (this.diffTakeable(entry[field])) {
                        list.push(entry[field]);
                    }
                });
            });
            return list;
        },

        // …те из них, что подходят под выбранные тип и столбец
        scanBarDiffs() {
            const bar = this.actionBar;
            return this.scanBarAll.filter(function (d) {
                return (!bar.scanKind || d.kind === bar.scanKind) && (!bar.field || d.field === bar.field);
            });
        },

        // Типы и столбцы для выбора – с числом значений (с учётом второго выбора)
        scanBarKinds() {
            const bar = this.actionBar;
            const list = this.scanBarAll.filter(function (d) { return !bar.field || d.field === bar.field; });
            return SCAN_KINDS.map(function (k) {
                return { key: k.key, label: k.label, count: list.filter(function (d) { return d.kind === k.key; }).length };
            }).filter(function (k) { return k.count || k.key === bar.scanKind; });
        },

        scanBarFields() {
            const bar = this.actionBar;
            const list = this.scanBarAll.filter(function (d) { return !bar.scanKind || d.kind === bar.scanKind; });
            const counts = {};
            list.forEach(function (d) { counts[d.field] = (counts[d.field] || 0) + 1; });
            return this.allColumns.filter(function (col) { return counts[col.field] || col.field === bar.field; })
                .map(function (col) { return { key: col.field, label: col.headerName, count: counts[col.field] || 0 }; });
        },

        scanBarKindTotal() {
            const bar = this.actionBar;
            return this.scanBarAll.filter(function (d) { return !bar.field || d.field === bar.field; }).length;
        },

        scanBarFieldTotal() {
            const bar = this.actionBar;
            return this.scanBarAll.filter(function (d) { return !bar.scanKind || d.kind === bar.scanKind; }).length;
        },

        // Те же списки с пунктом «все» – для выбора со счётчиками (count-select)
        scanBarKindOptions() {
            return [{ key: "", label: "Все", count: this.scanBarKindTotal }].concat(this.scanBarKinds);
        },

        scanBarFieldOptions() {
            return [{ key: "", label: "Все столбцы", count: this.scanBarFieldTotal }].concat(this.scanBarFields);
        },

        // Есть ли что взять у выбранных строк (пункт меню «Выбрано»)
        selectedScanCount() {
            let n = 0;
            this.selectedRows.forEach((id) => {
                const entry = this.diffIndex.get(id);
                Object.keys(entry || {}).forEach((field) => {
                    if (this.diffTakeable(entry[field])) {
                        n += 1;
                    }
                });
            });
            return n;
        },

        diffCountBadge() {
            return this.diffs.count > 99 ? "99" : String(this.diffs.count);
        },

        // Подсказка кнопки «Значения сканера»: сколько их всего (на кнопке – не больше 99)
        scanButtonTitle() {
            return "Значения сканера: " + (this.diffs.count || "нет");
        },

        scanMarkByKind() {
            const map = {};
            this.scanMarks.forEach(function (m) { map[m.kind] = m; });
            return map;
        },

        // Все расхождения по ПК: id ПК → { поле → расхождение } (без отклонённых)
        diffIndex() {
            const map = new Map();
            this.diffs.items.forEach(function (d) {
                if (d.rejected_by) {
                    return;
                }
                let entry = map.get(d.computer_id);
                if (!entry) {
                    map.set(d.computer_id, entry = {});
                }
                entry[d.field] = d;
            });
            return map;
        },

        // Какие пометки видны сейчас: ситуация включена и (кнопка нажата или «без кнопки»)
        scanShownKinds() {
            const kinds = new Set();
            this.scanMarks.forEach((m) => {
                if (m.enabled && (this.scanOverlay || m.always)) {
                    kinds.add(m.kind);
                }
            });
            return kinds;
        },

        // Антивирусы, которые показываются в столбце: id ПК → [{ name, status, version, source }]
        avIndex() {
            const map = new Map();
            const settings = this.avSettings;
            if (!settings) {
                return map;
            }
            const shown = new Set(settings.statuses.filter(function (st) { return st.show; }).map(function (st) { return st.kind; }));
            const hidden = new Set(settings.hidden.map(function (n) { return n.trim().toLowerCase(); }));
            const names = settings.names || {};
            const data = this.diffs.antivirus || {};
            Object.keys(data).forEach(function (id) {
                const list = data[id].filter(function (a) { return shown.has(a.status) && !hidden.has(a.name.trim().toLowerCase()); })
                    .map(function (a) { return Object.assign({}, a, { title: names[avKey(a.name)] || a.name }); });
                if (list.length) {
                    map.set(Number(id), list);
                }
            });
            return map;
        },

        avStatusMap() {
            const map = {};
            (this.avSettings ? this.avSettings.statuses : []).forEach(function (st) { map[st.kind] = st; });
            return map;
        },

        // Справочники: сколько антивирусов в каждом состоянии и все названия (и скрытые)
        avStatusCounts() {
            const counts = { on: 0, old: 0, off: 0 };
            const data = this.diffs.antivirus || {};
            Object.keys(data).forEach(function (id) {
                data[id].forEach(function (a) { counts[a.status] = (counts[a.status] || 0) + 1; });
            });
            return counts;
        },

        avNames() {
            const byKey = new Map();
            const data = this.diffs.antivirus || {};
            Object.keys(data).forEach(function (id) {
                data[id].forEach(function (a) {
                    const key = a.name.trim().toLowerCase();
                    const item = byKey.get(key) || { key: key, name: a.name, count: 0 };
                    item.count += 1;
                    byKey.set(key, item);
                });
            });
            const hidden = this.avSettings ? this.avSettings.hidden : [];
            hidden.forEach(function (name) {
                const key = name.trim().toLowerCase();
                if (!byKey.has(key)) {
                    byKey.set(key, { key: key, name: name, count: 0 });
                }
            });
            const hiddenKeys = new Set(hidden.map(function (n) { return n.trim().toLowerCase(); }));
            const names = this.avSettings ? this.avSettings.names || {} : {};
            return Array.from(byKey.values()).map(function (item) {
                return Object.assign(item, { hidden: hiddenKeys.has(item.key), title: names[avKey(item.name)] || "" });
            }).sort(function (a, b) { return (b.count - a.count) || a.name.localeCompare(b.name, "ru"); });
        },

        // Все расхождения по ПК, и отклонённые: id ПК → { поле → расхождение }
        diffAllIndex() {
            const map = new Map();
            this.diffs.items.forEach(function (d) {
                let entry = map.get(d.computer_id);
                if (!entry) {
                    map.set(d.computer_id, entry = {});
                }
                entry[d.field] = d;
            });
            return map;
        }
    },

    methods: {
        async loadDiffs() {
            if (!this.user) {
                return;
            }
            this.diffs.loading = true;
            this.diffs.error = "";
            try {
                const response = await apiFetch("/api/scan/diffs?rejected=true");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                this.diffs.items = data.items;
                // В счётчике – только то, что показывается блочком: без «в таблице часть» и без
                // другого имени ПК (этап 39)
                this.diffs.count = data.items.filter((d) => !d.rejected_by && d.kind !== "partial" && !this.scanChipHidden(d)).length;
                this.diffs.rejected = data.rejected;
                this.diffs.sources = data.sources;
                this.diffs.antivirus = data.antivirus || {};
                this.diffs.links = data.links || {};
                this.diffs.vacuumMissing = data.vacuum_missing || [];
                this.diffs.vacuumStale = data.vacuum_stale || {};
                this.diffs.jabber = data.jabber || {};
                this.diffs.net = data.net || {};
                this.diffs.verified = data.verified || {};
                this.diffs.checked = data.checked || {};
            } catch (e) {
                this.diffs.error = "Не удалось загрузить расхождения: " + (e.message || e);
            } finally {
                this.diffs.loading = false;
            }
        },

        // Можно взять разом: значение берётся, и такие блочки в Таблице вообще показываются;
        // привязку записи – только по одной, посмотрев на сравнение (этап 38)
        diffTakeable(d) {
            const mark = this.scanMarkByKind[d.kind];
            return d.can_take && d.kind !== "link" && (!mark || mark.enabled);
        },

        async loadScanMarks() {
            try {
                const response = await apiFetch("/api/scan/marks");
                if (response.ok) {
                    this.scanMarks = await response.json();
                }
            } catch (e) {
                // без пометок таблица работает как раньше
            }
        },

        // ---------- Столбец «Антивирусы» (этап 26д) ----------

        async loadAvSettings() {
            try {
                const response = await apiFetch("/api/scan/antivirus");
                if (response.ok) {
                    this.avSettings = await response.json();
                }
            } catch (e) {
                // без настроек столбец просто пустой
            }
        },

        async updateAvSettings(patch) {
            try {
                const response = await apiFetch("/api/scan/antivirus", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.avSettings = await response.json();
            } catch (e) {
                this.toastError("Не удалось сохранить: " + (e.message || e));
            }
        },

        // Своё название антивируса (этап 26е): двойной клик по названию в Справочниках
        startAvRename(item) {
            if (!this.canEdit) {
                return;
            }
            this.avRename = { key: item.key, source: item.name, value: item.title || item.name };
            this.$nextTick(() => {
                const el = document.querySelector(".av-rename");
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },

        async finishAvRename(save) {
            const edit = this.avRename;
            if (!edit || edit.saving) {
                return;
            }
            if (!save) {
                this.avRename = null;
                return;
            }
            edit.saving = true;
            const value = edit.value.trim();
            const names = (this.avSettings && this.avSettings.names) || {};
            const now = names[avKey(edit.source)] || edit.source;
            if (value !== now) {
                await this.updateAvSettings({ rename: { source: edit.source, name: value === edit.source ? "" : value } });
            }
            if (this.avRename === edit) {
                this.avRename = null;
            }
        },

        onAvRenameKeydown(event) {
            if (event.key === "Enter") {
                event.preventDefault();
                this.finishAvRename(true);
            } else if (event.key === "Escape") {
                event.preventDefault();
                this.finishAvRename(false);
            }
        },

        toggleAvHidden(item) {
            const hidden = this.avSettings.hidden.filter(function (n) { return n.trim().toLowerCase() !== item.key; });
            if (!item.hidden) {
                hidden.push(item.name);
            }
            this.updateAvSettings({ hidden: hidden });
        },

        // Строкам таблицы – названия показываемых антивирусов (через перенос)
        applyAntivirus() {
            const index = this.avIndex;
            let changed = false;
            this.rows.forEach(function (row) {
                const list = index.get(row.id);
                const text = list ? list.map(function (a) { return a.title; }).join("\n") : null;
                if (row.antivirus !== text) {
                    row.antivirus = text;
                    changed = true;
                }
            });
            if (changed) {
                this.recalcWidths();
            }
        },

        avItems(row) {
            return this.avIndex.get(row.id) || [];
        },

        // Вид антивируса – по состоянию (как оформление значения в Справочниках)
        avStatusStyle(st) {
            if (!st) {
                return null;
            }
            return {
                color: st.color || null,
                backgroundColor: st.bg_color || null,
                fontWeight: st.bold ? "700" : null,
                fontStyle: st.italic ? "italic" : null,
                textDecoration: decoration(st.underline, st.strike)
            };
        },

        avStyle(a) {
            return this.avStatusStyle(this.avStatusMap[a.status]);
        },

        // В ячейке Таблицы: фон «на всю ячейку» красит ячейку (avCellFill), а не строку
        avCellStyle(a) {
            const st = this.avStatusMap[a.status];
            const style = this.avStatusStyle(st);
            if (style && st.chip === false) {
                style.backgroundColor = null;
            }
            return style;
        },

        // Заливка ячейки «Антивирус»: фон первого антивируса, у состояния которого фон не блочком
        avCellFill(row) {
            if (!this.avFillOn) {
                return null;
            }
            const map = this.avStatusMap;
            const found = this.avItems(row).find(function (a) {
                const st = map[a.status];
                return !!st && !!st.bg_color && st.chip === false;
            });
            return found ? map[found.status].bg_color : null;
        },

        avTitle(a) {
            return (a.title || a.name) + ": " + AV_TEXT[a.status] + (a.version ? ", версия " + a.version : "") +
                (a.title && a.title !== a.name ? "\nВ источнике: " + a.name : "") + "\nИз " + a.source;
        },

        toggleScanOverlay() {
            this.scanOverlay = !this.scanOverlay;
            this.scanLegend = this.scanOverlay;
            if (!this.scanOverlay) {
                this.scanOnlyRows = false;
            }
            this.closeScanPop();
            if (this.scanOverlay) {
                this.loadDiffs();
            }
        },

        diffFieldLabel(field) {
            const col = this.builtinColumns.find(function (c) { return c.field === field; });
            return col ? col.headerName : field;
        },

        // ---------- Пометки в ячейках Таблицы ----------

        // Расхождение, блочок которого сейчас виден в ячейке (по полю)
        scanChipShown(row, field) {
            if (row.archived) {
                return null;
            }
            const entry = this.diffIndex.get(row.id);
            const d = entry ? entry[field] : null;
            return d && this.scanShownKinds.has(d.kind) && !this.scanChipHidden(d) ? d : null;
        },

        // Другое имя ПК при записанном в таблице блочком не показывается (этап 38): имя
        // выделено («Имя на ПК другое»), что на ПК – в подсказке у имени
        scanChipHidden(d) {
            return d.field === "hostname" && !d.can_take;
        },

        scanCellDiff(row, col) {
            const entry = this.diffIndex.get(row.id);
            return entry ? entry[col.field] || null : null;
        },

        // Пометка ячейки: вид ситуации, если она сейчас показывается
        scanCellMark(row, col) {
            if (row.archived) {
                return null;
            }
            const d = this.scanCellDiff(row, col);
            if (!d || !this.scanShownKinds.has(d.kind) || this.scanChipHidden(d)) {
                return null;
            }
            return this.scanMarkByKind[d.kind] || null;
        },

        // Блочок со значением сканера в ячейке (этап 26в): вид – по ситуации из Справочников
        // Блочок как значение с фоном в Справочниках: фон, цвет, Ж, К; рамка – тонкой линией внутри
        scanChipStyle(mark) {
            const style = {};
            if (mark.bg_color) {
                style.backgroundColor = mark.bg_color;
            }
            if (mark.frame) {
                style.boxShadow = "inset 0 0 0 1px " + mark.frame;
            }
            if (mark.color) {
                style.color = mark.color;
            }
            if (mark.bold) {
                style.fontWeight = "700";
            }
            if (mark.italic) {
                style.fontStyle = "italic";
            }
            return style;
        },

        // Сканер предлагает очистить ячейку – «пусто»
        scanChipText(d) {
            return d.proposed || "пусто";
        },

        scanChipTitle(d) {
            if (d.kind === "link") {
                return "Привязать " + this.diffSourceShort(d) + "? · " + d.note;
            }
            if (!d.can_take) {
                return "Имя на ПК · " + this.diffSourceShort(d);
            }
            return this.diffSourceShort(d) + (d.note ? " · " + d.note : "");
        },

        // ---------- Карточка действий у блочка ----------

        openScanPop(row, col, event) {
            const d = this.scanCellDiff(row, col);
            if (!d) {
                return;
            }
            const chip = event.currentTarget.getBoundingClientRect();
            this.scanPop = {
                d: d,
                row: row,
                col: col,
                anchor: { left: chip.left, right: chip.right, top: chip.top, bottom: chip.bottom },
                left: chip.right + 6,
                top: chip.top,
                placed: false,
                own: row[col.field] === null || row[col.field] === undefined ? "" : String(row[col.field]),
                forAll: false,
                busy: false
            };
            this.$nextTick(() => this.placeScanPop());
            if (!this._scanPopKey) {
                // Esc и клик мимо закрывают карточку (клик по другому блочку – откроет его)
                this._scanPopKey = (e) => {
                    if (e.key === "Escape" && this.scanPop) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.closeScanPop();
                    }
                };
                this._scanPopDown = (e) => {
                    const el = this.$refs.scanPop;
                    if (!this.scanPop || (el && el.contains(e.target)) || (e.target.closest && e.target.closest("button.scan-chip"))) {
                        return;
                    }
                    this.closeScanPop();
                };
                window.addEventListener("keydown", this._scanPopKey, true);
                window.addEventListener("mousedown", this._scanPopDown, true);
            }
        },

        // Справа от блочка, не помещается – слева; по верхнему краю блочка, внизу не
        // помещается – по нижнему
        placeScanPop() {
            const pop = this.scanPop;
            const el = this.$refs.scanPop;
            if (!pop || !el) {
                return;
            }
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const a = pop.anchor;
            let left = a.right + 6;
            if (left + w > window.innerWidth - 8) {
                left = Math.max(8, a.left - w - 6);
            }
            let top = a.top - 4;
            if (top + h > window.innerHeight - 8) {
                top = Math.max(8, a.bottom + 4 - h);
            }
            pop.left = left;
            pop.top = top;
            pop.placed = true;
        },

        closeScanPop() {
            this.scanPop = null;
            if (this._scanPopKey) {
                window.removeEventListener("keydown", this._scanPopKey, true);
                window.removeEventListener("mousedown", this._scanPopDown, true);
                this._scanPopKey = null;
                this._scanPopDown = null;
            }
        },

        // Перетаскивание за шапку
        startScanPopDrag(event) {
            const pop = this.scanPop;
            if (!pop || event.button !== 0) {
                return;
            }
            // Двигаем сам элемент, не данные Vue: иначе на каждое движение мыши
            // перерисовывалась бы вся страница с таблицей – медленно и рывками.
            // Итог записывается в данные один раз, при отпускании.
            const el = this.$refs.scanPop;
            const dx = event.clientX - pop.left;
            const dy = event.clientY - pop.top;
            let left = pop.left;
            let top = pop.top;
            const move = (e) => {
                left = Math.min(Math.max(0, e.clientX - dx), window.innerWidth - 60);
                top = Math.min(Math.max(0, e.clientY - dy), window.innerHeight - 30);
                if (el) {
                    el.style.left = left + "px";
                    el.style.top = top + "px";
                }
            };
            const up = () => {
                window.removeEventListener("mousemove", move);
                window.removeEventListener("mouseup", up);
                if (this.scanPop === pop) {
                    pop.left = left;
                    pop.top = top;
                }
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
        },

        // Пара «в таблице – у сканера» у других ПК (для «оставить у всех»)
        scanPopCanAll(pop) {
            return pop.d.name_field && !!pop.d.table && pop.d.kind !== "fill";
        },

        // replace – VACUUM: не дописать, а заменить ячейку теми, кто с адреса ПК
        async scanPopTake(replace) {
            const pop = this.scanPop;
            pop.busy = true;
            this.closeScanPop();
            await this.acceptDiffs([pop.d], replace === true);
        },

        // Подсказка «что будет в ячейке»
        diffResultTitle(value) {
            return "Будет: " + String(value || "").split("\n").join(", ");
        },

        async scanPopLeave() {
            const pop = this.scanPop;
            pop.busy = true;
            this.closeScanPop();
            if (pop.forAll && this.scanPopCanAll(pop)) {
                await this.keepDiff(pop.d);
            } else {
                await this.rejectDiffs([pop.d]);
            }
        },

        // «Своё»: значение записывается в таблицу как правильное для того, что
        // предлагает сканер. Название (модель, ОС, ЦП…) – «одно и то же» для всех ПК:
        // значение источника дальше называется так. Остальное (IP, MAC, VACUUM…) –
        // этому ПК это значение сканера больше не предлагается
        async scanPopSaveOwn() {
            const pop = this.scanPop;
            if (!pop || pop.busy) {
                return;
            }
            pop.busy = true;
            const d = pop.d;
            const own = pop.own.trim();
            try {
                if ((await this.saveComputerValue(d.computer_id, d.field, own)) === null) {
                    return;   // не сохранилось – ошибку уже показала правка ячейки
                }
                this.closeScanPop();
                if (own && NAME_FIELDS.includes(d.field) && d.raw) {
                    await this.diffPost("/api/scan/names", { field: d.field, source: d.raw, table: own, kind: "same" });
                } else {
                    await this.diffPost("/api/scan/diffs/reject", { items: [{ computer_id: d.computer_id, field: d.field, raw: d.raw }] });
                }
                await this.loadDiffs();
                this.reloadCheckIfShown();
            } catch (e) {
                this.toastError(e.message || e);
            } finally {
                pop.busy = false;
            }
        },

        // «Привязать?» (этап 38): «Привязать» – запись этому ПК, «Не этот ПК» – больше не предлагать
        async scanPopLink(yes) {
            const pop = this.scanPop;
            pop.busy = true;
            this.closeScanPop();
            await (yes ? this.acceptDiffs([pop.d]) : this.rejectDiffs([pop.d]));
        },

        // Сравнение записи с ПК в карточке у блочка: отметка и её подсказка
        linkCompareTitle(c) {
            return { "=": "Совпадает", "≈": "В таблице часть", "≠": "Отличается" }[c.mark] || null;
        },

        async linkDiffs(list, yes) {
            let done = 0;
            for (const d of list) {
                const s = d.sources[0];
                await this.diffPost("/api/scan/diffs/" + (yes ? "link" : "not-this"), {
                    computer_id: d.computer_id, source: s.source, source_id: s.source_id, table: d.table
                });
                done += 1;
            }
            return done;
        },

        // «Это материнская плата»: название – в «Мат. плату» этому ПК и всем с таким названием
        async scanPopBoard() {
            const pop = this.scanPop;
            pop.busy = true;
            this.closeScanPop();
            await this.boardDiff(pop.d);
        },

        async boardDiff(d) {
            try {
                await this.diffPost("/api/scan/diffs/board", {
                    computer_id: d.computer_id, raw: d.raw, value: d.proposed, source: this.diffSourceShort(d)
                });
                this.toast("Мат. плата: " + d.proposed, "success");
                await this.afterDiffChange();
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        onScanPopOwnKeydown(event) {
            if (event.key === "Enter" && !(event.shiftKey && this.scanPop && this.scanPop.col.multiline)) {
                event.preventDefault();
                this.scanPopSaveOwn();
            }
        },

        // ---------- Подсказка у включённой кнопки: что значат цвета ----------

        showScanLegend(on) {
            this.scanLegend = on && this.scanOverlay;
        },

        // Подсказка при правке ячейки / строки карточки: значение сканера первым
        scanSuggestFor(rowId, field) {
            const entry = this.diffIndex.get(rowId);
            const d = entry ? entry[field] : null;
            if (!d || d.kind === "partial" || d.kind === "link" || !d.can_take || !d.proposed || d.proposed.includes("\n")) {
                return [];
            }
            return [{ key: "scan:" + d.proposed.toLowerCase(), value: d.proposed, count: this.diffSourceShort(d), scan: true }];
        },

        // Строка карточки: что предлагает сканер (кроме «в таблице часть»)
        cardScanDiff(r) {
            if (!this.card || !r.field) {
                return null;
            }
            const entry = this.diffIndex.get(this.card.id);
            const d = entry ? entry[r.field] : null;
            // Как в Таблице: только когда значения сканера показаны (кнопка или «Без кнопки»)
            return d && d.kind !== "partial" && this.scanShownKinds.has(d.kind) ? d : null;
        },

        // ---------- Почему можно верить ----------

        diffSourceShort(d) {
            return d.sources.map(sourceName).join(", ");
        },

        // Части текста «почему можно верить»: как сопоставлен, согласие источников, когда проверен
        diffTrust(d) {
            const parts = [];
            const by = new Set();
            let manual = false;
            d.sources.forEach(function (s) {
                if (s.state === "link") {
                    manual = true;
                }
                (s.by || []).forEach(function (k) { by.add(k); });
            });
            if (manual) {
                parts.push({ text: "ПК привязан вручную" });
            }
            if (by.size && d.kind !== "link") {
                parts.push({ text: "ПК по " + KEY_ORDER.filter(function (k) { return by.has(k); }).map(function (k) { return KEY_TEXT[k]; }).join(" и ") });
            }
            if (d.sources.length > 1) {
                parts.push(d.kind === "unsure" && d.unsure.startsWith("источники")
                    ? { text: "источники расходятся", bad: true }
                    : { text: "источников согласны: " + d.sources.length });
            }
            if (d.kind === "unsure" && !d.unsure.startsWith("источники")) {
                parts.push({ text: "неточно: " + d.unsure, bad: true });
            }
            if (d.note) {
                parts.push({ text: d.note });
            }
            const dates = d.sources.map(function (s) { return s.checked_at; }).filter(Boolean).sort();
            if (dates.length) {
                const online = d.sources.every(function (s) { return s.source === "jabber" || s.source === "dhcp" || s.source === "net"; });
                parts.push({ text: (online ? "в сети " : "проверен ") + this.formatDate(dates[dates.length - 1]) });
            }
            return parts;
        },

        diffSourceTitle(d) {
            return d.sources.map((s) => sourceName(s) + (s.checked_at ? " · " + this.formatTime(s.checked_at) : "") +
                (d.sources.length > 1 ? " · " + s.value.split("\n").join(", ") : "")).join("\n") + (d.note ? "\n" + d.note : "");
        },

        // ---------- Решения ----------

        async diffPost(url, body) {
            const response = await apiFetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            if (!response.ok) {
                throw new Error(await this.errorText(response));
            }
            return response.json();
        },

        async afterDiffChange() {
            await Promise.all([this.loadDiffs(), this.loadTable()]);
            this.refreshCardRow();
            this.reloadCheckIfShown();
        },

        // Вкладка «Проверка» открыта – обновить и её (сравнение зависит от таблицы и названий)
        reloadCheckIfShown() {
            if (this.view === "scan" && this.scanTab === "check") {
                this.loadCheck();
            }
        },

        // replace – взять второй вариант (VACUUM: заменить, а не дописать). Привязка
        // записи (этап 38) – своим запросом
        async acceptDiffs(list, replace) {
            const links = list.filter(function (d) { return d.kind === "link"; });
            list = list.filter(function (d) { return d.kind !== "link" && d.can_take && (!replace || d.replace); });
            if (links.length) {
                try {
                    const done = await this.linkDiffs(links, true);
                    this.toast("Привязано: " + done, "success");
                } catch (e) {
                    this.toastError(e.message || e);
                }
                if (!list.length) {
                    await this.afterDiffChange();
                    return;
                }
            }
            if (!list.length) {
                return;
            }
            try {
                const result = await this.diffPost("/api/scan/diffs/accept", {
                    items: list.map((d) => ({
                        computer_id: d.computer_id, field: d.field, value: replace ? d.replace : d.proposed, table: d.table,
                        source: this.diffSourceShort(d)
                    }))
                });
                let text = "Принято: " + result.accepted;
                if (result.skipped.length) {
                    text += ", пропущено: " + result.skipped.length;
                }
                this.toast(text, result.skipped.length ? undefined : "success");
                await this.afterDiffChange();
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        // «Принять изменения…» у выбранных строк Таблицы: выбранные тип и столбец
        async submitScanBar() {
            const bar = this.actionBar;
            const list = this.scanBarDiffs.slice();
            if (!bar || bar.saving) {
                return;
            }
            if (!list.length) {
                bar.error = "Нечего принять.";
                return;
            }
            bar.saving = true;
            await this.acceptDiffs(list);
            this.actionBar = null;
            this.selectedRows = [];
            this.selectAnchorId = null;
        },

        async rejectDiffs(list, back) {
            const links = list.filter(function (d) { return d.kind === "link"; });
            if (links.length) {
                try {
                    await this.linkDiffs(links, false);
                    this.toast("Не этот ПК: " + links.length, "success");
                    await this.loadDiffs();
                    this.reloadCheckIfShown();
                } catch (e) {
                    this.toastError(e.message || e);
                }
                list = list.filter(function (d) { return d.kind !== "link"; });
                if (!list.length) {
                    return;
                }
            }
            try {
                const result = await this.diffPost("/api/scan/diffs/" + (back ? "unreject" : "reject"), {
                    items: list.map(function (d) { return { computer_id: d.computer_id, field: d.field, raw: d.raw }; })
                });
                this.toast(back ? "Возвращено: " + result.returned : "Отклонено: " + result.rejected, "success");
                await this.loadDiffs();
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        // «В таблице своё»: эта пара значений – не расхождение ни у одного ПК
        async keepDiff(d) {
            try {
                await this.diffPost("/api/scan/names", { field: d.field, source: d.raw, table: d.table, kind: "keep" });
                this.toast(this.diffFieldLabel(d.field) + ": «" + d.table + "» – оставлено", "success");
                await this.loadDiffs();
                this.reloadCheckIfShown();
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        // ---------- Правка значения таблицы прямо из списка / подробностей записи ----------

        // Своё значение в ПК (как правка ячейки): например, объединить таблицу и сканер.
        // Ответ: true – записано, false – значение то же, null – не удалось
        async saveComputerValue(computerId, field, value) {
            const row = this.rows.find(function (r) { return r.id === computerId; });
            const col = this.allColumns.find(function (c) { return c.field === field; });
            if (!row || !col) {
                this.toastError("ПК не найден – обнови страницу.");
                return null;
            }
            if (String(value) === String(row[field] || "")) {
                return false;
            }
            return (await this.saveCellValue(row, col, value)) ? true : null;
        },

        startValueEdit(key, computerId, field, value) {
            const col = this.allColumns.find(function (c) { return c.field === field; });
            if (!this.canEdit || !col || !col.editable) {
                return;
            }
            this.valueEdit = { key: key, computerId: computerId, field: field, value: value || "", multiline: !!col.multiline };
            this.$nextTick(() => {
                const el = document.querySelector(".value-edit");
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },

        onValueEditKeydown(event) {
            if (event.key === "Escape") {
                event.preventDefault();
                this.valueEdit = null;
            } else if (event.key === "Enter" && !(this.valueEdit.multiline && event.shiftKey)) {
                event.preventDefault();
                this.finishValueEdit();
            }
        },

        async finishValueEdit() {
            const edit = this.valueEdit;
            if (!edit || edit.saving) {
                return;
            }
            edit.saving = true;
            try {
                const changed = await this.saveComputerValue(edit.computerId, edit.field, edit.value);
                this.valueEdit = null;
                if (changed) {
                    await this.loadDiffs();
                    this.reloadCheckIfShown();
                }
            } finally {
                if (this.valueEdit === edit) {
                    this.valueEdit = null;
                }
            }
        },

        // ---------- Вид пометок (Справочники) ----------

        async updateScanMark(kind, patch) {
            try {
                const response = await apiFetch("/api/scan/marks/" + kind, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const saved = await response.json();
                this.scanMarks = this.scanMarks.map(function (m) { return m.kind === kind ? saved : m; });
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        scanLegendSample(kind) {
            return { diff: "8", fill: "Win 10", unsure: "TightVNC", partial: "10.0.9.5", link: "157" }[kind] || "…";
        },

        scanMarkHint(kind) {
            return {
                diff: "замена",
                fill: "новое значение",
                unsure: "неточно – проверь сам",
                partial: "добавление значений",
                link: "привязать запись GLPI / GSIT?"
            }[kind] || "";
        },

        scanMarkHasStyle(m) {
            return !!(m.color || m.bg_color || m.bold || m.italic || m.strike || m.frame);
        }
    }
};
