/* Settings view: compact per-service control, live status, troubleshooting
   diagnostics (each check hits its own endpoint and shows Kea's answer), a
   Kea log viewer, and the operation history from the audit log. */
(function () {
  "use strict";
  var h = window.h, U = window.U, api = window.api;
  var REFRESH_MS = 5000;

  window.App.views.settings = function (container) {
    var state = { status: window.App.status || { services: {}, kea: {} } };
    var logBox = h("div", { class: "log-box" });   // audit history
    var svcRows = {};   // which -> { pill, uptime }
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
        Object.keys(svcRows).forEach(updateSvcRow);
      }).catch(function () { /* background poll: keep last-known state, no toast noise */ });
    }

    function updateSvcRow(which) {
      var p = svcRows[which];
      if (!p) return;
      var running = !!(state.status.services && state.status.services[which]);
      U.clear(p.pill); p.pill.appendChild(svcPill(running));
      var info = state.status.kea && state.status.kea[which];
      if (p.uptime) p.uptime.textContent = info && info.uptime != null ? "· up " + U.fmtDuration(info.uptime) : "";
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

    // --- one compact row per service (name · status · actions) ---------------
    function svcRow(which, title, actions) {
      var pill = h("span");
      var uptime = h("span", { class: "svc-uptime" });
      svcRows[which] = { pill: pill, uptime: uptime };
      var btns = actions.map(function (a) {
        var b = h("button", { class: "btn " + a[1] + " btn-sm" }, a[2]);
        b.onclick = function () { serviceAction(which, a[0], b); };
        return b;
      });
      updateSvcRow(which);
      return h("div", { class: "svc-row" },
        h("div", { class: "svc-name" }, title, uptime),
        h("div", { class: "svc-status" }, pill),
        h("div", { class: "svc-actions" }, btns));
    }

    var FULL = [["start", "btn-primary", "Start"], ["stop", "btn-outline", "Stop"],
                ["restart", "btn-outline", "Restart"], ["reload", "btn-outline", "Reload"]];

    function servicesCard() {
      return h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", null, "Services")),
        h("div", { class: "card-body svc-list" },
          svcRow("dhcp4", "DHCPv4 server", FULL),
          svcRow("dhcp6", "DHCPv6 server", FULL),
          svcRow("ctrl_agent", "Control Agent", [["restart", "btn-outline", "Restart"]])));
    }

    // --- diagnostics: each check is its own button + backend response --------
    function detailNode(text) {
      text = text || "";
      return text.indexOf("\n") >= 0
        ? h("pre", { class: "diag-pre" }, text)
        : h("span", { class: "check-detail" }, text);
    }

    function diagRow(label, run) {
      var btn = h("button", { class: "btn btn-outline btn-sm" }, "Run");
      var result = h("div", { class: "check-result" }, h("span", { class: "muted" }, "Not run yet"));
      function show(ok, node) {
        U.clear(result);
        result.appendChild(h("span", { class: "status-pill " + (ok ? "up" : "down") },
          h("span", { class: "dot" }), ok ? "OK" : "Problem"));
        result.appendChild(node);
      }
      btn.onclick = function () {
        var label0 = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spin spin-dark"></span>';
        run(show, function () { btn.disabled = false; btn.textContent = label0; });
      };
      return h("div", { class: "check-row" }, h("div", { class: "check-label" }, label), btn, result);
    }

    function simpleCheck(path) {
      return function (show, done) {
        api.get(path).then(function (r) {
          show(!!r.ok, detailNode(r.detail || r.title || ""));
        }).catch(function (e) { show(false, detailNode(e.message)); }).then(done);
      };
    }

    function interfacesCheck(show, done) {
      api.get("/system/check/interfaces").then(function (r) {
        var lines = ["dhcp4", "dhcp6"].map(function (svc) {
          var d = r[svc]; if (!d) return svc + ": (unknown)";
          if (!d.ok) return svc + ": " + (d.error || "unavailable");
          return svc + ": " + (d.interfaces && d.interfaces.length ? d.interfaces.join(", ") : "(none set)");
        });
        var ok = (r.dhcp4 && r.dhcp4.ok) || (r.dhcp6 && r.dhcp6.ok);
        show(ok, detailNode(lines.join("\n")));
      }).catch(function (e) { show(false, detailNode(e.message)); }).then(done);
    }

    function diagnosticsCard() {
      return h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", null, "Diagnostics"),
          h("div", { class: "actions" }, h("span", { class: "muted sec-sub" }, "Run each check to see Kea's answer"))),
        h("div", { class: "card-body diag-list" },
          diagRow("Control Agent reachable", simpleCheck("/system/check/ca")),
          diagRow("DHCPv4 listening on UDP :67", simpleCheck("/system/check/socket/dhcp4")),
          diagRow("DHCPv6 listening on UDP :547", simpleCheck("/system/check/socket/dhcp6")),
          diagRow("Bound interfaces (from running config)", interfacesCheck),
          diagRow("DHCPv4 lease hook loaded", simpleCheck("/system/check/leasehook/dhcp4")),
          diagRow("DHCPv6 lease hook loaded", simpleCheck("/system/check/leasehook/dhcp6"))));
    }

    // --- Kea service logs ----------------------------------------------------
    var logView = h("div", { class: "log-box" }, "Pick a service to view its recent log lines.");

    function loadLog(which, btn) {
      var label = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spin spin-dark"></span>';
      logView.textContent = "Loading…";
      api.get("/system/logs/" + which + "?lines=150").then(function (r) {
        logView.textContent = r.lines || "(no output)";
        logView.scrollTop = logView.scrollHeight;
      }).catch(function (e) {
        logView.textContent = "Could not load log: " + e.message;
      }).then(function () { btn.disabled = false; btn.textContent = label; });
    }

    function logsCard() {
      function b(which, text) {
        var btn = h("button", { class: "btn btn-outline btn-sm" }, text);
        btn.onclick = function () { loadLog(which, btn); };
        return btn;
      }
      return h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", null, "Service logs"),
          h("div", { class: "actions" }, b("dhcp4", "DHCPv4"), b("dhcp6", "DHCPv6"), b("ctrl_agent", "Control Agent"))),
        h("div", { class: "card-body" }, logView));
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

    function historyCard() {
      return h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", null, "Operation history")),
        h("div", { class: "card-body" }, logBox));
    }

    function render() {
      U.clear(container);
      container.appendChild(h("div", { class: "page-head" },
        h("div", null,
          h("h1", null, "Settings"),
          h("div", { class: "sub" }, "Service control, diagnostics and logs for the Kea DHCP server")),
        h("div", { class: "actions" },
          h("button", { class: "btn btn-outline", onClick: function () { refreshStatus(); loadHistory(); } }, "↻ Refresh"))));

      container.appendChild(h("div", { class: "settings-stack" },
        servicesCard(), diagnosticsCard(), logsCard(), historyCard()));
    }

    render();
    refreshStatus();
    loadHistory();
    startAuto();
  };
})();
