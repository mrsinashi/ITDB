// Сочетания клавиш проверяются по самой клавише (event.code), а не по букве:
// так они работают в любой раскладке (Ctrl+F и в русской, где это «Ctrl+А»).

import { isTypingTarget } from "./util.js";

// Ctrl+F — в поиск текущего раздела
window.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === "KeyF") {
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
    if (vm.view !== "table" || vm.card || event.defaultPrevented || isTypingTarget(document.activeElement)) {
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
