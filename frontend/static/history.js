const app = Vue.createApp({
  data() {
    return {
      loading: true,
      error: "",
      items: []
    };
  },

  async mounted() {
    try {
      const response = await fetch("/api/history?limit=200");

      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      const data = await response.json();

      this.items = data.items || [];
    } catch (e) {
      this.error = String(e);
    }

    this.loading = false;
  },

  methods: {
    formatTime(value) {
      if (!value) {
        return "";
      }

      return new Date(value).toLocaleString();
    },

    display(value) {
      if (value === null || value === undefined) {
        return "—";
      }

      if (typeof value === "object") {
        return JSON.stringify(value);
      }

      return String(value);
    }
  }
});

app.mount("#app");