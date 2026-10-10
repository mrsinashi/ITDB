// Таблица: новый компьютер и смена расположения, архив, действия с выбранными строками.
// На странице «Принтеры» (этап 44) архив, «Изменить значения…» и смена расположения – те
// же, у принтеров (строка принтера – row._printer, запросы – /api/printers/…).

import { apiFetch, fixIpTyping, searchNorm, splitMulti } from "../util.js";
import { LOCATION_FIELDS } from "../columns.js";

// Куда можно добавить кабинет
const ROOM_PARENTS = ["department", "floor"];
// Подсказка полного IP: сколько вариантов
const IP_FULL_MAX = 8;

export default {
    computed: {
        // Кнопка «Архив»: с выбранными строками – убрать в архив / вернуть,
        // без выбора – показать архив / вернуться к таблице
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
                const path = (row.hostname || "без имени") + (place ? " – " + place : "");
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

        // Все узлы дерева в его порядке – для выбора расположения ПК
        locationOptions() {
            const list = [];
            const walk = (nodes, parentId) => {
                nodes.forEach((node) => {
                    const entry = this.treeIndex[node.id];
                    const path = entry ? entry.path : (node.name || node.code || "");
                    list.push({ id: node.id, kind: node.kind, parentId: parentId, path: path, search: searchNorm(path) });
                    walk(node.children || [], node.id);
                });
            };
            walk(this.treeRoots, null);
            return list;
        },

        // Место нового кабинета: отделения и этажи
        roomParentOptions() {
            return this.locationOptions.filter(function (o) { return ROOM_PARENTS.indexOf(o.kind) !== -1; });
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
        // дерева, поэтому таблица перечитывается целиком (ПК или принтеров)
        async saveLocation(row, locationId) {
            if (!locationId || locationId === row.location_id) {
                return;
            }
            const printer = !!row._printer;
            const reload = async () => {
                if (printer) {
                    await this.loadPrinters();
                } else {
                    await this.loadTable();
                    this.refreshCardRow();
                }
            };
            try {
                const response = await apiFetch((printer ? "/api/printers/" : "/api/computers/") + row.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ location_id: locationId, _version: row.version })
                });
                if (response.status === 409) {
                    this.toastError(await this.errorText(response));
                    await reload();
                    return;
                }
                if (!response.ok) {
                    this.toastError("Не удалось сохранить: " + (await this.errorText(response)));
                    return;
                }
                await reload();
                if (printer) {
                    this.reloadPrinterCardHistory(row.id);
                } else {
                    this.reloadCardHistory(row.id);
                }
                LOCATION_FIELDS.concat(["location_id", "number"]).forEach((field) => this.flashCell(this.rowKey(row), field));
                this.$nextTick(() => this.scrollToRow(row.id));
            } catch (e) {
                this.toastError("Не удалось сохранить: " + e);
            }
        },

        // Открыта карточка этого ПК – перечитать её историю после правки
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
            this.closeNewPrinter();
            // Новый ПК появится среди рабочих – из архива уходим
            this.setArchiveView(false);
            this.actionBar = null;
            this.ensureTree();
            // По умолчанию – узел, выбранный фильтром из дерева
            const locationId = this.locationFilter ? this.locationFilter.id : null;
            // autoName – имя по правилу в поле HOSTNAME (пока его не поменяли руками, этап 35)
            this.newComputer = { location_id: locationId, seat_no: "", hostname: "", ip: "", autoName: "" };
            this.newComputerError = "";
            this.newRoom = null;
            if (locationId) {
                this.newComputer.seat_no = this.nextSeatNo(locationId);
            }
            this.$nextTick(() => this.focusNewComputer(locationId ? "hostname" : "location"));
        },

        closeNewComputer() {
            this.closeIpSuggest();
            this.newComputer = null;
            this.newComputerError = "";
            if (!this.newPrinter) {
                this.newRoom = null;
            }
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

        // IP при вводе (новый ПК, ячейка, карточка): «ю», «/», набранные «,» и «б» –
        // точка (этап 36). target[key] – значение поля (null – this)
        onIpInput(event, target, key) {
            const fixed = fixIpTyping(event.target, event);
            if (fixed !== null) {
                (target || this)[key] = fixed;
            }
        },

        // ---------- Полный IP по его концу (этап 37) ----------
        // Набрано «15.12» (два-три числа, раскладка – как в поиске), и это не начало
        // адреса из таблицы, – в списке под полем адреса с началом подсетей таблицы:
        // «192.168.15.12». Сначала – где подсеть /24 уже есть (число ПК в ней)

        ipFullOptions(text) {
            const raw = String(text || "").trim().toLowerCase();
            if (!/^\d{1,3}([.,/юб]\d{1,3}){1,2}$/.test(raw)) {
                return [];
            }
            const typed = raw.split(/[.,/юб]/).map(Number);
            if (typed.some(function (n) { return n > 255; })) {
                return [];
            }
            const last = String(typed[typed.length - 1]);
            const subnets = new Map();   // «192.168.15» → число ПК
            let isStart = false;
            this.rows.forEach(function (row) {
                const seen = new Set();
                splitMulti(row.ip).forEach(function (ip) {
                    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
                    if (!m) {
                        return;
                    }
                    const oct = m.slice(1, 5).map(Number);
                    // Начало адреса из таблицы – подсказка не нужна
                    if (typed.slice(0, -1).every(function (n, i) { return oct[i] === n; }) && String(oct[typed.length - 1]).indexOf(last) === 0) {
                        isStart = true;
                    }
                    seen.add(oct.slice(0, 3).join("."));
                });
                seen.forEach(function (key) { subnets.set(key, (subnets.get(key) || 0) + 1); });
            });
            if (isStart) {
                return [];
            }
            const keep = 4 - typed.length;   // сколько чисел взять из начала подсети
            const found = new Map();
            subnets.forEach(function (count, key) {
                const head = key.split(".").slice(0, keep);
                const value = head.concat(typed).join(".");
                const net = value.split(".").slice(0, 3).join(".");
                const was = found.get(value) || { value: value, net: net, pcs: subnets.get(net) || 0, weight: 0 };
                was.weight += count;
                found.set(value, was);
            });
            let list = Array.from(found.values());
            if (list.some(function (o) { return o.pcs; })) {
                list = list.filter(function (o) { return o.pcs; });
            }
            list.sort(function (a, b) { return b.pcs - a.pcs || b.weight - a.weight; });
            return list.slice(0, IP_FULL_MAX).map(function (o) {
                return { key: o.value, value: o.value, count: o.pcs || "", countTitle: o.pcs ? "ПК в подсети " + o.net + ".0/24" : "" };
            });
        },

        onNewIpInput(event) {
            this.onIpInput(event, this.newComputer, "ip");
            const el = event.target;
            const options = this.ipFullOptions(el.value);
            if (!options.length) {
                this.closeIpSuggest();
                return;
            }
            this.openSuggestList(el, "ip-full", options, (value) => {
                if (this.newComputer) {
                    this.newComputer.ip = value;
                    this.$nextTick(() => this.focusNewComputer("ip"));
                }
            });
        },

        // Список открыт: ↑↓ Enter – в нём, Esc закрывает только его; иначе Enter – добавить ПК
        onNewIpKeydown(event) {
            if (this.suggest && this.suggest.field === "ip-full") {
                if (event.key === "Escape") {
                    event.preventDefault();
                    this.closeIpSuggest();
                    return;
                }
                if (this.suggestKeydown(event)) {
                    return;
                }
            }
            if (event.key === "Enter") {
                this.closeIpSuggest();
                this.submitNewComputer();
            }
        },

        closeIpSuggest() {
            if (this.suggest && this.suggest.field === "ip-full") {
                this.closeSuggest();
            }
        },

        // ---------- Новый кабинет из строки «Новый компьютер» (этап 36) ----------
        // В списке расположений – «＋ кабинет»: строка под строкой нового ПК. Место –
        // найденное в списке, иначе отделение или этаж выбранного расположения

        // data.afterId – «＋ кабинет» у кабинета: новый встаёт сразу после него (этап 37).
        // Так же – из строки нового принтера (этап 44)
        openNewRoom(data) {
            let parentId = data.parentId;
            const form = this.newPrinter || this.newComputer;
            const entry = !parentId && form ? this.treeIndex[form.location_id] : null;
            if (entry) {
                parentId = entry.node.kind === "room" ? entry.node.parent_id : (ROOM_PARENTS.indexOf(entry.node.kind) !== -1 ? entry.node.id : null);
            }
            this.newRoom = { parent_id: parentId || null, after_id: parentId && data.afterId || null, code: data.code || "", name: data.name || "", error: "", saving: false };
            this.$nextTick(() => this.focusNewRoom(!parentId ? "parent" : (data.code || data.name ? "name" : "code")));
        },

        // Подсказка у строки «Новый кабинет»: после какого кабинета он встанет
        newRoomAfterText() {
            const entry = this.newRoom && this.newRoom.after_id ? this.treeIndex[this.newRoom.after_id] : null;
            return entry ? "Встанет после: " + [entry.node.code, entry.node.name].filter(Boolean).join(" ") : null;
        },

        closeNewRoom() {
            this.newRoom = null;
            this.$nextTick(() => (this.newPrinter ? this.focusNewPrinter("location") : this.focusNewComputer("location")));
        },

        focusNewRoom(which) {
            const el = this.$refs["nr-" + which];
            const input = el && (el.$el ? el.$el.querySelector("input") : el);
            if (input) {
                input.focus();
            }
        },

        onNewRoomParent(parentId) {
            if (this.newRoom) {
                if (this.newRoom.parent_id !== parentId) {
                    this.newRoom.after_id = null;
                }
                this.newRoom.parent_id = parentId;
                this.newRoom.error = "";
                this.$nextTick(() => this.focusNewRoom("code"));
            }
        },

        async submitNewRoom() {
            const form = this.newRoom;
            if (!form || form.saving) {
                return;
            }
            const code = form.code.trim();
            const name = form.name.trim();
            if (!form.parent_id) {
                form.error = "Выбери отделение или этаж.";
                this.focusNewRoom("parent");
                return;
            }
            if (!code && !name) {
                form.error = "Нужен номер или название.";
                this.focusNewRoom("code");
                return;
            }
            // Среди соседей – сразу после кабинета, у которого нажали «＋ кабинет», иначе
            // по номеру: перед первым кабинетом с большим номером
            const parent = this.treeIndex[form.parent_id];
            const children = parent ? parent.node.children || [] : [];
            const after = form.after_id ? children.findIndex(function (child) { return child.id === form.after_id; }) : -1;
            const next = after !== -1 ? children[after + 1] : (code ? children.find(function (child) {
                return child.kind === "room" && child.code && child.code.localeCompare(code, "ru", { numeric: true, sensitivity: "base" }) > 0;
            }) : null);
            form.saving = true;
            form.error = "";
            try {
                const response = await apiFetch("/api/locations", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ parent_id: form.parent_id, kind: "room", code: code, name: name, before_id: next ? next.id : null })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const id = (await response.json()).id;
                await this.loadTree();
                this.newRoom = null;
                this.toast("Кабинет добавлен: " + [code, name].filter(Boolean).join(" "), "success");
                if (this.newPrinter) {
                    this.onNewPrinterLocation(id);
                } else {
                    this.onNewComputerLocation(id);
                }
            } catch (e) {
                form.error = String(e.message || e);
                form.saving = false;
            }
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
                    (data.shifted && data.shifted.length ? ". № места был занят – следующие сдвинуты: " + data.shifted.length : ""), "success");
                // Форма остаётся открытой: можно сразу добавить следующий в тот же узел
                form.hostname = "";
                form.ip = "";
                form.seat_no = this.nextSeatNo(form.location_id);
                this.refreshNewComputerName();
                this.$nextTick(() => this.focusNewComputer("hostname"));
            } catch (e) {
                this.newComputerError = String(e.message || e);
            }
            this.newComputerSaving = false;
        },

        // id строки таблицы на экране (ПК или принтера)
        flashRow(id) {
            const key = this.tableKind === "printer" ? "p" + id : id;
            this.allColumns.forEach((col) => this.flashCell(key, col.field));
        },

        // «Создан» – первым: в базе ключи изменений хранятся в другом порядке
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
            // Выбранные строки другого режима не видны – снимаем
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
            const printers = this.tableKind === "printer";
            try {
                const response = await apiFetch(printers ? "/api/printers/archive" : "/api/computers/archive", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ids: ids, archived: archived })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                let text;
                if (ids.length === 1) {
                    text = (archived ? "В архиве: " : "Возвращён из архива: ") + this.rowName(ids[0]);
                } else {
                    text = (archived ? "В архив убрано " : "Возвращено из архива ") + (printers ? "принтеров: " : "ПК: ") + ids.length;
                }
                this.selectedRows = [];
                this.selectAnchorId = null;
                await this.reloadTableRows();
                if (printers) {
                    if (this.pcard && ids.indexOf(this.pcard.id) !== -1) {
                        this.reloadPrinterCardHistory(this.pcard.id);
                    }
                } else if (this.card && ids.indexOf(this.card.id) !== -1) {
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
            if (this.tableKind === "printer") {
                const p = this.printerRows.find(function (r) { return r.id === id; });
                return (p && p.name) || "принтер без имени";
            }
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
            } else if (kind === "scan") {
                // «Принять изменения…»: тип и столбец; пусто – все
                bar.scanKind = "";
                bar.field = "";
            }
            this.actionBar = bar;
            if (kind === "scan") {
                return;
            }
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
            const what = bar.ids.length === 1 ? "«" + this.rowName(bar.ids[0]) + "»" : bar.ids.length + (this.tableKind === "printer" ? " принтеров" : " ПК");
            if (bar.kind === "move") {
                return "Переместить " + what + " в:";
            }
            if (bar.kind === "replace") {
                return "Заменить " + what + " на:";
            }
            if (bar.kind === "scan") {
                return "Принять изменения у " + what + ":";
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
            if (bar.kind === "scan") {
                await this.submitScanBar();
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
                url = this.tableKind === "printer" ? "/api/printers/bulk-update" : "/api/computers/bulk-update";
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
                return "Изменено у " + (this.tableKind === "printer" ? "принтеров: " : "ПК: ") + data.changed.length + " из " + bar.ids.length;
            }, (message) => { bar.error = message; });
            bar.saving = false;
            if (done) {
                this.actionBar = null;
            }
        },

        // Enter в строке действия – выполнить (открытый список выбора
        // расположения забирает Enter себе и дальше его не пускает)
        // «Изменить поле…»: подсказки значений выбранного столбца. Выбор
        // из списка только вписывает значение – выполнить Enter / ✓
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

        // Запрос действия; после успеха – таблица перечитывается, затронутые
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
                await this.reloadTableRows();
                this.refreshCardRow();
                if (this.card) {
                    this.reloadCardHistory(this.card.id);
                }
                if (this.pcard) {
                    this.reloadPrinterCardHistory(this.pcard.id);
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
