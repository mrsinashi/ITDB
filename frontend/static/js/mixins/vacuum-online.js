// Кружок «в сети» у логинов VACUUM в Таблице и карточке ПК (этап 41): зелёный – в сети,
// серый – нет. Кто в сети – GET /api/scan/jabber/online: сервер смотрит страницу
// online-users/ ejabberd не чаще раза в N минут («Подключения» → Jabber → «В сети»),
// по клику по строке ПК с логинами (click=1) – не чаще раза в 5 с; остальным отдаёт
// последний итог. Пока открыта Таблица (и вкладка браузера видна) – спрашивает снова,
// когда подойдёт срок (next_in). Без сообщений: не удалось – кружков нет.

import { apiFetch } from "../util.js";

export default {
    data() {
        return {
            // enabled – проверка включена; online – логины в сети (строчными), null – не узнали
            vacuumOnline: { enabled: false, online: null }
        };
    },

    computed: {
        // Кружки показываются: проверка включена и список получен
        vacuumDots() {
            return this.vacuumOnline.enabled && Array.isArray(this.vacuumOnline.online);
        },

        vacuumOnlineSet() {
            return new Set(this.vacuumOnline.online || []);
        }
    },

    watch: {
        // Кружки появились или пропали – ширина столбца VACUUM другая
        vacuumDots() {
            this.recalcWidths();
        },

        view(view) {
            if (view === "table") {
                this.loadVacuumOnline();
            } else {
                this.stopVacuumOnline();
            }
        }
    },

    mounted() {
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && this.view === "table") {
                this.loadVacuumOnline();
            }
        });
    },

    methods: {
        // click – по клику по строке ПК: сервер проверит заново, если с прошлой прошло больше 5 с
        async loadVacuumOnline(click) {
            if (!this.user) {
                return;
            }
            this.stopVacuumOnline();
            let nextIn = 0;
            try {
                const response = await apiFetch("/api/scan/jabber/online" + (click ? "?click=1" : ""));
                if (!response.ok) {
                    return;
                }
                const data = await response.json();
                const online = Array.isArray(data.online) ? data.online : null;
                // Тот же итог – данные не трогать (иначе перерисуется вся страница)
                if (this.vacuumOnline.enabled !== data.enabled || String(this.vacuumOnline.online) !== String(online)) {
                    this.vacuumOnline = { enabled: data.enabled, online: online };
                }
                nextIn = data.enabled ? data.next_in : 0;
            } catch (e) {
                return;   // сервер недоступен – кружки остаются как были
            }
            this.stopVacuumOnline();
            if (nextIn > 0 && this.view === "table") {
                this.vacuumOnlineTimer = setTimeout(() => {
                    if (document.visibilityState === "visible" && this.view === "table") {
                        this.loadVacuumOnline();
                    }
                }, (nextIn + 1) * 1000);
            }
        },

        stopVacuumOnline() {
            clearTimeout(this.vacuumOnlineTimer);
            this.vacuumOnlineTimer = null;
        },

        // Клик по строке ПК с логинами VACUUM – проверить их сейчас
        checkRowOnline(row) {
            if (this.vacuumOnline.enabled && row && !row.archived && String(row.vacuum || "").trim()) {
                this.loadVacuumOnline(true);
            }
        },

        // Логин в сети: true / false; null – кружка нет
        vacuumIsOnline(login) {
            if (!this.vacuumDots) {
                return null;
            }
            return this.vacuumOnlineSet.has(String(login).trim().toLowerCase());
        }
    }
};
