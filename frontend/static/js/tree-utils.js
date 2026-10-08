export const KIND_ICONS = {
    building: '<path d="M8 14.5s4.5-4.2 4.5-8a4.5 4.5 0 0 0-9 0c0 3.8 4.5 8 4.5 8z"/><circle cx="8" cy="6.5" r="1.6"/>',
    department: '<path d="M2 4.5h4l1.2 1.5H14v7.5H2z"/>',
    floor: '<path d="M8 2 14 5 8 8 2 5zM2 8l6 3 6-3M2 11l6 3 6-3"/>',
    room: '<path d="M4 14V2.5h8V14M2.5 14h11M9.5 8.5h0.01"/>'
};

// ------------------------------------------------------------
// Геометрия строки дерева. Те же числа – в app.css (раздел «Дерево»),
// по ним считается ширина колонки дерева.
// ------------------------------------------------------------
export const TREE = {
    padL: 6,         // отступ строки слева
    indent: 18,      // сдвиг на уровень
    toggle: 12,      // стрелка
    gap: 5,          // промежуток между стрелкой, значком и названием
    icon: 14,        // значок
    codeMin: 30,     // номер кабинета – колонкой
    codeGap: 6,
    padR: 10,
    countCol: 46,    // столбец «ПК»
    border: 2,       // рамка таблицы
    min: 300
};
// Шрифт по типу узла: [размер, жирность, заглавные]
export const TREE_FONTS = {
    building: [13, 600, false],
    department: [13, 400, false],
    floor: [13, 400, false],
    room: [13, 400, false]
};

// Подпись узла: номер кабинета отдельно, у этажа – «2 этаж»
export function treeNodeTexts(node) {
    let code = "";
    let name = node.name || node.code || "";
    if (node.kind === "room" && node.code) {
        code = node.code;
        name = (!node.name || node.name === node.code) ? "" : node.name;
    }
    if (node.kind === "floor" && /^\d+$/.test(String(node.name || "").trim())) {
        name = node.name + " этаж";
    }
    return { code: code, name: name };
}

let treeCanvas = null;

export function computeTreeWidth(roots) {
    treeCanvas = treeCanvas || document.createElement("canvas");
    const ctx = treeCanvas.getContext("2d");
    const family = window.getComputedStyle(document.body).fontFamily;
    function textWidth(text, size, weight, upper) {
        if (!text) {
            return 0;
        }
        ctx.font = weight + " " + size + "px " + family;
        const t = upper ? text.toUpperCase() : text;
        // letter-spacing у заглавных подписей этажей: 0.04em
        return ctx.measureText(t).width + (upper ? t.length * size * 0.04 : 0);
    }
    let max = TREE.min;
    const walk = function (nodes, level) {
        nodes.forEach(function (node) {
            const f = TREE_FONTS[node.kind] || TREE_FONTS.room;
            const t = treeNodeTexts(node);
            let title = textWidth(t.name, f[0], f[1], f[2]);
            if (t.code) {
                title += Math.max(TREE.codeMin, textWidth(t.code, 13, 600, false)) + (t.name ? TREE.codeGap : 0);
            }
            const w = TREE.padL + level * TREE.indent + TREE.toggle + TREE.gap + TREE.icon + TREE.gap +
                title + TREE.padR + TREE.countCol + TREE.border;
            if (w > max) {
                max = w;
            }
            if (node.children && node.children.length) {
                walk(node.children, level + 1);
            }
        });
    };
    walk(roots || [], 0);
    return Math.ceil(max) + 2;
}
