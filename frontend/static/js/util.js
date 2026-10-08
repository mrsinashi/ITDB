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

// Зажат Ctrl – класс на странице: по нему шапка Таблицы показывает закреплённые столбцы
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

// Длинная строка подсказки – переносом по словам, не длиннее width знаков в строке
// (подсказка браузера переносит только очень длинные: группы VACUUM, этап 41)
export function wrapLine(text, width) {
    const lines = [];
    let line = "";
    String(text).split(" ").forEach(function (word) {
        if (line && line.length + 1 + word.length > width) {
            lines.push(line);
            line = word;
        } else {
            line = line ? line + " " + word : word;
        }
    });
    if (line) {
        lines.push(line);
    }
    return lines.join("\n");
}

// «Иванов Иван Иванович» → «Иванов И.И.»; без ФИО – логин (панель, этап 22)
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

// ---------- Не та раскладка (этап 36) ----------
// Клавиши английской и русской раскладки: «[bh» – это «хир», «еук» – «ter»
const LAYOUT_EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`";
const LAYOUT_RU = "йцукенгшщзхъфывапролджэячсмитьбю.ё";
const TO_RU = new Map();
const TO_EN = new Map();
for (let i = 0; i < LAYOUT_EN.length; i++) {
    TO_RU.set(LAYOUT_EN[i], LAYOUT_RU[i]);
    TO_EN.set(LAYOUT_RU[i], LAYOUT_EN[i]);
}

// Слово, набранное в другой раскладке (строчными); "" – если менять нечего
export function otherLayout(word) {
    const map = /[а-яё]/.test(word) ? TO_EN : (/[a-z]/.test(word) ? TO_RU : null);
    if (!map) {
        return "";
    }
    let out = "";
    for (const ch of word) {
        out += map.get(ch) || ch;
    }
    return out !== word ? searchNorm(out) : "";
}

// Часть IP, набранная с «,», «/», «ю» или «б» вместо точки: «10,0/3» → «10.0.3»;
// не похоже на IP – ""
export function ipDots(word) {
    return /^[\d.,/юб]*\d[\d.,/юб]*$/.test(word) && /[,/юб]/.test(word) ? word.replace(/[,/юб]/g, ".") : "";
}

// Слова поиска; слово, которого нет ни в одном тексте, ищется в другой раскладке,
// а часть IP – с точками (этап 37). texts – тексты для поиска (уже searchNorm) или
// функция «есть ли слово где-нибудь»
export function searchWordsIn(query, texts) {
    const has = typeof texts === "function" ? texts : function (w) {
        return texts.some(function (t) { return t.indexOf(w) !== -1; });
    };
    return searchWords(query).map(function (w) {
        if (has(w)) {
            return w;
        }
        const alt = otherLayout(w);
        if (alt && has(alt)) {
            return alt;
        }
        const ip = ipDots(w);
        return ip && has(ip) ? ip : w;
    });
}

// IP при вводе: «ю», «/» и набранные «,» / «б» – это точка: 10ю0ю3ю5 → 10.0.3.5.
// Запятая, вставленная из буфера, – по-прежнему разделитель адресов. cidr – подсеть:
// «/» – это маска, не точка (этап 37).
// Ответ – исправленный текст или null, если править нечего
export function fixIpTyping(el, event, cidr) {
    const value = el.value;
    let fixed = value.replace(cidr ? /[юЮ]/g : /[юЮ/]/g, ".");
    const caret = el.selectionStart;
    const typed = event && event.inputType === "insertText" && event.data ? event.data : "";
    if (/[,бБ]/.test(typed) && caret !== null && caret >= typed.length) {
        const from = caret - typed.length;
        fixed = fixed.slice(0, from) + fixed.slice(from, caret).replace(/[,бБ]/g, ".") + fixed.slice(caret);
    }
    if (fixed === value) {
        return null;
    }
    el.value = fixed;
    if (caret !== null) {
        el.setSelectionRange(caret, caret);
    }
    return fixed;
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

// Фокус в поле ввода – там Ctrl+A, Esc и т. п. работают по-своему
export function isTypingTarget(el) {
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

// Выделение в списке по клику: Ctrl – добавить/убрать, Shift – диапазон от
// прошлой строки, Ctrl+Shift – добавить диапазон. single – обычный клик
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
