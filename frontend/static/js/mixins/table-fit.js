// Таблица: масштаб по ширине окна (кнопка между видом и печатью).

import { saveJson } from "../util.js";
import { TABLE_FIT_KEY } from "../columns.js";

// Мельче — не прочесть, крупнее — незачем
const FIT_MIN = 0.5;
const FIT_MAX = 1.5;

export default {
    computed: {
        // Ширина, масштаб и отступ слева (таблица уже окна — по центру; отступ — целым
        // числом пикселей, иначе линии мылятся)
        tableStyle() {
            const width = this.totalWidth;
            if (!this.tableFit) {
                return { width: width + "px", marginLeft: "max(0px, round(down, (100% - " + width + "px) / 2, 1px))" };
            }
            // Линии сетки — по-прежнему в 1px экрана: в масштабе тоньше пикселя они пропадают
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
            // Полоса прокрутки справа появляется с классом — мерить после него
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
                // Таблица уже окна стоит по центру — полоска нажатой строки за ней (этап 36)
                this.placeRowMark();
            });
            this.fitObserver.observe(wrap);
            this.updateTableFit();
        },

        updateTableFit() {
            const wrap = this.$refs.tableWrap;
            const width = this.totalWidth;
            let zoom = 1;
            let margin = 0;
            // Страница скрыта — ширины нет, масштаб не трогать
            if (this.tableFit && wrap && wrap.clientWidth && width) {
                const room = wrap.clientWidth - 2;   // рамка таблицы по 1px с краёв
                zoom = Math.min(FIT_MAX, Math.max(FIT_MIN, Math.floor(room / width * 1000) / 1000));
                // Отступ задаётся в масштабе таблицы
                margin = Math.max(0, Math.floor((wrap.clientWidth - width * zoom) / 2)) / zoom;
            } else if (this.tableFit) {
                return;
            }
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
