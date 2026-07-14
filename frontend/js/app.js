/* Application bootstrap: session check, app shell (top bar + sidebar), hash
   router, live status polling, logout, and forced password change. Loaded last. */
(function () {
  "use strict";
  var h = window.h, U = window.U, api = window.api, App = window.App;

  App.cleanups = [];
  App.addCleanup = function (fn) { App.cleanups.push(fn); };
  function runCleanups() {
    App.cleanups.forEach(function (fn) { try { fn(); } catch (e) {} });
    App.cleanups = [];
  }

  var STATUS_MS = 5000;
  var statusTimer = null;

  var ICON = {
    server: '<rect x="3" y="4" width="18" height="7" rx="1"/><rect x="3" y="13" width="18" height="7" rx="1"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  };

  var ROUTES = {
    "/dhcp/config": function (c) { App.views.dhcpConfig(c); },
    "/dhcp/leases": function (c) { App.views.leases(c); },
    "/dhcp/settings": function (c) { App.views.settings(c); },
    "/dns": function (c) { App.views.placeholder(c, { title: "DNS" }); },
    "/ntp": function (c) { App.views.placeholder(c, { title: "NTP / SNTP" }); }
  };
  var DEFAULT_ROUTE = "/dhcp/config";

  // --- boot --------------------------------------------------------------------
  function boot() {
    api.get("/auth/me")
      .then(function (u) { App.user = u; startApp(); })
      .catch(function () { showLogin(); });
  }

  function showLogin() {
    stopStatus();
    App.user = null;
    App.renderLogin(function (u) { App.user = u; startApp(); });
  }

  function startApp() {
    if (!location.hash || !ROUTES[currentPath()]) location.hash = "#" + DEFAULT_ROUTE;
    renderShell();
    startStatus();
    routeChanged();
    if (App.user && App.user.must_change_password) showChangePasswordBanner();
  }

  window.addEventListener("app:unauthorized", function () {
    window.toast && window.toast.error("Your session has expired. Please sign in again.", "Signed out");
    showLogin();
  });
  window.addEventListener("hashchange", routeChanged);

  // --- shell -------------------------------------------------------------------
  var pillV4, pillV6, bannerSlot, sidebarEl, viewEl;

  function statusPill(label, up) {
    return h("span", { class: "status-pill " + (up ? "up" : "down") },
      h("span", { class: "dot" }), label);
  }

  function renderShell() {
    var app = document.getElementById("app");
    U.clear(app);

    pillV4 = h("span", null, statusPill("DHCPv4", false));
    pillV6 = h("span", null, statusPill("DHCPv6", false));

    var avatar = h("div", { class: "avatar", title: App.user.username }, U.initials(App.user.username));
    var topbar = h("div", { class: "topbar" },
      h("img", { class: "logo", src: "/assets/logo.png", alt: "Schneider Electric" }),
      h("div", { class: "spacer" }),
      h("div", { class: "status-group" }, pillV4, pillV6),
      h("div", { class: "user-chip" }, avatar,
        h("button", { class: "btn btn-outline btn-sm", style: "margin-left:12px", onClick: logout }, "Logout")));

    sidebarEl = h("nav", { class: "sidebar" });
    bannerSlot = h("div");
    viewEl = h("div", { class: "view" });
    var main = h("main", { class: "main" }, bannerSlot, viewEl);

    app.appendChild(topbar);
    app.appendChild(sidebarEl);
    app.appendChild(main);
    renderSidebar();
    updateStatusPills();
  }

  function navItem(path, label, iconKey, opts) {
    opts = opts || {};
    var active = currentPath() === path;
    var cls = "nav-item" + (opts.sub ? " sub" : "") + (active ? " active" : "");
    var children = [];
    if (iconKey) children.push(h("span", { html: U.icon(ICON[iconKey]) }));
    children.push(h("span", null, label));
    if (opts.badge) children.push(h("span", { class: "nav-badge" }, opts.badge));
    return h("div", { class: cls, onClick: function () { location.hash = "#" + path; } }, children);
  }

  function renderSidebar() {
    U.clear(sidebarEl);
    sidebarEl.appendChild(h("div", { class: "nav-group-label" }, "Network Services"));
    sidebarEl.appendChild(navItem("/dhcp/config", "DHCP", "server"));
    sidebarEl.appendChild(navItem("/dhcp/config", "Configuration", "sliders", { sub: true }));
    sidebarEl.appendChild(navItem("/dhcp/leases", "Active Leases", "list", { sub: true }));
    sidebarEl.appendChild(navItem("/dhcp/settings", "Settings", "gear", { sub: true }));
    sidebarEl.appendChild(navItem("/dns", "DNS", "globe", { badge: "Soon" }));
    sidebarEl.appendChild(navItem("/ntp", "NTP / SNTP", "clock", { badge: "Soon" }));
  }

  // --- routing -----------------------------------------------------------------
  function currentPath() {
    var p = (location.hash || "").replace(/^#/, "");
    return p || DEFAULT_ROUTE;
  }

  function routeChanged() {
    if (!App.user) return;
    var path = currentPath();
    var render = ROUTES[path];
    if (!render) { location.hash = "#" + DEFAULT_ROUTE; return; }
    runCleanups();
    if (sidebarEl) renderSidebar();
    U.clear(viewEl);
    try { render(viewEl); }
    catch (e) {
      viewEl.appendChild(h("div", { class: "card" }, h("div", { class: "card-body" }, "View error: " + e.message)));
      window.toast && window.toast.error(e.message, "Rendering error");
    }
  }

  // --- status polling ----------------------------------------------------------
  function startStatus() {
    stopStatus();
    pollStatus();
    statusTimer = setInterval(pollStatus, STATUS_MS);
  }
  function stopStatus() { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } }

  function pollStatus() {
    api.get("/system/status").then(function (s) {
      App.status = s;
      updateStatusPills();
    }).catch(function () { /* leave last known state; a toast would be noisy on a poll */ });
  }

  function updateStatusPills() {
    if (!pillV4) return;
    var svc = (App.status && App.status.services) || {};
    U.clear(pillV4); pillV4.appendChild(statusPill("DHCPv4", !!svc.dhcp4));
    U.clear(pillV6); pillV6.appendChild(statusPill("DHCPv6", !!svc.dhcp6));
  }

  // --- logout / password -------------------------------------------------------
  function logout() {
    api.post("/auth/logout").then(function () {
      runCleanups(); stopStatus(); showLogin();
    }).catch(function () { showLogin(); });
  }

  function showChangePasswordBanner() {
    U.clear(bannerSlot);
    var btn = h("button", { class: "btn btn-primary btn-sm" }, "Change password");
    btn.onclick = openChangePassword;
    bannerSlot.appendChild(h("div", { class: "banner" },
      h("span", null, "You are using the default password. Please set a new password now."), btn));
  }

  function openChangePassword() {
    window.openFormModal({
      title: "Change password",
      submitText: "Update password",
      fields: [
        { name: "current", label: "Current password", type: "password", required: true },
        { name: "next", label: "New password", type: "password", required: true, hint: "At least 6 characters" },
        { name: "confirm", label: "Confirm new password", type: "password", required: true }
      ],
      onSubmit: function (v) {
        if (!v.current) throw new Error("Enter your current password");
        if (v.next.length < 6) throw new Error("New password must be at least 6 characters");
        if (v.next !== v.confirm) throw new Error("New passwords do not match");
        return api.post("/auth/change-password", { current_password: v.current, new_password: v.next })
          .then(function () {
            window.toast.success("Password updated");
            if (App.user) App.user.must_change_password = false;
            U.clear(bannerSlot);
          });
      }
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
  if (document.readyState !== "loading") boot();
})();
