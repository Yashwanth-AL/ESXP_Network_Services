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

    // --- one row per service (name · status · actions) -----------------------
    var ACTION_ICONS = {
      start: '<polygon points="5 3 19 12 5 21 5 3"/>',
      stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
      restart: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>' +
        '<path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>'
    };

    function svcRow(which, title, actions) {
      var pill = h("span");
      var uptime = h("span", { class: "svc-uptime" });
      svcRows[which] = { pill: pill, uptime: uptime };
      var btns = actions.map(function (a) {
        var actionType = a[0];
        var cls = "btn btn-action btn-" + actionType;
        var ic = h("span", { class: "btn-action-icon", unsafeHTML: U.icon(ACTION_ICONS[actionType], 15) });
        var b = h("button", { class: cls }, ic, a[2]);
        b.onclick = function () { serviceAction(which, actionType, b); };
        return b;
      });
      updateSvcRow(which);
      return h("div", { class: "svc-row" },
        h("div", { class: "svc-name" }, title, uptime),
        h("div", { class: "svc-status" }, pill),
        h("div", { class: "svc-actions" }, btns));
    }

    var FULL = [["start", "btn-primary", "Start"], ["stop", "btn-outline", "Stop"],
                ["restart", "btn-outline", "Restart"]];

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

    function diagRow(label, run, btnText, desc) {
      var btn = h("button", { class: "btn btn-outline btn-sm" }, btnText || "Run");
      var result = h("div", { class: "check-result" }, h("span", { class: "muted" }, "Not run yet"));
      // status: true/"ok" -> green, false/"problem" -> red, "warn" -> amber.
      function show(status, node) {
        var s = status === true ? "ok" : status === false ? "problem" : status;
        var cls = s === "ok" ? "up" : s === "warn" ? "warn" : "down";
        var text = s === "ok" ? "OK" : s === "warn" ? "No traffic" : "Problem";
        U.clear(result);
        result.appendChild(h("span", { class: "status-pill " + cls },
          h("span", { class: "dot" }), text));
        if (node) result.appendChild(node);
      }
      btn.onclick = function () {
        var label0 = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spin spin-dark"></span>';
        run(show, function () { btn.disabled = false; btn.textContent = label0; });
      };
      var labelDiv = h("div", { class: "check-label-col" },
        h("div", { class: "check-label" }, label));
      if (desc) labelDiv.appendChild(h("div", { class: "check-desc" }, desc));
      return h("div", { class: "check-row" }, labelDiv, btn, result);
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

    // --- live packet capture: is DORA arriving, and from which device? -------
    function capLabel(title, hint) {
      return h("div", null, h("div", null, title),
        h("div", { class: "check-hint" }, hint));
    }

    // Known message types, in exchange order, so the count pills read naturally.
    var CAP_ORDER = ["Discover", "Offer", "Request", "Ack", "Nak", "Decline",
      "Release", "Inform", "Solicit", "Advertise", "Reply", "Renew", "Rebind",
      "Confirm", "Information-request"];

    function captureNode(r) {
      var wrap = h("div", { class: "cap-result" });
      var counts = r.counts || {};
      var keys = Object.keys(counts).sort(function (a, b) {
        var ia = CAP_ORDER.indexOf(a), ib = CAP_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      var summary = h("div", { class: "cap-counts" });
      if (!keys.length) {
        summary.appendChild(h("span", { class: "muted" },
          "No DHCP packets seen on “" + r.interface + "” in " + r.seconds +
          "s. If a device should be getting an address, reconnect it while the " +
          "capture runs, or confirm it is on this interface."));
      } else {
        keys.forEach(function (k) {
          summary.appendChild(h("span", { class: "cap-pill" }, k, h("b", null, "×" + counts[k])));
        });
      }
      wrap.appendChild(summary);
      if (r.packets && r.packets.length) {
        var rows = r.packets.slice().reverse().map(function (p) {
          var route = (p.src_ip || "—") + (p.dst_ip ? " → " + p.dst_ip : "");
          return h("tr", null,
            h("td", { class: "cap-ts" }, p.ts || ""),
            h("td", null, h("span", { class: "cap-type" }, p.type)),
            h("td", { class: "cap-mac" }, p.src_mac || "—"),
            h("td", { class: "cap-route" }, route));
        });
        wrap.appendChild(h("div", { class: "cap-tablewrap" },
          h("table", { class: "cap-table" },
            h("thead", null, h("tr", null,
              h("th", null, "Time"), h("th", null, "Message"),
              h("th", null, "From (MAC)"), h("th", null, "Source → Destination"))),
            h("tbody", null, rows))));
      }
      return wrap;
    }

    function captureCheck(family, seconds) {
      return function (show, done) {
        api.get("/system/check/dhcp-traffic/" + family + "?seconds=" + seconds)
          .then(function (r) {
            if (!r.ok) { show(false, detailNode(r.error || "Capture failed.")); return; }
            show(r.total > 0 ? true : "warn", captureNode(r));
          })
          .catch(function (e) { show(false, detailNode(e.message)); })
          .then(done);
      };
    }

    function diagnosticsCard() {
      return h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", null, "Diagnostics"),
          h("div", { class: "actions" }, h("span", { class: "muted sec-sub" }, "Run each check to verify Kea is healthy"))),
        h("div", { class: "card-body diag-list" },
          diagRow("Control Agent reachable", simpleCheck("/system/check/ca"), "Run",
            "Verifies the REST API at :8000 is responding. If Problem: check systemctl status kea-ctrl-agent or restart it."),
          diagRow("DHCPv4 listening on UDP :67", simpleCheck("/system/check/socket/dhcp4"), "Run",
            "Confirms DHCPv4 is bound to :67. If Problem: verify systemctl is-active kea-dhcp4-server and check for port conflicts."),
          diagRow("DHCPv6 listening on UDP :547", simpleCheck("/system/check/socket/dhcp6"), "Run",
            "Confirms DHCPv6 is bound to :547. If Problem: verify systemctl is-active kea-dhcp6-server and check for port conflicts."),
          diagRow("Bound interfaces (from running config)", interfacesCheck, "Run",
            "Shows which NICs are listening (from Kea's live config, not the .conf file). If (none), use Configuration tab to pick interfaces."),
          diagRow("DHCPv4 lease hook loaded", simpleCheck("/system/check/leasehook/dhcp4"), "Run",
            "Checks if lease_cmds hook is loaded (needed for Active Leases). If Problem: run sudo ./install/repair-kea.sh to inject it."),
          diagRow("DHCPv6 lease hook loaded", simpleCheck("/system/check/leasehook/dhcp6"), "Run",
            "Checks if lease_cmds hook is loaded (needed for Active Leases). If Problem: run sudo ./install/repair-kea.sh to inject it."),
          diagRow(capLabel("Capture live DHCPv4 exchange",
                  "Sniffs ~12s for DISCOVER, OFFER, REQUEST, ACK and who sent them"),
                  captureCheck("dhcp4", 12), "Capture",
            "Captures live DHCP packets. If No traffic: reconnect a device while capture runs. If Problem: tcpdump may need sudo."),
          diagRow(capLabel("Capture live DHCPv6 exchange",
                  "Sniffs ~12s for SOLICIT, ADVERTISE, REQUEST, REPLY"),
                  captureCheck("dhcp6", 12), "Capture",
            "Captures live DHCP packets. If No traffic: reconnect a device while capture runs. If Problem: tcpdump may need sudo.")));
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
