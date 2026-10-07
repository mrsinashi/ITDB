// Печать Таблицы: кнопка справа от кнопки вида открывает окно печати — настройки и
// предпросмотр листа. Печатаются выбранные строки, а без выделения — все показанные;
// столбцы — как в текущем виде (в окне их можно поменять). Лист — отдельный документ
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

const DEFAULTS = { color: "color", paper: "A4", landscape: true, margin: "0,8", strike: true, headers: true };
const PX_PER_MM = 96 / 25.4;
const FONT_PX = 12;
// Запас ширины: чтобы текст на бумаге не упёрся в край столбца
const FONT_SAFE = 0.985;

function esc(text) {
    return String(text === null || text === undefined ? "" : text)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// «0,8» / «0.8» → 0.8 см; пусто или не число — null. Не больше 5 см
export function parseMargin(text) {
    const value = Number(String(text === null || text === undefined ? "" : text).trim().replace(",", "."));
    if (!isFinite(value) || String(text).trim() === "" || value < 0 || value > 5) {
        return null;
    }
    return value;
}

// Любой цвет CSS (и переменная программы) → [r, g, b] на белом; не цвет — null
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

function luma(rgb) {
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function cssRgb(rgb) {
    return "rgb(" + rgb.join(",") + ")";
}

function cssVar(name, fallback) {
    return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export default {
    computed: {
        // Столбцы листа — в порядке таблицы
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

        // Столбцы листа — те же, что сейчас в таблице
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

        // Изменили настройку: запомнить и перерисовать лист (ввод полей — с задержкой)
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

        // which: "table" — как сейчас в таблице, "all" — все
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

        // Оформление значения для листа: цвета — числами (переменные программы в
        // листе не действуют), ч/б — фон оттенком серого, текст чёрным (на тёмном
        // фоне — белым); зачёркивание — по настройке. under — фон под значением
        printStyle(style, opt, under) {
            const out = [];
            let bg = style ? rgbOf(style.backgroundColor) : null;
            let fg = style ? rgbOf(style.color) : null;
            if (opt.bw) {
                if (bg) {
                    const g = Math.round(luma(bg));
                    bg = [g, g, g];
                }
                const base = bg || under;
                fg = base && luma(base) < 128 ? [255, 255, 255] : (fg || bg ? [0, 0, 0] : null);
            }
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

        // Ячейка листа — как в таблице: заливка ячейки, блочки значений, выделения
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
            }, opt, null);
            const line = (text, style) => {
                const st = this.printStyle(style, opt, td.bg);
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
                    const st = this.printStyle(this.cellTextStyle(row, col), opt, td.bg);
                    html = "<span class=\"" + (col.note ? "n" : "t") + "\"" + (st.css ? " style=\"" + st.css + "\"" : "") + ">" + esc(value) + "</span>";
                }
            }
            return "<td" + (cls.length ? " class=\"" + cls.join(" ") + "\"" : "") + (td.css ? " style=\"" + td.css + "\"" : "") + ">" + html + "</td>";
        },

        // Документ листа целиком. Ширина столбцов — как на экране, всё вместе
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
            const total = cols.reduce(function (sum, col) { return sum + col.width; }, 0) + 1;
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
                "th,td{border:1px solid " + grid + ";padding:.22em .5em;overflow:hidden;vertical-align:middle;text-align:left;font-weight:400}",
                "th{background:" + headBg + ";border-color:" + headLine + ";font-weight:600;text-align:center;white-space:nowrap}",
                "td.c{text-align:center}",
                // Перенос — как на экране: узкий столбец значение переносит, а не режет
                ".l,.t,.n{white-space:pre-wrap;overflow-wrap:break-word}",
                ".l{display:block}",
                ".l.chip{display:table;border-radius:3px;padding:0 .42em;margin:0 -.42em}",
                "td.c .l.chip{margin:0 auto}",
                "@media screen{html{background:#8f8f8f}body{padding:14px}" +
                    ".sheet{box-sizing:border-box;width:" + paperW + "mm;min-height:" + paperH + "mm;padding:" + margin + "mm;margin:0 auto;" +
                    "background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.4)}}"
            ].join("\n");
            const head = cols.map(function (col) { return "<th>" + esc(col.headerName) + "</th>"; }).join("");
            const widths = cols.map(function (col) { return "<col style=\"width:" + (col.width * scale).toFixed(2) + "px\">"; }).join("");
            const body = dlg.rows.map((row) => {
                return "<tr>" + cols.map((col) => this.printCell(row, col, opt)).join("") + "</tr>";
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
        // на бумагу этот масштаб не идёт. Клавиши из листа — как в окне
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
