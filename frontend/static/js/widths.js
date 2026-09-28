// Замер ширины текста и автоматический размер столбцов
// ============================================================

import { styleKey } from "./columns.js";

export const TABLE_WIDTHS_KEY = "itdb.tableWidths.v1";
export const DEFAULT_MAX_WIDTH = 400;
export const WIDTH_EXTRA = 0;
let widthProbe = null;

// Обычная ячейка данных — образец для шрифта и отступов.
export function sampleDataCell() {
    return document.querySelector(".data-table tbody td:not(.editing)");
}

export function ensureWidthProbe() {
    if (widthProbe) {
        return widthProbe;
    }
    widthProbe = document.createElement("span");
    widthProbe.style.position = "absolute";
    widthProbe.style.left = "-9999px";
    widthProbe.style.top = "0";
    widthProbe.style.visibility = "hidden";
    widthProbe.style.whiteSpace = "pre";
    document.body.appendChild(widthProbe);
    return widthProbe;
}

export function syncProbeFont() {
    const sample = sampleDataCell() || document.querySelector(".data-table th");
    if (!sample) {
        return;
    }
    const style = window.getComputedStyle(sample);
    widthProbe.style.fontFamily = style.fontFamily;
    widthProbe.style.fontSize = style.fontSize;
    widthProbe.style.fontWeight = style.fontWeight;
    widthProbe.style.fontStyle = style.fontStyle;
    widthProbe.style.letterSpacing = style.letterSpacing;
}

export function measureTextWidth(text) {
    const probe = ensureWidthProbe();
    probe.textContent = text || "";
    return probe.getBoundingClientRect().width;
}

export function cellOverhead() {
    const sample = sampleDataCell();
    if (!sample) {
        return 13;
    }
    const style = window.getComputedStyle(sample);
    const left = parseFloat(style.paddingLeft) || 0;
    const right = parseFloat(style.paddingRight) || 0;
    // +1 — линия сетки (inset box-shadow), рамки у ячеек нет
    return left + right + 1;
}

export function computeAutoWidths(rows, builtinColumns, fieldDefs, choiceStyleMap, columnStyles) {
    ensureWidthProbe();
    syncProbeFont();
    const overhead = cellOverhead();
    const probe = ensureWidthProbe();
    const savedFontSize = probe.style.fontSize;
    probe.style.fontSize = "9px";
    probe.textContent = "▲";
    const arrowWidth = probe.getBoundingClientRect().width;
    probe.style.fontSize = savedFontSize;
    probe.textContent = "";
    const sortArrowSpace = arrowWidth + 3;
    const widths = {};
    const allCols = (builtinColumns || []).concat((fieldDefs || []).map(function (fd) {
        return { field: fd.key, headerName: fd.label };
    }));
    const styleMap = choiceStyleMap || {};
    const colStyles = columnStyles || {};
    allCols.forEach(function (col) {
        const colBold = col.bold || !!(colStyles[col.field] && colStyles[col.field].bold);
        probe.style.fontWeight = "600";
        let max = measureTextWidth(col.headerName) + sortArrowSpace;
        rows.forEach(function (row) {
            const value = row[col.field];
            if (value === null || value === undefined || value === "") {
                return;
            }
            const fieldStyles = styleMap[col.field];
            String(value).split("\n").forEach(function (line) {
                const s = fieldStyles ? fieldStyles[styleKey(col.field, line)] : null;
                probe.style.fontWeight = (colBold || (s && s.bold)) ? "700" : "400";
                const w = measureTextWidth(line);
                if (w > max) {
                    max = w;
                }
            });
        });
        let width = Math.ceil(max) + overhead + WIDTH_EXTRA;
        const cap = col.maxWidth || DEFAULT_MAX_WIDTH;
        if (width > cap) {
            width = cap;
        }
        widths[col.field] = width;
    });
    return widths;
}

export function loadManualWidths() {
    try {
        const raw = localStorage.getItem(TABLE_WIDTHS_KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) {
            return {};
        }
        return parsed;
    } catch (e) {
        return {};
    }
}

// ============================================================
