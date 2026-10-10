// Справочники → «Модели принтеров» (этап 44): модели, из которых у принтера берутся тип,
// производитель, печать и дуплекс. Таблица в манере «Пользователей»: новая модель и правка –
// строкой прямо в таблице, ✓ ✕ – плашкой справа; удалить – модель без принтеров.
// Правка модели меняет все её принтеры.

import { apiFetch, matchesAllWords, searchNorm, searchWords, searchWordsIn } from "../util.js";
import { COLOR_LABELS, PRINTER_KINDS, YES_NO_LABELS } from "../columns.js";

// Выбор в строке правки: «да / нет / не указано» – как в select
function boolOf(value) {
    return value === "true" ? true : (value === "false" ? false : null);
}

function boolText(value) {
    return value === true ? "true" : (value === false ? "false" : "");
}

export default {
    data() {
        return {
            modelsBar: null,     // строка в таблице: новая модель / изменить
            modelsHover: null,   // строка под курсором – плашка действий
            modelsQuery: ""
        };
    },

    computed: {
        printerKinds() {
            return PRINTER_KINDS;
        },

        // Строки таблицы: модели (по поиску), правка – на месте строки, новая – последней
        modelsView() {
            const bar = this.modelsBar;
            let list = this.printerModels;
            if (searchWords(this.modelsQuery).length) {
                const texts = list.map((m) => searchNorm([this.modelKindLabel(m.kind), m.title, this.modelColorText(m.color)].join(" ")));
                const words = searchWordsIn(this.modelsQuery, texts);
                list = list.filter(function (m, i) { return matchesAllWords(texts[i], words); });
            }
            const rows = list.map(function (m) {
                return { key: "m" + m.id, model: m, edit: !!bar && bar.kind === "edit" && bar.id === m.id };
            });
            if (bar && bar.kind === "new") {
                rows.push({ key: "new", model: null, edit: true });
            }
            return rows;
        },

        modelsCountText() {
            return "Моделей: " + this.printerModels.length;
        }
    },

    methods: {
        modelKindLabel(kind) {
            const found = PRINTER_KINDS.find(function (k) { return k.key === kind; });
            return found ? found.label : kind;
        },

        modelColorText(value) {
            return value === null || value === undefined ? "" : COLOR_LABELS[value];
        },

        modelYesNoText(value) {
            return value === null || value === undefined ? "" : YES_NO_LABELS[value];
        },

        openNewModelRow() {
            if (this.modelsBar && this.modelsBar.kind === "new") {
                this.closeModelsBar();
                return;
            }
            this.modelsBar = { kind: "new", type: "printer", maker: "", model: "", color: "false", duplex: "", error: "", saving: false, plate: null };
            this.showEditRow("modelsBar", "mb-maker");
        },

        openEditModel(m) {
            if (!this.canEdit) {
                return;
            }
            this.modelsHover = null;
            this.modelsBar = {
                kind: "edit", id: m.id, type: m.kind, maker: m.maker || "", model: m.model,
                color: boolText(m.color), duplex: boolText(m.duplex), error: "", saving: false, plate: null
            };
            this.showEditRow("modelsBar", "mb-model");
        },

        closeModelsBar() {
            this.modelsBar = null;
        },

        async submitModelsBar() {
            const bar = this.modelsBar;
            if (!bar || bar.saving) {
                return;
            }
            if (!bar.model.trim()) {
                bar.error = "Нужно название модели.";
                this.focusRef("mb-model");
                return;
            }
            bar.saving = true;
            bar.error = "";
            try {
                const response = await apiFetch(bar.kind === "new" ? "/api/printer-models" : "/api/printer-models/" + bar.id, {
                    method: bar.kind === "new" ? "POST" : "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ kind: bar.type, maker: bar.maker, model: bar.model, color: boolOf(bar.color), duplex: boolOf(bar.duplex) })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const saved = await response.json();
                await this.loadPrinterModels();
                // Значения модели видны в таблице принтеров
                if (bar.kind === "edit" && saved.printers) {
                    this.loadPrinters();
                }
                this.modelsBar = null;
                this.toast((bar.kind === "new" ? "Модель добавлена: " : "Сохранено: ") + saved.title, "success");
            } catch (e) {
                bar.error = String(e.message || e);
                bar.saving = false;
            }
        },

        async deleteModel(m) {
            if (m.printers) {
                return;
            }
            if (!(await this.confirmDialog("Удалить модель «" + m.title + "»?", { okText: "Удалить", danger: true }))) {
                return;
            }
            try {
                const response = await apiFetch("/api/printer-models/" + m.id, { method: "DELETE" });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.modelsHover = null;
                await this.loadPrinterModels();
                this.toast("Удалено: " + m.title, "success");
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        // Плашка действий справа от таблицы, у строки под курсором (как у Пользователей)
        setModelsHover(m, rowEl) {
            const wrap = rowEl.closest(".users-wrap");
            if (!wrap || !this.canEdit) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const r = rowEl.getBoundingClientRect();
            this.modelsHover = { id: m.id, model: m, top: r.top - w.top, height: r.height };
        },

        // Принтеры этой модели – на странице «Принтеры» (фильтр по столбцу «Модель»)
        showModelPrinters(m) {
            this.setView("printers");
            const key = String(m.model || "").trim().toLowerCase();
            this.quickFilter = "";
            this.setColFilter("model", { exclude: false, keys: [key], labels: { [key]: m.model } });
        }
    }
};
