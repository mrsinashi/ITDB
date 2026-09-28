// Общее: ошибки запросов, полоска загрузки, сообщения и подтверждения, выгрузка.

import { apiFetch, pad2 } from "../util.js";
import { FIELD_LABELS, LOCATION_FIELD_LABELS } from "../columns.js";

export default {
    methods: {
        // ---------- Общие ----------

        async errorText(response) {
            let message = "HTTP " + response.status;
            try {
                const data = await response.json();
                if (data && data.detail) {
                    message = typeof data.detail === "string"
                        ? data.detail
                        : JSON.stringify(data.detail);
                }
            } catch (e) {
                // оставляем HTTP-статус
            }
            return message;
        },

        formatTime(value) {
            if (!value) {
                return "";
            }
            const d = new Date(value);
            if (isNaN(d.getTime())) {
                return String(value);
            }
            return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear() + " " +
                pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
        },

        formatDate(value) {
            const d = new Date(value);
            if (!value || isNaN(d.getTime())) {
                return "";
            }
            return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear();
        },

        // Время для таблицы истории: «чч:мм:сс» (дата — в строке дня)
        formatClock(value) {
            const d = new Date(value);
            if (!value || isNaN(d.getTime())) {
                return String(value || "");
            }
            return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
        },

        entityLabel(entity) {
            if (entity === "computers") {
                return "ПК";
            }
            if (entity === "locations") {
                return "Расположение";
            }
            return entity;
        },

        fieldLabel(entity, field) {
            if (entity === "locations") {
                return LOCATION_FIELD_LABELS[field] || field;
            }
            // Поля из computers.extra пишутся в историю как «extra.<ключ>»
            if (field && field.indexOf("extra.") === 0) {
                field = field.slice(6);
                const builtin = { "GSIT": "gsit", "Сост.": "state", "Метка": "label" }[field];
                if (builtin) {
                    return FIELD_LABELS[builtin];
                }
            }
            if (FIELD_LABELS[field]) {
                return FIELD_LABELS[field];
            }
            const fd = this.fieldDefs.find(function (item) { return item.key === field; });
            return fd ? fd.label : field;
        },

        // ---------- Полоска загрузки ----------

        startLoading() {
            this._loadCount = (this._loadCount || 0) + 1;
            if (this._loadCount !== 1) {
                return;
            }
            const el = this.$refs.loadBar;
            if (!el) {
                return;
            }
            clearTimeout(this._loadHideTimer);
            el.classList.remove("running", "done");
            void el.offsetWidth; // сброс, чтобы анимация началась с нуля
            el.classList.add("running");
        },

        finishLoading() {
            this._loadCount = Math.max(0, (this._loadCount || 0) - 1);
            if (this._loadCount !== 0) {
                return;
            }
            const el = this.$refs.loadBar;
            if (!el) {
                return;
            }
            el.classList.add("done");
            this._loadHideTimer = setTimeout(() => {
                if (!this._loadCount) {
                    el.classList.remove("running", "done");
                }
            }, 700);
        },

        // ---------- Сообщения и подтверждения ----------

        toast(text, type, ms) {
            const id = (this._toastSeq = (this._toastSeq || 0) + 1);
            this.toasts.push({ id: id, text: String(text), type: type || "info" });
            const delay = ms || (type === "error" ? 7000 : 3000);
            setTimeout(() => {
                this.dismissToast(id);
            }, delay);
        },

        toastError(text) {
            this.toast(text, "error");
        },

        dismissToast(id) {
            this.toasts = this.toasts.filter(function (t) { return t.id !== id; });
        },

        confirmDialog(text, options) {
            const opts = options || {};
            if (this.dialog) {
                this.dialog.resolve(false);
            }
            return new Promise((resolve) => {
                this.dialog = {
                    text: text,
                    okText: opts.okText || "OK",
                    danger: !!opts.danger,
                    resolve: resolve
                };
                this.$nextTick(() => {
                    if (this.$refs.dialogOk) {
                        this.$refs.dialogOk.focus();
                    }
                });
            });
        },

        closeDialog(result) {
            const dialog = this.dialog;
            this.dialog = null;
            if (dialog) {
                dialog.resolve(result);
            }
        },

        // Зелёная вспышка после сохранения. Повторное сохранение той же
        // ячейки во время вспышки перезапускает её с начала.
        flashCell(rowId, field) {
            const key = rowId + ":" + field;
            this._flashTimers = this._flashTimers || {};
            const drop = () => {
                const next = Object.assign({}, this.savedFlash);
                delete next[key];
                this.savedFlash = next;
            };
            const start = () => {
                this.savedFlash = Object.assign({}, this.savedFlash, { [key]: true });
                clearTimeout(this._flashTimers[key]);
                this._flashTimers[key] = setTimeout(drop, 1500);
            };
            if (this.savedFlash[key]) {
                drop();
                this.$nextTick(() => requestAnimationFrame(start));
            } else {
                start();
            }
        },

        displayValue(value) {
            if (value === null || value === undefined) {
                return "—";
            }
            if (typeof value === "boolean") {
                return value ? "да" : "нет";
            }
            if (typeof value === "object") {
                return JSON.stringify(value);
            }
            return String(value);
        },

        // withArchive — ещё лист «Архив» с ПК из архива
        async downloadExport(withArchive) {
            try {
                const response = await apiFetch("/api/export/computers.xlsx" + (withArchive ? "?archive=true" : ""));
                if (!response.ok) {
                    this.toastError("Не удалось выгрузить: " + (await this.errorText(response)));
                    return;
                }
                const blob = await response.blob();
                let filename = "itdb_computers.xlsx";
                const disposition = response.headers.get("Content-Disposition");
                if (disposition && disposition.includes("filename=")) {
                    filename = disposition.split("filename=")[1].replace(/["']/g, "");
                }
                const link = document.createElement("a");
                link.href = URL.createObjectURL(blob);
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
            } catch (e) {
                this.toastError("Не удалось выгрузить: " + e);
            }
        },
    }
};
