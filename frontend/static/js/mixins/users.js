// Пользователи системы (страница только у администратора) и смена своего
// пароля (меню пользователя справа вверху – у любой роли).
//
// Новый пользователь и «Изменить» (логин, ФИО, должность, роль, новый пароль) –
// строкой прямо в таблице (этап 26д): поля – под своими столбцами, пароль и повтор –
// ниже, под «Логином»; ✓ ✕ – плашкой справа у строки. Отключение – архив: удаления нет.
// Свою роль и отключение себя сервер не даёт (в системе всегда есть
// администратор). Свои логин, ФИО и должность любой меняет в меню пользователя.

import { ROLE_LABELS } from "../settings.js";
import { apiFetch } from "../util.js";

// Буквы и цифры без похожих друг на друга (l/1, O/0) – пароль диктуют голосом
const PASSWORD_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

export default {
    watch: {
        // Форма своего пароля живёт, пока открыто меню пользователя
        openMenu(name) {
            if (name !== "user") {
                this.ownPassword = null;
                this.ownProfile = null;
                this.ownMenu = false;
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

        // Строки таблицы: пользователи, правка – на месте строки, новый – последней строкой
        usersView() {
            const bar = this.userBar;
            const rows = this.users.map(function (u) {
                return { key: "u" + u.id, user: u, edit: !!bar && bar.kind === "edit" && bar.id === u.id };
            });
            if (bar && bar.kind === "new") {
                rows.push({ key: "new", user: null, edit: true });
            }
            return rows;
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
                this.placeEditPlate("userBar");
            }
        },

        // Пароль на выбор: 8 знаков, их потом можно поправить руками
        makePassword() {
            const bytes = new Uint32Array(8);
            window.crypto.getRandomValues(bytes);
            return Array.from(bytes, function (n) { return PASSWORD_CHARS[n % PASSWORD_CHARS.length]; }).join("");
        },

        // Придуманный пароль – в оба поля (они скрыты) и в буфер обмена: его можно
        // вставить в письмо пользователю или посмотреть глазом рядом с полями
        fillPassword() {
            if (this.userBar) {
                const password = this.makePassword();
                this.userBar.password = password;
                this.userBar.repeat = password;
                this.userBar.error = "";
                this.copyText(password, "Пароль придуман и скопирован в буфер обмена");
                // Фокус – в поле пароля: Enter сохраняет, а не придумывает заново
                this.$nextTick(() => this.focusRef("ub-password"));
            }
        },

        // ---------- Строка в таблице: новый / изменить ----------

        openNewUser() {
            if (this.userBar && this.userBar.kind === "new") {
                this.closeUserBar();
                return;
            }
            this.userBar = this.emptyUserBar("reader", false);
            this.showEditRow("userBar", "ub-login");
        },

        emptyUserBar(role, show) {
            return { kind: "new", login: "", full_name: "", position: "", role: role, password: "", repeat: "", show: show, error: "", saving: false, plate: null };
        },

        openEditUser(u) {
            this.usersHover = null;
            this.userBar = {
                kind: "edit", id: u.id, was: u.login, login: u.login, full_name: u.full_name || "", position: u.position || "",
                self: u.is_self, role: u.role, password: "", repeat: "", show: false, error: "", saving: false, plate: null
            };
            this.showEditRow("userBar", "ub-fio");
        },

        closeUserBar() {
            this.userBar = null;
        },

        focusRef(name) {
            // В строке таблицы (v-for) ссылка – список элементов
            const ref = this.$refs[name];
            const el = Array.isArray(ref) ? ref[0] : ref;
            if (el) {
                el.focus();
            }
        },

        // Строка добавления / правки в таблице (пользователи, подсети): показать её,
        // поставить плашку ✓ ✕ рядом и фокус – в нужное поле
        showEditRow(name, focus) {
            this.$nextTick(() => {
                const tr = document.querySelector(".users-wrap tr.er-row");
                if (tr) {
                    tr.scrollIntoView({ block: "nearest" });
                }
                this.placeEditPlate(name);
                if (focus) {
                    this.focusRef(focus);
                }
            });
        },

        // Плашка ✓ ✕ – у первой строки правки, снаружи рамки; ушла строка из вида – нет плашки
        placeEditPlate(name) {
            const bar = this[name];
            if (!bar) {
                return;
            }
            this.$nextTick(() => {
                if (this[name] !== bar) {
                    return;
                }
                const tr = document.querySelector(".users-wrap tr.er-row");
                const wrap = tr && tr.closest(".users-wrap");
                const scroll = tr && tr.closest(".history-scroll");
                if (!tr || !wrap || !scroll) {
                    bar.plate = null;
                    return;
                }
                const w = wrap.getBoundingClientRect();
                const s = scroll.getBoundingClientRect();
                const head = scroll.querySelector("thead");
                const r = tr.getBoundingClientRect();
                const visible = r.top >= s.top + (head ? head.offsetHeight : 0) - 1 && r.bottom <= s.bottom + 1;
                const top = Math.round(r.top - w.top);
                const height = Math.round(r.height);
                if (!visible) {
                    bar.plate = null;
                } else if (!bar.plate || bar.plate.top !== top || bar.plate.height !== height) {
                    bar.plate = { top: top, height: height };
                }
            });
        },

        async submitUserBar() {
            const bar = this.userBar;
            if (!bar || bar.saving) {
                return;
            }
            // Повтор пароля: у нового – всегда, при изменении – если пароль задают
            if ((bar.password || bar.repeat) && bar.password !== bar.repeat) {
                bar.error = bar.repeat ? "Пароль и повтор не совпадают." : "Повтори пароль во втором поле.";
                this.$nextTick(() => this.focusRef(bar.repeat ? "ub-password" : "ub-repeat"));
                return;
            }
            let url = "/api/users";
            let method = "POST";
            let body;
            if (bar.kind === "new") {
                body = { login: bar.login, full_name: bar.full_name, position: bar.position, role: bar.role, password: bar.password };
            } else {
                const was = this.users.find(function (u) { return u.id === bar.id; });
                url += "/" + bar.id;
                method = "PATCH";
                body = {};
                if (was && bar.role !== was.role) {
                    body.role = bar.role;
                }
                // Только то, что поменяли (пробелы по краям не в счёт)
                if (was) {
                    ["login", "full_name", "position"].forEach(function (name) {
                        if ((bar[name] || "").trim() !== (was[name] || "")) {
                            body[name] = bar[name];
                        }
                    });
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
                    // Строка остаётся открытой – можно завести следующего
                    this.toast("Добавлен пользователь: " + saved.login, "success");
                    this.userBar = this.emptyUserBar(bar.role, bar.show);
                    this.showEditRow("userBar", "ub-login");
                } else {
                    const parts = [];
                    if (body.login || body.full_name !== undefined || body.position !== undefined) {
                        parts.push("данные изменены");
                    }
                    if (body.role) {
                        parts.push("роль – " + this.roleName(body.role).toLowerCase());
                    }
                    if (body.password) {
                        parts.push("пароль изменён");
                    }
                    this.toast(saved.login + ": " + parts.join(", "), "success");
                    // Себя – сразу и на панели
                    if (bar.self && this.user) {
                        Object.assign(this.user, { login: saved.login, full_name: saved.full_name, position: saved.position });
                        this.$nextTick(() => this.snapNavUser());
                    }
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
            this.ownMenu = false;
            this.ownProfile = null;
            this.ownPassword = { current: "", next: "", repeat: "", error: "", saving: false };
            this.$nextTick(() => this.focusRef("op-current"));
        },

        // «Редактировать» в меню пользователя: свои логин, ФИО, должность
        openOwnProfile() {
            this.ownMenu = false;
            this.ownPassword = null;
            const u = this.user;
            this.ownProfile = { login: u.login, full_name: u.full_name || "", position: u.position || "", error: "", saving: false };
            this.$nextTick(() => this.focusRef("pf-login"));
        },

        async submitOwnProfile() {
            const f = this.ownProfile;
            if (!f || f.saving) {
                return;
            }
            f.saving = true;
            f.error = "";
            try {
                const response = await apiFetch("/api/auth/me/profile", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ login: f.login, full_name: f.full_name, position: f.position })
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const me = await response.json();
                Object.assign(this.user, { login: me.login, full_name: me.full_name, position: me.position });
                this.ownProfile = null;
                this.closeMenus();
                this.$nextTick(() => this.snapNavUser());
                if (this.view === "users" && this.isAdmin) {
                    this.loadUsers();
                }
                this.toast("Данные сохранены", "success");
            } catch (e) {
                f.error = e.message || String(e);
            } finally {
                f.saving = false;
            }
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
