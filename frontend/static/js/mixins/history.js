// Страница «История».

import { apiFetch, matchesAllWords, searchWords, splitMulti } from "../util.js";
import { OVERDUE_STYLE, isOverdue, refreshDuplicates, styleKey } from "../columns.js";

// Сколько записей истории загружать сразу и по «Показать ещё»
const HISTORY_PAGE = 200;

export default {
    computed: {
        filteredHistory() {
            const words = searchWords(this.historyQuery);
            if (!words.length) {
                return this.historyItems;
            }
            return this.historyItems.filter((item) => {
                const parts = [
                    item.title,
                    item.user_name,
                    this.entityLabel(item.entity),
                    this.formatTime(item.at)
                ];
                Object.keys(item.changes || {}).forEach((field) => {
                    const ch = item.changes[field] || {};
                    parts.push(field, this.fieldLabel(item.entity, field), this.displayValue(ch.old), this.displayValue(ch.new));
                });
                const text = parts.filter(function (p) { return p !== null && p !== undefined; }).join("\n");
                return matchesAllWords(text, words);
            });
        },

        // Записи истории, разбитые по дням (порядок — как пришёл с сервера)
        historyDays() {
            const days = [];
            let current = null;
            this.filteredHistory.forEach((item) => {
                const date = this.formatDate(item.at);
                if (!current || current.date !== date) {
                    current = { key: date + ":" + item.id, date: date, items: [] };
                    days.push(current);
                }
                current.items.push(item);
            });
            return days;
        },

        historyCountText() {
            const total = this.historyTotal;
            if (!this.historyQuery.trim()) {
                return (this.historyFiltered ? "Найдено: " : "Записей: ") + total;
            }
            return "Показано: " + this.filteredHistory.length + " из " + total;
        },

        // Сколько записей ещё не загружено (кнопки «Показать ещё» внизу)
        historyRest() {
            return Math.max(0, this.historyTotal - this.historyItems.length);
        },
    },

    watch: {
        // Другой набор дней (поиск, обновление) — пересчитать выталкивание
        historyDays() {
            this.$nextTick(() => {
                this.pushHistoryDays();
            });
        },

        // Поиск идёт по всей истории — догрузить остальное
        historyQuery(value) {
            if (value.trim() && this.historyRest > 0) {
                this.loadMoreHistory(true);
            }
        },
    },

    methods: {
        // ---------- История: строки дней ----------
        // Липкая строка дня прилипает под шапкой, но у ячеек таблицы границей
        // прилипания служит вся таблица, а не день (tbody) — строки дней
        // наезжали друг на друга. Поэтому следующий день выталкивает
        // прилипшую строку вверх вручную, как адреса в Дереве.
        onHistoryScroll() {
            if (this._dayRaf) {
                return;
            }
            this._dayRaf = requestAnimationFrame(() => {
                this._dayRaf = null;
                this.pushHistoryDays();
            });
        },

        // Число записей за день: без поиска — точное с сервера (день мог
        // загрузиться не целиком), с поиском — сколько найдено
        historyDayCount(day) {
            if (this.historyQuery.trim()) {
                return day.items.length;
            }
            const count = this.historyDayCounts[day.date];
            return count === undefined ? day.items.length : count;
        },

        pushHistoryDays() {
            const sc = this.$refs.historyScroll;
            const table = sc ? sc.querySelector(".history-table") : null;
            if (!table || !table.tHead) {
                return;
            }
            const headH = table.tHead.offsetHeight;
            const limit = sc.getBoundingClientRect().top + headH;
            Array.prototype.forEach.call(table.tBodies, function (tbody) {
                const dayCell = tbody.rows[0] && tbody.rows[0].classList.contains("h-day") && tbody.rows[0].cells[0];
                const last = tbody.rows[tbody.rows.length - 1];
                if (!dayCell || !last) {
                    return;
                }
                const push = last.getBoundingClientRect().bottom - dayCell.offsetHeight - limit;
                const top = push < 0 ? (headH + push) + "px" : "";
                if (dayCell.style.top !== top) {
                    dayCell.style.top = top;
                }
            });
        },

        closeCard() {
            this.card = null;
            this.setHoverRow(null);
        },

        openCardById(id) {
            const row = this.rows.find(function (r) { return r.id === id; });
            if (row) {
                this.openCard(row);
            } else {
                this.toast("Этого ПК нет в таблице");
            }
        },

        toggleCardHistory() {
            this.cardHistoryOpen = !this.cardHistoryOpen;
        },

        // Оформление значения в карточке — как в таблице: значение из
        // Справочников поверх оформления столбца. line — строка значения
        // (у многострочных — каждая своя); без line — первая оформленная.
        cardValueStyle(r, line) {
            if (!r.field) {
                return null;
            }
            const fieldStyles = this.choiceStyleMap[r.field] || {};
            let choice = null;
            const lines = line === undefined ? String(r.value).split("\n") : [line];
            for (const l of lines) {
                const s = fieldStyles[styleKey(r.field, l)];
                if (s) {
                    choice = s;
                    break;
                }
            }
            let st = this.effectiveStyle(r.field, choice);
            if (r.date && isOverdue(r.value)) {
                st = Object.assign({}, st, OVERDUE_STYLE);
            }
            return st.color || st.backgroundColor || st.fontWeight || st.fontStyle ? st : null;
        },

        splitLines(value) {
            return splitMulti(value);
        },

        // Копирование в буфер. navigator.clipboard работает только по https
        // или на localhost, поэтому есть запасной путь через execCommand.
        async copyText(text) {
            text = String(text);
            let ok = false;
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(text);
                    ok = true;
                }
            } catch (e) {
                ok = false;
            }
            if (!ok) {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.setAttribute("readonly", "");
                ta.style.position = "fixed";
                ta.style.top = "-1000px";
                document.body.appendChild(ta);
                ta.select();
                try {
                    ok = document.execCommand("copy");
                } catch (e) {
                    ok = false;
                }
                ta.remove();
            }
            if (ok) {
                this.toast("Скопировано: " + text, "success", 1800);
            } else {
                this.toastError("Не удалось скопировать");
            }
        },

        startEditHostname() {
            this.editingHostname = true;
            this.$nextTick(() => {
                const input = this.$refs.hostnameInput;
                if (input) {
                    input.focus();
                    const length = input.value.length;
                    input.setSelectionRange(length, length);
                }
            });
        },

        cancelEditHostname() {
            this.cardHostname = this.card ? (this.card.hostname || "") : "";
            this.editingHostname = false;
        },

        async saveHostname() {
            if (!this.card || !this.editingHostname) {
                return;
            }
            const newValue = this.cardHostname.trim();
            const id = this.card.id;
            if (newValue === (this.card.hostname || "")) {
                this.editingHostname = false;
                return;
            }
            this.editingHostname = false;
            try {
                const response = await apiFetch("/api/computers/" + id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        hostname: newValue === "" ? null : newValue,
                        _version: this.card.version
                    })
                });
                if (response.status === 409) {
                    this.toastError(await this.errorText(response));
                    this.closeCard();
                    await this.loadTable();
                    return;
                }
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const result = await response.json();
                const updated = result.updated || {};
                const index = this.rows.findIndex(function (row) {
                    return row.id === id;
                });
                if (index >= 0) {
                    const updatedRow = Object.assign({}, this.rows[index], updated);
                    this.rows[index] = updatedRow;
                    refreshDuplicates(this.rows, this.builtinColumns);
                this.dupVersion++;
                    this.recalcWidths();
                    this.card = updatedRow;
                    this.toast("Имя сохранено", "success");
                }
                this.reloadCardHistory(id);
            } catch (e) {
                this.editingHostname = true;
                this.toastError("Не удалось сохранить: " + (e.message || e));
            }
        },

        // ---------- История ----------

        // Порция истории с сервера: записи + точные счётчики (всего и по дням)
        async fetchHistory(offset, limit) {
            const params = this.historyParams();
            params.set("limit", limit);
            params.set("offset", offset);
            params.set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
            const response = await apiFetch("/api/history?" + params);
            if (!response.ok) {
                throw new Error(await this.errorText(response));
            }
            const data = await response.json();
            this.historyTotal = data.total || 0;
            this.historyDayCounts = data.days || {};
            this.historyUsers = data.users || [];
            return data.items || [];
        },

        // Сначала — последние 200 записей, остальное — «Показать ещё / все»
        async loadHistory() {
            this.historyLoading = true;
            this.startLoading();
            this.historyError = "";
            try {
                this.historyItems = await this.fetchHistory(0, HISTORY_PAGE);
                if (this.historyQuery.trim() && this.historyRest > 0) {
                    this.loadMoreHistory(true);
                }
            } catch (e) {
                this.historyError = String(e.message || e);
            }
            this.finishLoading();
            this.historyLoading = false;
        },

        async loadMoreHistory(all) {
            if (this.historyLoadingMore) {
                return;
            }
            this.historyLoadingMore = true;
            this.startLoading();
            try {
                do {
                    const limit = all ? 5000 : HISTORY_PAGE;
                    const items = await this.fetchHistory(this.historyItems.length, limit);
                    // Пока листали, могли добавиться новые записи — без повторов
                    const seen = new Set(this.historyItems.map(function (item) { return item.id; }));
                    const fresh = items.filter(function (item) { return !seen.has(item.id); });
                    this.historyItems = this.historyItems.concat(fresh);
                    if (!items.length) {
                        break;
                    }
                } while (all && this.historyRest > 0);
            } catch (e) {
                this.toastError("Не удалось загрузить историю: " + (e.message || e));
            }
            this.finishLoading();
            this.historyLoadingMore = false;
        },
    }
};
