// Alt + клик копирует значение под курсором во всех таблицах, кроме главной (у неё
// своё копирование, по строкам значения — mixins/table.js) и карточки ПК (там
// значение копирует обычный клик). Пока Alt зажат, значение затемнено, после
// клика — зелёное. Подсветка — один элемент в body, стиль пишется прямо в него:
// данные Vue не трогаются, страница не перерисовывается.

// Где копировать: ячейки таблиц, строки Дерева, значения Справочников
const CELLS = "td, .node-row, .st-val";
// Где нет: главная таблица, карточка ПК, формы и настройки, строки правки
const NOT_IN = ".data-table, .card-table, .scan-form, .scan-marks-table, .st-colrow, .st-sub, .er-row, .cf-menu";
// Кнопки, поля и то, что копируется обычным кликом
const CONTROLS = "button, input, textarea, select, label, .icon-btn, .copy-val, .sc, .st-act, .st-n";

let mouseX = null;
let mouseY = null;
let hintEl = null;
let shown = null;   // что сейчас подсвечено: { text, top, left }

// Текст под точкой: узел и место в нём
function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
    }
    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        return range ? { node: range.startContainer, offset: range.startOffset } : null;
    }
    return null;
}

// Что скопирует клик в точке (x, y): { text, rect } или null
function targetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || el.closest(CONTROLS)) {
        return null;
    }
    const cell = el.closest(CELLS);
    if (!cell || cell.closest(NOT_IN) || cell.querySelector("table")) {
        return null;
    }
    const caret = caretAt(x, y);
    if (!caret || caret.node.nodeType !== 3 || !cell.contains(caret.node)) {
        return null;
    }
    // Значение — кусок текста под курсором; в многострочном — одна строка
    const data = caret.node.data;
    let start = 0;
    let end = data.length;
    if (data.indexOf("\n") !== -1 && /^pre/.test(getComputedStyle(caret.node.parentElement).whiteSpace)) {
        start = data.lastIndexOf("\n", caret.offset - 1) + 1;
        end = data.indexOf("\n", caret.offset);
        if (end === -1) {
            end = data.length;
        }
    }
    const text = data.slice(start, end).replace(/\s+/g, " ").trim();
    if (!text || text === "—") {
        return null;
    }
    const range = document.createRange();
    range.setStart(caret.node, start);
    range.setEnd(caret.node, end);
    const rect = range.getBoundingClientRect();
    const box = cell.getBoundingClientRect();
    const left = Math.max(rect.left, box.left + 2);
    const right = Math.min(rect.right, box.right - 2);
    // Курсор далеко от текста (пустое место ячейки рядом с другим значением) — не оно
    if (right <= left || !rect.height || y < rect.top - 6 || y > rect.bottom + 6) {
        return null;
    }
    return { text: text, rect: { top: rect.top, bottom: rect.bottom, left: left, right: right } };
}

function hide() {
    if (hintEl) {
        hintEl.style.display = "none";
    }
    shown = null;
}

function show(target) {
    const top = Math.round(target.rect.top) - 1;
    const left = Math.round(target.rect.left) - 3;
    if (shown && shown.text === target.text && shown.top === top && shown.left === left) {
        return; // то же значение — не сбрасывать зелёный «скопировано»
    }
    if (!hintEl) {
        hintEl = document.createElement("div");
        document.body.appendChild(hintEl);
    }
    hintEl.className = "copy-hint over";
    hintEl.style.cssText = "display: block; top: " + top + "px; left: " + left + "px; width: " +
        (Math.round(target.rect.right - target.rect.left) + 6) + "px; height: " +
        (Math.round(target.rect.bottom - target.rect.top) + 2) + "px";
    shown = { text: target.text, top: top, left: left };
}

// Подсветить значение под курсором (Alt зажат); true — есть что копировать
function update() {
    const target = mouseX === null ? null : targetAt(mouseX, mouseY);
    if (target) {
        show(target);
    } else {
        hide();
    }
    return !!target;
}

document.addEventListener("mousemove", function (event) {
    mouseX = event.clientX;
    mouseY = event.clientY;
    if (event.altKey) {
        update();
    } else if (shown) {
        hide();
    }
}, { passive: true });

document.addEventListener("scroll", function () {
    if (shown) {
        update();
    }
}, { capture: true, passive: true });

// Отпущенный Alt в Windows выделяет меню браузера — над значением это гасится
window.addEventListener("keydown", function (event) {
    if (event.key === "Alt" && update()) {
        event.preventDefault();
    }
});
window.addEventListener("keyup", function (event) {
    if (event.key === "Alt") {
        if (shown) {
            event.preventDefault();
        }
        hide();
    }
});
window.addEventListener("blur", hide);

// Нажатие с Alt над значением: текст не выделяется, строка не выбирается
document.addEventListener("mousedown", function (event) {
    if (event.altKey && event.button === 0 && targetAt(event.clientX, event.clientY)) {
        event.preventDefault();
        event.stopPropagation();
    }
}, true);

document.addEventListener("click", function (event) {
    if (!event.altKey || event.button !== 0) {
        return;
    }
    const target = targetAt(event.clientX, event.clientY);
    if (!target || !window.itdbTable) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    window.itdbTable.copyText(target.text);
    show(target);
    hintEl.classList.add("done");
}, true);
