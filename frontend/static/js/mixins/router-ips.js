// Кружок Router у IP в таблицах (этап 73): адрес есть в адрес-листе Mikrotik и включён – синий
// кружок у правого края строки ячейки (Компьютеры, Принтеры, журналы «Движение» и «IP»), как
// «в сети» у VACUUM; в журнале «IP» – и серый у выключенного (этап 74). Адреса – GET
// /api/scan/hosts/router по последнему сбору Router (выключен или давно не собирали – кружков нет);
// грузятся вместе с таблицей, по «Обновить» и после сбора Router.

import { apiFetch, setIfChanged } from "../util.js";

// Столбцы с адресами: IP у ПК и принтеров, у записи «Движения», у журнала «IP»
const ROUTER_FIELDS = new Set(["ip", "move_ip", "ip_addr"]);

export default {
    data() {
        return {
            routerIps: [],  // включённые адреса адрес-листа
            routerOff: []   // выключенные (журнал «IP»)
        };
    },

    computed: {
        routerIpSet() {
            return new Set(this.routerIps);
        },

        routerOffSet() {
            return new Set(this.tableKind === "ips" ? this.routerOff : []);
        }
    },

    watch: {
        // Кружки появились или пропали – ширина столбцов IP другая
        routerIps() {
            this.recalcWidths();
        },

        routerOff() {
            this.recalcWidths();
        }
    },

    methods: {
        async loadRouterIps() {
            if (!this.user) {
                return;
            }
            try {
                const response = await apiFetch("/api/scan/hosts/router");
                if (!response.ok) {
                    return;
                }
                const data = await response.json();
                // Тот же список – данные не трогать (иначе перерисуются все строки)
                setIfChanged(this, "routerIps", data.ips);
                setIfChanged(this, "routerOff", data.disabled || []);
            } catch (e) {
                // сервер недоступен – кружки остаются как были
            }
        },

        // В ячейке этого столбца бывают кружки Router
        routerColumn(row, col) {
            return ROUTER_FIELDS.has(col.field) && !row.archived && (this.routerIpSet.size > 0 || this.routerOffSet.size > 0);
        },

        // Кружок у значения строки ячейки: "on" – включённый адрес из адрес-листа, "off" – выключенный
        // (только в журнале «IP»), нет – null
        routerDot(row, col, line) {
            if (!this.routerColumn(row, col)) {
                return null;
            }
            const ip = String(line).trim();
            return this.routerIpSet.has(ip) ? "on" : (this.routerOffSet.has(ip) ? "off" : null);
        },

        // Подсказка кружка: в Компьютерах, Принтерах и «Движении» – «Прямой IP» (ответ пользователя),
        // в журнале «IP» – состояние в адрес-листе
        routerDotTitle(rt) {
            if (!rt) {
                return "";
            }
            return this.tableKind === "ips" ? "Router: " + (rt === "on" ? "Enabled" : "Disabled") : "Прямой IP";
        }
    }
};
