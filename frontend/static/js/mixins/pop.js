// Всплывающие окошки: общее у окошка принтера, карточки у блочка сканера и «Имени по правилу»
// (у ссылки или блочка), слушатели окна и место под ячейкой – ещё и у «Доступа» и подключения
// принтеров.
// name – имя окошка в data и его ref в шаблоне.

export default {
    methods: {
        // Слушатели окна, пока окошко открыто: { mousedown: fn, keydown: fn, scroll: fn, resize: fn }
        listenPop(name, handlers) {
            this.unlistenPop(name);
            const all = this._popListeners || (this._popListeners = {});
            all[name] = handlers;
            Object.keys(handlers).forEach(function (type) { window.addEventListener(type, handlers[type], true); });
        },

        unlistenPop(name) {
            const handlers = this._popListeners && this._popListeners[name];
            if (!handlers) {
                return;
            }
            Object.keys(handlers).forEach(function (type) { window.removeEventListener(type, handlers[type], true); });
            delete this._popListeners[name];
        },

        // Окошко у элемента el: data – свои поля окошка; Esc и клик мимо закрывают,
        // клик по keep (такая же ссылка или блочок) – не мимо: откроет своё окошко
        openAnchorPop(name, el, data, keep) {
            const r = el.getBoundingClientRect();
            this[name] = Object.assign({
                anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
                left: r.right + 6,
                top: r.top,
                placed: false
            }, data);
            this.$nextTick(() => this.placeAnchorPop(name));
            this.listenPop(name, {
                keydown: (e) => {
                    if (e.key === "Escape" && this[name]) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.closePop(name);
                    }
                },
                mousedown: (e) => {
                    const box = this.$refs[name];
                    if (!this[name] || (box && box.contains(e.target)) || (e.target.closest && e.target.closest(keep))) {
                        return;
                    }
                    this.closePop(name);
                }
            });
        },

        // Справа от ссылки, не помещается – слева; по её верхнему краю, внизу не
        // помещается – по нижнему
        placeAnchorPop(name) {
            const pop = this[name];
            const el = this.$refs[name];
            if (!pop || !el) {
                return;
            }
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const a = pop.anchor;
            let left = a.right + 6;
            if (left + w > window.innerWidth - 8) {
                left = Math.max(8, a.left - w - 6);
            }
            let top = a.top - 4;
            if (top + h > window.innerHeight - 8) {
                top = Math.max(8, a.bottom + 4 - h);
            }
            pop.left = left;
            pop.top = top;
            pop.placed = true;
        },

        // Под ячейкой pop.el по её левому краю; снизу не помещается и сверху больше места –
        // над ней (pop.up). width – ширина окошка, если она задана заранее (этап 55)
        placeUnderPop(name, width) {
            const pop = this[name];
            const box = this.$refs[name];
            if (!pop || !box || !pop.el.isConnected) {
                return;
            }
            const r = pop.el.getBoundingClientRect();
            const h = box.offsetHeight;
            // Правый край – видимая часть таблицы без её полосы прокрутки (этап 61), иначе – окно
            const wrap = pop.el.closest(".table-wrap");
            const right = wrap ? Math.min(window.innerWidth, wrap.getBoundingClientRect().left + wrap.clientWidth) : window.innerWidth;
            pop.left = Math.max(4, Math.min(Math.round(r.left), right - (width || box.offsetWidth) - 4));
            pop.up = r.bottom + h + 4 > window.innerHeight && r.top > window.innerHeight - r.bottom;
            pop.top = pop.up ? Math.max(4, Math.round(r.top - h)) : Math.round(r.bottom);
            pop.placed = true;
        },

        closePop(name) {
            this[name] = null;
            this.unlistenPop(name);
        },

        // Тянуть за шапку
        startPopDrag(name, event) {
            const pop = this[name];
            if (!pop || event.button !== 0) {
                return;
            }
            // Двигаем сам элемент, не данные Vue: иначе на каждое движение мыши
            // перерисовывалась бы вся страница с таблицей – медленно и рывками.
            // Итог записывается в данные один раз, при отпускании.
            const el = this.$refs[name];
            const dx = event.clientX - pop.left;
            const dy = event.clientY - pop.top;
            let left = pop.left;
            let top = pop.top;
            const move = (e) => {
                left = Math.min(Math.max(0, e.clientX - dx), window.innerWidth - 60);
                top = Math.min(Math.max(0, e.clientY - dy), window.innerHeight - 30);
                if (el) {
                    el.style.left = left + "px";
                    el.style.top = top + "px";
                }
            };
            const up = () => {
                window.removeEventListener("mousemove", move);
                window.removeEventListener("mouseup", up);
                if (this[name] === pop) {
                    pop.left = left;
                    pop.top = top;
                }
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
        }
    }
};
