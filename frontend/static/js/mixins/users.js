// Пользователи системы (страница только у администратора) и смена своего
// пароля (меню пользователя справа вверху — у любой роли).
//
// Новый пользователь и «Изменить» (роль, новый пароль) — строкой под панелью,
// как «Новый компьютер». Отключение — архив: удаления нет. Свою роль и
// отключение себя сервер не даёт (в системе всегда есть администратор).

import { ROLE_LABELS } from "../settings.js";
import { apiFetch } from "../util.js";

// Буквы и цифры без похожих друг на друга (l/1, O/0) — пароль диктуют голосом
const PASSWORD_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

export default {
    watch: {
        // Форма своего пароля живёт, пока открыто меню пользователя
        openMenu(name) {
            if (name !== "user") {
                this.ownPassword = null;
            }
        },
    },

    computed: {
        isAdmin() {
            return !!this.user && this.user.role === "admin";
        },

        roleOptions() {
            return Object.keys(ROLE_LABELS).map(function (key) {
                return { key: key, label: ROLE_LABELS[key] };
            });
        },

        usersCountText() {
            const off = this.users.filter(function (u) { return u.archived; }).length;
            const text = "Пользователей: " + (this.users.length - off);
            return off ? text + ", отключено: " + off : text;
        },
    },

    methods: {
        roleName(role) {
            return ROLE_LABELS[role] || role;
        },

        async loadUsers() {
            this.usersLoading = true;
            this.usersError = "";
            this.startLoading();
            try {
                const response = await apiFetch("/api/users");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.users = await response.json();
            } catch (e) {
                this.usersError = "Не удалось загрузить пользователей: " + (e.message || e);
            } finally {
                this.usersLoading = false;
                this.finishLoading();
            }
        },

        // Пароль на выбор: 8 знаков, их потом можно поправить руками
        makePassword() {
            const bytes = new Uint32Array(8);
            window.crypto.getRandomValues(bytes);
            return Array.from(bytes, function (n) { return PASSWORD_CHARS[n % PASSWORD_CHARS.length]; }).join("");
        },

        // Придуманный пароль — в оба поля (они скрыты) и в буфер обмена: его можно
        // вставить в письмо пользователю или посмотреть глазом рядом с полями
        fillPassword() {
            if (this.userBar) {
                const password = this.makePassword();
                this.userBar.password = password;
                this.userBar.repeat = password;
                this.userBar.error = "";
                this.copyText(password, "Пароль придуман и скопирован в буфер обмена");
                // Фокус — в поле пароля: Enter сохраняет, а не придумывает заново
                this.$nextTick(() => this.focusRef("ub-password"));
            }
        },

        // ---------- Строка под панелью: новый / изменить ----------

        openNewUser() {
            if (this.userBar && this.userBar.kind === "new") {
                this.closeUserBar();
                return;
            }
            this.userBar = { kind: "new", login: "", role: "reader", password: "", repeat: "", show: false, error: "", saving: false };
            this.$nextTick(() => this.focusRef("ub-login"));
        },

        openEditUser(u) {
            this.usersHover = null;
            this.userBar = { kind: "edit", id: u.id, login: u.login, self: u.is_self, role: u.role, password: "", repeat: "", show: false, error: "", saving: false };
            this.$nextTick(() => this.focusRef(u.is_self ? "ub-password" : "ub-role"));
        },

        closeUserBar() {
            this.userBar = null;
        },

        focusRef(name) {
            const el = this.$refs[name];
            if (el) {
                el.focus();
            }
        },

        async submitUserBar() {
            const bar = this.userBar;
            if (!bar || bar.saving) {
                return;
            }
            // Повтор пароля: у нового — всегда, при изменении — если пароль задают
            if ((bar.password || bar.repeat) && bar.password !== bar.repeat) {
                bar.error = bar.repeat ? "Пароль и повтор не совпадают." : "Повтори пароль во втором поле.";
                this.$nextTick(() => this.focusRef(bar.repeat ? "ub-password" : "ub-repeat"));
                return;
            }
            let url = "/api/users";
            let method = "POST";
            let body;
            if (bar.kind === "new") {
                body = { login: bar.login, role: bar.role, password: bar.password };
            } else {
                const was = this.users.find(function (u) { return u.id === bar.id; });
                url += "/" + bar.id;
                method = "PATCH";
                body = {};
                if (was && bar.role !== was.role) {
                    body.role = bar.role;
                }
                if (bar.password) {
                    body.password = bar.password;
                }
                if (!Object.keys(body).length) {
                    this.closeUserBar();
                    return;
                }
            }
            bar.saving = true;
            bar.error = "";
            try {
                const response = await apiFetch(url, {
                    method: method,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const saved = await response.json();
                await this.loadUsers();
                if (bar.kind === "new") {
                    // Строка остаётся открытой — можно завести следующего
                    this.toast("Добавлен пользователь: " + saved.login, "success");
                    this.userBar = { kind: "new", login: "", role: bar.role, password: "", repeat: "", show: bar.show, error: "", saving: false };
                    this.$nextTick(() => this.focusRef("ub-login"));
                } else {
                    const parts = [];
                    if (body.role) {
                        parts.push("роль — " + this.roleName(body.role).toLowerCase());
                    }
                    if (body.password) {
                        parts.push("пароль изменён");
                    }
                    this.toast(saved.login + ": " + parts.join(", "), "success");
                    this.closeUserBar();
                }
            } catch (e) {
                bar.error = e.message || String(e);
            } finally {
                bar.saving = false;
            }
        },

        async setUserArchived(u, archived) {
            this.usersHover = null;
            try {
                const response = await apiFetch("/api/users/" + u.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ archived: archived })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                if (this.userBar && this.userBar.id === u.id) {
                    this.closeUserBar();
                }
                await this.loadUsers();
                this.toast((archived ? "Отключён: " : "Включён: ") + u.login, "success");
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        // Плашка действий справа от таблицы, у строки под курсором (как в Дереве)
        setUsersHover(u, rowEl) {
            const wrap = rowEl.closest(".users-wrap");
            if (!wrap) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const r = rowEl.getBoundingClientRect();
            this.usersHover = { id: u.id, user: u, top: r.top - w.top, height: r.height };
        },

        // ---------- Свой пароль (меню пользователя) ----------

        openOwnPassword() {
            this.ownPassword = { current: "", next: "", repeat: "", error: "", saving: false };
            this.$nextTick(() => this.focusRef("op-current"));
        },

        async submitOwnPassword() {
            const f = this.ownPassword;
            if (!f || f.saving) {
                return;
            }
            if (!f.current || !f.next) {
                f.error = "Заполни текущий и новый пароль.";
                return;
            }
            if (f.next !== f.repeat) {
                f.error = "Новый пароль и повтор не совпадают.";
                return;
            }
            f.saving = true;
            f.error = "";
            try {
                const response = await apiFetch("/api/auth/me/password", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ current: f.current, new: f.next })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                this.ownPassword = null;
                this.closeMenus();
                this.toast("Пароль изменён. Входы на других компьютерах завершены.", "success");
            } catch (e) {
                f.error = e.message || String(e);
            } finally {
                f.saving = false;
            }
        },
    }
};
