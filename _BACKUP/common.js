const MENU_ITEMS = [
  { key: "table", label: "Таблица", href: "/" },
  { key: "tree", label: "Дерево", href: "/tree.html" },
  { key: "history", label: "История", href: "/history.html" }
];

function renderTopMenu(active) {
  const container = document.getElementById("top-menu");

  if (!container) {
    return;
  }

  const nav = document.createElement("nav");
  nav.className = "top-menu";

  let html = '<span class="brand">ITDB</span>';

  MENU_ITEMS.forEach(function (item) {
    const activeClass = item.key === active ? ' class="active"' : "";
    html += `<a href="${item.href}"${activeClass}>${item.label}</a>`;
  });

  html += '<a href="#" onclick="downloadExport(); return false;">Экспорт</a>';
  html += '<span class="menu-right" id="menu-user"></span>';

  nav.innerHTML = html;

  container.innerHTML = "";
  container.appendChild(nav);

  fetch("/api/auth/me")
    .then(function (response) {
      if (response.status === 401) {
        window.location.replace("/login.html");
        return null;
      }

      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      return response.json();
    })
    .then(function (user) {
      if (!user) {
        return;
      }

      const userBox = document.getElementById("menu-user");

      if (!userBox) {
        return;
      }

      const userSpan = document.createElement("span");
      userSpan.className = "user";
      userSpan.textContent = user.login;

      const logoutLink = document.createElement("a");
      logoutLink.href = "#";
      logoutLink.textContent = "Выход";

      logoutLink.onclick = function (event) {
        event.preventDefault();
        logout();
        return false;
      };

      userBox.innerHTML = "";
      userBox.appendChild(userSpan);
      userBox.appendChild(logoutLink);
    })
    .catch(function () {
      // если не удалось получить пользователя, просто не показываем имя
    });
}

async function apiFetch(url, options) {
  const response = await fetch(url, options);

  if (response.status === 401) {
    window.location.replace("/login.html");

    // Возвращаем незавершающийся promise, чтобы код дальше не продолжал работу.
    return new Promise(function () {});
  }

  return response;
}

async function downloadExport() {
  try {
    const response = await apiFetch("/api/export/computers.xlsx");

    const blob = await response.blob();

    let filename = "itdb_computers.xlsx";

    const disposition = response.headers.get("Content-Disposition");

    if (disposition && disposition.includes("filename=")) {
      filename = disposition.split("filename=")[1].replace(/["']/g, "");
    }

    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (e) {
    // если экспорт не удался, ничего не ломаем
  }
}

async function logout() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch (e) {
    // если сессия уже истекла, просто уходим на страницу входа
  }

  window.location.replace("/login.html");
}