// Подключение принтеров к ПК (этап 45): двойной клик по ячейке «Компьютеры» принтера или
// «Принтеры» ПК (и по этой строке карточки) – окошко под ячейкой: поиск и список с
// галочками. Подключённые – сверху, дальше – из того же кабинета, отделения, остальные;
// «usb» справа у строки – подключён по USB. Ввод ищет по имени, IP, кабинету, отделению,
// пользователю, модели; Enter – отметить первый найденный, Enter в пустом поиске,
// «Готово» и клик мимо – сохранить, Esc – отменить.

import { matchesAllWords, searchNorm, searchWordsIn } from "../util.js";
import { roomText } from "../columns.js";

// Строк в списке – не больше (остальные находятся поиском)
const PICK_MAX = 80;
const PICK_WIDTH = 380;

function linksKey(items) {
    return items.map(function (i) { return i.id + (i.usb ? "u" : ""); }).sort().join(",");
}

export default {
    data() {
        return {
            linkPick: null
        };
    },

    computed: {
        // Все, кого можно подключить: [{ id, title, sub, search, near, untitled }]
        linkPickAll() {
            const p = this.linkPick;
            if (!p) {
                return [];
            }
            const pcs = p.kind === "pc";
            const owner = p.owner;
            const ownerDept = [owner.building, owner.department].join("|");
            const keep = new Set(p.initial.map(function (i) { return i.id; }));
            const list = [];
            (pcs ? this.rows : this.printerRows).forEach(function (row) {
                // Из архива – только уже подключённые (их можно снять)
                if (row.archived && !keep.has(row.id)) {
                    return;
                }
                const name = pcs ? row.hostname : row.name;
                const room = roomText(row);
                const ip = String(row.ip || "").split("\n")[0];
                const what = pcs ? row.user : [row.kind, row.model_title].filter(Boolean).join(" ");
                list.push({
                    id: row.id,
                    title: name || (pcs ? "ПК без имени" : (row.kind || "Принтер") + " без имени"),
                    untitled: !name,
                    sub: [room, ip].filter(Boolean).join(" · "),
                    hint: [row.building, row.department, room, what].filter(Boolean).join(" / "),
                    search: searchNorm([name, row.ip, row.building, row.department, room, what, row.inv_no, pcs ? row.vacuum : ""].filter(Boolean).join(" ")),
                    near: row.location_id && row.location_id === owner.location_id ? 2 : ([row.building, row.department].join("|") === ownerDept ? 1 : 0)
                });
            });
            return list;
        },

        // Что в списке сейчас: подключённые – первыми, потом ближние, потом по имени
        linkPickShown() {
            const p = this.linkPick;
            if (!p) {
                return [];
            }
            const chosen = new Map(p.items.map(function (i) { return [i.id, i.usb]; }));
            let list = this.linkPickAll;
            if (p.query.trim()) {
                const words = searchWordsIn(p.query, function (w) {
                    return list.some(function (o) { return o.search.indexOf(w) !== -1; });
                });
                list = list.filter(function (o) { return matchesAllWords(o.search, words); });
            }
            const shown = list.map(function (o) {
                return Object.assign({}, o, { linked: chosen.has(o.id), usb: !!chosen.get(o.id) });
            });
            shown.sort(function (a, b) {
                return (b.linked - a.linked) || (b.near - a.near) || (a.untitled - b.untitled) ||
                    a.title.localeCompare(b.title, "ru", { numeric: true, sensitivity: "base" });
            });
            return shown.slice(0, PICK_MAX);
        },

        linkPickCountText() {
            const p = this.linkPick;
            return p ? "Подключено: " + p.items.length : "";
        }
    },

    methods: {
        // Окошко у ячейки или строки карточки el; owner – ПК или принтер, col – его столбец
        openLinkPick(owner, col, el) {
            if (!this.canEdit || !el) {
                return;
            }
            this.closeLinkPick();
            this.hideWebShown();
            const sel = window.getSelection && window.getSelection();
            if (sel) {
                sel.removeAllRanges();
            }
            const refs =(col.links === "printer" ? owner.printer_refs : owner.computer_refs) || [];
            const items = refs.map(function (ref) { return { id: ref.id, usb: !!ref.usb }; });
            this.linkPick = {
                kind: col.links,
                owner: owner,
                col: col,
                el: el,
                items: items,
                initial: items.slice(),
                query: "",
                active: -1,
                left: 0,
                top: 0,
                up: false,
                placed: false
            };
            // Сначала встать на место (до этого окошко скрыто – поле фокус не примет)
            this.$nextTick(() => {
                this.placeLinkPick();
                this.$nextTick(() => {
                    if (this.$refs.linkPickInput) {
                        this.$refs.linkPickInput.focus();
                    }
                });
            });
            const move = () => this.placeLinkPick();
            this.listenPop("linkPick", {
                mousedown: (e) => {
                    const box = this.$refs.linkPick;
                    if (this.linkPick && !(box && box.contains(e.target))) {
                        this.saveLinkPick();
                    }
                },
                scroll: move,
                resize: move
            });
        },

        // Под ячейкой по её левому краю; снизу мало места – над ней
        placeLinkPick() {
            const p = this.linkPick;
            const box = this.$refs.linkPick;
            if (!p || !box || !p.el.isConnected) {
                return;
            }
            const r = p.el.getBoundingClientRect();
            const h = box.offsetHeight;
            p.left = Math.max(4, Math.min(Math.round(r.left), window.innerWidth - PICK_WIDTH - 4));
            p.up = r.bottom + h + 4 > window.innerHeight && r.top > window.innerHeight - r.bottom;
            p.top = p.up ? Math.max(4, Math.round(r.top - h)) : Math.round(r.bottom);
            p.placed = true;
        },

        closeLinkPick() {
            this.closePop("linkPick");
        },

        toggleLinkPick(o) {
            const p = this.linkPick;
            if (!p) {
                return;
            }
            const at = p.items.findIndex(function (i) { return i.id === o.id; });
            if (at === -1) {
                p.items.push({ id: o.id, usb: false });
            } else {
                p.items.splice(at, 1);
            }
            this.$nextTick(() => this.placeLinkPick());
        },

        // «usb» у строки: не подключён – подключить по USB, иначе – USB / по сети
        toggleLinkUsb(o) {
            const p = this.linkPick;
            if (!p) {
                return;
            }
            const item = p.items.find(function (i) { return i.id === o.id; });
            if (item) {
                item.usb = !item.usb;
            } else {
                p.items.push({ id: o.id, usb: true });
            }
        },

        onLinkPickInput() {
            const p = this.linkPick;
            if (p) {
                p.active = p.query.trim() ? 0 : -1;
                this.$nextTick(() => this.placeLinkPick());
            }
        },

        onLinkPickKeydown(event) {
            const p = this.linkPick;
            if (!p) {
                return;
            }
            const list = this.linkPickShown;
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && list.length) {
                event.preventDefault();
                const n = list.length;
                p.active = p.active < 0 ? (event.key === "ArrowDown" ? 0 : n - 1) : (p.active + (event.key === "ArrowDown" ? 1 : -1) + n) % n;
                this.$nextTick(() => {
                    const box = this.$refs.linkPickList;
                    const item = box ? box.children[p.active] : null;
                    if (item) {
                        item.scrollIntoView({ block: "nearest" });
                    }
                });
            } else if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                if (p.active >= 0 && list[p.active]) {
                    this.toggleLinkPick(list[p.active]);
                    p.query = "";
                    p.active = -1;
                } else {
                    this.saveLinkPick();
                }
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (p.query) {
                    p.query = "";
                    p.active = -1;
                } else {
                    this.closeLinkPick();
                }
            }
        },

        // Сохранить, если что-то поменяли: в ячейке до ответа – новый текст, на сервер – номера
        saveLinkPick() {
            const p = this.linkPick;
            if (!p) {
                return;
            }
            this.closeLinkPick();
            if (linksKey(p.items) === linksKey(p.initial)) {
                return;
            }
            const titles = new Map(this.linkPickAll.map(function (o) { return [o.id, o.untitled ? "#" + o.id : o.title]; }));
            const text = p.items.map(function (i) { return (titles.get(i.id) || "#" + i.id) + (i.usb ? " [usb]" : ""); }).join("\n");
            const ids = p.items.map(function (i) { return [i.id, i.usb]; });
            const row = p.kind === "pc" ? p.owner : (this.rows.find(function (r) { return r.id === p.owner.id; }) || p.owner);
            this.saveCellValue(row, p.col, text, ids);
        }
    }
};
