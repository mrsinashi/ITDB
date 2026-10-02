// История: отмена изменений, возврат значения, фильтры, выделение строк (этап 19).
//
// Отменить — у изменения пометка «отменено», новой записи нет, значение поля
// пересчитывается по оставшимся изменениям (сервер: backend/history_undo.py).
// Вернуть значение — поле получает значение из истории, в Истории новая запись
// с пометкой «возврат значения».
// Отменённые по умолчанию скрыты и не считаются — глаз в шапке таблицы Истории.
// Окно «История значения» — двойной клик по полю в записи (Истории и карточки).

import { apiFetch, clickSelect } from "../util.js";
import { FIXED_HISTORY_FIELDS } from "../columns.js";

const ENTITY_FILTERS = {
    computers: "Компьютеры",
    locations: "Расположения",
    choices: "Справочники",
    field_defs: "Польз. поля",
    column_styles: "Оформление столбцов",
    users: "Пользователи системы",
    scan_sources: "Сканер: подключения",
    scan_subnets: "Сканер: подсети",
    scan_records: "Сканер: сопоставление",
    scan_aliases: "Сканер: названия",
    scan_schedule: "Сканер: расписание",
    scan_marks: "Пометки сканера",
    scan_antivirus: "Антивирусы (вид столбца)",
    table_marks: "Выделения в Таблице"
};
// Только администратор видит эти записи; отмены у них нет (только просмотр)
const ADMIN_ENTITIES = ["users", "scan_sources", "scan_subnets", "scan_records", "scan_aliases", "scan_schedule"];
const NO_UNDO_ENTITIES = ["scan_sources", "scan_subnets", "scan_records", "scan_aliases", "scan_schedule", "scan_marks", "scan_antivirus", "table_marks"];

export default {
    computed: {
        // Пользователей системы в фильтре видит только администратор
        historyEntityFilters() {
            const result = Object.assign({}, ENTITY_FILTERS);
            if (!this.isAdmin) {
                ADMIN_ENTITIES.forEach(function (key) { delete result[key]; });
            }
            return result;
        },

        // Выбранные записи Истории (только из видимых сейчас)
        historySelectedItems() {
            const set = new Set(this.historySelected);
            return this.filteredHistory.filter(function (item) { return set.has(item.id); });
        },

        historySelectedCanCancel() {
            return this.historySelectedItems.some((item) => NO_UNDO_ENTITIES.indexOf(item.entity) === -1 && this.hasFields(item.changes, false));
        },

        historySelectedCanRestore() {
            return this.historySelectedItems.some((item) => NO_UNDO_ENTITIES.indexOf(item.entity) === -1 && this.hasFields(item.changes, true));
        },

        historyFiltered() {
            const f = this.historyFilter;
            return !!(f.user || f.entity);
        },

        // История карточки: отменённые целиком записи — только с глазом
        cardHistoryShown() {
            if (this.historyShowCancelled) {
                return this.cardHistory;
            }
            return this.cardHistory.filter(function (item) { return !item.cancelled; });
        },

        // ---------- Окно «История значения» ----------

        vhRows() {
            const d = this.valueDialog && this.valueDialog.data;
            if (!d) {
                return [];
            }
            const rows = d.items.map(function (it) { return { key: "h" + it.id, item: it }; });
            // Исходное значение — «было» самого первого изменения: к нему тоже можно вернуться
            if (d.kind === "value" && d.items.length) {
                rows.push({ key: "initial", initial: true, value: d.initial });
            }
            return rows;
        },

        vhSelectedRows() {
            const vd = this.valueDialog;
            if (!vd) {
                return [];
            }
            return this.vhRows.filter(function (r) { return vd.selected.indexOf(r.key) !== -1; });
        },

        vhCanCancel() {
            const d = this.valueDialog && this.valueDialog.data;
            return !!d && (d.kind === "value" || d.kind === "info") && this.vhSelectedRows.some(function (r) { return r.item && !r.item.cancelled; });
        },

        vhHasCancelled() {
            const d = this.valueDialog && this.valueDialog.data;
            return !!d && d.items.some(function (it) { return it.cancelled; });
        },

        vhCanRestore() {
            const d = this.valueDialog && this.valueDialog.data;
            return !!d && d.kind !== "gone" && this.vhSelectedRows.some(function (r) { return r.item && r.item.cancelled; });
        },

        // Отменять и возвращать пользователей системы может только администратор
        vhCanAct() {
            const vd = this.valueDialog;
            return !!vd && !!vd.data && this.canEdit && (vd.entity !== "users" || this.isAdmin);
        },

        vhCanRevert() {
            const d = this.valueDialog && this.valueDialog.data;
            if (!d || d.kind !== "value" || this.vhSelectedRows.length !== 1) {
                return false;
            }
            const r = this.vhSelectedRows[0];
            const value = r.initial ? r.value : r.item.new;
            return this.displayValue(value) !== this.displayValue(d.current) && d.kind === "value";
        },
    },

    watch: {
        // Другой набор записей — выделение снимается
        historyItems() {
            const ids = new Set(this.historyItems.map(function (item) { return item.id; }));
            this.historySelected = this.historySelected.filter(function (id) { return ids.has(id); });
        },
    },

    methods: {
        // Поля записи для показа: «Создан» первым; отменённые — только с глазом
        shownChanges(changes) {
            const ordered = this.orderedChanges(changes) || {};
            if (this.historyShowCancelled) {
                return ordered;
            }
            const result = {};
            Object.keys(ordered).forEach(function (field) {
                if (!(ordered[field] || {}).cancelled) {
                    result[field] = ordered[field];
                }
            });
            return result;
        },

        // Есть ли в записи отменённые (cancelled=true) / неотменённые поля
        hasFields(changes, cancelled) {
            return Object.keys(changes || {}).some(function (field) {
                return !!(changes[field] || {}).cancelled === cancelled;
            });
        },

        cancelTitle(change) {
            const c = change && change.cancelled;
            if (!c) {
                return "";
            }
            return "Отменил " + (c.by || "—") + " " + this.formatTime(c.at);
        },

        // Двойной клик открывает «Историю значения» (у создания, удаления и пароля — нет)
        canOpenValue(entity, field) {
            return !!ENTITY_FILTERS[entity] && NO_UNDO_ENTITIES.indexOf(entity) === -1 && FIXED_HISTORY_FIELDS.indexOf(field) === -1;
        },

        toggleShowCancelled() {
            this.historyShowCancelled = !this.historyShowCancelled;
            this.loadHistory();
        },

        // ---------- Фильтры ----------

        historyParams() {
            const f = this.historyFilter;
            const params = new URLSearchParams();
            if (f.user) {
                params.set("user", f.user);
            }
            if (f.entity) {
                params.set("entity", f.entity);
                if (f.entityId !== null) {
                    params.set("entity_id", f.entityId);
                }
                if (f.entityKey) {
                    params.set("entity_key", f.entityKey);
                }
            }
            if (this.historyShowCancelled) {
                params.set("cancelled", "true");
            }
            return params;
        },

        setHistoryUser(name) {
            this.closeMenus();
            this.historyFilter = Object.assign({}, this.historyFilter, { user: name || null });
            this.loadHistory();
        },

        setHistoryEntity(entity) {
            this.closeMenus();
            this.historyFilter = Object.assign({}, this.historyFilter, { entity: entity || null, entityId: null, entityKey: null, title: "" });
            this.loadHistory();
        },

        // Только этот объект (значок у имени объекта в строке)
        filterHistoryObject(item) {
            this.historyFilter = Object.assign({}, this.historyFilter, {
                entity: item.entity,
                entityId: item.entity_id,
                entityKey: item.entity_key || null,
                title: item.title || ("#" + item.entity_id)
            });
            this.loadHistory();
        },

        historyEntityChip() {
            const f = this.historyFilter;
            if (f.entityId !== null) {
                return this.entityLabel(f.entity) + ": " + f.title;
            }
            return ENTITY_FILTERS[f.entity] || f.entity;
        },

        // ---------- Выделение строк ----------

        onHistoryRowMouseDown(event) {
            if (event.button !== 0) {
                return;
            }
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                event.preventDefault();
            }
        },

        onHistoryRowClick(event, item) {
            if (event.target.closest(".h-link, .h-user-link, .h-only")) {
                return;
            }
            const ids = this.filteredHistory.map(function (i) { return i.id; });
            const r = clickSelect(this.historySelected, ids, this.historyAnchor, item.id, event, false);
            this.historySelected = r.selected;
            this.historyAnchor = r.anchor;
        },

        isHistorySelected(item) {
            return this.historySelected.indexOf(item.id) !== -1;
        },

        selectAllHistory() {
            this.historySelected = this.filteredHistory.map(function (i) { return i.id; });
        },

        clearHistorySelection() {
            this.historySelected = [];
            this.historyAnchor = null;
            this.closeMenus();
        },

        // ---------- Отменить / восстановить ----------

        async cancelHistory(items, cancel) {
            try {
                const response = await apiFetch("/api/history/cancel", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ items: items, cancel: cancel })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                this.toast((cancel ? "Отменено изменений: " : "Восстановлено изменений: ") + data.count, "success");
                await this.afterHistoryAction();
                return true;
            } catch (e) {
                this.toastError(e.message || e);
                return false;
            }
        },

        async cancelSelectedHistory(cancel) {
            const items = this.historySelectedItems
                .filter(function (item) { return NO_UNDO_ENTITIES.indexOf(item.entity) === -1; })
                .map(function (item) { return { id: item.id }; });
            this.closeMenus();
            if (items.length && await this.cancelHistory(items, cancel)) {
                this.clearHistorySelection();
            }
        },

        // После отмены и возврата: значения ПК, узлов, справочников и т. п.
        // изменились — перечитать Историю, таблицу, открытую карточку, дерево,
        // Справочники (оформление таблицы) и пользователей
        async afterHistoryAction() {
            const cardId = this.card ? this.card.id : null;
            const tasks = [this.loadChoices(), this.loadColumnStyles(), this.loadFieldDefs()];
            tasks.push(this.loadTable());
            if (this.view === "users" && this.isAdmin) {
                tasks.push(this.loadUsers());
            }
            if (this.view === "history") {
                tasks.push(this.loadHistory());
            }
            if (this.view === "tree") {
                tasks.push(this.loadTree());
            }
            await Promise.all(tasks);
            if (cardId !== null) {
                const row = this.rows.find(function (r) { return r.id === cardId; });
                if (row) {
                    this.card = row;
                }
                this.reloadCardHistory(cardId);
            }
        },

        // ---------- Окно «История значения» ----------

        async openValueHistory(entity, entityId, field, entityKey) {
            if (!this.canOpenValue(entity, field)) {
                return;
            }
            window.getSelection && window.getSelection().removeAllRanges();
            this.valueDialog = { entity: entity, entityId: entityId, entityKey: entityKey || null, field: field, data: null, selected: [], anchor: null, busy: false, error: "" };
            await this.loadValueHistory();
        },

        async loadValueHistory() {
            const vd = this.valueDialog;
            if (!vd) {
                return;
            }
            try {
                const params = new URLSearchParams({ entity: vd.entity, entity_id: vd.entityId, field: vd.field });
                if (vd.entityKey) {
                    params.set("entity_key", vd.entityKey);
                }
                const response = await apiFetch("/api/history/value?" + params);
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                vd.data = await response.json();
                vd.selected = [];
                vd.anchor = null;
            } catch (e) {
                vd.error = e.message || String(e);
            }
        },

        closeValueDialog() {
            this.valueDialog = null;
        },

        vhRowMouseDown(event) {
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                event.preventDefault();
            }
        },

        vhRowClick(event, row) {
            const vd = this.valueDialog;
            const keys = this.vhRows.map(function (r) { return r.key; });
            const r = clickSelect(vd.selected, keys, vd.anchor, row.key, event, true);
            vd.selected = r.selected;
            vd.anchor = r.anchor;
            vd.error = "";
        },

        async vhCancel(cancel) {
            const vd = this.valueDialog;
            const items = this.vhSelectedRows
                .filter(function (r) { return r.item && !!r.item.cancelled !== cancel; })
                .map(function (r) { return { id: r.item.id, field: vd.field }; });
            if (!items.length || vd.busy) {
                return;
            }
            vd.busy = true;
            if (await this.cancelHistory(items, cancel)) {
                await this.loadValueHistory();
            }
            vd.busy = false;
        },

        async vhRevert() {
            const vd = this.valueDialog;
            if (!this.vhCanRevert || vd.busy) {
                return;
            }
            const r = this.vhSelectedRows[0];
            const items = vd.data.items;
            const body = r.initial
                ? { id: items[items.length - 1].id, field: vd.field, initial: true }
                : { id: r.item.id, field: vd.field };
            vd.busy = true;
            try {
                const response = await apiFetch("/api/history/revert", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.toast(vd.data.label + ": возвращено «" + this.historyValue(vd.entity, vd.field, r.initial ? r.value : r.item.new) + "»", "success");
                await this.afterHistoryAction();
                await this.loadValueHistory();
            } catch (e) {
                vd.error = e.message || String(e);
            }
            vd.busy = false;
        },
    }
};
