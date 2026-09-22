const kindLabels = {
  building: "Здание",
  department: "Отделение",
  floor: "Этаж",
  room: "Кабинет"
};

const app = Vue.createApp({
  data() {
    return {
      loading: true,
      error: "",
      roots: [],
      unlocated: 0
    };
  },

  async mounted() {
    try {
      const response = await fetch("/api/locations/tree");

      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      const data = await response.json();

      this.roots = data.roots || [];
      this.unlocated = data.unlocated || 0;
    } catch (e) {
      this.error = String(e);
    }

    this.loading = false;
  }
});

app.component("tree-node", {
  name: "tree-node",

  props: {
    node: Object,
    level: Number
  },

  data() {
    return {
      open: this.level < 2
    };
  },

  computed: {
    kindLabel() {
      return kindLabels[this.node.kind] || this.node.kind;
    },

    title() {
      if (
        this.node.kind === "room" &&
        this.node.code &&
        this.node.name &&
        this.node.code !== this.node.name
      ) {
        return this.node.code + " " + this.node.name;
      }

      return this.node.name || this.node.code || "";
    }
  },

  methods: {
    toggle() {
      if (this.node.children && this.node.children.length) {
        this.open = !this.open;
      }
    }
  },

  template: `
    <div class="node">
      <div class="node-row" @click="toggle">
        <span class="toggle">
          <template v-if="node.children && node.children.length">{{ open ? "−" : "+" }}</template>
          <template v-else>•</template>
        </span>

        <span class="kind">{{ kindLabel }}</span>
        <span class="name">{{ title }}</span>
        <span class="count">{{ node.total_count }}</span>
      </div>

      <div class="children" v-if="open && node.children && node.children.length">
        <tree-node
          v-for="child in node.children"
          :key="child.id"
          :node="child"
          :level="level + 1"
        ></tree-node>
      </div>
    </div>
  `
});

app.mount("#app");