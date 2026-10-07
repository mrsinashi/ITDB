// ============================================================
// Общие утилиты
// ============================================================

export function loadJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) {
            return fallback;
        }
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
        return fallback;
    }
}

export function saveJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        // ignore
    }
}

// Зажат Ctrl — класс на странице: по нему шапка Таблицы показывает закреплённые столбцы
export function setCtrlDown(on) {
    const root = document.documentElement;
    if (root.classList.contains("ctrl-down") !== !!on) {
        root.classList.toggle("ctrl-down", !!on);
    }
}

export function pad2(n) {
    return n < 10 ? "0" + n : String(n);
}

export async function apiFetch(url, options) {
    const response = await fetch(url, options);
    if (response.status === 401) {
        window.location.replace("/login.html");
        return new Promise(function () {});
    }
    return response;
}

export function splitMulti(value) {
    if (value === null || value === undefined || value === "") {
        return [];
    }
    return String(value)
        .split(/\r?\n/)
        .map(function (item) {
            return item.trim();
        })
        .filter(Boolean);
}

// «Иванов Иван Иванович» → «Иванов И.И.»; без ФИО — логин (панель, этап 22)
export function shortName(fullName, login) {
    const words = String(fullName || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
        return login || "";
    }
    const initials = words.slice(1, 3).map(function (w) { return w.charAt(0).toUpperCase() + "."; }).join("");
    return initials ? words[0] + " " + initials : words[0];
}

// ---------- Поиск по словам ----------
// «хир орд 3»: каждое слово ищется отдельно, найтись должны все.
// Регистр и ё/е не различаются.
export function searchNorm(text) {
    return String(text).toLowerCase().replace(/ё/g, "е");
}

export function searchWords(query) {
    return searchNorm(query).split(/\s+/).filter(Boolean);
}

export function matchesAllWords(text, words) {
    const t = searchNorm(text);
    return words.every(function (w) { return t.indexOf(w) !== -1; });
}


// Разбивка строки на части для подсветки найденного (любое из слов)
export function highlightParts(text, words) {
    text = text || "";
    if (!words || !words.length) {
        return [{ t: text, m: false }];
    }
    const lower = searchNorm(text);
    const marked = new Array(text.length).fill(false);
    words.forEach(function (w) {
        let idx = lower.indexOf(w);
        while (idx !== -1) {
            for (let i = idx; i < idx + w.length; i++) {
                marked[i] = true;
            }
            idx = lower.indexOf(w, idx + w.length);
        }
    });
    const parts = [];
    let i = 0;
    while (i < text.length) {
        let j = i;
        while (j < text.length && marked[j] === marked[i]) {
            j++;
        }
        parts.push({ t: text.slice(i, j), m: marked[i] });
        i = j;
    }
    return parts.length ? parts : [{ t: text, m: false }];
}

// Фокус в поле ввода — там Ctrl+A, Esc и т. п. работают по-своему
export function isTypingTarget(el) {
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

// Выделение в списке по клику: Ctrl — добавить/убрать, Shift — диапазон от
// прошлой строки, Ctrl+Shift — добавить диапазон. single — обычный клик
// выбирает одну строку (в окне), иначе только запоминает её (как в таблице).
export function clickSelect(selected, ids, anchor, id, event, single) {
    const ctrl = event.ctrlKey || event.metaKey;
    const from = anchor === null ? -1 : ids.indexOf(anchor);
    if (event.shiftKey && from !== -1) {
        const to = ids.indexOf(id);
        const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
        if (ctrl) {
            return { selected: selected.concat(range.filter(function (x) { return selected.indexOf(x) === -1; })), anchor: anchor };
        }
        return { selected: range, anchor: anchor };
    }
    if (ctrl) {
        const has = selected.indexOf(id) !== -1;
        return { selected: has ? selected.filter(function (x) { return x !== id; }) : selected.concat([id]), anchor: id };
    }
    return { selected: single ? [id] : selected, anchor: id };
}
