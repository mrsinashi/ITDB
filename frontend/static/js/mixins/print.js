// Печать Таблицы: кнопка справа от кнопки вида открывает окно печати – настройки и
// предпросмотр листа. Печатаются выбранные строки, а без выделения – все показанные;
// столбцы – как в текущем виде (в окне их можно поменять). Лист – отдельный документ
// в рамке (iframe): стили программы на него не действуют, печатает его сам браузер.
// Таблица вписывается в ширину листа: шрифт и столбцы уменьшаются вместе.

import { loadJson, saveJson } from "../util.js";
import { columnTitle } from "../columns.js";

export const PRINT_KEY = "itdb.print.v1";

// Размер листа в мм (книжная ориентация)
export const PAPERS = {
    A4: [210, 297],
    A3: [297, 420],
    A5: [148, 210]
};

// numbers – столбец «#» слева: строки листа по порядку с 1 (этап 37)
const DEFAULTS = { color: "color", paper: "A4", landscape: true, margin: "0,8", strike: true, headers: true, numbers: false };
const PX_PER_MM = 96 / 25.4;
const FONT_PX = 12;
// Запас ширины: чтобы текст на бумаге не упёрся в край столбца
const FONT_SAFE = 0.985;
// Отступ ячейки слева и справа: на экране 6px, на листе меньше – столбцы уже, текст крупнее
const SCREEN_PAD = 6;
const PRINT_PAD = 3;
const MIN_COL = 16;

// Ширина столбца на листе (до уменьшения по ширине листа)
function printWidth(col) {
    return Math.max(MIN_COL, col.width - 2 * (SCREEN_PAD - PRINT_PAD));
}

// Столбец «#»: по самому длинному номеру (цифра – около 7px шрифта 12px)
function numbersWidth(count) {
    return Math.max(MIN_COL + 4, String(count).length * 7 + 2 * PRINT_PAD + 4);
}

function esc(text) {
    return String(text === null || text === undefined ? "" : text)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// «0,8» / «0.8» → 0.8 см; пусто или не число – null. Не больше 5 см
export function parseMargin(text) {
    const value = Number(String(text === null || text === undefined ? "" : text).trim().replace(",", "."));
    if (!isFinite(value) || String(text).trim() === "" || value < 0 || value > 5) {
        return null;
    }
    return value;
}

// Любой цвет CSS (и переменная программы) → [r, g, b] на белом; не цвет – null
let colorProbe = null;
const colorCache = new Map();
function rgbOf(value) {
    if (!value) {
        return null;
    }
    if (colorCache.has(value)) {
        return colorCache.get(value);
    }
    if (!colorProbe) {
        colorProbe = document.createElement("span");
        colorProbe.style.display = "none";
        document.body.appendChild(colorProbe);
    }
    colorProbe.style.color = "";
    colorProbe.style.color = value;
    let result = null;
    if (colorProbe.style.color) {
        const m = /rgba?\(([^)]+)\)/.exec(window.getComputedStyle(colorProbe).color);
        if (m) {
            const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
            const a = p.length > 3 && isFinite(p[3]) ? p[3] : 1;
            result = [0, 1, 2].map(function (i) { return Math.round(p[i] * a + 255 * (1 - a)); });
        }
    }
    colorCache.set(value, result);
    return result;
}

function cssRgb(rgb) {
    return "rgb(" + rgb.join(",") + ")";
}

function cssVar(name, fallback) {
    return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export default {
    computed: {
        // Столбцы листа – в порядке таблицы
        printColumns() {
            const dlg = this.printDlg;
            if (!dlg) {
                return [];
            }
            return this.allColumns.filter(function (col) { return dlg.fields.indexOf(col.field) !== -1; });
        },

        printMarginBad() {
            return !!this.printDlg && parseMargin(this.printDlg.margin) === null;
        },

        printPapers() {
            return Object.keys(PAPERS);
        },

        // Столбцы листа – те же, что сейчас в таблице
        printColumnsAsTable() {
            const dlg = this.printDlg;
            const shown = this.columns.map(function (col) { return col.field; });
            return !!dlg && shown.length === dlg.fields.length && shown.every(function (f) { return dlg.fields.indexOf(f) !== -1; });
        }
    },

    methods: {
        openPrint() {
            this.cancelEdit();
            this.scanPop = null;
            this.closeMenus();
            const selected = this.selectedSet;
            const rows = selected.size
                ? this.displayRows.filter(function (row) { return selected.has(row.id); })
                : this.displayRows.slice();
            if (!rows.length) {
                this.toast("Нет строк для печати", "error");
                return;
            }
            const saved = loadJson(PRINT_KEY, {});
            const opt = {};
            Object.keys(DEFAULTS).forEach(function (key) {
                opt[key] = typeof saved[key] === typeof DEFAULTS[key] ? saved[key] : DEFAULTS[key];
            });
            if (!PAPERS[opt.paper]) {
                opt.paper = DEFAULTS.paper;
            }
            if (parseMargin(opt.margin) === null) {
                opt.margin = DEFAULTS.margin;
            }
            this.printDlg = Object.assign(opt, {
                rows: rows,
                selected: selected.size > 0,
                fields: this.columns.map(function (col) { return col.field; }),
                colsOpen: false,
                scale: 1
            });
            this.$nextTick(this.renderPrint);
        },

        closePrint() {
            window.clearTimeout(this.printTimer);
            this.printDlg = null;
        },

        // Изменили настройку: запомнить и перерисовать лист (ввод полей – с задержкой)
        printChanged(delay) {
            const dlg = this.printDlg;
            if (!dlg) {
                return;
            }
            const keep = {};
            Object.keys(DEFAULTS).forEach(function (key) { keep[key] = dlg[key]; });
            if (parseMargin(keep.margin) === null) {
                keep.margin = DEFAULTS.margin;
            }
            saveJson(PRINT_KEY, keep);
            window.clearTimeout(this.printTimer);
            this.printTimer = window.setTimeout(this.renderPrint, delay || 0);
        },

        setPrintOption(key, value) {
            this.printDlg[key] = value;
            this.printChanged();
        },

        togglePrintColumn(field) {
            const dlg = this.printDlg;
            const at = dlg.fields.indexOf(field);
            if (at === -1) {
                dlg.fields = dlg.fields.concat([field]);
            } else if (dlg.fields.length > 1) {
                dlg.fields = dlg.fields.filter(function (f) { return f !== field; });
            }
            this.printChanged();
        },

        // which: "table" – как сейчас в таблице, "all" – все
        setPrintColumns(which) {
            const list = which === "all" ? this.allColumns : this.columns;
            this.printDlg.fields = list.map(function (col) { return col.field; });
            this.printChanged();
        },

        printColTitle(col) {
            return columnTitle(col);
        },

        // Клик мимо списка столбцов закрывает его
        onPrintDialogClick(event) {
            const dlg = this.printDlg;
            if (dlg && dlg.colsOpen && !(this.$refs.printColsWrap && this.$refs.printColsWrap.contains(event.target))) {
                dlg.colsOpen = false;
            }
        },

        // Esc: сначала список столбцов, потом окно
        onPrintEsc() {
            if (this.printDlg.colsOpen) {
                this.printDlg.colsOpen = false;
            } else {
                this.closePrint();
            }
        },

        // ---------- Лист ----------

        // Оформление значения для листа: цвета – числами (переменные программы в
        // листе не действуют). Ч/б – без фона и цвета: чёрный текст на белом (серое
        // на сером на бумаге не читается); жирный, курсив, зачёркивание остаются.
        // Зачёркивание – по настройке
        printStyle(style, opt) {
            const out = [];
            const bg = style && !opt.bw ? rgbOf(style.backgroundColor) : null;
            const fg = style && !opt.bw ? rgbOf(style.color) : null;
            if (bg) {
                out.push("background-color:" + cssRgb(bg));
            }
            if (fg) {
                out.push("color:" + cssRgb(fg));
            }
            if (style) {
                if (style.fontWeight) {
                    out.push("font-weight:" + style.fontWeight);
                }
                if (style.fontStyle) {
                    out.push("font-style:" + style.fontStyle);
                }
                let deco = style.textDecoration || "";
                if (!opt.strike) {
                    deco = deco.replace("line-through", "").trim();
                }
                if (deco) {
                    out.push("text-decoration:" + deco);
                }
            }
            return { css: out.join(";"), bg: bg };
        },

        // Ячейка листа – как в таблице: заливка ячейки, блочки значений, выделения
        printCell(row, col, opt) {
            const cls = [];
            if (col.center) {
                cls.push("c");
            }
            const look = col.scanOnly ? null : this.cellLook(row, col);
            const td = this.printStyle({
                backgroundColor: this.cellFillOf(row, col),
                fontWeight: col.bold || (look && look.bold) ? "700" : null,
                fontStyle: look && look.italic ? "italic" : null
            }, opt);
            const line = (text, style) => {
                const st = this.printStyle(style, opt);
                return "<span class=\"l" + (st.bg ? " chip" : "") + "\"" + (st.css ? " style=\"" + st.css + "\"" : "") + ">" + esc(text) + "</span>";
            };
            let html = "";
            const parts = col.scanOnly ? null : this.cellParts(row, col);
            if (col.scanOnly) {
                html = this.avItems(row).map((a) => line(a.title, this.avCellStyle(a))).join("");
            } else if (parts) {
                html = parts.map(function (p) { return line(p.text, p.style); }).join("");
            } else {
                const value = row[col.field];
                if (value !== null && value !== undefined && value !== "") {
                    const st = this.printStyle(this.cellTextStyle(row, col), opt);
                    html = "<span class=\"" + (col.note ? "n" : "t") + "\"" + (st.css ? " style=\"" + st.css + "\"" : "") + ">" + esc(value) + "</span>";
                }
            }
            return "<td" + (cls.length ? " class=\"" + cls.join(" ") + "\"" : "") + (td.css ? " style=\"" + td.css + "\"" : "") + ">" + html + "</td>";
        },

        // Документ листа целиком. Ширина столбцов – как на экране, всё вместе
        // уменьшено до ширины листа (без полей)
        printDocument() {
            const dlg = this.printDlg;
            const cols = this.printColumns;
            const opt = { bw: dlg.color === "bw", strike: dlg.strike };
            const size = PAPERS[dlg.paper];
            const paperW = dlg.landscape ? size[1] : size[0];
            const paperH = dlg.landscape ? size[0] : size[1];
            const marginCm = parseMargin(dlg.margin);
            const margin = (marginCm === null ? parseMargin(DEFAULTS.margin) : marginCm) * 10;
            const numW = dlg.numbers ? numbersWidth(dlg.rows.length) : 0;
            const total = cols.reduce(function (sum, col) { return sum + printWidth(col); }, numW) + 1;
            const avail = Math.max(50, Math.floor((paperW - 2 * margin) * PX_PER_MM) - 2);
            const scale = Math.min(1, avail / total);
            dlg.scale = scale;
            const grid = cssRgb(rgbOf(cssVar("--grid-line", "#e5e5e5")) || [229, 229, 229]);
            const headLine = cssRgb(rgbOf(cssVar("--grid-head-line-v", "#d8d8d8")) || [216, 216, 216]);
            const headBg = cssRgb(rgbOf(cssVar("--grid-head-bg", "#f0f0f0")) || [240, 240, 240]);
            const font = window.getComputedStyle(document.body).fontFamily;
            const css = [
                "@page{size:" + paperW + "mm " + paperH + "mm;margin:" + margin + "mm}",
                "html,body{margin:0;padding:0}",
                "body{font-family:" + font + ";font-size:" + (FONT_PX * scale * FONT_SAFE).toFixed(3) + "px;line-height:1.25;color:#000;" +
                    "-webkit-print-color-adjust:exact;print-color-adjust:exact}",
                "table{border-collapse:collapse;table-layout:fixed;width:" + (total * scale).toFixed(2) + "px}",
                "thead{display:" + (dlg.headers ? "table-header-group" : "table-row-group") + "}",
                "tr{break-inside:avoid;page-break-inside:avoid}",
                "th,td{border:1px solid " + grid + ";padding:.1em " + (PRINT_PAD / FONT_PX) + "em;overflow:hidden;vertical-align:middle;text-align:left;font-weight:400}",
                "th{background:" + headBg + ";border-color:" + headLine + ";font-weight:600;text-align:center;white-space:nowrap}",
                "td.c{text-align:center}",
                "td.num{text-align:right;color:#000;white-space:nowrap}",
                // Перенос – как на экране: узкий столбец значение переносит, а не режет
                ".l,.t,.n{white-space:pre-wrap;overflow-wrap:break-word}",
                ".l{display:block}",
                // Блочок – как на экране: его край там же, где начинается обычный текст,
                // текст в нём сдвинут вправо. Не display:table – у него отступ не действует
                // (border-collapse наследуется от таблицы листа)
                ".l.chip{width:fit-content;max-width:100%;box-sizing:border-box;border-radius:3px;padding:0 .42em}",
                ".l.chip+.l.chip{margin-top:1px}",
                "td.c .l.chip{margin-left:auto;margin-right:auto}",
                "@media screen{html{background:#8f8f8f}body{padding:14px}" +
                    ".sheet{box-sizing:border-box;width:" + paperW + "mm;min-height:" + paperH + "mm;padding:" + margin + "mm;margin:0 auto;" +
                    "background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.4)}}"
            ].join("\n");
            const head = (numW ? "<th>#</th>" : "") + cols.map(function (col) { return "<th>" + esc(col.headerName) + "</th>"; }).join("");
            const widths = (numW ? "<col style=\"width:" + (numW * scale).toFixed(2) + "px\">" : "") +
                cols.map(function (col) { return "<col style=\"width:" + (printWidth(col) * scale).toFixed(2) + "px\">"; }).join("");
            const body = dlg.rows.map((row, i) => {
                return "<tr>" + (numW ? "<td class=\"num\">" + (i + 1) + "</td>" : "") + cols.map((col) => this.printCell(row, col, opt)).join("") + "</tr>";
            }).join("\n");
            return "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><title>ITDB</title><style>" + css + "</style></head>" +
                "<body><div class=\"sheet\"><table><colgroup>" + widths + "</colgroup><thead><tr>" + head + "</tr></thead><tbody>\n" +
                body + "\n</tbody></table></div></body></html>";
        },

        renderPrint() {
            const frame = this.$refs.printFrame;
            if (!this.printDlg || !frame) {
                return;
            }
            const fit = () => this.fitPrintPreview();
            frame.onload = fit;
            frame.srcdoc = this.printDocument();
        },

        // Предпросмотр: лист целиком по ширине окна. Только на экране (@media screen):
        // на бумагу этот масштаб не идёт. Клавиши из листа – как в окне
        fitPrintPreview() {
            const frame = this.$refs.printFrame;
            const doc = frame && frame.contentDocument;
            const sheet = doc && doc.querySelector(".sheet");
            if (!sheet) {
                return;
            }
            let fit = doc.getElementById("fit");
            if (!fit) {
                fit = doc.createElement("style");
                fit.id = "fit";
                doc.head.appendChild(fit);
                doc.addEventListener("keydown", (event) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        this.onPrintEsc();
                    } else if (event.code === "KeyP" && (event.ctrlKey || event.metaKey) && !event.altKey) {
                        event.preventDefault();
                        this.doPrint();
                    }
                });
                doc.addEventListener("mousedown", () => {
                    if (this.printDlg) {
                        this.printDlg.colsOpen = false;
                    }
                });
            }
            fit.textContent = "";
            const room = doc.documentElement.clientWidth - 28;
            const width = sheet.getBoundingClientRect().width;
            if (width > room && room > 100) {
                fit.textContent = "@media screen{.sheet{zoom:" + (room / width).toFixed(4) + "}}";
            }
        },

        doPrint() {
            const frame = this.$refs.printFrame;
            if (!frame || !frame.contentWindow) {
                return;
            }
            frame.contentWindow.focus();
            frame.contentWindow.print();
        }
    }
};
