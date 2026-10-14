// Справочники → «Модели принтеров» (этап 44): модели, из которых у принтера берутся тип,
// производитель, печать и дуплекс. Таблица в манере «Пользователей»: новая модель и правка –
// строкой прямо в таблице, ✓ ✕ – плашкой справа; удалить – модель без принтеров.
// Правка модели меняет все её принтеры. Этап 47: и картриджи модели (через запятую, подсказками
// из справочника картриджей; новые попадают в него сами).

import { apiFetch, matchesAllWords, searchNorm, searchWords, searchWordsIn, rowPlate } from "../util.js";
import { COLOR_LABELS, PRINTER_KINDS, YES_NO_LABELS } from "../columns.js";

// Выбор в строке правки: «да / нет / не указано» – как в select
function boolOf(value) {
    return value === "true" ? true : (value === "false" ? false : null);
}

function boolText(value) {
    return value === true ? "true" : (value === false ? "false" : "");
}

// Подсказки у поля «Производитель» (этап 45): сначала – из справочника, за ними – эти
const COMMON_MAKERS = ["HP", "Kyocera", "Canon", "Brother", "Xerox", "Ricoh", "Konica Minolta", "Epson", "Pantum",
    "Samsung", "Lexmark", "OKI", "Sharp", "Toshiba", "Катюша"];

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

        // Производители для подсказки: из справочника (справа – число моделей), потом
        // распространённые, которых там ещё нет
        makerOptions() {
            const found = new Map();
            this.printerModels.forEach(function (m) {
                const maker = String(m.maker || "").trim();
                if (maker) {
                    const was = found.get(maker.toLowerCase());
                    found.set(maker.toLowerCase(), { value: was ? was.value : maker, n: (was ? was.n : 0) + 1 });
                }
            });
            const list = Array.from(found.entries()).sort(function (a, b) {
                return b[1].n - a[1].n || a[1].value.localeCompare(b[1].value, "ru");
            }).map(function (e) {
                return { key: e[0], value: e[1].value, count: e[1].n, countTitle: "Моделей в справочнике" };
            });
            COMMON_MAKERS.forEach(function (maker) {
                if (!found.has(maker.toLowerCase())) {
                    list.push({ key: maker.toLowerCase(), value: maker, count: "", countTitle: "" });
                }
            });
            return list;
        },

        // Поле «Производитель» (новая модель, строка справочника): список под полем; выбрали –
        // фокус в поле next
        openMakerSuggest(el, form, next) {
            this.openSuggestList(el, "maker", this.makerOptions(), (value) => {
                form.maker = value;
                this.$nextTick(() => this.focusRef(next));
            });
        },

        // Список открыт: ↑↓ и Enter – в нём, Esc закрывает только его
        onMakerKeydown(event) {
            if (!this.suggest || this.suggest.field !== "maker") {
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

        openNewModelRow() {
            if (this.modelsBar && this.modelsBar.kind === "new") {
                this.closeModelsBar();
                return;
            }
            this.modelsBar = { kind: "new", type: "printer", maker: "", model: "", color: "false", duplex: "", cartridges: "", error: "", saving: false, plate: null };
            this.loadCartridges();
            this.showEditRow("modelsBar", "mb-maker");
        },

        openEditModel(m) {
            if (!this.canEdit) {
                return;
            }
            this.modelsHover = null;
            this.modelsBar = {
                kind: "edit", id: m.id, type: m.kind, maker: m.maker || "", model: m.model,
                color: boolText(m.color), duplex: boolText(m.duplex), cartridges: (m.cartridges || []).join(", "),
                error: "", saving: false, plate: null
            };
            this.loadCartridges();
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
                const response = await this.apiSend(bar.kind === "new" ? "/api/printer-models" : "/api/printer-models/" + bar.id, bar.kind === "new" ? "POST" : "PATCH", {
                    kind: bar.type, maker: bar.maker, model: bar.model, color: boolOf(bar.color), duplex: boolOf(bar.duplex),
                    cartridges: bar.cartridges
                });
                const saved = await response.json();
                await Promise.all([this.loadPrinterModels(), this.loadCartridges()]);
                // Значения модели видны в таблице принтеров, название – и у ПК (этап 47)
                if (bar.kind === "edit" && saved.printers) {
                    this.loadPrinters();
                    this.loadTable();
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
            if (this.canEdit) {
                this.modelsHover = rowPlate(rowEl, ".users-wrap", { id: m.id, model: m });
            }
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
