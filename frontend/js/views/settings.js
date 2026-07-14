/* Settings view: per-service control (start/stop/restart/reload) and live
   status, plus operation history from the audit log. Configuration verify/
   save now live in the Configuration tab next to each subnet -- this page is
   scoped to infrastructure control, not config editing. */
(function () {
  "use strict";
  var h = window.h, U = window.U, api = window.api;
  var REFRESH_MS = 5000;

  window.App.views.settings = function (container) {
    var state = { status: window.App.status || { services: {}, kea: {} } };
    var logBox = h("div", { class: "log-box" });
    var panels = {}; // which -> { pill, card, statsWrap }
    var timer = null;

    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function startAuto() { stop(); timer = setInterval(refreshStatus, REFRESH_MS); }
    window.App.addCleanup(stop);

    function svcPill(running) {
      return h("span", { class: "status-pill " + (running ? "up" : "down") },
        h("span", { class: "dot" }), running ? "Running" : "Stopped");
    }

    function refreshStatus() {
      return api.get("/system/status").then(function (s) {
        state.status = s; window.App.status = s;
        Object.keys(panels).forEach(updatePanel);
      }).catch(function () { /* background poll failure: keep last-known state, no toast noise */ });
    }

    function updatePanel(which) {
      var p = panels[which];
      if (!p) return;
      var running = !!(state.status.services && state.status.services[which]);
      U.clear(p.pill); p.pill.appendChild(svcPill(running));
      p.card.classList.toggle("accent-up", running);
      p.card.classList.toggle("accent-down", !running);
      if (p.uptime) updateUptime(which, p.uptime);
    }

    function updateUptime(which, span) {
      var info = state.status.kea && state.status.kea[which];
      span.textContent = info && info.uptime != null ? "· up " + U.fmtDuration(info.uptime) : "";
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

    function servicePanel(which, title, opts) {
      opts = opts || {};
      var pill = h("span");
      var uptime = opts.noStats ? null : h("span", { class: "svc-uptime" });
      var card = h("div", { class: "card" });
      panels[which] = { pill: pill, card: card, uptime: uptime };

      function b(action, cls, text) {
        var btn = h("button", { class: "btn " + cls + " btn-sm" }, text);
        btn.onclick = function () { serviceAction(which, action, btn); };
        return btn;
      }

      var titleWrap = h("div", { class: "svc-title" }, h("h3", null, title), uptime);

      if (opts.singleAction) {
        card.appendChild(h("div", { class: "card-head" }, titleWrap, h("div", { class: "actions" }, pill)));
        card.appendChild(h("div", { class: "card-body" },
          h("div", { class: "svc-controls single" }, b(opts.singleAction, "btn-outline", opts.singleLabel))));
      } else {
        var controls = h("div", { class: "svc-controls" },
          h("div", { class: "svc-group" }, b("start", "btn-primary", "Start"), b("stop", "btn-outline", "Stop")),
          h("div", { class: "svc-group" }, b("restart", "btn-outline", "Restart"), b("reload", "btn-outline", "Reload")));
        card.appendChild(h("div", { class: "card-head" }, titleWrap, h("div", { class: "actions" }, pill)));
        card.appendChild(h("div", { class: "card-body" }, controls));
      }

      updatePanel(which);
      return card;
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
          h("div", { class: "sub" }, "Service control and live status for the Kea DHCP server")),
        h("div", { class: "actions" },
          h("button", { class: "btn btn-outline", onClick: function () { refreshStatus(); loadHistory(); } }, "↻ Refresh"))));

      container.appendChild(h("div", { class: "panel-stack" },
        servicePanel("dhcp4", "DHCPv4 Server"),
        servicePanel("dhcp6", "DHCPv6 Server"),
        servicePanel("ctrl_agent", "Kea Control Agent", { noStats: true, singleAction: "restart", singleLabel: "Restart" })));

      container.appendChild(h("div", { class: "card", style: "margin-top:18px" },
        h("div", { class: "card-head" }, h("h3", null, "Status & operation history")),
        h("div", { class: "card-body" }, logBox)));
    }

    render();
    refreshStatus();
    loadHistory();
    startAuto();
  };
})();
