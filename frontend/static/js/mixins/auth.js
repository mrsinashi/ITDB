// Вход, выход, личные настройки (цветовая схема, акценты).

import { ROLE_LABELS, THEMES, applyTheme } from "../settings.js";
import { apiFetch } from "../util.js";

export default {
    computed: {
        // reader — только просмотр; правка у admin и editor
        canEdit() {
            return !!this.user && (this.user.role === "admin" || this.user.role === "editor");
        },

        themes() {
            return THEMES;
        },

        userInitial() {
            return this.user && this.user.login ? this.user.login.charAt(0).toUpperCase() : "?";
        },

        roleLabel() {
            return this.user ? (ROLE_LABELS[this.user.role] || this.user.role) : "";
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
        // ---------- Авторизация ----------

        async checkAuth() {
            try {
                const response = await apiFetch("/api/auth/me");
                this.user = await response.json();
                // Схема — личная: у пользователя без настройки — красная,
                // даже если в этом браузере до него работал другой
                const prefs = (this.user && this.user.prefs) || {};
                this.theme = applyTheme(prefs.theme || "red");
                this.accentBorders = !!prefs.accent_borders;
                this.accentHeaders = Object.assign({ tree: true, history: true, choices: true, users: true }, prefs.accent_headers || {});
            } catch (e) {
                this.user = null;
            }
        },

        // Ширина кнопки пользователя — целое число пикселей экрана.
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
                const response = await apiFetch("/api/auth/me/prefs", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
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

        async toggleAccentHeader(page) {
            const on = !this.accentHeaders[page];
            this.accentHeaders = Object.assign({}, this.accentHeaders, { [page]: on });
            if (!(await this.savePrefs({ accent_headers: { [page]: on } }))) {
                this.accentHeaders = Object.assign({}, this.accentHeaders, { [page]: !on });
            }
        },

        setView(view) {
            this.view = view;
            if (view === "tree") {
                this.loadTree();
            } else if (view === "history") {
                this.loadHistory();
            } else if (view === "choices") {
                this.loadChoices();
                this.loadColumnStyles();
                this.loadFieldDefs();
            } else if (view === "users") {
                this.loadUsers();
            }
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
