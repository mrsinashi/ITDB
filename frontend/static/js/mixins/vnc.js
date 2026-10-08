// Подключение к ПК по VNC через внешнее приложение (этап 28б): ссылки
// itdb://vnc/tight/IP и itdb://vnc/ultra/IP. Обработчик протокола itdb:// – отдельное
// приложение на компьютере пользователя. Двойной клик по значению TightVNC / UltraVNC
// (Таблица, карточка ПК, подробности «Проверки») – подключение этим VNC; Enter –
// тем, что записан у ПК, а если не записан – тем, что выбран по умолчанию в
// Справочниках (блок «Тип VNC»).
// Alt+P (itdb://ping/IP) и Alt+R (itdb://rdp/IP) работают с последним ПК, по строке
// которого нажали мышью (выделять строку не нужно); открыта карточка – с её ПК.
// Enter (этап 40) – только к строке с полоской: по строке нажали и больше ни по чему
// (карточка, кнопки, поля, меню); иначе подключения нет, а полоска снимается.
// Строка отмечена полоской слева (элемент .row-mark ставится прямо в DOM: данные Vue
// не меняются – таблица на каждый клик не перерисовывается). Полоска – в «подписи»
// таблицы, липкой у левого края: при прокрутке её ведёт сам браузер, как закреплённые
// столбцы (этап 40); строку скрыли поиском или фильтром – она забыта (этап 36).

import { apiFetch, isTypingTarget } from "../util.js";

export const VNC_KINDS = [
    { key: "tight", label: "TightVNC" },
    { key: "ultra", label: "UltraVNC" }
];

// «TightVNC» → tight, «UltraVNC 1.4» → ultra; другое – null
export function vncKindOf(text) {
    const value = String(text || "").toLowerCase();
    if (value.indexOf("tight") !== -1) {
        return "tight";
    }
    if (value.indexOf("ultra") !== -1) {
        return "ultra";
    }
    return null;
}

function firstIp(value) {
    const lines = String(value || "").split("\n");
    for (const line of lines) {
        const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/.exec(line);
        if (m) {
            return m[1];
        }
    }
    return null;
}

// Открыть ссылку внешнего приложения, не уходя со страницы. Firefox при незнакомом
// протоколе показал бы вместо программы страницу ошибки – там ссылка открывается в
// скрытой рамке
function launch(url) {
    if (/firefox/i.test(navigator.userAgent)) {
        const frame = document.createElement("iframe");
        frame.style.display = "none";
        frame.src = url;
        document.body.appendChild(frame);
        setTimeout(function () { frame.remove(); }, 3000);
    } else {
        window.location.href = url;
    }
}

export default {
    computed: {
        vncKinds() {
            return VNC_KINDS;
        }
    },

    mounted() {
        document.addEventListener("mousedown", this.onMarkMouseDown, true);
    },

    updated() {
        if (this.view === "table") {
            this.markActiveRow();
        }
    },

    watch: {
        // Строку скрыли поиском или фильтром – она больше не «последняя нажатая» (этап 36)
        displayRows(rows) {
            const id = this.activeRowId;
            if (id !== null && id !== undefined && !rows.some(function (r) { return r.id === id; })) {
                this.setActiveRow(null);
            }
        }
    },

    methods: {
        async loadAppSettings() {
            try {
                const response = await apiFetch("/api/settings");
                if (response.ok) {
                    this.appSettings = await response.json();
                }
            } catch (e) {
                // без настроек – значения по умолчанию
            }
        },

        async setVncDefault(kind) {
            try {
                const response = await apiFetch("/api/settings", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ vnc_default: kind })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.appSettings = await response.json();
            } catch (e) {
                this.toastError("Не удалось сохранить: " + (e.message || e));
            }
        },

        vncLabel(kind) {
            const found = VNC_KINDS.find(function (k) { return k.key === kind; });
            return found ? found.label : kind;
        },

        // Каким VNC подключаться к ПК: записанным в таблице, иначе – по умолчанию
        vncKindOfRow(row) {
            const lines = String(row.vnc || "").split("\n");
            for (const line of lines) {
                const kind = vncKindOf(line);
                if (kind) {
                    return kind;
                }
            }
            return this.appSettings.vnc_default;
        },

        // Подключиться к ПК: kind – tight / ultra (нет – как у ПК или по умолчанию)
        vncConnect(row, kind) {
            const ip = firstIp(row && row.ip);
            if (!ip) {
                this.toastError("У ПК нет IP – подключиться некуда.");
                return;
            }
            const use = kind || this.vncKindOfRow(row);
            launch("itdb://vnc/" + use + "/" + ip);
            this.toast(this.vncLabel(use) + ": " + (row.hostname || ip) + " (" + ip + ")");
        },

        // Двойной клик по значению в ячейке Таблицы: TightVNC / UltraVNC – подключение,
        // остальное – как обычно (правка ячейки)
        onCellValueDblclick(event, row, col) {
            if (col.field !== "vnc" || this.isEditing(row, col)) {
                return;
            }
            const target = this.copyTargetAt(event.clientX, event.clientY);
            const kind = vncKindOf(target ? target.text : event.target.textContent);
            if (kind) {
                event.stopPropagation();
                this.vncConnect(row, kind);
            }
        },

        // То же в карточке ПК (строка «Тип VNC»); line – строка значения
        onCardValueDblclick(event, r, line) {
            if (r.field !== "vnc" || !this.card) {
                return;
            }
            const kind = vncKindOf(line);
            if (kind) {
                event.stopPropagation();
                this.vncConnect(this.card, kind);
            }
        },

        // То же в подробностях «Проверки»: значение VNC из GLPI / GSIT
        checkVncConnect(event, computerId, text) {
            const kind = vncKindOf(text);
            const row = this.rows.find(function (r) { return r.id === computerId; });
            if (kind && row) {
                event.stopPropagation();
                this.vncConnect(row, kind);
            }
        },

        // Запомнить строку, по которой нажали (Enter, Alt+P, Alt+R – к этому ПК)
        setActiveRow(row) {
            this.activeRowId = row ? row.id : null;
            this.markActiveRow();
        },

        // Полоска у запомненной строки; Vue мог перерисовать строку
        markActiveRow() {
            const table = this.$refs.table;
            const id = this.activeRowId;
            let el = this.activeRowEl;
            if (el && (!el.isConnected || el.dataset.id !== String(id))) {
                el = null;
            }
            if (!el && table && id !== null && id !== undefined) {
                el = table.querySelector('tbody tr[data-id="' + id + '"]');
            }
            this.activeRowEl = el || null;
            this.placeRowMark();
        },

        // Полоска – в «подписи» таблицы (caption), липкой у левого края видимой части:
        // при прокрутке её двигает браузер, место по высоте – от верха таблицы (этап 40).
        // Ставится заново, только когда меняется строка или вид таблицы, не на прокрутку.
        // В масштабе «По ширине окна» подпись тоже в масштабе – размеры делятся на него
        placeRowMark() {
            const mark = this.$refs.rowMark;
            const tr = this.activeRowEl;
            if (!mark) {
                return;
            }
            if (!tr || !tr.isConnected) {
                mark.style.display = "none";
                return;
            }
            const zoom = this.tableFit ? this.tableZoom : 1;
            const rail = mark.parentNode.getBoundingClientRect();
            const row = tr.getBoundingClientRect();
            mark.style.display = "block";
            mark.style.top = (row.top - rail.top) / zoom + "px";
            mark.style.height = Math.max(0, row.height - 1) / zoom + "px";
        },

        // Нажатие мыши не по ячейке строки Таблицы (кнопки, поля, карточка, меню, шапка,
        // блочок в ячейке) – полоска снимается: Enter после этого не подключает (этап 40).
        // Полоса прокрутки таблицы – не в счёт; по ячейке полоску ставит onCellMouseDown
        onMarkMouseDown(event) {
            if (this.activeRowId === null || this.activeRowId === undefined) {
                return;
            }
            const target = event.target;
            if (target === this.$refs.tableWrap) {
                return;
            }
            const td = target.closest ? target.closest("td") : null;
            const table = this.$refs.table;
            if (td && table && table.contains(td) && !target.closest("button, input, textarea, select, .loc-pick")) {
                return;
            }
            this.setActiveRow(null);
        },

        // Enter в Таблице: подключение к строке с полоской, если после нажатия по ней ничего
        // другого не трогали; иначе подключения нет, полоска снимается (этап 40)
        onTableEnter(event) {
            const row = this.activeRowId === null || this.activeRowId === undefined ? null
                : this.rows.find((r) => r.id === this.activeRowId) || null;
            const target = event.target;
            const free = !event.defaultPrevented && !isTypingTarget(document.activeElement) &&
                !(target && target.closest && target.closest("button, .dropdown, .cf-menu, .scan-pop, .add-bar, .card-overlay")) &&
                !this.editingRowId && !this.cardEditKey && !this.editingHostname && !this.openMenu && !this.scanPop &&
                !this.namePop && !this.actionBar && !this.newComputer && !this.showArchive;
            if (row && free) {
                event.preventDefault();
                this.vncConnect(row, null);
                return;
            }
            if (row) {
                this.setActiveRow(null);
            }
        },

        // ПК для Alt+P / Alt+R: открытая карточка, иначе последняя нажатая строка, иначе
        // единственная выбранная
        activePc() {
            if (this.card) {
                return this.card;
            }
            let id = this.activeRowId;
            if ((id === null || id === undefined) && this.selectedRows.length === 1) {
                id = this.selectedRows[0];
            }
            return this.rows.find(function (r) { return r.id === id; }) || null;
        },

        // what: ping / rdp. Ответ – нашёлся ли ПК
        connectActive(what) {
            const row = this.activePc();
            if (!row) {
                return false;
            }
            const ip = firstIp(row.ip);
            if (!ip) {
                this.toastError("У ПК нет IP.");
                return true;
            }
            launch("itdb://" + what + "/" + ip);
            this.toast((what === "rdp" ? "RDP" : "Ping") + ": " + (row.hostname || ip) + " (" + ip + ")");
            return true;
        }
    }
};
