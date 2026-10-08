// Имена ПК по правилам (этапы 35, 36): вкладка «Имена ПК» в Справочниках, проверка
// имён в Таблице, имя нового ПК. Что считается – в js/naming.js.
//
// Вкладка: дерево строками, у каждого узла – имя его ПК, собранное из частей:
// серое начало от узлов выше, своя часть (ввод прямо в имени) и серый номер; клик
// по серому – убрать / вернуть («только своя», «одно место»). «В таблице» – как
// названы ПК сейчас (клик – взять); «Взять из таблицы» на панели – всё разом.
// Клик по строке – справа ПК узла: как названы и как должны (меняется при вводе).
// Ничего не выбрано – справа ПК со «своим именем».
//
// Таблица: кнопка на панели показывает слева от HOSTNAME столбец «По правилу» –
// имя по правилу у ПК, названных иначе; клик – карточка: переименовать или оставить своё.

import { apiFetch, matchesAllWords, searchNorm, searchWords, searchWordsIn } from "../util.js";
import { KIND_ICONS, treeNodeTexts } from "../tree-utils.js";
import {
    NAME_MAX, checkNames, hostKey, keepValid, learnAll, namingIndex, newName, observedNames, ruleText, rowSuggestions
} from "../naming.js";

// Узел одной строкой, как в дереве: «304 Процедурная»
function nodeTitle(entry) {
    if (!entry) {
        return "";
    }
    const t = treeNodeTexts(entry.node);
    return [t.code, t.name].filter(Boolean).join(" ");
}

export default {
    watch: {
        // Блочки имён появились или пропали – пересчитать ширину столбцов
        nameChipVersion() {
            this.recalcWidths();
        },

        // Дерево догрузилось или правила поменялись – имя нового ПК тоже
        namingIdx() {
            this.refreshNewComputerName();
        },

        "newComputer.seat_no"() {
            this.refreshNewComputerName();
        },

        "newComputer.location_id"() {
            this.refreshNewComputerName();
        }
    },

    computed: {
        namingIdx() {
            return namingIndex(this.treeRoots, null);
        },

        // То же с частью, которую сейчас вводят на вкладке, – имя меняется сразу
        namesEditIdx() {
            return this.nameDraft ? namingIndex(this.treeRoots, this.nameDraft) : this.namingIdx;
        },

        // id ПК → { entry, ok, kept, expected, num } (только ПК в узлах с правилом)
        nameChecks() {
            return checkNames(this.rows, this.namingIdx, this.nameKeep);
        },

        // То же с частью, которую вводят: справа на вкладке видно, какими станут имена
        namesPreviewChecks() {
            return this.nameDraft ? checkNames(this.rows, this.namesEditIdx, this.nameKeep) : this.nameChecks;
        },

        nameBadCount() {
            let n = 0;
            this.nameChecks.forEach(function (c) {
                if (!c.ok) {
                    n += 1;
                }
            });
            return n;
        },

        nameBadBadge() {
            return this.nameBadCount > 99 ? "99" : String(this.nameBadCount);
        },

        nameOnlyOn() {
            return this.nameCheck && this.nameOnlyRows;
        },

        nameChipVersion() {
            if (!this.nameCheck) {
                return "";
            }
            const parts = [];
            this.nameChecks.forEach(function (c, id) {
                if (!c.ok || c.kept) {
                    parts.push(id + ":" + (c.kept ? "" : c.expected));
                }
            });
            return "on|" + parts.join("|");
        },

        // Выбранные строки, которым есть что предложить
        selectedNameFixes() {
            return this.selectedRows.map((id) => {
                const c = this.nameChecks.get(id);
                return c && !c.ok ? { id: id, hostname: c.expected } : null;
            }).filter(Boolean);
        },

        nameObserved() {
            return observedNames(this.rows, this.nameKeep);
        },

        nameSuggestions() {
            return rowSuggestions(this.treeRoots, this.nameObserved);
        },

        nameLearnItems() {
            return learnAll(this.treeRoots, this.nameObserved);
        },

        // ПК в узле и ниже: всего и не по правилу
        nameNodeStats() {
            const stats = new Map();
            const own = new Map();
            this.rows.forEach((row) => {
                if (row.archived || row.location_id === null || row.location_id === undefined) {
                    return;
                }
                const s = own.get(row.location_id) || { total: 0, bad: 0 };
                s.total += 1;
                const c = this.nameChecks.get(row.id);
                if (c && !c.ok) {
                    s.bad += 1;
                }
                own.set(row.location_id, s);
            });
            const walk = function (node) {
                const s = Object.assign({ total: 0, bad: 0 }, own.get(node.id));
                (node.children || []).forEach(function (child) {
                    const c = walk(child);
                    s.total += c.total;
                    s.bad += c.bad;
                });
                stats.set(node.id, s);
                return s;
            };
            this.treeRoots.forEach(walk);
            return stats;
        },

        // Номера ПК узла по правилу (с тем, что вводят): id узла → { min, max }
        nameNodeNums() {
            const nums = new Map();
            this.rows.forEach((row) => {
                const c = this.namesPreviewChecks.get(row.id);
                if (!c || !c.num) {
                    return;
                }
                const n = nums.get(row.location_id);
                if (!n) {
                    nums.set(row.location_id, { min: c.num, max: c.num });
                } else {
                    n.min = Math.min(n.min, c.num);
                    n.max = Math.max(n.max, c.num);
                }
            });
            return nums;
        },

        // Строки вкладки: узлы дерева по порядку; поиск – по пути, части и имени
        // (видны найденные и узлы над ними)
        namesRows() {
            const texts = [];
            const query = this.namesQuery.trim();
            const list = [];
            const walk = (nodes, path) => {
                nodes.forEach((node) => {
                    const entry = this.namesEditIdx.get(node.id);
                    const t = treeNodeTexts(node);
                    const title = [t.code, t.name].filter(Boolean).join(" ");
                    const text = searchNorm(path + " " + title + " " + (node.name_part || "") + " " + ruleText(entry));
                    texts.push(text);
                    list.push({ node: node, entry: entry, code: t.code, name: t.name, level: entry.level, text: text });
                    walk(node.children || [], path + " " + title);
                });
            };
            walk(this.treeRoots, "");
            if (!searchWords(query).length) {
                return list;
            }
            // Слово, которого нет ни в одной строке, – в другой раскладке
            const words = searchWordsIn(query, texts);
            const keep = new Set();
            list.forEach(function (row) {
                if (matchesAllWords(row.text, words)) {
                    keep.add(row.node.id);
                }
            });
            // Видны найденные и узлы над ними
            const index = this.namesEditIdx;
            Array.from(keep).forEach(function (id) {
                let parent = index.get(id).parentId;
                while (parent !== null && parent !== undefined && !keep.has(parent)) {
                    keep.add(parent);
                    parent = index.get(parent).parentId;
                }
            });
            return list.filter(function (row) { return keep.has(row.node.id); });
        },

        // Выбранный узел вкладки (клик по строке): справа – его ПК
        nameSelEntry() {
            return this.nameSelId === null ? null : (this.namesEditIdx.get(this.nameSelId) || null);
        },

        nameSelTitle() {
            return nodeTitle(this.nameSelEntry);
        },

        // ПК выбранного узла и ниже – в порядке Таблицы; узлы с ПК – строками-группами,
        // если таких несколько. Имена – с тем, что сейчас вводят
        nameSelRows() {
            const sel = this.nameSelEntry;
            if (!sel) {
                return [];
            }
            const ids = new Set();
            const walk = function (node) {
                ids.add(node.id);
                (node.children || []).forEach(walk);
            };
            walk(sel.node);
            const byNode = new Map();
            this.rows.forEach((row) => {
                if (row.archived || !ids.has(row.location_id)) {
                    return;
                }
                let list = byNode.get(row.location_id);
                if (!list) {
                    byNode.set(row.location_id, list = []);
                }
                list.push({ key: row.id, row: row, check: this.namesPreviewChecks.get(row.id) || null });
            });
            const index = this.namesEditIdx;
            const nodes = Array.from(byNode.keys()).sort(function (a, b) { return index.get(a).order - index.get(b).order; });
            const out = [];
            nodes.forEach((id) => {
                if (nodes.length > 1 || id !== sel.node.id) {
                    const entry = index.get(id);
                    out.push({ key: "n" + id, group: true, title: nodeTitle(entry), path: (this.treeIndex[id] || {}).path || "" });
                }
                byNode.get(id).forEach(function (item) { out.push(item); });
            });
            return out;
        },

        // ПК выбранного узла с именем не по правилу (как сохранено, без того, что вводят)
        nameSelFixes() {
            const list = [];
            this.nameSelRows.forEach((item) => {
                const c = item.row ? this.nameChecks.get(item.row.id) : null;
                if (c && !c.ok) {
                    list.push({ id: item.row.id, hostname: c.expected });
                }
            });
            return list;
        },

        // ПК со «своим именем», которое ещё действует
        nameKeepRows() {
            const list = [];
            this.rows.forEach((row) => {
                if (!row.archived && keepValid(this.nameKeep, row)) {
                    const entry = this.treeIndex[row.location_id];
                    list.push({ row: row, path: entry ? entry.path : "", place: nodeTitle(entry), by: this.nameKeep[row.id].by });
                }
            });
            return list.sort(function (a, b) { return hostKey(a.row.hostname) < hostKey(b.row.hostname) ? -1 : 1; });
        },

        namesCountText() {
            return "Не по правилу: " + this.nameBadCount;
        }
    },

    methods: {
        // ---------- Справочники: вкладки ----------

        setChoicesTab(tab) {
            this.choicesTab = tab;
            this.namesHover = null;
            if (tab === "names") {
                this.ensureTree();
                this.loadNameKeep();
            }
            this.syncHash();
        },

        async loadNameKeep() {
            try {
                const response = await apiFetch("/api/naming/keep");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.setNameKeep((await response.json()).items);
            } catch (e) {
                this.toastError("Не удалось загрузить «свои имена»: " + (e.message || e));
            }
        },

        setNameKeep(items) {
            const map = {};
            items.forEach(function (item) { map[item.computer_id] = item; });
            this.nameKeep = map;
        },

        nameRuleText(entry) {
            return ruleText(entry);
        },

        // Имя длиннее, чем можно в имени Windows (с номером до 99)
        nameTooLong(entry) {
            return !!entry && !!entry.start && entry.start.length + (entry.single ? 0 : 3) > NAME_MAX;
        },

        // Своя часть узла в поле: как набрано, пока вводят
        namePartValue(r) {
            return this.nameDraft && this.nameDraft.id === r.node.id ? this.nameDraft.raw : (r.node.name_part || "");
        },

        // Строка под курсором или в правке: у пустого поля – подсказка «часть»
        namePartActive(r) {
            return this.canEdit && ((!!this.namesHover && this.namesHover.node.id === r.node.id) || (!!this.nameDraft && this.nameDraft.id === r.node.id));
        },

        // Серое начало от узлов выше: «ter-» (без своей части – «ter», под курсором –
        // «ter-» перед подсказкой «часть»); у «только своей» – зачёркнуто
        namePrefixText(r) {
            return r.entry.above + (r.entry.part || this.namePartActive(r) ? "-" : "");
        },

        namePrefixTitle(entry) {
            const parent = this.namesEditIdx.get(entry.parentId);
            const from = parent ? "«" + nodeTitle(parent) + "»" : "выше";
            return entry.own ? "Без начала от " + from + " – вернуть" : "Начало от " + from + " – убрать";
        },

        // Серый номер: у конечного узла – номера его ПК («-1…3»), одно место – зачёркнуто;
        // у узла с детьми – «-…» (начало имён)
        nameSuffixText(r) {
            if (!r.entry.leaf) {
                return "-…";
            }
            const n = this.nameNodeNums.get(r.node.id);
            if (!n || r.entry.single) {
                return "-N";
            }
            return "-" + n.min + (n.max > n.min ? "…" + n.max : "");
        },

        nameSuffixTitle(r) {
            if (!r.entry.leaf) {
                return "Начало имён";
            }
            return r.entry.single ? "Одно место, без номера – вернуть номер" : "Номер по № места – убрать";
        },

        nameRowTitle(r) {
            if (!r.entry.start) {
                return null;
            }
            return this.nameTooLong(r.entry) ? "Длиннее " + NAME_MAX + " знаков" : null;
        },

        setNamesHover(node, rowEl) {
            const wrap = rowEl.closest(".nr-wrap");
            if (!wrap) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const r = rowEl.getBoundingClientRect();
            this.namesHover = { node: node, top: r.top - w.top, height: r.height };
        },

        // Клик по строке – справа её ПК; ещё раз – снять. Клик в имени – в поле части
        // (серые начало и номер, блочки и ссылки – свои)
        onNamesRowClick(node, event) {
            if (event.target.closest("input, button, a, .nr-pre, .nr-suf")) {
                return;
            }
            const cell = event.target.closest("td.nr-name");
            if (cell) {
                if (this.canEdit) {
                    cell.querySelector("input").focus();
                }
                return;
            }
            this.nameSelId = this.nameSelId === node.id ? null : node.id;
        },

        // ---------- Правила узлов ----------

        async saveNameRules(items, message) {
            if (!items.length || this.nameSaving) {
                return false;
            }
            this.nameSaving = true;
            try {
                const response = await apiFetch("/api/naming/nodes", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ items: items })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                // Узлы дерева – на месте, без перечитывания
                (await response.json()).nodes.forEach((saved) => {
                    const entry = this.namingIdx.get(saved.id);
                    if (entry) {
                        Object.assign(entry.node, { name_part: saved.name_part, name_own: saved.name_own, name_single: saved.name_single });
                    }
                });
                if (message) {
                    this.toast(message, "success");
                }
                return true;
            } catch (e) {
                this.toastError("Не сохранилось: " + (e.message || e));
                return false;
            } finally {
                this.nameSaving = false;
            }
        },

        // Черновик: raw – как набрано (в поле), part – для имени
        onNamePartFocus(node) {
            this.nameDraft = { id: node.id, raw: node.name_part || "", part: node.name_part || "" };
        },

        onNamePartInput(node, value) {
            if (this.nameDraft && this.nameDraft.id === node.id) {
                this.nameDraft.raw = value;
                this.nameDraft.part = value.trim().toLowerCase();
            }
        },

        onNamePartKeydown(event) {
            if (event.key === "Enter") {
                event.preventDefault();
                event.target.blur();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                this.nameDraft = null;
                event.target.blur();
            }
        },

        async finishNamePart(node, event) {
            const draft = this.nameDraft;
            if (!draft || draft.id !== node.id) {
                return;
            }
            const value = draft.part;
            if (value !== (node.name_part || "")) {
                await this.saveNameRules([{ id: node.id, part: value }]);
            }
            if (this.nameDraft === draft) {
                this.nameDraft = null;
            }
            // Не сохранилось – в поле снова то, что было
            event.target.value = node.name_part || "";
        },

        toggleNameFlag(node, flag) {
            if (!this.canEdit || this.nameSaving) {
                return;
            }
            const item = { id: node.id };
            item[flag] = !node["name_" + flag];
            this.saveNameRules([item]);
        },

        applyNameSuggestion(node) {
            const s = this.nameSuggestions.get(node.id);
            if (s) {
                this.saveNameRules(s.items, "Взято из таблицы: " + s.text);
            }
        },

        async learnAllNames() {
            const items = this.nameLearnItems;
            if (!items.length) {
                this.toast("Правила и таблица уже совпадают.");
                return;
            }
            if (!(await this.confirmDialog("Взять из таблицы правила для " + items.length + " узлов?", { okText: "Взять" }))) {
                return;
            }
            this.saveNameRules(items, "Правила взяты из таблицы: " + items.length);
        },

        kindIcon(kind) {
            return KIND_ICONS[kind] || KIND_ICONS.room;
        },

        // Показать ПК узла в таблице с проверкой имён (onlyBad – только не по правилу)
        showNamesInTable(node, onlyBad) {
            this.showLocationInTable(node);
            if (!this.nameCheck) {
                this.toggleNameCheck();
            }
            this.nameOnlyRows = !!onlyBad;
        },

        openNameKeepPc(row) {
            this.setView("table");
            this.openCardById(row.id);
        },

        // ---------- «Своё имя» ----------

        async setNameKeepFor(ids, keep) {
            try {
                const response = await apiFetch("/api/naming/keep", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ids: ids, keep: keep })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.setNameKeep((await response.json()).items);
                return true;
            } catch (e) {
                this.toastError("Не сохранилось: " + (e.message || e));
                return false;
            }
        },

        // ---------- Проверка имён в Таблице ----------

        toggleNameCheck() {
            this.nameCheck = !this.nameCheck;
            this.closeNamePop();
            this.$nextTick(() => this.updateStickyShadow());
            if (!this.nameCheck) {
                this.nameOnlyRows = false;
                return;
            }
            this.ensureTree();
            this.loadNameKeep();
        },

        // Столбец «По правилу»: имя по правилу, если у ПК другое
        nameChip(row) {
            if (!this.nameCheck || row.archived) {
                return null;
            }
            const c = this.nameChecks.get(row.id);
            return c && !c.ok ? c.expected : null;
        },

        nameKept(row) {
            const c = this.nameCheck && !row.archived ? this.nameChecks.get(row.id) : null;
            return !!c && c.kept;
        },

        nameChipTitle(row) {
            const c = this.nameChecks.get(row.id);
            return c ? "Правило: " + ruleText(c.entry) : null;
        },

        rowHasNameChip(row) {
            const c = this.nameChecks.get(row.id);
            return !!c && !c.ok;
        },

        // Карточка у блочка: в Таблице и на вкладке (справа, ПК выбранного узла)
        openNamePop(row, event) {
            const c = this.nameChecks.get(row.id);
            if (!c || c.ok) {
                return;
            }
            const chip = event.currentTarget.getBoundingClientRect();
            const entry = this.treeIndex[c.entry.node.id];
            this.namePop = {
                row: row,
                check: c,
                path: entry ? entry.path : "",
                place: nodeTitle(entry),
                anchor: { left: chip.left, right: chip.right, top: chip.top, bottom: chip.bottom },
                left: chip.right + 6,
                top: chip.top,
                placed: false,
                busy: false
            };
            this.$nextTick(() => this.placeNamePop());
            if (!this._namePopKey) {
                this._namePopKey = (e) => {
                    if (e.key === "Escape" && this.namePop) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.closeNamePop();
                    }
                };
                this._namePopDown = (e) => {
                    const el = this.$refs.namePop;
                    if (!this.namePop || (el && el.contains(e.target)) || (e.target.closest && e.target.closest("button.name-chip"))) {
                        return;
                    }
                    this.closeNamePop();
                };
                window.addEventListener("keydown", this._namePopKey, true);
                window.addEventListener("mousedown", this._namePopDown, true);
            }
        },

        // Как карточка у блочка сканера: справа от блочка, не помещается – слева
        placeNamePop() {
            const pop = this.namePop;
            const el = this.$refs.namePop;
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

        closeNamePop() {
            this.namePop = null;
            if (this._namePopKey) {
                window.removeEventListener("keydown", this._namePopKey, true);
                window.removeEventListener("mousedown", this._namePopDown, true);
                this._namePopKey = null;
                this._namePopDown = null;
            }
        },

        async namePopRename() {
            const pop = this.namePop;
            if (!pop || pop.busy) {
                return;
            }
            pop.busy = true;
            const name = pop.check.expected;
            this.closeNamePop();
            if (await this.saveComputerValue(pop.row.id, "hostname", name)) {
                this.toast("Переименован: " + name, "success");
            }
        },

        async namePopKeep() {
            const pop = this.namePop;
            if (!pop || pop.busy) {
                return;
            }
            pop.busy = true;
            this.closeNamePop();
            if (await this.setNameKeepFor([pop.row.id], true)) {
                this.toast("Своё имя: " + pop.row.hostname, "success");
            }
        },

        // Правило узла – на вкладке «Имена ПК», строка узла выбрана
        namePopRule() {
            const pop = this.namePop;
            if (!pop) {
                return;
            }
            this.closeNamePop();
            this.namesQuery = "";
            this.setView("choices");
            this.setChoicesTab("names");
            this.nameSelId = pop.check.entry.node.id;
            this.$nextTick(() => {
                const el = document.querySelector('.nr-table tr[data-id="' + this.nameSelId + '"]');
                if (el) {
                    el.scrollIntoView({ block: "center" });
                }
            });
        },

        // «Выбрано» → «Переименовать по правилу»
        renameSelectedByRule() {
            this.closeMenus();
            this.renameByRule(this.selectedNameFixes);
        },

        // Вкладка: все ПК выбранного узла, названные не по правилу
        renameNodeByRule() {
            this.renameByRule(this.nameSelFixes);
        },

        async renameByRule(items) {
            if (!items.length) {
                return;
            }
            if (!(await this.confirmDialog("Переименовать по правилу " + items.length + " ПК?", { okText: "Переименовать" }))) {
                return;
            }
            try {
                const response = await apiFetch("/api/naming/rename", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ items: items })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                await this.loadTable();
                data.changed.forEach((id) => this.flashCell(id, "hostname"));
                this.toast("Переименовано: " + data.changed.length, "success");
            } catch (e) {
                this.toastError("Не переименовалось: " + (e.message || e));
            }
        },

        // ---------- Новый компьютер ----------

        // Имя по правилу – в поле HOSTNAME, пока его не поменяли руками
        refreshNewComputerName() {
            const form = this.newComputer;
            if (!form) {
                return;
            }
            if (form.hostname && form.hostname !== form.autoName) {
                return;
            }
            const name = form.location_id ? newName(this.namingIdx, form.location_id, form.seat_no, this.rows, this.nameKeep) : "";
            form.hostname = name;
            form.autoName = name;
        }
    }
};
