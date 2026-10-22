// Кружок Router у IP в таблицах (этап 73): адрес есть в адрес-листе Mikrotik и включён – синий
// кружок у правого края строки ячейки (Компьютеры, Принтеры, журналы «Движение» и «IP»), как
// «в сети» у VACUUM. Адреса – GET /api/scan/hosts/router по последнему сбору Router (выключен или
// давно не собирали – кружков нет); грузятся вместе с таблицей, по «Обновить» и после сбора Router.

import { apiFetch, setIfChanged } from "../util.js";

// Столбцы с адресами: IP у ПК и принтеров, у записи «Движения», у журнала «IP»
const ROUTER_FIELDS = new Set(["ip", "move_ip", "ip_addr"]);

export default {
    data() {
        return {
            routerIps: []   // включённые адреса адрес-листа
        };
    },

    computed: {
        routerIpSet() {
            return new Set(this.routerIps);
        }
    },

    watch: {
        // Кружки появились или пропали – ширина столбцов IP другая
        routerIps() {
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
            } catch (e) {
                // сервер недоступен – кружки остаются как были
            }
        },

        // В ячейке этого столбца бывают кружки Router
        routerColumn(row, col) {
            return ROUTER_FIELDS.has(col.field) && !row.archived && this.routerIpSet.size > 0;
        },

        // Значение строки ячейки – включённый адрес из адрес-листа
        routerDot(row, col, line) {
            return this.routerColumn(row, col) && this.routerIpSet.has(String(line).trim());
        }
    }
};
