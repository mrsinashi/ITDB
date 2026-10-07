// Сочетания клавиш проверяются по самой клавише (event.code), а не по букве:
// так они работают в любой раскладке (Ctrl+F и в русской, где это «Ctrl+А»).

import { isTypingTarget, setCtrlDown } from "./util.js";

// Зажат Ctrl: шапка Таблицы под курсором показывает закреплённые столбцы
window.addEventListener("keydown", function (event) {
    if (event.key === "Control" || event.key === "Meta") {
        setCtrlDown(true);
    }
});
window.addEventListener("keyup", function (event) {
    if (event.key === "Control" || event.key === "Meta") {
        setCtrlDown(false);
    }
});
window.addEventListener("blur", function () {
    setCtrlDown(false);
});

// Ctrl+F и Alt+F — в поиск текущего раздела
window.addEventListener("keydown", function (event) {
    const ctrl = event.ctrlKey || event.metaKey;
    if (event.code === "KeyF" && !event.shiftKey && (ctrl !== event.altKey)) {
        const input = Array.from(document.querySelectorAll(".tb-search input")).find(function (el) {
            return el.offsetParent !== null;
        });
        if (!input) {
            return;
        }
        event.preventDefault();
        input.focus();
        input.select();
    }
});

window.addEventListener("keydown", function (event) {
    const vm = window.itdbTable;
    if (!vm) {
        return;
    }
    // Окно печати: Esc — закрыть (сначала список столбцов), Ctrl+P — печать листа
    if (vm.printDlg && !vm.dialog) {
        if (event.key === "Escape") {
            event.preventDefault();
            vm.onPrintEsc();
        } else if (event.code === "KeyP" && (event.ctrlKey || event.metaKey) && !event.altKey) {
            event.preventDefault();
            vm.doPrint();
        }
        return;
    }
    // Окно «История значения»: Esc — закрыть
    if (vm.valueDialog && !vm.dialog) {
        if (event.key === "Escape") {
            event.preventDefault();
            vm.closeValueDialog();
        }
        return;
    }
    // Открыт диалог подтверждения: Esc — отмена, Enter — OK
    if (vm.dialog) {
        if (event.key === "Escape") {
            event.preventDefault();
            vm.closeDialog(false);
        } else if (event.key === "Enter") {
            event.preventDefault();
            vm.closeDialog(true);
        }
        return;
    }
    // Ctrl+Z — отменить своё последнее изменение, Ctrl+Y / Ctrl+Shift+Z — вернуть
    // (в поле ввода — обычная отмена набранного)
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.code === "KeyZ" || event.code === "KeyY") &&
        !event.defaultPrevented && !isTypingTarget(document.activeElement) && !vm.editingRowId) {
        event.preventDefault();
        if (event.code === "KeyY" || event.shiftKey) {
            vm.redoLast();
        } else {
            vm.undoLast();
        }
        return;
    }
    if (event.key === "Escape" && vm.card) {
        if (vm.cardEditKey) {
            vm.cardEditKey = null;
        } else if (vm.editingHostname) {
            vm.cancelEditHostname();
        } else {
            vm.closeCard();
        }
        return;
    }
    // Esc закрывает строку добавления (Таблица), форму узла (Дерево) и строку
    // «Новый пользователь / Изменить» (Пользователи), «Новая подсеть» (Сканирование),
    // где бы ни был фокус; открытый список выбора расположения закрывается
    // своим Esc раньше (он не пропускает событие дальше)
    if (event.key === "Escape" && !event.defaultPrevented && !vm.card) {
        if (vm.view === "table" && vm.newComputer) {
            vm.closeNewComputer();
            return;
        }
        if (vm.view === "table" && vm.actionBar) {
            vm.closeAction();
            return;
        }
        if (vm.view === "tree" && vm.treeForm) {
            vm.treeForm = null;
            return;
        }
        if (vm.view === "users" && vm.userBar) {
            vm.closeUserBar();
            return;
        }
        if (vm.view === "scan" && vm.subnetBar) {
            vm.subnetBar = null;
            return;
        }
        if (vm.view === "scan" && vm.scanLinkBar) {
            vm.scanLinkBar = null;
            return;
        }
    }
    // История: Ctrl+A — выделить все видимые записи, Esc — снять выделение
    if (vm.view === "history" && !vm.card && !event.defaultPrevented && !isTypingTarget(document.activeElement)) {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === "KeyA") {
            event.preventDefault();
            vm.selectAllHistory();
        } else if (event.key === "Escape" && vm.historySelected.length) {
            vm.clearHistorySelection();
        }
        return;
    }
    // «Проверка» (Сканирование): Ctrl+A — выделить все показанные строки, Esc — снять
    if (vm.view === "scan" && vm.scanTab === "check" && !vm.card && !event.defaultPrevented && !isTypingTarget(document.activeElement)) {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === "KeyA") {
            event.preventDefault();
            vm.selectAllCheck();
        } else if (event.key === "Escape" && vm.check.selected.length) {
            vm.clearCheckSelection();
        }
        return;
    }
    if (vm.view !== "table" || event.defaultPrevented || isTypingTarget(document.activeElement)) {
        return;
    }
    // Enter — VNC, Alt+P — ping, Alt+R — RDP: к ПК, по строке которого нажали последним
    // (выделять не нужно); открыта карточка — к её ПК
    const plainEnter = event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const altKey = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    const what = plainEnter ? "vnc" : (altKey && event.code === "KeyP" ? "ping" : (altKey && event.code === "KeyR" ? "rdp" : null));
    if (what) {
        if (!vm.editingRowId && !vm.cardEditKey && !vm.editingHostname && !vm.openMenu && !vm.scanPop && !vm.actionBar &&
            !vm.newComputer && !vm.showArchive &&
            !(plainEnter && event.target.closest && event.target.closest("button, .dropdown, .cf-menu, .scan-pop, .add-bar")) &&
            vm.connectActive(what)) {
            event.preventDefault();
        }
        return;
    }
    if (vm.card) {
        return;
    }
    // Ctrl+A — выделить все видимые строки таблицы
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === "KeyA") {
        event.preventDefault();
        vm.selectAllVisible();
    } else if (event.key === "Escape" && vm.selectedRows.length && !vm.editingRowId) {
        vm.clearSelection();
    }
});

// Alt над таблицей: курсор «копировать», клик копирует значение.
// Отпущенный Alt в Windows выделяет меню браузера — пока курсор над
// таблицей, это гасится.
window.addEventListener("keydown", function (event) {
    const vm = window.itdbTable;
    if (!vm || event.key !== "Alt") {
        return;
    }
    vm.altDown = true;
    if (vm.lastMouseX !== undefined) {
        event.preventDefault();
        vm.updateCopyHint();
    }
});
window.addEventListener("keyup", function (event) {
    const vm = window.itdbTable;
    if (!vm || event.key !== "Alt") {
        return;
    }
    vm.altDown = false;
    vm.copyHint = null;
    if (vm.lastMouseX !== undefined) {
        event.preventDefault();
    }
});
window.addEventListener("blur", function () {
    if (window.itdbTable) {
        window.itdbTable.altDown = false;
        window.itdbTable.copyHint = null;
    }
});
