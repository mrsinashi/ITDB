// Страница «Дерево»: узлы, поиск, форма узла, ширина колонки.

import { apiFetch, highlightParts, matchesAllWords, searchWords } from "../util.js";
import { kindLabels } from "../columns.js";
import { computeTreeWidth, treeNodeTexts } from "../tree-utils.js";

export default {
    computed: {
        // Поиск по дереву: self — совпали сами, anc — предки совпавших
        treeMatch() {
            // Слова ищутся по всему пути узла («хир орд» — ординаторские
            // хирургии). Найденным считается верхний узел, на котором путь
            // впервые собрал все слова; его потомки видны под ним.
            const q = this.treeQuery.trim();
            const words = searchWords(q);
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
                this.treeRoots = data.roots || [];
                this.treeHover = null;
                this.$nextTick(() => this.watchTreeScroll());
                this.unlocated = data.unlocated || 0;
                this.buildTreeIndex();
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

        // Плашка действий у строки дерева — одна на всё дерево и стоит
        // снаружи таблицы (сама таблица обрезана по скруглённой рамке)
        setTreeHover(node, rowEl) {
            const wrap = rowEl.closest(".tree-wrap");
            if (!wrap) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const r = rowEl.getBoundingClientRect();
            this.treeHover = { id: node.id, node: node, top: r.top - w.top, height: r.height };
        },

        // Когда у дерева появляется полоса прокрутки, колонка расширяется
        // на её ширину — текст узлов не обрезается
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

        // Раскрыт ли узел: по умолчанию всё свёрнуто; что раскрыл пользователь —
        // остаётся раскрытым до перезагрузки страницы
        isTreeOpen(node, level) {
            const state = this.treeOpenState[node.id];
            return state === true;
        },

        setTreeOpen(id, open) {
            this.treeOpenState[id] = open;
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

        kindLabel(kind) {
            return kindLabels[kind] || kind;
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

        // node — родитель («+» у строки дерева); без него — с панели, kind —
        // что добавить (выбрано в меню «+»), родитель — из списка в форме
        openAddForm(node, kind) {
            const allowedChildren = {
                building: ["department"],
                department: ["floor", "room"],
                floor: ["room"]
            };
            // Кнопка на панели: любой тип, родитель — из списка
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
                nodeId: node.id,
                kind: node.kind,
                kinds: [node.kind],
                code: node.code || "",
                name: node.name || "",
                path: entry ? entry.path : ""
            };
            this.treeFormError = "";
        },

        // Куда можно добавить узел этого типа — для формы на панели
        treeParentOptions(kind) {
            const parentKinds = {
                department: ["building"],
                floor: ["department"],
                room: ["department", "floor"]
            }[kind] || [];
            return Object.keys(this.treeIndex)
                .map((id) => this.treeIndex[id])
                .filter(function (e) { return parentKinds.indexOf(e.node.kind) !== -1; })
                .map(function (e) { return { id: e.node.id, path: e.path }; })
                .sort(function (a, b) { return a.path.localeCompare(b.path, "ru", { numeric: true }); });
        },

        async submitTreeForm() {
            const form = this.treeForm;
            if (!form) {
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
                    response = await apiFetch("/api/locations/" + form.nodeId, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            name: form.name,
                            code: form.code
                        })
                    });
                }
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.treeForm = null;
                await this.loadTree();
                await this.loadTable();
            } catch (e) {
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
                let response;
                if (node.sort === target.sort) {
                    response = await apiFetch("/api/locations/" + node.id, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            sort: target.sort + (dir > 0 ? 1 : -1)
                        })
                    });
                    if (!response.ok) {
                        throw new Error(await this.errorText(response));
                    }
                } else {
                    response = await apiFetch("/api/locations/" + node.id, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ sort: target.sort })
                    });
                    if (!response.ok) {
                        throw new Error(await this.errorText(response));
                    }
                    response = await apiFetch("/api/locations/" + target.id, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ sort: node.sort })
                    });
                    if (!response.ok) {
                        throw new Error(await this.errorText(response));
                    }
                }
                await this.loadTree();
                await this.loadTable();
            } catch (e) {
                this.toastError("Не удалось переместить: " + e);
            }
        },
    }
};
