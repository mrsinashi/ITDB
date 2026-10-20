// Вход, выход, личные настройки (цветовая схема, акценты).

import { ROLE_LABELS, THEMES, applyNoRadius, applyTheme } from "../settings.js";
import { apiFetch, shortName } from "../util.js";

// Уровни доступа к странице по возрастанию (как LEVELS в auth.py)
export const PAGE_LEVELS = ["none", "view", "edit"];

export default {
    computed: {
        // Права по страницам (этап 69): user.perms – страница → none / view / edit (роль и
        // свои ограничения пользователя, считает сервер). Страница – как адрес (#scan/check)
        viewPage() {
            if (this.view === "scan") {
                return "scan/" + this.scanTab;
            }
            if (this.view === "journals") {
                return "journals/" + this.journalTab;
            }
            if (this.view === "choices") {
                return "choices/" + this.choicesTab;
            }
            return this.view;
        },

        // Правка на открытой странице (вкладке); карточки ПК и принтера – canEditPc / canEditPrinters
        canEdit() {
            return this.canPage(this.viewPage, "edit");
        },

        canEditPc() {
            return this.canPage("table", "edit");
        },

        canEditPrinters() {
            return this.canPage("printers", "edit");
        },

        // Хоть где-то правка: Ctrl+Z / Ctrl+Y
        canEditAny() {
            const perms = (this.user && this.user.perms) || {};
            return Object.keys(perms).some(function (page) { return perms[page] === "edit"; });
        },

        themes() {
            return THEMES;
        },

        userInitial() {
            return this.user && this.user.login ? this.user.login.charAt(0).toUpperCase() : "?";
        },

        // На панели – «Фамилия И.О.» (без ФИО – логин), в подсказке – полностью
        navUserName() {
            return this.user ? shortName(this.user.full_name, this.user.login) : "";
        },

        navUserTitle() {
            const u = this.user;
            if (!u) {
                return null;
            }
            return [u.full_name, u.position, "логин: " + u.login].filter(Boolean).join("\n");
        },

        roleLabel() {
            return this.user ? (ROLE_LABELS[this.user.role] || this.user.role) : "";
        },

        // «Акцентные шапки» в «Настройках» (этап 64; раньше – шестерёнка на каждой странице):
        // страницы, которые пользователь видит, в порядке меню
        accentHeaderPages() {
            return [
                { key: "tree", label: "Структура" },
                { key: "vacuum", label: "Vacuum" },
                { key: "scan", label: "Сканер" },
                { key: "choices", label: "Справочники" },
                { key: "history", label: "История" },
                { key: "users", label: "Пользователи" }
            ].filter((p) => this.canOpenView(p.key));
        },
    },

    watch: {
        accentBorders: {
            handler(on) {
                document.body.classList.toggle("accent-borders", on);
            },
            immediate: true
        },
    },

    methods: {
        // canPage("scan/net") – можно открыть; canPage("table", "edit") – можно править
        canPage(page, level) {
            const perms = (this.user && this.user.perms) || {};
            const have = PAGE_LEVELS.indexOf(perms[page] || "none");
            return have > 0 && have >= PAGE_LEVELS.indexOf(level || "view");
        },

        // Строка ПК или принтера (в таблице и карточке): правка – по своей странице
        canEditRow(row) {
            return row && row._printer ? this.canEditPrinters : this.canEditPc;
        },

        // ---------- Авторизация ----------

        // Без входа apiFetch сам уводит на страницу входа; ошибка здесь – сервер не ответил
        // (перезапуск при обновлении, сбой базы): на странице – «Сервер не отвечает»
        async checkAuth() {
            try {
                const response = await apiFetch("/api/auth/me");
                if (!response.ok) {
                    throw new Error("HTTP " + response.status);
                }
                this.user = await response.json();
                // Схема – личная: у пользователя без настройки – красная,
                // даже если в этом браузере до него работал другой
                const prefs = (this.user && this.user.prefs) || {};
                // Пометка копии (DEV) – и во вкладке браузера
                if (this.user && this.user.label) {
                    document.title = "ITDB · " + this.user.label;
                }
                this.theme = applyTheme(prefs.theme || "red");
                this.accentBorders = !!prefs.accent_borders;
                this.noRadius = applyNoRadius(!!prefs.no_radius);
                this.buttonCounts = prefs.button_counts !== false;
                this.accentHeaders = Object.assign({ tree: true, history: true, choices: true, users: true, scan: true, vacuum: true }, prefs.accent_headers || {});
            } catch (e) {
                this.user = null;
            }
        },

        reloadPage() {
            window.location.reload();
        },

        // Ширина кнопки пользователя – целое число пикселей экрана.
        // Иначе при масштабе Windows 125–150% край шестерёнки и её меню
        // сглаживаются по-разному и меню кажется на 1px уже кнопки.
        snapNavUser() {
            const el = this.$refs.navUser;
            if (!el) {
                return;
            }
            el.style.minWidth = "";
            const dpr = window.devicePixelRatio || 1;
            const w = el.getBoundingClientRect().width;
            el.style.minWidth = (Math.ceil(w * dpr - 0.01) / dpr) + "px";
        },

        async savePrefs(patch) {
            try {
                await this.apiSend("/api/auth/me/prefs", "PATCH", patch);
                return true;
            } catch (e) {
                this.toastError("Не удалось сохранить настройку: " + (e.message || e));
                return false;
            }
        },

        async setTheme(key) {
            const previous = this.theme;
            this.theme = applyTheme(key);
            if (!(await this.savePrefs({ theme: key }))) {
                this.theme = applyTheme(previous);
            }
        },

        async toggleAccentBorders() {
            this.accentBorders = !this.accentBorders;
            if (!(await this.savePrefs({ accent_borders: this.accentBorders }))) {
                this.accentBorders = !this.accentBorders;
            }
        },

        // Простая личная настройка-галочка: «Закругления», «Счётчики на кнопках»
        async togglePref(name, key) {
            const apply = () => {
                if (name === "noRadius") {
                    applyNoRadius(this.noRadius);
                }
            };
            this[name] = !this[name];
            apply();
            if (!(await this.savePrefs({ [key]: this[name] }))) {
                this[name] = !this[name];
                apply();
            }
        },

        async toggleAccentHeader(page) {
            const on = !this.accentHeaders[page];
            this.accentHeaders = Object.assign({}, this.accentHeaders, { [page]: on });
            if (!(await this.savePrefs({ accent_headers: { [page]: on } }))) {
                this.accentHeaders = Object.assign({}, this.accentHeaders, { [page]: !on });
            }
        },

        setView(view) {
            // Страница закрыта правами (этап 69): ссылки из других страниц («Принтеры модели»,
            // «Показать в таблице») туда не ведут
            if (!this.canOpenView(view)) {
                this.toast("Нет доступа к этой странице");
                return;
            }
            // Другая страница – показанные логин и пароль прячутся (этап 45)
            this.closeWebEdit();
            this.hideWebShown();
            this.closeLinkPick();
            this.closePop("permsPop");
            // Таблица показывает ПК, принтеры или журнал (этапы 44, 66): её настройки – меняются местами
            this.switchTableKind(view === "printers" ? "printer" : (view === "journals" ? "moves" : "pc"));
            this.view = view;
            this.scanPop = null;
            if (view === "table") {
                this.loadDiffs();
            } else if (view === "journals") {
                this.openJournals();
            } else if (view === "printers") {
                this.loadPrinters();
                this.loadPrinterModels();
                this.loadPrinterDiffs();
                this.loadCartridges();
            } else if (view === "tree") {
                this.loadTree();
            } else if (view === "history") {
                this.loadHistory();
            } else if (view === "choices") {
                // Вкладка, на которую нет прав (этап 69), – первая доступная
                if (!this.canPage("choices/" + this.choicesTab)) {
                    this.choicesTab = this.firstTab("choices") || "styles";
                }
                this.loadChoices();
                this.loadColumnStyles();
                this.loadFieldDefs();
                this.loadAvSettings();
                this.loadTableMarks();
                this.loadAppSettings();
                if (this.choicesTab === "names") {
                    this.ensureTree();
                    this.loadNameKeep();
                } else if (this.choicesTab === "models") {
                    this.loadPrinterModels();
                }
            } else if (view === "users") {
                this.loadUsers();
            } else if (view === "vacuum") {
                this.loadVacuum();
                if (this.isAdmin && !this.scanSources.length) {
                    this.loadScanSources();     // «обновить» запускает сбор из Jabber
                }
            } else if (view === "scan") {
                // «Сканер» всегда открывается на первой вкладке слева – «GLPI / GSIT» (этап 28);
                // нет прав на неё (этап 69) – на первой доступной
                this.scanMatchQuery = "";
                if (this.isAdmin) {
                    this.loadScan();
                }
                this.setScanTab(this.firstTab("scan") || "check");
            }
            this.syncHash();
        },

        async logout() {
            try {
                await apiFetch("/api/auth/logout", { method: "POST" });
            } catch (e) {
                // сессия уже могла истечь
            }
            window.location.replace("/login.html");
        },
    }
};
