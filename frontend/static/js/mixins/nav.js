// Адреса страниц и переходы по ним (средняя кнопка открывает нужное место в
// новой вкладке), Ctrl+Z — отменить своё последнее изменение, Ctrl+Y — вернуть.

import { apiFetch } from "../util.js";
import { pageLink, parseHash } from "../route.js";

// Вкладки «Сканера»: какие есть у редактора (остальные — только администратор)
const SCAN_TABS = ["check", "net", "names", "schedule", "settings"];
const EDITOR_SCAN_TABS = ["check", "net"];

export default {
    methods: {
        // Адрес страницы для ссылки: pageHref("scan/net"), pageHref("table", { pc: 12 })
        pageHref(page, params) {
            return pageLink(page, params);
        },

        // Обычный клик по ссылке-вкладке — переход на месте; с Ctrl / Shift —
        // как у любой ссылки (новая вкладка, новое окно)
        navClick(event, run) {
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
            }
            event.preventDefault();
            run();
        },

        // Адрес в строке браузера — как у открытой страницы (без записи в журнал переходов)
        syncHash() {
            const page = this.view === "scan" ? "scan/" + this.scanTab : this.view;
            const hash = pageLink(page);
            if (window.location.hash !== hash) {
                try {
                    window.history.replaceState(null, "", hash);
                } catch (e) {
                    // адрес не поменялся — не страшно
                }
            }
        },

        canOpenView(view) {
            if (view === "users") {
                return this.isAdmin;
            }
            if (view === "vacuum" || view === "scan") {
                return this.canEdit;
            }
            return true;
        },

        // Открыть то, что названо в адресе (при загрузке страницы и при смене адреса)
        async applyRoute(route) {
            if (!route || !this.canOpenView(route.view)) {
                this.syncHash();
                return;
            }
            const params = route.params || {};
            if (route.view === "table" && params.loc) {
                await this.ensureTree();
                const node = this.findTreeNode(Number(params.loc));
                if (node) {
                    this.showLocationInTable(node);
                }
            }
            if (this.view !== route.view || route.view === "scan") {
                this.setView(route.view);
            }
            if (route.view === "scan" && route.tab && SCAN_TABS.indexOf(route.tab) !== -1 &&
                (this.isAdmin || EDITOR_SCAN_TABS.indexOf(route.tab) !== -1)) {
                this.setScanTab(route.tab);
            }
            if (params.pc) {
                this.openCardById(Number(params.pc));
            }
            this.syncHash();
        },

        applyHash() {
            return this.applyRoute(parseHash(window.location.hash));
        },

        findTreeNode(id) {
            let found = null;
            const walk = function (nodes) {
                (nodes || []).forEach(function (node) {
                    if (node.id === id) {
                        found = node;
                    } else if (!found) {
                        walk(node.children);
                    }
                });
            };
            walk(this.treeRoots);
            return found;
        },

        // ---------- Ctrl+Z / Ctrl+Y ----------

        // После отмены или возврата — перечитать то, что на экране
        async reloadAfterUndo() {
            await this.afterHistoryAction();
            this.loadDiffs();
            if (this.view === "scan" && this.scanTab === "check") {
                this.loadCheck();
            }
        },

        // Ctrl+Z: отменить своё последнее действие (как «Отменить изменения» в Истории)
        async undoLast() {
            if (!this.canEdit || this.undoBusy) {
                return;
            }
            this.undoBusy = true;
            try {
                const response = await apiFetch("/api/history/undo-last", { method: "POST" });
                if (!response.ok) {
                    this.toast(await this.errorText(response), response.status === 404 ? "info" : "error");
                    return;
                }
                const data = await response.json();
                this.undone.push(data.items);
                await this.reloadAfterUndo();
                this.toast("Отменено: " + data.text, "success");
            } catch (e) {
                this.toastError("Не удалось отменить: " + (e.message || e));
            } finally {
                this.undoBusy = false;
            }
        },

        // Ctrl+Y (Ctrl+Shift+Z): вернуть то, что отменил Ctrl+Z
        async redoLast() {
            if (!this.canEdit || this.undoBusy) {
                return;
            }
            if (!this.undone.length) {
                this.toast("Возвращать нечего.");
                return;
            }
            this.undoBusy = true;
            try {
                const items = this.undone[this.undone.length - 1];
                const response = await apiFetch("/api/history/cancel", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ items: items, cancel: false })
                });
                if (!response.ok) {
                    this.toastError(await this.errorText(response));
                    return;
                }
                this.undone.pop();
                await this.reloadAfterUndo();
                this.toast("Возвращено", "success");
            } catch (e) {
                this.toastError("Не удалось вернуть: " + (e.message || e));
            } finally {
                this.undoBusy = false;
            }
        }
    }
};
