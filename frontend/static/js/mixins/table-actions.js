// Таблица: новый компьютер и смена расположения, архив, действия с выбранными строками.

import { apiFetch, searchNorm } from "../util.js";
import { LOCATION_FIELDS } from "../columns.js";

export default {
    computed: {
        // Кнопка «Архив»: с выбранными строками — убрать в архив / вернуть,
        // без выбора — показать архив / вернуться к таблице
        archiveAction() {
            if (this.canEdit && this.selectedRows.length) {
                return this.showArchive ? "restore" : "archive";
            }
            return "toggle";
        },

        archiveButtonTitle() {
            const n = this.selectedRows.length;
            if (this.archiveAction === "archive") {
                return "В архив: выбранные (" + n + ")";
            }
            if (this.archiveAction === "restore") {
                return "Вернуть из архива: выбранные (" + n + ")";
            }
            if (this.showArchive) {
                return "К таблице";
            }
            return "Архив";
        },

        // Рабочие ПК для «Заменить на…»: имя, расположение, № места
        computerOptions() {
            const skip = new Set(this.actionBar ? this.actionBar.ids : []);
            return this.activeRows.filter(function (row) { return !skip.has(row.id); }).map((row) => {
                const entry = this.treeIndex[row.location_id];
                const place = [entry ? entry.path : "", row.seat_no ? "№ " + row.seat_no : ""].filter(Boolean).join(", ");
                const path = (row.hostname || "без имени") + (place ? " — " + place : "");
                return {
                    id: row.id,
                    kind: "pc",
                    path: path,
                    search: searchNorm([path, row.inv_no, row.status].filter(Boolean).join(" "))
                };
            });
        },

        // Столбцы для «Изменить поле у выбранных»: без расположения и № места
        // (это «Переместить») и без значений, которые у каждого ПК свои
        bulkColumns() {
            return this.allColumns.filter(function (col) {
                return col.editable && !col.location && col.bulk !== false;
            });
        },

        // Все узлы дерева в его порядке — для выбора расположения ПК
        locationOptions() {
            const list = [];
            const walk = (nodes) => {
                nodes.forEach((node) => {
                    const entry = this.treeIndex[node.id];
                    const path = entry ? entry.path : (node.name || node.code || "");
                    list.push({ id: node.id, kind: node.kind, path: path, search: searchNorm(path) });
                    walk(node.children || []);
                });
            };
            walk(this.treeRoots);
            return list;
        },
    },

    methods: {
        // ---------- Расположение ПК и новый компьютер ----------

        // Дерево нужно для выбора расположения; грузится один раз
        async ensureTree() {
            if (!this.treeRoots.length && !this.treeLoading) {
                await this.loadTree();
            }
        },

        onCellLocationPick(row, locationId) {
            this.cancelEdit();
            this.saveLocation(row, locationId);
        },

        onCardLocationPick(locationId) {
            this.cardEditKey = null;
            if (!this.card) {
                return;
            }
            const row = this.rows.find((item) => item.id === this.card.id) || this.card;
            this.saveLocation(row, locationId);
        },

        // Смена расположения: строка переезжает на своё место в порядке
        // дерева, поэтому таблица перечитывается целиком
        async saveLocation(row, locationId) {
            if (!locationId || locationId === row.location_id) {
                return;
            }
            try {
                const response = await apiFetch("/api/computers/" + row.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ location_id: locationId, _version: row.version })
                });
                if (response.status === 409) {
                    this.toastError(await this.errorText(response));
                    await this.loadTable();
                    this.refreshCardRow();
                    return;
                }
                if (!response.ok) {
                    this.toastError("Не удалось сохранить: " + (await this.errorText(response)));
                    return;
                }
                await this.loadTable();
                this.refreshCardRow();
                this.reloadCardHistory(row.id);
                LOCATION_FIELDS.concat(["location_id"]).forEach((field) => this.flashCell(row.id, field));
                this.$nextTick(() => this.scrollToRow(row.id));
            } catch (e) {
                this.toastError("Не удалось сохранить: " + e);
            }
        },

        // Открыта карточка этого ПК — перечитать её историю после правки
        async reloadCardHistory(id) {
            if (!this.card || this.card.id !== id) {
                return;
            }
            try {
                const response = await apiFetch("/api/computers/" + id);
                if (!response.ok || !this.card || this.card.id !== id) {
                    return;
                }
                const data = await response.json();
                this.cardHistory = data.history || [];
            } catch (e) {
                // не страшно: история обновится при следующем открытии
            }
        },

        // После перечитывания таблицы карточка показывает новую строку
        refreshCardRow() {
            if (!this.card) {
                return;
            }
            const id = this.card.id;
            const row = this.rows.find((item) => item.id === id);
            if (row) {
                this.card = row;
            }
        },

        scrollToRow(id) {
            const wrap = this.$refs.tableWrap;
            const tr = wrap && wrap.querySelector('tr[data-id="' + id + '"]');
            if (!tr) {
                return false;
            }
            const w = wrap.getBoundingClientRect();
            const r = tr.getBoundingClientRect();
            const head = this.$refs.table ? this.$refs.table.tHead.getBoundingClientRect().height : 0;
            if (r.top < w.top + head || r.bottom > w.bottom) {
                wrap.scrollTop += r.top - w.top - head - (w.height - head) / 3;
            }
            return true;
        },

        toggleNewComputer() {
            if (this.newComputer) {
                this.closeNewComputer();
                return;
            }
            // Новый ПК появится среди рабочих — из архива уходим
            this.setArchiveView(false);
            this.actionBar = null;
            this.ensureTree();
            // По умолчанию — узел, выбранный фильтром из дерева
            const locationId = this.locationFilter ? this.locationFilter.id : null;
            this.newComputer = { location_id: locationId, seat_no: "", hostname: "", ip: "" };
            this.newComputerError = "";
            if (locationId) {
                this.newComputer.seat_no = this.nextSeatNo(locationId);
            }
            this.$nextTick(() => this.focusNewComputer(locationId ? "hostname" : "location"));
        },

        closeNewComputer() {
            this.newComputer = null;
            this.newComputerError = "";
        },

        focusNewComputer(which) {
            const el = this.$refs["nc-" + which];
            const input = el && (el.$el ? el.$el.querySelector("input") : el);
            if (input) {
                input.focus();
            }
        },

        // Следующий свободный № места в узле: наибольший + 1
        nextSeatNo(locationId, excludeIds) {
            let max = 0;
            const skip = new Set(excludeIds || []);
            this.rows.forEach(function (row) {
                if (!row.archived && !skip.has(row.id) && row.location_id === locationId && Number(row.seat_no) > max) {
                    max = Number(row.seat_no);
                }
            });
            return String(max + 1);
        },

        onNewComputerLocation(locationId) {
            if (!this.newComputer) {
                return;
            }
            const changed = this.newComputer.location_id !== locationId;
            this.newComputer.location_id = locationId;
            if (changed) {
                this.newComputer.seat_no = this.nextSeatNo(locationId);
            }
            this.newComputerError = "";
            this.$nextTick(() => this.focusNewComputer("hostname"));
        },

        async submitNewComputer() {
            const form = this.newComputer;
            if (!form || this.newComputerSaving) {
                return;
            }
            if (!form.location_id) {
                this.newComputerError = "Выбери расположение.";
                this.focusNewComputer("location");
                return;
            }
            this.newComputerError = "";
            this.newComputerSaving = true;
            try {
                const response = await apiFetch("/api/computers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        location_id: form.location_id,
                        seat_no: form.seat_no,
                        hostname: form.hostname,
                        ip: form.ip
                    })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                await this.loadTable();
                this.flashRow(data.id);
                this.$nextTick(() => {
                    if (!this.scrollToRow(data.id)) {
                        this.toast("Компьютер добавлен, но скрыт поиском или фильтром");
                    }
                });
                (data.shifted || []).forEach((id) => this.flashCell(id, "seat_no"));
                this.toast("Добавлен: " + (form.hostname.trim() || "компьютер без имени") +
                    (data.shifted && data.shifted.length ? ". № места был занят — следующие сдвинуты: " + data.shifted.length : ""), "success");
                // Форма остаётся открытой: можно сразу добавить следующий в тот же узел
                form.hostname = "";
                form.ip = "";
                form.seat_no = this.nextSeatNo(form.location_id);
                this.$nextTick(() => this.focusNewComputer("hostname"));
            } catch (e) {
                this.newComputerError = String(e.message || e);
            }
            this.newComputerSaving = false;
        },

        flashRow(id) {
            this.allColumns.forEach((col) => this.flashCell(id, col.field));
        },

        // «Создан» — первым: в базе ключи изменений хранятся в другом порядке
        orderedChanges(changes) {
            if (!changes || !changes.created) {
                return changes;
            }
            return Object.assign({ created: changes.created }, changes);
        },

        // ---------- Архив ----------

        onArchiveButton() {
            if (this.archiveAction === "toggle") {
                this.setArchiveView(!this.showArchive);
            } else {
                this.setArchived(this.selectedRows.slice(), this.archiveAction === "archive");
            }
        },

        setArchiveView(on) {
            if (this.showArchive === on) {
                return;
            }
            this.showArchive = on;
            // Выбранные строки другого режима не видны — снимаем
            this.selectedRows = [];
            this.selectAnchorId = null;
            if (on) {
                this.closeNewComputer();
            }
            this.actionBar = null;
            this.cancelEdit();
            this.$nextTick(() => {
                if (this.$refs.tableWrap) {
                    this.$refs.tableWrap.scrollTop = 0;
                }
            });
        },

        async setArchived(ids, archived) {
            this.closeMenus();
            if (!ids.length || this.archiveSaving) {
                return;
            }
            this.archiveSaving = true;
            try {
                const response = await apiFetch("/api/computers/archive", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ids: ids, archived: archived })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                let text;
                if (ids.length === 1) {
                    const row = this.rows.find(function (r) { return r.id === ids[0]; });
                    const name = (row && row.hostname) || "компьютер без имени";
                    text = (archived ? "В архиве: " : "Возвращён из архива: ") + name;
                } else {
                    text = (archived ? "В архив убрано ПК: " : "Возвращено из архива ПК: ") + ids.length;
                }
                this.selectedRows = [];
                this.selectAnchorId = null;
                await this.loadTable();
                if (this.card && ids.indexOf(this.card.id) !== -1) {
                    this.refreshCardRow();
                    this.reloadCardHistory(this.card.id);
                }
                this.toast(text, "success");
            } catch (e) {
                this.toastError("Не удалось: " + (e.message || e));
            }
            this.archiveSaving = false;
        },

        // ---------- Действия с выбранными строками ----------

        // Выбранные ПК в порядке таблицы (так они и встанут при перемещении)
        selectedInOrder() {
            const set = this.selectedSet;
            const shown = this.displayRows.filter(function (row) { return set.has(row.id); }).map(function (row) { return row.id; });
            const rest = this.selectedRows.filter(function (id) { return shown.indexOf(id) === -1; });
            return shown.concat(rest);
        },

        rowName(id) {
            const row = this.rows.find(function (r) { return r.id === id; });
            return (row && row.hostname) || "компьютер без имени";
        },

        openAction(kind) {
            this.closeMenus();
            this.closeNewComputer();
            this.cancelEdit();
            this.ensureTree();
            const ids = this.selectedInOrder();
            const bar = { kind: kind, ids: ids, error: "", saving: false, location_id: null, with_people: true };
            if (kind === "move") {
                bar.seat_no = "";
            } else if (kind === "replace") {
                bar.new_id = null;
            } else if (kind === "bulk") {
                bar.field = (this.bulkColumns[0] || {}).field || "";
                bar.value = "";
            }
            this.actionBar = bar;
            this.$nextTick(() => this.focusAction(kind === "replace" ? "new" : kind === "bulk" ? "value" : "location"));
        },

        closeAction() {
            this.actionBar = null;
        },

        focusAction(which) {
            const el = this.$refs["ab-" + which];
            const input = el && (el.$el ? el.$el.querySelector("input") : el);
            if (input) {
                input.focus();
            }
        },

        actionTitle() {
            const bar = this.actionBar;
            if (!bar) {
                return "";
            }
            const what = bar.ids.length === 1 ? "«" + this.rowName(bar.ids[0]) + "»" : bar.ids.length + " ПК";
            if (bar.kind === "move") {
                return "Переместить " + what + " в:";
            }
            if (bar.kind === "replace") {
                return "Заменить " + what + " на:";
            }
            return "Изменить у " + what + ":";
        },

        onActionLocation(locationId) {
            const bar = this.actionBar;
            if (!bar) {
                return;
            }
            const changed = bar.location_id !== locationId;
            bar.location_id = locationId;
            bar.error = "";
            if (bar.kind === "move") {
                if (changed) {
                    bar.seat_no = this.nextSeatNo(locationId, bar.ids);
                }
                this.$nextTick(() => this.focusAction("seat"));
            }
        },

        // Новый ПК выбран: старый по умолчанию уходит туда, откуда взят новый
        onReplaceNew(computerId) {
            const bar = this.actionBar;
            if (!bar) {
                return;
            }
            bar.new_id = computerId;
            bar.error = "";
            const row = this.rows.find(function (r) { return r.id === computerId; });
            if (!bar.location_id && row && row.location_id) {
                bar.location_id = row.location_id;
            }
            this.$nextTick(() => this.focusAction("location"));
        },

        async submitAction() {
            const bar = this.actionBar;
            if (!bar || bar.saving) {
                return;
            }
            let url;
            let body;
            if (bar.kind === "move") {
                if (!bar.location_id) {
                    bar.error = "Выбери, куда переместить.";
                    return;
                }
                url = "/api/computers/move";
                body = { ids: bar.ids, location_id: bar.location_id, seat_no: bar.seat_no, with_people: bar.with_people };
            } else if (bar.kind === "replace") {
                if (!bar.new_id) {
                    bar.error = "Выбери новый ПК.";
                    return;
                }
                if (!bar.location_id) {
                    bar.error = "Выбери, куда убрать старый.";
                    return;
                }
                url = "/api/computers/replace";
                body = { old_id: bar.ids[0], new_id: bar.new_id, location_id: bar.location_id, with_people: bar.with_people };
            } else {
                if (!bar.field) {
                    bar.error = "Выбери поле.";
                    return;
                }
                url = "/api/computers/bulk-update";
                body = { ids: bar.ids, field: bar.field, value: bar.value };
            }
            bar.error = "";
            bar.saving = true;
            const done = await this.runAction(url, body, (data) => {
                if (bar.kind === "move") {
                    return bar.ids.length === 1 ? "Перемещён: " + this.rowName(bar.ids[0]) : "Перемещено ПК: " + bar.ids.length;
                }
                if (bar.kind === "replace") {
                    return "Заменён: " + this.rowName(bar.ids[0]) + " → " + this.rowName(bar.new_id);
                }
                return "Изменено у ПК: " + data.changed.length + " из " + bar.ids.length;
            }, (message) => { bar.error = message; });
            bar.saving = false;
            if (done) {
                this.actionBar = null;
            }
        },

        // Enter в строке действия — выполнить (открытый список выбора
        // расположения забирает Enter себе и дальше его не пускает)
        // «Изменить поле…»: подсказки значений выбранного столбца. Выбор
        // из списка только вписывает значение — выполнить Enter / ✓
        openBulkSuggest(el) {
            const bar = this.actionBar;
            if (!bar || bar.kind !== "bulk") {
                return;
            }
            const col = this.bulkColumns.find(function (c) { return c.field === bar.field; });
            this.openSuggest(el, col, (value) => {
                bar.value = value;
            });
        },

        onBulkSuggestInput(el) {
            if (!this.suggest) {
                this.openBulkSuggest(el);
            }
            this.onSuggestInput(el.value);
        },

        onActionEnter(event) {
            if (event.target.tagName === "SELECT" || event.target.tagName === "BUTTON") {
                return;
            }
            event.preventDefault();
            this.submitAction();
        },

        async startSwap() {
            this.closeMenus();
            const ids = this.selectedInOrder();
            if (ids.length !== 2) {
                return;
            }
            const text = "Поменять местами «" + this.rowName(ids[0]) + "» и «" + this.rowName(ids[1]) + "»?\n" +
                "Меняются расположение и № места, остальное остаётся при своих ПК.";
            if (!(await this.confirmDialog(text, { okText: "Поменять" }))) {
                return;
            }
            await this.runAction("/api/computers/swap", { ids: ids }, () => "Поменяны местами: " + this.rowName(ids[0]) + " и " + this.rowName(ids[1]), (message) => this.toastError(message));
        },

        // Запрос действия; после успеха — таблица перечитывается, затронутые
        // строки вспыхивают, выделение снимается
        async runAction(url, body, doneText, onError) {
            try {
                const response = await apiFetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (!response.ok) {
                    onError(await this.errorText(response));
                    return false;
                }
                const data = await response.json();
                const text = doneText(data);
                this.selectedRows = [];
                this.selectAnchorId = null;
                await this.loadTable();
                this.refreshCardRow();
                if (this.card) {
                    this.reloadCardHistory(this.card.id);
                }
                (data.changed || []).forEach((id) => this.flashRow(id));
                const first = (data.ids || [])[0];
                if (first) {
                    this.$nextTick(() => this.scrollToRow(first));
                }
                this.toast(text, "success");
                return true;
            } catch (e) {
                onError(String(e.message || e));
                return false;
            }
        },
    }
};
