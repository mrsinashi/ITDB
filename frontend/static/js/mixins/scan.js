// Сканирование (этап 24, страница только у администратора): подключения к
// источникам данных (GLPI, GSIT, Jabber) и подсети для сетевого сканирования.
//
// Форма источника правится прямо в блоке: «Сохранить» отправляет только
// изменённое, «Проверить подключение» проверяет то, что сейчас в форме (даже
// несохранённое). Пароли и токены с сервера не приходят — только «сохранён»;
// пустое поле — не менять, «✕» у сохранённого — удалить при сохранении.
// Подсети — таблица; новая и «Изменить» — строкой прямо в таблице (этап 26д), как у
// пользователей; при вводе подсети — список подсетей /24 с ПК из базы, которых нет в списке.

import { apiFetch } from "../util.js";

const SOURCE_TEXT_FIELDS = ["url", "domain", "login"];
const SECRET_FIELDS = ["password", "user_token", "app_token"];

export default {
    computed: {
        scanCountText() {
            const on = this.scanSources.filter(function (s) { return s.enabled; }).length;
            return "Источников включено: " + on + " из " + this.scanSources.length + " · Подсетей: " + this.scanSubnets.length;
        },

        // Строки таблицы подсетей: правка — на месте строки, новая — последней строкой
        subnetsView() {
            const bar = this.subnetBar;
            const rows = this.scanSubnets.map(function (sn) {
                return { key: "s" + sn.id, subnet: sn, edit: !!bar && bar.kind === "edit" && bar.id === sn.id };
            });
            if (bar && bar.kind === "new") {
                rows.push({ key: "new", subnet: null, edit: true });
            }
            return rows;
        },

        scanPurposeOptions() {
            const purposes = this.scanPurposes;
            return Object.keys(purposes).map(function (key) { return { key: key, label: purposes[key] }; });
        },
    },

    methods: {
        loadScan() {
            this.loadScanSources();
            this.loadScanSubnets();
        },

        scanTopCountText() {
            if (this.scanTab === "check") {
                return this.checkCountText;
            }
            if (this.scanTab === "vacuum") {
                return this.vacuumCountText;
            }
            return this.scanTab === "settings" ? this.scanCountText : this.scanNamesCountText;
        },

        async loadScanSources() {
            this.scanError = "";
            this.startLoading();
            try {
                const response = await apiFetch("/api/scan/sources");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                this.scanKeyReady = data.key_ready;
                this.scanSources = data.sources;
                const forms = {};
                data.sources.forEach((s) => { forms[s.kind] = this.scanFormFrom(s); });
                this.scanForms = forms;
                this.resumeScanRuns();
                if (this.scanTab !== "settings") {
                    this.setScanTab(this.scanTab);
                }
            } catch (e) {
                this.scanError = "Не удалось загрузить настройки: " + (e.message || e);
            } finally {
                this.finishLoading();
            }
        },

        scanFormFrom(s) {
            return {
                enabled: s.enabled,
                url: s.url || "",
                domain: s.domain || "",
                login: s.login || "",
                password: "",
                user_token: "",
                app_token: "",
                clear: { password: false, user_token: false, app_token: false },
                verify_tls: s.verify_tls,
                fresh_days: s.fresh_days,
                show: false,
                saving: false,
                checking: false,
                result: null,       // проверка несохранённой формы: { ok, message, checked_at }
                error: ""
            };
        },

        scanSource(kind) {
            return this.scanSources.find(function (s) { return s.kind === kind; });
        },

        // Изменённые поля формы — то, что уйдёт на сервер
        scanChanges(kind) {
            const s = this.scanSource(kind);
            const f = this.scanForms[kind];
            if (!s || !f) {
                return {};
            }
            const body = {};
            if (f.enabled !== s.enabled) {
                body.enabled = f.enabled;
            }
            SOURCE_TEXT_FIELDS.forEach(function (name) {
                if (name === "domain" && s.kind !== "jabber") {
                    return;
                }
                if ((f[name] || "").trim() !== (s[name] || "")) {
                    body[name] = f[name];
                }
            });
            if (f.verify_tls !== s.verify_tls) {
                body.verify_tls = f.verify_tls;
            }
            if (s.fresh_days !== null && Number(f.fresh_days) !== s.fresh_days) {
                body.fresh_days = Number(f.fresh_days);
            }
            SECRET_FIELDS.forEach(function (name) {
                if (!(name in s.secrets)) {
                    return;
                }
                if (f[name]) {
                    body[name] = f[name];
                } else if (f.clear[name] && s.secrets[name]) {
                    body[name] = "";
                }
            });
            return body;
        },

        scanDirty(kind) {
            return Object.keys(this.scanChanges(kind)).length > 0;
        },

        // Сохранённый пароль / токен: поле пустое, подсказка короткая (просьба 01.10)
        scanSecretPlaceholder(kind, name) {
            const s = this.scanSource(kind);
            const f = this.scanForms[kind];
            if (s && s.secrets[name]) {
                if (f.clear[name]) {
                    return "будет удалён";
                }
                return name === "password" ? "сменить пароль" : "сменить токен";
            }
            return name === "password" ? "" : "не указан";
        },

        toggleSecretClear(kind, name) {
            const f = this.scanForms[kind];
            f.clear[name] = !f.clear[name];
            f[name] = "";
        },

        resetScanForm(kind) {
            const s = this.scanSource(kind);
            if (s) {
                this.scanForms[kind] = this.scanFormFrom(s);
            }
        },

        async saveScanSource(kind) {
            const f = this.scanForms[kind];
            const body = this.scanChanges(kind);
            if (!f || f.saving || !Object.keys(body).length) {
                return;
            }
            f.saving = true;
            f.error = "";
            try {
                const response = await apiFetch("/api/scan/sources/" + kind, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const saved = await response.json();
                this.scanSources = this.scanSources.map(function (s) { return s.kind === kind ? saved : s; });
                const show = f.show;
                this.scanForms[kind] = Object.assign(this.scanFormFrom(saved), { show: show });
                this.toast(saved.title + ": настройки сохранены", "success");
            } catch (e) {
                f.error = e.message || String(e);
            } finally {
                f.saving = false;
            }
        },

        async checkScanSource(kind) {
            const f = this.scanForms[kind];
            if (!f || f.checking) {
                return;
            }
            const body = this.scanChanges(kind);
            delete body.enabled;
            delete body.fresh_days;
            f.checking = true;
            f.error = "";
            f.result = null;
            try {
                const response = await apiFetch("/api/scan/sources/" + kind + "/check", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const result = await response.json();
                if (result.saved) {
                    const s = this.scanSource(kind);
                    Object.assign(s, { checked_at: result.checked_at, check_ok: result.ok, check_message: result.message });
                } else {
                    f.result = result;
                }
                // Удачная проверка — сообщением (под формой — только ошибки)
                if (result.ok) {
                    this.toast(this.scanSource(kind).title + ": " + result.message, "success");
                }
            } catch (e) {
                f.error = e.message || String(e);
            } finally {
                f.checking = false;
            }
        },

        // Строка результата проверки: несохранённой формы или последней сохранённой
        scanStatus(kind) {
            const s = this.scanSource(kind);
            const f = this.scanForms[kind];
            if (f && f.result) {
                return { ok: f.result.ok, text: f.result.message, at: f.result.checked_at, unsaved: true };
            }
            if (s && s.checked_at) {
                return { ok: s.check_ok, text: s.check_message, at: s.checked_at, unsaved: false };
            }
            return null;
        },

        // Подсказка у блочка «подключено / ошибка»: когда проверяли и что ответил источник
        scanTagTitle(kind) {
            const st = this.scanStatus(kind);
            if (!st) {
                return "Подключение ещё не проверяли: значок с вилкой внизу";
            }
            return "Проверено " + this.formatTime(st.at) + (st.unsaved ? " (несохранённые данные)" : "") + "\n" + st.text;
        },

        // Число в шапке: ПК в GLPI / GSIT, пользователи Jabber — по последнему сбору
        scanSourceCount(kind) {
            const run = this.scanRunOf(kind);
            const st = run && run.status === "ok" ? run.stats || {} : null;
            if (!st || st.total === undefined || st.total === null) {
                return null;
            }
            const info = this.scanRunInfo(kind);
            return { n: st.total, title: info ? info.text : "" };
        },

        scanTag(kind) {
            const s = this.scanSource(kind);
            if (!s || !s.checked_at) {
                return { text: "не проверено", cls: "" };
            }
            return s.check_ok ? { text: "подключено", cls: "ok" } : { text: "ошибка", cls: "bad" };
        },

        // ---------- Подсети ----------

        async loadScanSubnets() {
            this.startLoading();
            try {
                const response = await apiFetch("/api/scan/subnets");
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                const data = await response.json();
                this.scanSubnets = data.subnets;
                this.scanUncovered = data.uncovered;
                this.scanBuildings = data.buildings;
                this.scanPurposes = data.purposes;
            } catch (e) {
                this.scanError = "Не удалось загрузить подсети: " + (e.message || e);
            } finally {
                this.finishLoading();
                this.placeEditPlate("subnetBar");
            }
        },

        purposeName(key) {
            return this.scanPurposes[key] || key;
        },

        buildingName(id) {
            const b = this.scanBuildings.find(function (x) { return x.id === id; });
            return b ? b.name : "";
        },

        subnetSizeText(s) {
            return "Адресов: " + s.size;
        },

        openNewSubnet() {
            if (this.subnetBar && this.subnetBar.kind === "new") {
                this.subnetBar = null;
                return;
            }
            this.subnetBar = { kind: "new", cidr: "", purpose: "mixed", location_id: "", scan: true, note: "", error: "", saving: false, plate: null };
            this.showEditRow("subnetBar", "sb-cidr");
        },

        openEditSubnet(s) {
            this.subnetHover = null;
            this.subnetBar = {
                kind: "edit", id: s.id, was: s.cidr, cidr: s.cidr, purpose: s.purpose,
                location_id: s.location_id || "", scan: s.scan, note: s.note || "", error: "", saving: false, plate: null
            };
            this.showEditRow("subnetBar", "sb-note");
        },

        // Подсказка у поля подсети: подсети /24, где есть ПК из базы, а в списке их нет
        openCidrSuggest(el) {
            const options = this.scanUncovered.map(function (u) { return { key: u.cidr, value: u.cidr, count: u.computers }; });
            this.openSuggestList(el, "cidr", options, (value) => {
                if (this.subnetBar) {
                    this.subnetBar.cidr = value;
                    this.$nextTick(() => this.focusRef("sb-note"));
                }
            });
        },

        onCidrKeydown(event) {
            if (this.suggest && event.key === "Escape") {
                event.preventDefault();   // Esc закрывает только список, строка остаётся
                this.closeSuggest();
                return;
            }
            this.suggestKeydown(event);
        },

        async submitSubnetBar() {
            const bar = this.subnetBar;
            if (!bar || bar.saving) {
                return;
            }
            const locationId = bar.location_id === "" ? null : Number(bar.location_id);
            let url = "/api/scan/subnets";
            let method = "POST";
            let body;
            if (bar.kind === "new") {
                body = { cidr: bar.cidr, purpose: bar.purpose, location_id: locationId, scan: bar.scan, note: bar.note };
            } else {
                const was = this.scanSubnets.find(function (s) { return s.id === bar.id; });
                url += "/" + bar.id;
                method = "PATCH";
                body = {};
                if (was) {
                    if (bar.cidr.trim() !== was.cidr) {
                        body.cidr = bar.cidr;
                    }
                    if (bar.purpose !== was.purpose) {
                        body.purpose = bar.purpose;
                    }
                    if (locationId !== was.location_id) {
                        if (locationId === null) {
                            body.clear_location = true;
                        } else {
                            body.location_id = locationId;
                        }
                    }
                    if (bar.scan !== was.scan) {
                        body.scan = bar.scan;
                    }
                    if (bar.note.trim() !== (was.note || "")) {
                        body.note = bar.note;
                    }
                }
                if (!Object.keys(body).length) {
                    this.subnetBar = null;
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
                await this.loadScanSubnets();
                if (bar.kind === "new") {
                    this.toast("Добавлена подсеть: " + saved.cidr, "success");
                    // Строка остаётся открытой для следующей; назначение и адрес — те же
                    this.subnetBar = { kind: "new", cidr: "", purpose: bar.purpose, location_id: bar.location_id, scan: bar.scan, note: "", error: "", saving: false, plate: null };
                    this.showEditRow("subnetBar", "sb-cidr");
                } else {
                    this.toast("Подсеть изменена: " + saved.cidr, "success");
                    this.subnetBar = null;
                }
            } catch (e) {
                bar.error = e.message || String(e);
            } finally {
                bar.saving = false;
            }
        },

        async setSubnetScan(s, scan) {
            this.subnetHover = null;
            await this.patchSubnet(s, { scan: scan }, (scan ? "Будет сканироваться: " : "Не сканируется: ") + s.cidr);
        },

        async patchSubnet(s, body, done) {
            try {
                const response = await apiFetch("/api/scan/subnets/" + s.id, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                await this.loadScanSubnets();
                this.toast(done, "success");
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        async deleteSubnet(s) {
            this.subnetHover = null;
            const ok = await this.confirmDialog("Удалить подсеть " + s.cidr + "?", { okText: "Удалить", danger: true });
            if (!ok) {
                return;
            }
            try {
                const response = await apiFetch("/api/scan/subnets/" + s.id, { method: "DELETE" });
                if (!response.ok) {
                    throw new Error(await this.errorText(response));
                }
                if (this.subnetBar && this.subnetBar.id === s.id) {
                    this.subnetBar = null;
                }
                await this.loadScanSubnets();
                this.toast("Удалена подсеть: " + s.cidr, "success");
            } catch (e) {
                this.toastError(e.message || e);
            }
        },

        setSubnetHover(s, rowEl) {
            const wrap = rowEl.closest(".users-wrap");
            if (!wrap) {
                return;
            }
            const w = wrap.getBoundingClientRect();
            const r = rowEl.getBoundingClientRect();
            this.subnetHover = { id: s.id, subnet: s, top: r.top - w.top, height: r.height };
        },
    }
};
