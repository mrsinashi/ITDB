// Панель под меню (этап 47): поиск стоит по центру, пока хватает места. Левой части
// тесно – поиск сдвигается вправо, потом сужается (до --search-min из CSS), и только
// потом сжимаются плашки фильтров. Сетка панели (1fr | поиск | 1fr) этого сама не умеет:
// плашки сжимаемые, и сетка не знает, сколько места они хотят. Поэтому левой части
// ставится min-width – сколько ей нужно, но не больше, чем остаётся от узкого поиска и
// правой части. Считается при смене ширины панели и её содержимого.
//
// Директива v-tb-fit – у каждой .toolbar.

// Самый узкий поиск, если в CSS не задан --search-min
const SEARCH_MIN = 120;
// Плашки при нехватке места сжимаются, но не меньше этого
const CHIPS_MIN = 60;

// Ширина по содержимому: элементы правой части Таблицы растянуты пустышкой .tb-view-gap
function contentWidth(el) {
    const items = Array.from(el.children).filter(function (child) {
        return !child.classList.contains("tb-view-gap") && getComputedStyle(child).display !== "none";
    });
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    let width = 0;
    items.forEach(function (child) {
        width += child.getBoundingClientRect().width;
    });
    return width + gap * Math.max(0, items.length - 1);
}

// Плашки целиком, без сжатия
function chipsWidth(chips) {
    const flex = chips.style.flex;
    chips.style.flex = "none";
    chips.style.width = "max-content";
    const width = chips.getBoundingClientRect().width;
    chips.style.flex = flex;
    chips.style.width = "";
    return width;
}

function fit(bar) {
    const left = bar.querySelector(":scope > .tb-left");
    if (!left || !bar.clientWidth) {
        return;   // панель скрыта (Таблица под v-show) – посчитается, когда покажется
    }
    const right = bar.querySelector(":scope > .tb-right");
    const style = getComputedStyle(bar);
    const inner = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const gap = parseFloat(style.columnGap) || 0;

    let want = 0;
    let shrink = 0;   // сколько из этого могут отдать плашки
    const items = Array.from(left.children).filter(function (child) { return getComputedStyle(child).display !== "none"; });
    items.forEach(function (child) {
        if (child.classList.contains("tb-chips")) {
            const width = chipsWidth(child);
            want += width;
            shrink += Math.max(0, width - CHIPS_MIN);
        } else {
            want += child.getBoundingClientRect().width;
        }
    });
    want += (parseFloat(getComputedStyle(left).columnGap) || 0) * Math.max(0, items.length - 1);

    const searchMin = parseFloat(style.getPropertyValue("--search-min")) || SEARCH_MIN;
    const room = inner - gap * 2 - searchMin - (right ? contentWidth(right) : 0);
    const min = Math.max(want - shrink, Math.min(want, room));
    const value = Math.ceil(Math.max(0, min)) + "px";
    if (left.style.minWidth !== value) {
        left.style.minWidth = value;
    }
}

export default {
    mounted(bar) {
        let frame = null;
        const schedule = function () {
            if (frame === null) {
                frame = requestAnimationFrame(function () {
                    frame = null;
                    fit(bar);
                });
            }
        };
        const resize = new ResizeObserver(schedule);
        resize.observe(bar);
        // Содержимое: счётчик, плашки, «Выбрано: N», кнопки справа
        const mutation = new MutationObserver(schedule);
        mutation.observe(bar, { childList: true, subtree: true, characterData: true });
        bar._tbFit = { resize: resize, mutation: mutation, cancel: function () { cancelAnimationFrame(frame); } };
        schedule();
    },

    unmounted(bar) {
        const state = bar._tbFit;
        if (state) {
            state.resize.disconnect();
            state.mutation.disconnect();
            state.cancel();
            bar._tbFit = null;
        }
    }
};
