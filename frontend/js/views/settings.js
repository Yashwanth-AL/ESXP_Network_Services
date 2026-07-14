/* Settings view: per-service control (start/stop/restart/reload), configuration
   verify/save, and a status/history panel backed by the audit log. */
(function () {
  "use strict";
  var h = window.h, U = window.U, api = window.api;

  window.App.views.settings = function (container) {
    var state = { status: window.App.status || { services: {} } };
    var logBox = h("div", { class: "log-box" });
    var statusMsg = h("div", { style: "margin-bottom:10px" });
    var pills = {};

    function svcPill(running) {
      return h("span", { class: "status-pill " + (running ? "up" : "down") },
        h("span", { class: "dot" }), running ? "Running" : "Stopped");
    }

    function refreshStatus() {
      return api.get("/system/status").then(function (s) {
        state.status = s; window.App.status = s;
        ["dhcp4", "dhcp6", "ctrl_agent"].forEach(function (k) {
          if (pills[k]) { U.clear(pills[k]); pills[k].appendChild(svcPill(!!(s.services && s.services[k]))); }
        });
      }).catch(function () { /* toast handled elsewhere */ });
    }

    function serviceAction(which, action, btn) {
      var label = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spin spin-dark"></span>';
      api.post("/system/service/" + which + "/" + action).then(function (res) {
        window.toast.success(res.message || (which + " " + action + " ok"), "Service control");
      }).catch(function (e) {
        window.toast.error(e.message, "Service control");
      }).then(function () {
        btn.disabled = false; btn.textContent = label;
        refreshStatus(); loadHistory();
      });
    }

    function configAction(service, kind, btn) {
      var label = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spin spin-dark"></span>';
      api.post("/config/" + service + "/" + kind).then(function (res) {
        setStatus(res.ok, (service.toUpperCase() + " " + (kind === "verify" ? "verify" : "save") + ": ") + res.message);
        if (res.ok) window.toast.success(res.message, kind === "verify" ? "Configuration valid" : "Configuration saved");
        else window.toast.error(res.message, kind === "verify" ? "Validation failed" : "Save failed");
      }).catch(function (e) {
        setStatus(false, e.message);
        window.toast.error(e.message, "Configuration");
      }).then(function () {
        btn.disabled = false; btn.textContent = label; loadHistory();
      });
    }

    function setStatus(ok, msg) {
      U.clear(statusMsg);
      statusMsg.appendChild(h("div", { class: "banner", style: ok
        ? "background:var(--se-green-050);border-color:#bfe6c8;color:#1c7a34"
        : "" },
        h("strong", null, ok ? "OK" : "Problem"), h("span", null, msg)));
    }

    function servicePanel(which, title) {
      var pill = h("span"); pills[which] = pill;
      pill.appendChild(svcPill(!!(state.status.services && state.status.services[which])));
      function b(action, cls, text) {
        var btn = h("button", { class: "btn " + cls + " btn-sm" }, text);
        btn.onclick = function () { serviceAction(which, action, btn); };
        return btn;
      }
      var controls = which === "ctrl_agent"
        ? [b("restart", "btn-outline", "Restart")]
        : [b("start", "btn-primary", "Start"), b("stop", "btn-outline", "Stop"),
           b("restart", "btn-outline", "Restart"), b("reload", "btn-outline", "Reload")];
      var configRow = which === "ctrl_agent" ? null :
        h("div", { class: "svc-controls", style: "margin-top:14px" },
          verifyBtn(which === "dhcp4" ? "dhcp4" : "dhcp6"),
          saveBtn(which === "dhcp4" ? "dhcp4" : "dhcp6"));
      return h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", null, title), h("div", { class: "actions" }, pill)),
        h("div", { class: "card-body" },
          h("div", { class: "muted", style: "font-size:12px;margin-bottom:6px" }, "Service control"),
          h("div", { class: "svc-controls" }, controls),
          configRow ? h("div", { class: "muted", style: "font-size:12px;margin:14px 0 0" }, "Configuration") : null,
          configRow));
    }

    function verifyBtn(service) {
      var btn = h("button", { class: "btn btn-outline btn-sm" }, "Verify configuration");
      btn.onclick = function () { configAction(service, "verify", btn); };
      return btn;
    }
    function saveBtn(service) {
      var btn = h("button", { class: "btn btn-primary btn-sm" }, "Save configuration");
      btn.onclick = function () { configAction(service, "save", btn); };
      return btn;
    }

    function loadHistory() {
      api.get("/system/audit?limit=60").then(function (rows) {
        U.clear(logBox);
        if (!rows.length) { logBox.appendChild(h("div", { class: "muted" }, "No activity yet.")); return; }
        rows.forEach(function (r) {
          logBox.appendChild(h("div", { class: "log-line" },
            h("span", { class: "t" }, "[" + r.ts + "] "),
            h("span", { class: r.status === "success" ? "ok" : "err" }, r.status.toUpperCase()),
            " " + (r.username || "-") + " · " + r.category + "/" + r.action +
            (r.detail ? " — " + r.detail : "")));
        });
      }).catch(function (e) {
        U.clear(logBox); logBox.appendChild(h("div", { class: "err" }, "Could not load history: " + e.message));
      });
    }

    function render() {
      U.clear(container);
      container.appendChild(h("div", { class: "page-head" },
        h("div", null,
          h("h1", null, "Settings"),
          h("div", { class: "sub" }, "Control the Kea services and manage configuration")),
        h("div", { class: "actions" },
          h("button", { class: "btn btn-outline", onClick: function () { refreshStatus(); loadHistory(); } }, "↻ Refresh"))));

      container.appendChild(statusMsg);
      container.appendChild(h("div", { class: "panel-grid" },
        servicePanel("dhcp4", "DHCPv4 Server"),
        servicePanel("dhcp6", "DHCPv6 Server")));
      container.appendChild(h("div", { style: "margin-top:18px" },
        servicePanel("ctrl_agent", "Kea Control Agent (REST API)")));

      container.appendChild(h("div", { class: "card", style: "margin-top:18px" },
        h("div", { class: "card-head" }, h("h3", null, "Status & operation history")),
        h("div", { class: "card-body" }, logBox)));
    }

    render();
    refreshStatus();
    loadHistory();
  };
})();
