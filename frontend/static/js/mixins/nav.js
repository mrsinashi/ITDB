// Адреса страниц и переходы по ним (средняя кнопка открывает нужное место в
// новой вкладке), Ctrl+Z – отменить своё последнее изменение, Ctrl+Y – вернуть.

import { apiFetch } from "../util.js";
import { pageLink, parseHash } from "../route.js";

// Страницы в порядке меню; вкладки страниц – слева направо; права у каждой вкладки свои
// (этап 69: «scan/net», «choices/models»)
const MENU_VIEWS = ["table", "printers", "tree", "journals", "vacuum", "scan", "choices", "history", "users"];
const VIEW_TABS = {
    journals: ["moves", "ips"],
    scan: ["check", "net", "names", "schedule", "settings"],
    choices: ["styles", "names", "models", "cartridges"]
};
// Ctrl+Y возвращает отменённое Ctrl+Z только столько после отмены (этап 47)
const REDO_WINDOW_MS = 60 * 1000;

export default {
    methods: {
        // Адрес страницы для ссылки: pageHref("scan/net"), pageHref("table", { pc: 12 })
        pageHref(page, params) {
            return pageLink(page, params);
        },

        // Обычный клик по ссылке-вкладке – переход на месте; с Ctrl / Shift –
        // как у любой ссылки (новая вкладка, новое окно)
        navClick(event, run) {
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
            }
            event.preventDefault();
            run();
        },

        // Адрес в строке браузера – как у открытой страницы (без записи в журнал переходов)
        syncHash() {
            let page = this.view;
            if (this.view === "scan") {
                page = "scan/" + this.scanTab;
            } else if (this.view === "journals") {
                page = "journals/" + this.journalTab;
            } else if (this.view === "choices" && this.choicesTab !== "styles") {
                page = "choices/" + this.choicesTab;
            }
            const hash = pageLink(page);
            if (window.location.hash !== hash) {
                try {
                    window.history.replaceState(null, "", hash);
                } catch (e) {
                    // адрес не поменялся – не страшно
                }
            }
        },

        // Страница в меню и по адресу (этап 69): есть доступ хоть к одной её вкладке;
        // «Пользователи» с этапа 70 – по правам, как все
        canOpenView(view) {
            return VIEW_TABS[view] ? !!this.firstTab(view) : this.canPage(view);
        },

        // Первая слева вкладка страницы, которую можно открыть; нет таких – null
        firstTab(view) {
            return (VIEW_TABS[view] || []).find((tab) => this.canPage(view + "/" + tab)) || null;
        },

        // Первая по меню страница, которую можно открыть («Компьютеры» закрыты – не они)
        firstView() {
            return MENU_VIEWS.find((view) => this.canOpenView(view)) || null;
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
            // Вкладка «Журналов» (этап 71) – до перехода: страница откроется сразу на ней
            if (route.view === "journals" && VIEW_TABS.journals.indexOf(route.tab) !== -1 && this.canPage("journals/" + route.tab) && this.journalTab !== route.tab) {
                if (this.view === "journals") {
                    this.setJournalTab(route.tab);
                } else {
                    this.journalTab = route.tab;
                }
            }
            if (this.view !== route.view || route.view === "scan") {
                this.setView(route.view);
            }
            if (route.view === "scan" && route.tab && VIEW_TABS.scan.indexOf(route.tab) !== -1 && this.canPage("scan/" + route.tab)) {
                this.setScanTab(route.tab);
            }
            if (route.view === "choices") {
                const tab = VIEW_TABS.choices.indexOf(route.tab) !== -1 ? route.tab : "styles";
                this.setChoicesTab(this.canPage("choices/" + tab) ? tab : this.firstTab("choices"));
            }
            if (params.pc) {
                this.openCardById(Number(params.pc));
            }
            // Карточка принтера (этап 44): принтеры могли ещё не загрузиться
            if (params.pr) {
                if (!this.printerRows.length) {
                    await this.loadPrinters();
                }
                this.openPrinterCardById(Number(params.pr));
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

        // После отмены или возврата – перечитать то, что на экране
        async reloadAfterUndo() {
            await this.afterHistoryAction();
            this.loadDiffs();
            this.loadPrinterDiffs();
            if (this.view === "scan" && this.scanTab === "check") {
                this.loadCheck();
            }
            // Решения сканера отменяются тоже (этап 53) – «Названия» на экране перечитать
            if (this.view === "scan" && this.scanTab === "names") {
                this.loadScanNames();
            }
        },

        // Ctrl+Z: отменить своё последнее действие (как «Отменить изменения» в Истории).
        // Этап 47: только за 5 минут; сделанное больше минуты назад – с подтверждением
        async undoLast() {
            if (!this.canEditAny || this.undoBusy) {
                return;
            }
            this.undoBusy = true;
            try {
                const post = (body) => apiFetch("/api/history/undo-last", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                let response = await post({});
                if (!response.ok) {
                    this.toast(await this.errorText(response), response.status === 404 ? "info" : "error");
                    return;
                }
                let data = await response.json();
                if (data.confirm) {
                    const minutes = Math.floor(data.age / 60);
                    if (!(await this.confirmDialog("Изменение сделано " + minutes + " мин. назад: " + data.text + ". Отменить?", { okText: "Отменить изменение" }))) {
                        return;
                    }
                    response = await post({ confirm_id: data.last_id });
                    if (!response.ok) {
                        this.toast(await this.errorText(response), response.status === 404 ? "info" : "error");
                        return;
                    }
                    data = await response.json();
                    if (data.confirm) {
                        this.toast("Последнее изменение уже другое – нажми Ctrl+Z ещё раз.", "info");
                        return;
                    }
                }
                this.undone.push({ items: data.items, at: Date.now() });
                await this.reloadAfterUndo();
                this.toast("Отменено: " + data.text, "success");
            } catch (e) {
                this.toastError("Не удалось отменить: " + (e.message || e));
            } finally {
                this.undoBusy = false;
            }
        },

        // Ctrl+Y (Ctrl+Shift+Z): вернуть то, что отменил Ctrl+Z, – в течение минуты после отмены
        async redoLast() {
            if (!this.canEditAny || this.undoBusy) {
                return;
            }
            const last = this.undone[this.undone.length - 1];
            if (last && Date.now() - last.at > REDO_WINDOW_MS) {
                this.undone = [];
                this.toast("Ctrl+Y возвращает только в течение минуты – остальное в Истории.");
                return;
            }
            if (!last) {
                this.toast("Возвращать нечего.");
                return;
            }
            this.undoBusy = true;
            try {
                const items = last.items;
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
