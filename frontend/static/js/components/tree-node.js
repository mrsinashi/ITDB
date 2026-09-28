import { highlightParts } from "../util.js";
import { kindLabels } from "../columns.js";
import { KIND_ICONS, treeNodeTexts } from "../tree-utils.js";

export default {
    name: "tree-node",
    inject: ["root"],
    props: {
        node: Object,
        level: Number,
        underMatch: Boolean
    },
    computed: {
        hasChildren() {
            return !!(this.node.children && this.node.children.length);
        },
        match() {
            return this.root.treeMatch;
        },
        visible() {
            const m = this.match;
            if (!m.query || this.underMatch) {
                return true;
            }
            return m.self.has(this.node.id) || m.anc.has(this.node.id);
        },
        isOpen() {
            const m = this.match;
            if (m.query && m.anc.has(this.node.id)) {
                return true;
            }
            return this.root.isTreeOpen(this.node, this.level);
        },
        kindLabel() {
            return kindLabels[this.node.kind] || this.node.kind;
        },
        icon() {
            return KIND_ICONS[this.node.kind] || KIND_ICONS.room;
        },
        texts() {
            return treeNodeTexts(this.node);
        },
        codeParts() {
            return highlightParts(this.texts.code, this.match.words);
        },
        nameParts() {
            return highlightParts(this.texts.name, this.match.words);
        },
        canAddChild() {
            return this.node.kind !== "room";
        },
        canEdit() {
            return this.root.canEdit;
        },
        formHere() {
            const f = this.root.treeForm;
            if (!f) {
                return false;
            }
            return (f.action === "add" && !f.top && f.parentId === this.node.id) ||
                (f.action === "edit" && f.nodeId === this.node.id);
        }
    },
    methods: {
        toggle() {
            if (this.hasChildren) {
                this.root.setTreeOpen(this.node.id, !this.isOpen);
            }
        },
        call(method) {
            this.root[method](this.node);
        }
    },
    template: `
        <div class="node" v-if="visible">
            <div class="node-row" :class="['kind-' + node.kind, { 'has-children': hasChildren, 'is-open': hasChildren && isOpen, 'is-hover': root.treeHover && root.treeHover.id === node.id }]"
                :style="{ '--lvl': level }" @click="toggle" @mouseenter="root.setTreeHover(node, $event.currentTarget)">
                <span class="node-main">
                    <span class="node-toggle" :class="{ open: isOpen }">
                        <svg v-if="hasChildren" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>
                    </span>
                    <svg class="node-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" v-html="icon"></svg>
                    <span class="node-title" :title="kindLabel">
                        <span v-if="texts.code" class="node-code"><template v-for="(p, i) in codeParts" :key="'c' + i"><mark v-if="p.m">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span><span v-if="texts.name" class="node-name"><template v-for="(p, i) in nameParts" :key="'n' + i"><mark v-if="p.m">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span>
                    </span>
                </span>
                <span class="node-count" title="Компьютеров внутри"><span class="cnt" :class="{ zero: !node.total_count }">{{ node.total_count || 0 }}</span></span>
            </div>
            <tree-form v-if="formHere" :level="level + 1"></tree-form>
            <template v-if="isOpen && hasChildren">
                <tree-node
                    v-for="child in node.children"
                    :key="child.id"
                    :node="child"
                    :level="level + 1"
                    :under-match="underMatch || match.self.has(node.id)"
                ></tree-node>
            </template>
        </div>
    `
};
