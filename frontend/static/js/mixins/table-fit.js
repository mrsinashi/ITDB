// Таблица: масштаб по ширине окна (кнопка между видом и печатью).

import { saveJson } from "../util.js";
import { TABLE_FIT_KEY } from "../columns.js";

// Мельче – не прочесть, крупнее – незачем
const FIT_MIN = 0.5;
const FIT_MAX = 1.5;

export default {
    computed: {
        // Ширина, масштаб и отступ слева (таблица уже окна – по центру; отступ – целым
        // числом пикселей, иначе линии мылятся)
        tableStyle() {
            const width = this.totalWidth;
            if (!this.tableFit) {
                return { width: width + "px", marginLeft: "max(0px, round(down, (100% - " + width + "px) / 2, 1px))" };
            }
            // Линии сетки – по-прежнему в 1px экрана: в масштабе тоньше пикселя они пропадают
            return { width: width + "px", zoom: this.tableZoom, marginLeft: this.tableFitMargin + "px", "--px": (1 / this.tableZoom) + "px" };
        },
    },

    watch: {
        totalWidth() {
            this.updateTableFit();
        },
    },

    methods: {
        toggleTableFit() {
            this.cancelEdit();
            this.scanPop = null;
            this.tableFit = !this.tableFit;
            saveJson(TABLE_FIT_KEY, this.tableFit);
            // Полоса прокрутки справа появляется с классом – мерить после него
            this.$nextTick(() => {
                this.updateTableFit();
            });
        },

        // Следить за шириной области таблицы: окно, карточка ПК слева
        watchTableFit() {
            const wrap = this.$refs.tableWrap;
            if (!wrap || this.fitObserver || !window.ResizeObserver) {
                return;
            }
            this.fitObserver = new ResizeObserver(() => {
                this.updateTableFit();
                // Масштаб по ширине окна поменялся – полоска нажатой строки в нём же (этап 40)
                this.placeRowMark();
            });
            this.fitObserver.observe(wrap);
            // Строк стало больше или меньше (поиск, фильтры) – нужна ли полоса прокрутки
            if (this.$refs.table) {
                this.fitObserver.observe(this.$refs.table);
            }
            this.updateTableFit();
        },

        updateTableFit() {
            const wrap = this.$refs.tableWrap;
            const table = this.$refs.table;
            const width = this.totalWidth;
            let zoom = 1;
            let margin = 0;
            let scroll = this.tableFitScroll;
            // Страница скрыта – ширины нет, масштаб не трогать
            if (this.tableFit && wrap && wrap.clientWidth && width) {
                const zoomFor = function (room) {
                    return Math.min(FIT_MAX, Math.max(FIT_MIN, Math.floor((room - 2) / width * 1000) / 1000));   // рамка таблицы по 1px с краёв
                };
                // Полоса прокрутки – если таблица в масштабе без полосы выше окна (этап 37).
                // Высота таблицы без масштаба от масштаба не зависит – решение не скачет;
                // запас в 6px – чтобы не мигала на границе
                const full = wrap.offsetWidth;
                const height = table ? table.getBoundingClientRect().height / (this.tableZoom || 1) * zoomFor(full) : 0;
                scroll = height > wrap.clientHeight - (scroll ? 6 : 0);
                // Ширина с полосой – когда она уже есть (появится – пересчёт по ResizeObserver)
                const room = scroll && this.tableFitScroll ? wrap.clientWidth : full;
                zoom = zoomFor(room);
                // Отступ задаётся в масштабе таблицы
                margin = Math.max(0, Math.floor((room - width * zoom) / 2)) / zoom;
            } else if (this.tableFit) {
                return;
            }
            this.tableFitScroll = scroll;
            if (this.tableZoom !== zoom || this.tableFitMargin !== margin) {
                this.tableZoom = zoom;
                this.tableFitMargin = margin;
                this.$nextTick(() => {
                    this.updateStickyShadow();
                });
            }
        },
    },
};
