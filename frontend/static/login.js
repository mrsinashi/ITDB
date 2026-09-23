async function checkAlreadyLogged() {
  try {
    const response = await fetch("/api/auth/me");

    if (response.ok) {
      window.location.replace("/");
    }
  } catch (e) {
    // не залогинен — оставляем форму входа
  }
}

checkAlreadyLogged();

document.getElementById("loginForm").addEventListener("submit", async function (event) {
  event.preventDefault();

  const login = document.getElementById("login").value;
  const password = document.getElementById("password").value;
  const errorElement = document.getElementById("error");

  errorElement.textContent = "";

  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        login: login,
        password: password
      })
    });

    if (response.ok) {
      window.location.replace("/");
      return;
    }

    let message = "Ошибка входа";

    try {
      const data = await response.json();

      if (data && data.detail) {
        if (typeof data.detail === "string") {
          message = data.detail;
        } else {
          message = JSON.stringify(data.detail);
        }
      }
    } catch (e) {
      // оставляем сообщение по умолчанию
    }

    errorElement.textContent = message;
  } catch (e) {
    errorElement.textContent = String(e);
  }
});