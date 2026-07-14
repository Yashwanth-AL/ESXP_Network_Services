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
    var auditBody = h("tbody");
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
      if (p.statsWrap) renderStats(which, p.statsWrap);
    }

    function renderStats(which, wrap) {
      U.clear(wrap);
      var info = state.status.kea && state.status.kea[which];
      if (!info) {
        wrap.appendChild(h("div", { class: "muted", style: "font-size:12.5px;margin-bottom:10px" },
          "No status data yet."));
        return;
      }
      wrap.appendChild(h("div", { class: "kv" }, h("span", null, "PID"),
        h("span", { class: "mono" }, info.pid != null ? String(info.pid) : "—")));
      wrap.appendChild(h("div", { class: "kv" }, h("span", null, "Uptime"),
        h("span", null, info.uptime != null ? U.fmtDuration(info.uptime) : "—")));
      wrap.appendChild(h("div", { class: "kv" }, h("span", null, "Config reloaded"),
        h("span", null, info.reload != null ? U.fmtDuration(info.reload) + " ago" : "—")));
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
      var statsWrap = opts.noStats ? null : h("div");
      var card = h("div", { class: "card" });
      panels[which] = { pill: pill, card: card, statsWrap: statsWrap };

      function b(action, cls, text) {
        var btn = h("button", { class: "btn " + cls + " btn-sm" }, text);
        btn.onclick = function () { serviceAction(which, action, btn); };
        return btn;
      }
      var controls = opts.singleAction
        ? [b(opts.singleAction, "btn-outline", opts.singleLabel)]
        : [b("start", "btn-primary", "Start"), b("stop", "btn-outline", "Stop"),
           b("restart", "btn-outline", "Restart"), b("reload", "btn-outline", "Reload")];

      card.appendChild(h("div", { class: "card-head" }, h("h3", null, title), h("div", { class: "actions" }, pill)));
      card.appendChild(h("div", { class: "card-body" },
        statsWrap,
        h("div", { class: "svc-controls" }, controls)));

      updatePanel(which);
      return card;
    }

    function loadHistory() {
      api.get("/system/audit?limit=60").then(function (rows) {
        U.clear(auditBody);
        if (!rows.length) {
          auditBody.appendChild(h("tr", null, h("td", { colspan: 6, class: "table-empty" }, "No activity yet.")));
          return;
        }
        rows.forEach(function (r) {
          auditBody.appendChild(h("tr", null,
            h("td", { class: "mono" }, r.ts),
            h("td", null, r.username || "—"),
            h("td", null, r.category),
            h("td", null, r.action),
            h("td", null, h("span", { class: "badge " + (r.status === "success" ? "green" : "red") }, r.status)),
            h("td", null, r.detail || h("span", { class: "muted" }, "—"))));
        });
      }).catch(function (e) {
        U.clear(auditBody);
        auditBody.appendChild(h("tr", null,
          h("td", { colspan: 6, class: "table-empty" }, "Could not load history: " + e.message)));
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

      container.appendChild(h("div", { class: "panel-grid" },
        servicePanel("dhcp4", "DHCPv4 Server"),
        servicePanel("dhcp6", "DHCPv6 Server"),
        servicePanel("ctrl_agent", "Kea Control Agent", { noStats: true, singleAction: "restart", singleLabel: "Restart" })));

      container.appendChild(h("div", { class: "card", style: "margin-top:18px" },
        h("div", { class: "card-head" },
          h("h3", null, "Operation history"),
          h("div", { class: "actions" }, h("span", { class: "muted", style: "font-size:12px" }, "Last 60 events"))),
        h("div", { class: "table-wrap" },
          h("table", { class: "data" },
            h("thead", null, h("tr", null,
              h("th", null, "Time"), h("th", null, "User"), h("th", null, "Category"),
              h("th", null, "Action"), h("th", null, "Status"), h("th", null, "Detail"))),
            auditBody))));
    }

    render();
    refreshStatus();
    loadHistory();
    startAuto();
  };
})();
