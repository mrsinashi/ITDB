// Справочники → «Картриджи» (этап 47): справочник картриджей. Пополняется сам – картридж,
// вписанный модели (ячейка «Картриджи» в таблице принтеров, справочник моделей), появляется
// здесь. Картриджи – у модели: у принтера в таблице – картриджи его модели. Таблица в манере
// «Моделей принтеров»: новый и правка – строкой прямо в таблице (название и модели через
// запятую, подсказками), удалить – картридж без моделей; число принтеров – ссылка «показать
// в Принтерах» (фильтр столбца «Картриджи»).
//
// Подсказки по частям через запятую (картриджи у модели и у принтера, модели у картриджа) –
// openTokenSuggest: выбор заменяет набираемую часть, список открывается снова для следующей.

import { apiFetch, matchesAllWords, searchNorm, searchWords, searchWordsIn } from "../util.js";

// Части значения: «CF283A, CF283X» (и строками)
export function splitTokens(text) {
    return String(text || "").split(/[,;\n]/).map(function (part) { return part.trim(); }).filter(Boolean);
}

export default {
    data() {
        return {
            cartridges: [],          // /api/cartridges: [{ id, name, models: [{ id, title }], printers }]
            cartridgesBar: null,     // строка в таблице: новый картридж / изменить
            cartridgesHover: null,   // строка под курсором – плашка действий
            cartridgesQuery: ""
        };
    },

    computed: {
        // Строки таблицы: картриджи (по поиску), правка – на месте строки, новый – последним
        cartridgesView() {
            const bar = this.cartridgesBar;
            let list = this.cartridges;
            if (searchWords(this.cartridgesQuery).length) {
                const texts = list.map(function (c) { return searchNorm([c.name].concat(c.models.map(function (m) { return m.title; })).join(" ")); });
                const words = searchWordsIn(this.cartridgesQuery, texts);
                list = list.filter(function (c, i) { return matchesAllWords(texts[i], words); });
            }
            const rows = list.map(function (c) {
                return { key: "c" + c.id, cart: c, edit: !!bar && bar.kind === "edit" && bar.id === c.id };
            });
            if (bar && bar.kind === "new") {
                rows.push({ key: "new", cart: null, edit: true });
            }
            return rows;
        },

        cartridgesCountText() {
            return "Картриджей: " + this.cartridges.length;
        }
    },

    methods: {
        async loadCartridges() {
            try {
                const response = await apiFetch("/api/cartridges");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.cartridges = (await response.json()).items || [];
            } catch (e) {
                this.toastError("Не удалось загрузить картриджи: " + (e.message || e));
            }
        },

        cartridgeModelsText(c) {
            return c.models.map(function (m) { return m.title; }).join(", ");
        },

        // Подсказки: картриджи справочника (справа – у скольких моделей) и модели (принтеров)
        cartridgeOptions() {
            return this.cartridges.map(function (c) {
                return { key: c.name.toLowerCase(), value: c.name, count: c.models.length || "", countTitle: "Моделей" };
            });
        },

        modelTitleOptions() {
            return this.printerModels.map(function (m) {
                return { key: m.title.toLowerCase(), value: m.title, count: m.printers || "", countTitle: "Принтеров" };
            });
        },

        // Подсказки по частям: выбор заменяет набираемую часть, дальше – «, » и список снова
        openTokenSuggest(el, field, options) {
            this.openSuggestList(el, field, options, (value) => {
                const parts = String(el.value || "").split(/[,;\n]/);
                parts[parts.length - 1] = value;
                const text = parts.map(function (part) { return part.trim(); }).filter(Boolean).join(", ") + ", ";
                el.value = text;
                el.dispatchEvent(new Event("input"));
                el.focus();
                el.setSelectionRange(text.length, text.length);
                this.$nextTick(() => this.openTokenSuggest(el, field, options));
            }, true);
        },

        // Список открыт: ↑↓ и Enter – в нём, Esc закрывает только его
        onTokenKeydown(event) {
            if (!this.suggest || !this.suggest.tokens) {
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                this.closeSuggest();
                return;
            }
            this.suggestKeydown(event);
        },

        openNewCartridgeRow() {
            if (this.cartridgesBar && this.cartridgesBar.kind === "new") {
                this.closeCartridgesBar();
                return;
            }
            if (!this.printerModels.length) {
                this.loadPrinterModels();
            }
            this.cartridgesBar = { kind: "new", name: "", models: "", error: "", saving: false, plate: null };
            this.showEditRow("cartridgesBar", "cb-name");
        },

        openEditCartridge(c) {
            if (!this.canEdit) {
                return;
            }
            this.cartridgesHover = null;
            this.cartridgesBar = { kind: "edit", id: c.id, name: c.name, models: this.cartridgeModelsText(c), error: "", saving: false, plate: null };
            this.showEditRow("cartridgesBar", "cb-name");
        },

        closeCartridgesBar() {
            this.cartridgesBar = null;
        },

        async submitCartridgesBar() {
            const bar = this.cartridgesBar;
            if (!bar || bar.saving) {
                return;
            }
            if (!bar.name.trim()) {
                bar.error = "Нужно название картриджа.";
                this.focusRef("cb-name");
                return;
            }
            // Модели – по названию «Производитель Модель» (или без производителя, если одна такая)
            const ids = [];
            for (const title of splitTokens(bar.models)) {
                const key = title.toLowerCase();
                let found = this.printerModels.filter(function (m) { return m.title.toLowerCase() === key; });
                if (!found.length) {
                    found = this.printerModels.filter(function (m) { return String(m.model).toLowerCase() === key; });
                }
                if (found.length !== 1) {
                    bar.error = found.length ? "«" + title + "» – несколько моделей: укажи производителя." : "Нет модели «" + title + "».";
                    this.focusRef("cb-models");
                    return;
                }
                ids.push(found[0].id);
            }
            bar.saving = true;
            bar.error = "";
            try {
                const response = await apiFetch(bar.kind === "new" ? "/api/cartridges" : "/api/cartridges/" + bar.id, {
                    method: bar.kind === "new" ? "POST" : "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: bar.name, model_ids: ids })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const saved = await response.json();
                await Promise.all([this.loadCartridges(), this.loadPrinterModels()]);
                // Картриджи моделей видны в таблице принтеров
                this.loadPrinters();
                this.cartridgesBar = null;
                this.toast((bar.kind === "new" ? "Картридж добавлен: " : "Сохранено: ") + saved.name, "success");
            } catch (e) {
                bar.error = String(e.message || e);
                bar.saving = false;
            }
        },

        async deleteCartridge(c) {
            if (c.models.length) {
                return;
            }
            if (!(await this.confirmDialog("Удалить картридж «" + c.name + "»?", { okText: "Удалить", danger: true }))) {
                return;
            }
            try {
                const response = await apiFetch("/api/cartridges/" + c.id, { method: "DELETE" });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.cartridgesHover = null;
                await this.loadCartridges();
                this.toast("Удалено: " + c.name, "success");
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        // Плашка действий справа от таблицы, у строки под курсором (как у моделей)
        setCartridgesHover(c, rowEl) {
            const wrap = rowEl.closest(".users-wrap");
            if (!wrap || !this.canEdit) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const r = rowEl.getBoundingClientRect();
            this.cartridgesHover = { id: c.id, cart: c, top: r.top - w.top, height: r.height };
        },

        // Принтеры с этим картриджем – на странице «Принтеры» (фильтр по столбцу «Картриджи»)
        showCartridgePrinters(c) {
            this.setView("printers");
            const key = c.name.trim().toLowerCase();
            this.quickFilter = "";
            this.setColFilter("cartridges", { exclude: false, keys: [key], labels: { [key]: c.name } });
        }
    }
};
