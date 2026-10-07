// Подключение к ПК по VNC через внешнее приложение (этап 28б): ссылки
// itdb://vnc/tight/IP и itdb://vnc/ultra/IP. Обработчик протокола itdb:// — отдельное
// приложение на компьютере пользователя. Двойной клик по значению TightVNC / UltraVNC
// (Таблица, карточка ПК, подробности «Проверки») — подключение этим VNC; Enter —
// тем, что записан у ПК, а если не записан — тем, что выбран по умолчанию в
// Справочниках (блок «Тип VNC»).
// Enter, Alt+P (itdb://ping/IP) и Alt+R (itdb://rdp/IP) работают с последним ПК, по
// строке которого нажали мышью (выделять строку не нужно); открыта карточка — с её ПК.
// Строка отмечена полоской слева (класс row-active ставится прямо в DOM: данные Vue
// не меняются — таблица на каждый клик не перерисовывается).

import { apiFetch } from "../util.js";

export const VNC_KINDS = [
    { key: "tight", label: "TightVNC" },
    { key: "ultra", label: "UltraVNC" }
];

// «TightVNC» → tight, «UltraVNC 1.4» → ultra; другое — null
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
// протоколе показал бы вместо программы страницу ошибки — там ссылка открывается в
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

    updated() {
        if (this.view === "table") {
            this.markActiveRow();
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
                // без настроек — значения по умолчанию
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

        // Каким VNC подключаться к ПК: записанным в таблице, иначе — по умолчанию
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

        // Подключиться к ПК: kind — tight / ultra (нет — как у ПК или по умолчанию)
        vncConnect(row, kind) {
            const ip = firstIp(row && row.ip);
            if (!ip) {
                this.toastError("У ПК нет IP — подключиться некуда.");
                return;
            }
            const use = kind || this.vncKindOfRow(row);
            launch("itdb://vnc/" + use + "/" + ip);
            this.toast(this.vncLabel(use) + ": " + (row.hostname || ip) + " (" + ip + ")");
        },

        // Двойной клик по значению в ячейке Таблицы: TightVNC / UltraVNC — подключение,
        // остальное — как обычно (правка ячейки)
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

        // То же в карточке ПК (строка «Тип VNC»); line — строка значения
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

        // Запомнить строку, по которой нажали (Enter, Alt+P, Alt+R — к этому ПК)
        setActiveRow(row) {
            this.activeRowId = row ? row.id : null;
            this.markActiveRow();
        },

        // Полоска у запомненной строки; Vue мог сбросить класс, перерисовав строку
        markActiveRow() {
            const table = this.$refs.table;
            const id = this.activeRowId;
            let el = this.activeRowEl;
            if (el && (!el.isConnected || el.dataset.id !== String(id))) {
                el.classList.remove("row-active");
                el = null;
            }
            if (!el && table && id !== null && id !== undefined) {
                el = table.querySelector('tbody tr[data-id="' + id + '"]');
            }
            if (el && !el.classList.contains("row-active")) {
                el.classList.add("row-active");
            }
            this.activeRowEl = el || null;
        },

        // ПК для Enter / Alt+P / Alt+R: открытая карточка, иначе последняя нажатая
        // строка, иначе единственная выбранная
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

        // what: vnc / ping / rdp. Ответ — нашёлся ли ПК
        connectActive(what) {
            const row = this.activePc();
            if (!row) {
                return false;
            }
            if (what === "vnc") {
                this.vncConnect(row, null);
                return true;
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
