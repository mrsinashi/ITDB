// Страница «Дерево»: узлы, поиск, форма узла, ширина колонки.

import { apiFetch, highlightParts, loadJson, matchesAllWords, saveJson, searchNorm, searchWords, searchWordsIn, rowPlate, setIfChanged } from "../util.js";
import { kindLabels } from "../columns.js";
import { KIND_ICONS, computeTreeWidth, treeFormWidth, treeNodeTexts } from "../tree-utils.js";

// Раскрытые узлы Структуры – в браузере (этап 62): список id
const TREE_OPEN_KEY = "itdb.treeOpen.v1";

function loadTreeOpen() {
    const state = {};
    const ids = loadJson(TREE_OPEN_KEY, []);
    (Array.isArray(ids) ? ids : []).forEach(function (id) { state[id] = true; });
    return state;
}

export default {
    data() {
        return {
            treeOpenState: loadTreeOpen()
        };
    },

    computed: {
        // Поиск по дереву: self – совпали сами, anc – предки совпавших
        treeMatch() {
            // Слова ищутся по всему пути узла («хир орд» – ординаторские
            // хирургии). Найденным считается верхний узел, на котором путь
            // впервые собрал все слова; его потомки видны под ним.
            const q = this.treeQuery.trim();
            // Слово, которого нет ни в одном пути, – в другой раскладке
            const paths = [];
            const collect = (nodes, parentPath) => {
                nodes.forEach((node) => {
                    const path = parentPath + " / " + [node.code, node.name, treeNodeTexts(node).name].filter(Boolean).join(" ");
                    paths.push(searchNorm(path));
                    collect(node.children || [], path);
                });
            };
            if (searchWords(q).length) {
                collect(this.treeRoots, "");
            }
            const words = searchWordsIn(q, paths);
            const self = new Set();
            const anc = new Set();
            if (words.length) {
                const walk = (nodes, parents, parentPath) => {
                    nodes.forEach((node) => {
                        const own = [node.code, node.name, treeNodeTexts(node).name].filter(Boolean).join(" ");
                        const path = parentPath + " / " + own;
                        if (matchesAllWords(path, words)) {
                            self.add(node.id);
                            parents.forEach(function (id) { anc.add(id); });
                            return;
                        }
                        if (node.children && node.children.length) {
                            walk(node.children, parents.concat([node.id]), path);
                        }
                    });
                };
                walk(this.treeRoots, [], "");
            }
            return { query: q, words: words, self: self, anc: anc, size: self.size };
        },

        // Ширина колонки дерева: по самому широкому узлу; пока открыта форма узла – не уже,
        // чем нужно её полям и кнопкам одной строкой на её уровне (этап 62)
        treeBoxWidth() {
            const width = this.treeWidth + this.treeScrollbar;
            const f = this.treeForm;
            if (!f) {
                return width;
            }
            // Форма – под узлом (правка) или его родителем (добавление), уровнем ниже
            let level = 0;
            if (!f.top) {
                const id = f.action === "add" ? f.parentId : f.nodeId;
                for (let e = this.treeIndex[id]; e; e = this.treeIndex[e.node.parent_id]) {
                    level++;
                }
            }
            return Math.max(width, treeFormWidth(level) + this.treeScrollbar);
        },
    },

    methods: {
        // ---------- Дерево ----------

        async loadTree() {
            this.treeLoading = true;
            this.startLoading();
            this.treeError = "";
            try {
                const response = await apiFetch("/api/locations/tree");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                // То же дерево – не присваивать: по нему считаются имена по правилу у всех строк
                // таблицы (этап 59)
                const changed = setIfChanged(this, "treeRoots", data.roots || []);
                this.treeHover = null;
                this.$nextTick(() => this.watchTreeScroll());
                this.unlocated = data.unlocated || 0;
                if (changed || !Object.keys(this.treeIndex).length) {
                    this.buildTreeIndex();
                }
            } catch (e) {
                this.treeError = String(e.message || e);
            }
            this.finishLoading();
            this.treeLoading = false;
        },

        buildTreeIndex() {
            const index = {};
            const walk = (nodes, parts) => {
                nodes.forEach((node) => {
                    // Как в дереве: «214 Процедурная», «2 этаж»
                    const t = treeNodeTexts(node);
                    const title = [t.code, t.name].filter(Boolean).join(" ") || node.name || node.code || "";
                    const path = parts.concat([title]).join(" → ");
                    index[node.id] = { node: node, path: path };
                    if (node.children && node.children.length) {
                        walk(node.children, parts.concat([title]));
                    }
                });
            };
            walk(this.treeRoots, []);
            this.treeIndex = index;
            this.treeWidth = computeTreeWidth(this.treeRoots);
        },

        kindLabel(kind) {
            return kindLabels[kind] || kind;
        },

        // Плашка действий у строки дерева – одна на всё дерево и стоит
        // снаружи таблицы (сама таблица обрезана по скруглённой рамке)
        setTreeHover(node, rowEl) {
            this.treeHover = rowPlate(rowEl, ".tree-wrap", { id: node.id, node: node });
        },

        // Когда у дерева появляется полоса прокрутки, колонка расширяется
        // на её ширину – текст узлов не обрезается
        watchTreeScroll() {
            const el = this.$refs.treeScroll;
            const content = this.$refs.treeContent;
            if (!el || !content || this._treeObservedEl === el) {
                return;
            }
            if (this._treeObserver) {
                this._treeObserver.disconnect();
            }
            const update = () => {
                const sb = el.offsetWidth - el.clientWidth;
                if (sb !== this.treeScrollbar) {
                    this.treeScrollbar = sb;
                }
            };
            this._treeObserver = new ResizeObserver(update);
            this._treeObserver.observe(el);
            this._treeObserver.observe(content);
            this._treeObservedEl = el;
            update();
        },

        treeAction(method) {
            const hover = this.treeHover;
            this.treeHover = null;
            if (hover) {
                this[method](hover.node);
            }
        },

        // Раскрыт ли узел: по умолчанию всё свёрнуто; что раскрыл пользователь –
        // помнится в браузере (этап 62)
        isTreeOpen(node, level) {
            const state = this.treeOpenState[node.id];
            return state === true;
        },

        setTreeOpen(id, open) {
            this.treeOpenState[id] = open;
            this.saveTreeOpen();
        },

        // Только раскрытые и только узлы, которые есть в дереве (ушедшие в архив – забываются)
        saveTreeOpen() {
            const state = this.treeOpenState;
            const index = this.treeIndex;
            const known = Object.keys(index).length > 0;
            const ids = Object.keys(state).filter(function (id) { return state[id] && (!known || index[id]); });
            saveJson(TREE_OPEN_KEY, ids.map(Number));
        },

        setAllTreeOpen(open) {
            const state = {};
            const walk = (nodes) => {
                nodes.forEach((node) => {
                    if (node.children && node.children.length) {
                        state[node.id] = open;
                        walk(node.children);
                    }
                });
            };
            walk(this.treeRoots);
            this.treeOpenState = state;
            this.saveTreeOpen();
        },

        expandAllTree() {
            this.setAllTreeOpen(true);
        },

        collapseAllTree() {
            this.setAllTreeOpen(false);
        },

        // Показать в таблице только ПК из узла и всех вложенных
        showLocationInTable(node) {
            const ids = new Set();
            const walk = (n) => {
                ids.add(n.id);
                (n.children || []).forEach(walk);
            };
            walk(node);
            const entry = this.treeIndex[node.id];
            this.setArchiveView(false);
            this.locationFilter = {
                id: node.id,
                path: entry ? entry.path : (node.name || node.code || ""),
                ids: ids
            };
            this.setView("table");
        },

        // Подсветка слов поиска Справочников в тексте
        hl(text) {
            return highlightParts(String(text || ""), this.choicesMatch.words);
        },

        nextChoicesBlock() {
            if (this.choicesMatch.blocks.length) {
                this.choicesPos = (this.choicesPos + 1) % this.choicesMatch.blocks.length;
                this.scrollToChoicesHit();
            }
        },

        // Показать текущий найденный раздел и первое совпавшее значение в нём
        scrollToChoicesHit() {
            this.$nextTick(() => {
                const field = this.choicesMatch.current;
                if (!field) {
                    return;
                }
                const block = document.querySelector('.st-block[data-field="' + field + '"]');
                if (!block) {
                    return;
                }
                block.scrollIntoView({ block: "nearest" });
                const row = block.querySelector(".st-row.search-hit");
                const list = block.querySelector(".st-values");
                if (row && list) {
                    list.scrollTop = row.offsetTop - list.offsetTop - 27;
                }
            });
        },

        // node – родитель («+» у строки дерева); без него – с панели, kind –
        // что добавить (выбрано в меню «+»), родитель – из списка в форме
        openAddForm(node, kind) {
            const allowedChildren = {
                building: ["department"],
                department: ["floor", "room"],
                floor: ["room"]
            };
            // Кнопка на панели: любой тип, родитель – из списка
            let kinds = ["building", "department", "floor", "room"];
            let path = "";
            if (node) {
                kinds = allowedChildren[node.kind] || [];
                if (!kinds.length) {
                    return;
                }
                this.setTreeOpen(node.id, true);
                const entry = this.treeIndex[node.id];
                path = entry ? entry.path : "";
            }
            if (kind && kinds.indexOf(kind) !== -1) {
                kinds = [kind];
            }
            this.treeForm = {
                action: "add",
                top: !node,
                parentId: node ? node.id : null,
                nodeId: null,
                kind: kinds[0],
                kinds: kinds,
                code: "",
                name: "",
                path: path
            };
            this.treeFormError = "";
        },

        openEditForm(node) {
            const entry = this.treeIndex[node.id];
            this.treeForm = {
                action: "edit",
                parentId: node.parent_id,
                openParentId: node.parent_id,
                nodeId: node.id,
                kind: node.kind,
                kinds: [node.kind],
                code: node.code || "",
                name: node.name || "",
                path: entry ? entry.path : ""
            };
            this.treeFormError = "";
        },

        // Куда можно добавить узел этого типа (форма с панели), где может быть кабинет –
        // варианты для выбора места в форме, в порядке дерева (этап 62)
        treeParentOptions(kind) {
            const parentKinds = {
                department: ["building"],
                floor: ["department"],
                room: ["department", "floor"]
            }[kind] || [];
            return this.locationOptions.filter(function (o) { return parentKinds.indexOf(o.kind) !== -1; });
        },

        // Значок типа узла – как в дереве (меню «+», этап 62)
        treeKindIcon(kind) {
            return KIND_ICONS[kind] || KIND_ICONS.room;
        },

        async submitTreeForm() {
            const form = this.treeForm;
            if (!form || form.saving) {
                return;
            }
            this.treeFormError = "";
            if (form.top) {
                if (form.kind === "building") {
                    form.parentId = null;
                } else if (!form.parentId) {
                    this.treeFormError = "Выбери, куда добавить.";
                    return;
                }
            }
            // Enter дважды подряд – один запрос
            form.saving = true;
            try {
                let response;
                if (form.action === "add") {
                    response = await apiFetch("/api/locations", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            parent_id: form.parentId,
                            kind: form.kind,
                            name: form.name,
                            code: form.code
                        })
                    });
                } else {
                    const body = { name: form.name, code: form.code };
                    // Кабинет – и место (этап 58), только если его поменяли в форме: иначе форма,
                    // открытая до чужого переноса, вернула бы кабинет назад
                    if (form.kind === "room" && form.parentId !== form.openParentId) {
                        body.parent_id = form.parentId;
                    }
                    response = await apiFetch("/api/locations/" + form.nodeId, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body)
                    });
                }
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const moved = form.action !== "add" && form.kind === "room" && form.parentId !== form.openParentId;
                this.treeForm = null;
                await this.loadTree();
                await this.loadTable();
                // Перенесённый кабинет – виден на новом месте (раскрыть путь к нему)
                if (moved) {
                    this.loadPrinters();
                    for (let id = form.parentId; id && this.treeIndex[id]; id = this.treeIndex[id].node.parent_id) {
                        this.setTreeOpen(id, true);
                    }
                }
            } catch (e) {
                form.saving = false;
                this.treeFormError = String(e.message || e);
            }
        },

        async archiveLocation(node) {
            const entry = this.treeIndex[node.id];
            const path = entry ? entry.path : node.name;
            if (!(await this.confirmDialog("Архивировать «" + path + "»?\nУзел исчезнет из дерева.", { okText: "Архивировать", danger: true }))) {
                return;
            }
            try {
                const response = await apiFetch("/api/locations/" + node.id + "/archive", {
                    method: "POST"
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                await this.loadTree();
                await this.loadTable();
            } catch (e) {
                this.toastError("Не удалось архивировать: " + e);
            }
        },

        moveLocationUp(node) {
            this.moveLocation(node, -1);
        },

        moveLocationDown(node) {
            this.moveLocation(node, 1);
        },

        async moveLocation(node, dir) {
            const parentEntry = node.parent_id ? this.treeIndex[node.parent_id] : null;
            const siblings = parentEntry ? parentEntry.node.children : this.treeRoots;
            const index = siblings.findIndex((item) => item.id === node.id);
            const target = siblings[index + dir];
            if (!target) {
                return;
            }
            try {
                if (node.sort === target.sort) {
                    await this.apiSend("/api/locations/" + node.id, "PATCH", { sort: target.sort + (dir > 0 ? 1 : -1) });
                } else {
                    await this.apiSend("/api/locations/" + node.id, "PATCH", { sort: target.sort });
                    await this.apiSend("/api/locations/" + target.id, "PATCH", { sort: node.sort });
                }
                await this.loadTree();
                await this.loadTable();
            } catch (e) {
                this.toastError("Не удалось переместить: " + e);
            }
        },
    }
};
