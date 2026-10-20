// Значок вкладки – цветом верхнего меню схемы (--nav-bg). Рисуется прямо в странице
// (SVG в адресе data:), без файла: при смене схемы меняется сразу, кэш браузера не мешает.
// Буквы «IT» – обводка favicon.ico; он остаётся запасным (без JS, старые браузеры).

const LETTERS = "M11.5 8.9L9.5 9.2L7.7 10.5L7.1 14.5L6.3 16.5L6 19.5L4.6 22.5L4.6 24.5L3.9 30.5L2.1 33.5"
    + "L1.9 34.5L2.2 35.5L3.5 37L4.5 37.5L6.5 37.6L8.5 37L10 35.5L10.3 30.5L11.2 28.5L12.1 27.5"
    + "L12.3 24.5L13.6 21.5L14.3 18.5L16.2 13.5L16.1 12.5L15.4 11.5L14.5 10.6Z"
    + "M21.5 9.2L19.3 9.5L18.5 10.5L18.5 11.8L19.5 12.7L21.5 13.2L22.5 13.9L25.5 14L26.5 14.7"
    + "L27 15.5L27 17.5L26.1 20.5L25.6 24.5L25 26.5L24.8 29.5L23.1 32.5L21.9 37.5L21.9 38.5"
    + "L22.5 39.1L24.5 39.3L25.5 38.9L27.5 37.3L29.5 36.8L30.7 34.5L32.1 25.5L33.2 23.5"
    + "L34.6 16.5L35.1 15.5L38.5 13.6L41.5 13.3L43.5 12.6L44.5 11.2L45.8 10.5L45.5 9.6"
    + "L44.5 9.3L40.5 10.1L35.5 10.3L32.5 10L30.5 9.3L26.5 9.9Z";

export function applyFavicon() {
    const color = getComputedStyle(document.documentElement).getPropertyValue("--nav-bg").trim();
    if (!color) {
        return;
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">'
        + '<rect width="48" height="48" rx="5" fill="' + color + '"/>'
        + '<path fill="#fff" d="' + LETTERS + '"/></svg>';
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        link.type = "image/svg+xml";
        document.head.appendChild(link);
    }
    link.href = "data:image/svg+xml," + encodeURIComponent(svg);
}

applyFavicon();
