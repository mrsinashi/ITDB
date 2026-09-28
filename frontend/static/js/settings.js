// Варианты оформления и цветовые схемы
// ============================================================
// Варианты оформления. Спорные решения можно вернуть, поставив false.
// ============================================================

export const UI_OPTIONS = {
    lightToolbar: true,   // светлая панель под меню (false — красная, как было)
    darkHostname: true,   // HOSTNAME тёмным, подчёркивание при наведении (false — синий)
    cardGroups: true      // поля карточки разбиты на группы (false — одним списком, как было)
};

document.body.classList.toggle("ui-light-toolbar", UI_OPTIONS.lightToolbar);
document.body.classList.toggle("ui-dark-hostname", UI_OPTIONS.darkHostname);

// Цветовые схемы (личная настройка, шестерёнка в меню). Цвета — в app.css,
// здесь только список для выбора и цвет кружка.
export const THEMES = [
    { key: "red", label: "Красная", color: "#8a2828" },
    { key: "green", label: "Зелёная", color: "#2e5e3e" },
    { key: "blue", label: "Синяя", color: "#233d66" },
    { key: "graphite", label: "Тёмно-серая", color: "#31363c" },
    { key: "teal", label: "Бирюзовая", color: "#1f5c63" }
];
export const THEME_KEY = "itdb.theme";

export function applyTheme(key) {
    if (!THEMES.some(function (t) { return t.key === key; })) {
        key = "red";
    }
    document.documentElement.dataset.theme = key;
    try {
        localStorage.setItem(THEME_KEY, key);
    } catch (e) {
        // ignore
    }
    return key;
}

export const ROLE_LABELS = {
    admin: "Администратор",
    editor: "Редактор",
    reader: "Только чтение"
};
