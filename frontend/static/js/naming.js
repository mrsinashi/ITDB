// Имена ПК по правилам (этап 35): всё, что считается по дереву и строкам таблицы.
//
// Правило — у узлов дерева: часть имени (name_part), «только своя» (name_own —
// части узлов выше не добавляются), одно место (name_single — имя без номера).
// Начало имени узла — части по пути от адреса через «-»: отделение ter, кабинет
// proc → ter-proc, у ПК в нём — ter-proc-1. Без частей на всём пути правила нет.
//
// ПК по правилу, если имя — начало имени узла и номер (ter-proc-7: номер любой,
// № места с ним совпадать не обязан), у одного места — само начало. Иначе ПК
// предлагается имя: с № места, если такое свободно, или следующее после самого
// большого номера. «Своё имя» действует, пока у ПК то же имя и то же расположение.
//
// «По таблице»: как названы ПК сейчас → правила узлов. У узла — самое частое
// начало имён его ПК; у отделения — ещё и первая часть, общая для большинства
// ПК в нём и ниже (ter). Правило ставится так, чтобы начала имён узлов ниже, у
// которых есть своя часть, не поменялись.

export const NAME_MAX = 15;

// Имена, которые Windows даёт сама, — не образец
const DEFAULT_HOST = /^(desktop|win|laptop)-[a-z0-9]{5,}$/;

export function hostKey(name) {
    return String(name || "").trim().toLowerCase();
}

export function joinParts(a, b) {
    return a && b ? a + "-" + b : (a || b || "");
}

// «ter-proc-12» → { base: "ter-proc", num: 12 }; «adm1-glav» → { base: "adm1-glav", num: null }
export function parseHost(name) {
    const key = hostKey(name);
    const m = /^(.+?)-(\d+)$/.exec(key);
    return m ? { base: m[1], num: Number(m[2]) } : { base: key, num: null };
}

// Узлы дерева → id → { node, parentId, level, start (начало имени), above (начало
// узла выше), single, leaf }. draft — { id, part }: часть, которую сейчас вводят
export function namingIndex(roots, draft) {
    const index = new Map();
    const walk = function (nodes, parentId, above, level) {
        nodes.forEach(function (node) {
            const part = draft && draft.id === node.id ? draft.part : (node.name_part || "");
            const start = node.name_own ? part : joinParts(above, part);
            const children = node.children || [];
            index.set(node.id, {
                node: node, parentId: parentId, level: level, start: start, above: above,
                single: !!node.name_single, leaf: !children.length
            });
            walk(children, node.id, start, level + 1);
        });
    };
    walk(roots || [], null, "", 0);
    return index;
}

// Шаблон имени узла: «ter-proc-N», у одного места — «adm1-glav»
export function ruleText(entry) {
    return entry && entry.start ? entry.start + (entry.single ? "" : "-N") : "";
}

// Подходит ли имя под правило узла (null — правила нет)
export function matchesRule(entry, hostname) {
    if (!entry || !entry.start) {
        return null;
    }
    const key = hostKey(hostname);
    if (entry.single) {
        return key === entry.start;
    }
    const head = entry.start + "-";
    return key.indexOf(head) === 0 && /^\d+$/.test(key.slice(head.length));
}

export function keepValid(keep, row) {
    const k = keep && keep[row.id];
    return !!k && k.name === row.hostname && k.location_id === row.location_id;
}

export function takenNames(rows) {
    const taken = new Set();
    rows.forEach(function (row) {
        if (!row.archived && row.hostname) {
            taken.add(hostKey(row.hostname));
        }
    });
    return taken;
}

// Имя по правилу для ПК с № места seat: с № места, если свободно, иначе — следующий номер
export function freeName(entry, seat, taken) {
    if (entry.single) {
        return entry.start;
    }
    const head = entry.start + "-";
    const n = Number(seat);
    if (Number.isInteger(n) && n > 0 && !taken.has(head + n)) {
        return head + n;
    }
    let max = 0;
    taken.forEach(function (name) {
        if (name.indexOf(head) === 0 && /^\d+$/.test(name.slice(head.length))) {
            max = Math.max(max, Number(name.slice(head.length)));
        }
    });
    return head + (max + 1);
}

// Проверка имён: id ПК → { entry, ok, kept, expected }; ПК без правила в карте нет.
// Предлагаемые имена не повторяются: занятые и уже предложенные пропускаются
export function checkNames(rows, index, keep) {
    const result = new Map();
    const taken = takenNames(rows);
    const pending = [];
    rows.forEach(function (row) {
        if (row.archived) {
            return;
        }
        const entry = index.get(row.location_id);
        if (!entry || !entry.start) {
            return;
        }
        const kept = keepValid(keep, row);
        const ok = kept || (!!row.hostname && matchesRule(entry, row.hostname));
        const item = { entry: entry, ok: ok, kept: kept, expected: null };
        result.set(row.id, item);
        if (!ok) {
            pending.push([row, item]);
        }
    });
    pending.forEach(function (pair) {
        pair[1].expected = freeName(pair[1].entry, pair[0].seat_no, taken);
        taken.add(pair[1].expected);
    });
    return result;
}

// Имя нового ПК в узле (нет правила — "")
export function newName(index, locationId, seat, rows) {
    const entry = index.get(locationId);
    return entry && entry.start ? freeName(entry, seat, takenNames(rows)) : "";
}

// Как названы ПК узлов сейчас: id узла → { base, single, count, total } — самое
// частое начало имени (у большинства ПК узла с понятным именем); одно место —
// ни у кого с этим началом нет номера. «Своё имя» и имена Windows — не в счёт
export function observedNames(rows, keep) {
    const byNode = new Map();
    rows.forEach(function (row) {
        if (row.archived || !row.hostname || row.location_id === null || row.location_id === undefined || keepValid(keep, row)) {
            return;
        }
        const key = hostKey(row.hostname);
        if (!/^[a-z0-9-]+$/.test(key) || DEFAULT_HOST.test(key)) {
            return;
        }
        let list = byNode.get(row.location_id);
        if (!list) {
            byNode.set(row.location_id, list = []);
        }
        list.push(parseHost(key));
    });
    const result = new Map();
    byNode.forEach(function (list, id) {
        const counts = new Map();
        let best = null;
        let n = 0;
        list.forEach(function (p) {
            const c = (counts.get(p.base) || 0) + 1;
            counts.set(p.base, c);
            if (c > n) {
                best = p.base;
                n = c;
            }
        });
        if (list.length > 1 && n * 2 <= list.length) {
            return;     // большинства нет
        }
        const single = list.every(function (p) { return p.base !== best || p.num === null; });
        result.set(id, { base: best, single: single, count: n, total: list.length });
    });
    return result;
}

// Часть и «только своя», чтобы начало имени узла стало start при начале выше above
function relRule(start, above) {
    if (!above) {
        return { part: start, own: false };
    }
    if (start === above) {
        return { part: "", own: false };
    }
    if (start.indexOf(above + "-") === 0) {
        return { part: start.slice(above.length + 1), own: false };
    }
    return { part: start, own: true };
}

// Черновик правил всего дерева: правила меняются в нём, а не в узлах; changes() —
// что поменять ([{ id, part, own, single }])
class RuleDraft {
    constructor(roots) {
        this.nodes = [];
        this.rules = new Map();
        this.parents = new Map();
        this.children = new Map();
        const walk = (nodes, parentId) => {
            nodes.forEach((node) => {
                this.nodes.push(node);
                this.rules.set(node.id, { part: node.name_part || "", own: !!node.name_own, single: !!node.name_single });
                this.parents.set(node.id, parentId);
                this.children.set(node.id, (node.children || []).map(function (c) { return c.id; }));
                walk(node.children || [], node.id);
            });
        };
        walk(roots || [], null);
    }

    startOf(id) {
        const rule = this.rules.get(id);
        return rule.own ? rule.part : joinParts(this.aboveOf(id), rule.part);
    }

    aboveOf(id) {
        const parentId = this.parents.get(id);
        return parentId === null || parentId === undefined ? "" : this.startOf(parentId);
    }

    // Новое правило узла; у узлов ниже со своей частью начала имён остаются прежними
    set(id, values) {
        const keep = [];
        const collect = (nodeId) => {
            this.children.get(nodeId).forEach((childId) => {
                const rule = this.rules.get(childId);
                if (rule.part || rule.own) {
                    keep.push([childId, this.startOf(childId)]);
                }
                collect(childId);
            });
        };
        collect(id);
        Object.assign(this.rules.get(id), values);
        keep.forEach(([childId, start]) => {
            if (this.startOf(childId) !== start) {
                Object.assign(this.rules.get(childId), relRule(start, this.aboveOf(childId)));
            }
        });
    }

    changes() {
        const list = [];
        this.nodes.forEach((node) => {
            const rule = this.rules.get(node.id);
            if (rule.part !== (node.name_part || "") || rule.own !== !!node.name_own || rule.single !== !!node.name_single) {
                list.push({ id: node.id, part: rule.part, own: rule.own, single: rule.single });
            }
        });
        return list;
    }
}

// Первая часть начал имён в отделении и ниже (у большинства), если у отделения
// своей части нет, а ПК в нём названы не по правилам: «ter» у ter-proc, ter-ord
function departmentPart(draft, node, observed) {
    const rule = draft.rules.get(node.id);
    if (node.kind !== "department" || rule.part || rule.own) {
        return null;
    }
    const above = draft.aboveOf(node.id);
    const counts = new Map();
    let total = 0;
    let differs = false;
    const walk = (id) => {
        const o = observed.get(id);
        if (o && !differs && (draft.startOf(id) !== o.base || draft.rules.get(id).single !== o.single)) {
            differs = true;
        }
        if (o && (!above || o.base.indexOf(above + "-") === 0)) {
            const first = (above ? o.base.slice(above.length + 1) : o.base).split("-")[0];
            counts.set(first, (counts.get(first) || 0) + o.count);
            total += o.count;
        }
        draft.children.get(id).forEach(walk);
    };
    walk(node.id);
    let best = null;
    let n = 0;
    counts.forEach(function (c, first) {
        if (c > n) {
            best = first;
            n = c;
        }
    });
    return differs && best && n * 2 > total ? { part: best, count: n, total: total } : null;
}

// Узел с ПК, названными не так, как велит правило: каким должно быть правило
function nodeRule(draft, node, observed) {
    const o = observed.get(node.id);
    const rule = draft.rules.get(node.id);
    if (!o || (draft.startOf(node.id) === o.base && rule.single === o.single)) {
        return null;
    }
    return Object.assign(relRule(o.base, draft.aboveOf(node.id)), { single: o.single });
}

// Предложения «по таблице» у строк: id узла → { text, title, items } — что взять
// этой строкой (одно изменение; узлы ниже со своей частью не меняют имён)
export function rowSuggestions(roots, observed) {
    const base = new RuleDraft(roots);
    const result = new Map();
    base.nodes.forEach(function (node) {
        const dept = departmentPart(base, node, observed);
        let values = null;
        let text = "";
        let title = "";
        if (dept) {
            values = { part: dept.part, own: false };
            text = joinParts(base.aboveOf(node.id), dept.part) + "-…";
            title = "Начало имён: " + dept.count + " из " + dept.total + " ПК";
        } else {
            values = nodeRule(base, node, observed);
            if (values) {
                const o = observed.get(node.id);
                text = o.base + (o.single ? "" : "-N");
                title = "Так названы " + o.count + " из " + o.total + " ПК";
            }
        }
        if (values) {
            const draft = new RuleDraft(roots);
            draft.set(node.id, values);
            result.set(node.id, { text: text, title: title, items: draft.changes() });
        }
    });
    return result;
}

// Всё «по таблице» разом: сначала части отделений, потом правила узлов с ПК
export function learnAll(roots, observed) {
    const draft = new RuleDraft(roots);
    draft.nodes.forEach(function (node) {
        const dept = departmentPart(draft, node, observed);
        if (dept) {
            draft.set(node.id, { part: dept.part, own: false });
        }
    });
    draft.nodes.forEach(function (node) {
        const values = nodeRule(draft, node, observed);
        if (values) {
            draft.set(node.id, values);
        }
    });
    return draft.changes();
}
