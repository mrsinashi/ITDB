// Адреса страниц (этап 28б): у каждой страницы и вкладки – свой адрес после «#»,
// чтобы ссылку можно было открыть в новой вкладке (средняя кнопка мыши, Ctrl + клик):
//   #table, #tree, #vacuum, #choices, #history, #users, #scan/check, #scan/net…
//   #table?pc=12   – Таблица с открытой карточкой ПК
//   #table?loc=7   – Таблица с фильтром по узлу дерева
//   #printers?pr=3 – Принтеры с открытой карточкой принтера (этап 44)

export const VIEWS = ["table", "tree", "vacuum", "printers", "scan", "choices", "history", "users"];

// pageLink("scan/net") → "#scan/net"; pageLink("table", { pc: 12 }) → "#table?pc=12"
export function pageLink(page, params) {
    const query = Object.keys(params || {}).filter(function (key) {
        return params[key] !== null && params[key] !== undefined && params[key] !== "";
    }).map(function (key) {
        return key + "=" + encodeURIComponent(params[key]);
    }).join("&");
    return "#" + page + (query ? "?" + query : "");
}

// "#scan/net?x=1" → { view: "scan", tab: "net", params: { x: "1" } }; не адрес страницы – null
export function parseHash(hash) {
    const text = String(hash || "").replace(/^#\/?/, "");
    if (!text) {
        return null;
    }
    const cut = text.indexOf("?");
    const path = (cut === -1 ? text : text.slice(0, cut)).split("/");
    if (VIEWS.indexOf(path[0]) === -1) {
        return null;
    }
    const params = {};
    if (cut !== -1) {
        text.slice(cut + 1).split("&").forEach(function (pair) {
            const eq = pair.indexOf("=");
            if (eq > 0) {
                try {
                    params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
                } catch (e) {
                    // испорченное значение – пропустить
                }
            }
        });
    }
    return { view: path[0], tab: path[1] || null, params: params };
}
