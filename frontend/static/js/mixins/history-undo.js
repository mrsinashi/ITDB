// История: отмена изменений, возврат значения, фильтры, выделение строк (этап 19).
//
// Отменить — у изменения пометка «отменено», новой записи нет, значение поля
// пересчитывается по оставшимся изменениям (сервер: backend/history_undo.py).
// Вернуть значение — поле получает значение из истории, в Истории новая запись
// с пометкой «возврат значения».
// Отменённые по умолчанию скрыты и не считаются — глаз в шапке таблицы Истории.
// Окно «История значения» — двойной клик по полю в записи (Истории и карточки).

import { apiFetch } from "../util.js";

const ENTITY_FILTERS = { computers: "Компьютеры", locations: "Расположения" };

// Выделение в списке по клику: Ctrl — добавить/убрать, Shift — диапазон от
// прошлой строки, Ctrl+Shift — добавить диапазон. single — обычный клик
// выбирает одну строку (в окне), иначе только запоминает её (как в таблице).
function clickSelect(selected, ids, anchor, id, event, single) {
    const ctrl = event.ctrlKey || event.metaKey;
    const from = anchor === null ? -1 : ids.indexOf(anchor);
    if (event.shiftKey && from !== -1) {
        const to = ids.indexOf(id);
        const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
        if (ctrl) {
            return { selected: selected.concat(range.filter(function (x) { return selected.indexOf(x) === -1; })), anchor: anchor };
        }
        return { selected: range, anchor: anchor };
    }
    if (ctrl) {
        const has = selected.indexOf(id) !== -1;
        return { selected: has ? selected.filter(function (x) { return x !== id; }) : selected.concat([id]), anchor: id };
    }
    return { selected: single ? [id] : selected, anchor: id };
}

export default {
    computed: {
        historyEntityFilters() {
            return ENTITY_FILTERS;
        },

        // Выбранные записи Истории (только из видимых сейчас)
        historySelectedItems() {
            const set = new Set(this.historySelected);
            return this.filteredHistory.filter(function (item) { return set.has(item.id); });
        },

        historySelectedCanCancel() {
            return this.historySelectedItems.some((item) => this.hasFields(item.changes, false));
        },

        historySelectedCanRestore() {
            return this.historySelectedItems.some((item) => this.hasFields(item.changes, true));
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
            return !!d && d.kind !== "created" && this.vhSelectedRows.some(function (r) { return r.item && !r.item.cancelled; });
        },

        vhHasCancelled() {
            const d = this.valueDialog && this.valueDialog.data;
            return !!d && d.items.some(function (it) { return it.cancelled; });
        },

        vhCanRestore() {
            return this.vhSelectedRows.some(function (r) { return r.item && r.item.cancelled; });
        },

        vhCanRevert() {
            const d = this.valueDialog && this.valueDialog.data;
            if (!d || d.kind !== "value" || this.vhSelectedRows.length !== 1) {
                return false;
            }
            const r = this.vhSelectedRows[0];
            const value = r.initial ? r.value : r.item.new;
            return this.displayValue(value) !== this.displayValue(d.current);
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

        // Двойной клик открывает «Историю значения» (у создания — нет)
        canOpenValue(entity, field) {
            return (entity === "computers" || entity === "locations") && field !== "created";
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
            this.historyFilter = Object.assign({}, this.historyFilter, { entity: entity || null, entityId: null, title: "" });
            this.loadHistory();
        },

        // Только этот объект (значок у имени объекта в строке)
        filterHistoryObject(item) {
            this.historyFilter = Object.assign({}, this.historyFilter, {
                entity: item.entity,
                entityId: item.entity_id,
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
            const items = this.historySelectedItems.map(function (item) { return { id: item.id }; });
            this.closeMenus();
            if (items.length && await this.cancelHistory(items, cancel)) {
                this.clearHistorySelection();
            }
        },

        // После отмены и возврата: значения ПК и узлов изменились —
        // перечитать Историю, таблицу, открытую карточку и дерево
        async afterHistoryAction() {
            const cardId = this.card ? this.card.id : null;
            const tasks = [this.loadTable()];
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

        async openValueHistory(entity, entityId, field) {
            if (!this.canOpenValue(entity, field)) {
                return;
            }
            window.getSelection && window.getSelection().removeAllRanges();
            this.valueDialog = { entity: entity, entityId: entityId, field: field, data: null, selected: [], anchor: null, busy: false, error: "" };
            await this.loadValueHistory();
        },

        async loadValueHistory() {
            const vd = this.valueDialog;
            if (!vd) {
                return;
            }
            try {
                const params = new URLSearchParams({ entity: vd.entity, entity_id: vd.entityId, field: vd.field });
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
                this.toast(vd.data.label + ": возвращено «" + this.displayValue(r.initial ? r.value : r.item.new) + "»", "success");
                await this.afterHistoryAction();
                await this.loadValueHistory();
            } catch (e) {
                vd.error = e.message || String(e);
            }
            vd.busy = false;
        },
    }
};
