/* Login screen. Rendered into #app when there is no active session. */
(function () {
  "use strict";
  var h = window.h;

  window.App.renderLogin = function (onSuccess) {
    var app = document.getElementById("app");
    window.U.clear(app);

    var userInput = h("input", { type: "text", autocomplete: "username", placeholder: "admin" });
    var passInput = h("input", { type: "password", autocomplete: "current-password", placeholder: "••••••••" });
    var err = h("div", { class: "err-text" });
    var btn = h("button", { class: "btn btn-primary btn-block", type: "submit" }, "Sign in");

    function submit(e) {
      e.preventDefault();
      err.textContent = "";
      var u = userInput.value.trim(), p = passInput.value;
      if (!u || !p) { err.textContent = "Enter username and password"; return; }
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      window.api.post("/auth/login", { username: u, password: p })
        .then(function (data) { onSuccess(data); })
        .catch(function (ex) {
          err.textContent = ex.message || "Login failed";
          btn.disabled = false; btn.textContent = "Sign in";
        });
    }

    var form = h("form", { onSubmit: submit },
      h("div", { class: "field", style: "margin-bottom:14px" },
        h("label", null, "Username"), userInput),
      h("div", { class: "field", style: "margin-bottom:8px" },
        h("label", null, "Password"), passInput),
      err,
      h("div", { style: "margin-top:14px" }, btn));

    app.appendChild(
      h("div", { class: "login-wrap" },
        h("div", { class: "login-card" },
          h("div", { class: "login-brand" },
            h("img", { src: "/assets/logo.png", alt: "Schneider Electric" }),
            h("h2", { class: "login-title" }, "Network Services"),
            h("div", { class: "subtitle" }, "Sign in to manage your DHCP infrastructure")),
          h("div", { class: "login-divider" }),
          form)));
    userInput.focus();
  };
})();
