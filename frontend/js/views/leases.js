/* Active Leases view: live, auto-refreshing table with search, renew and
   release (single + bulk). IPv4 / IPv6 tabs. */
(function () {
  "use strict";
  var h = window.h, U = window.U, api = window.api;
  var REFRESH_MS = 5000;

  window.App.views.leases = function (container) {
    var state = { version: 4, rows: [], filter: "", auto: true, selected: {} };
    var timer = null;

    var tbody = h("tbody");
    var countEl = h("span", { class: "muted" });
    var searchInput = h("input", { type: "search", placeholder: "Search IP, MAC/DUID, or hostname…" });
    var autoChk = h("input", { type: "checkbox", class: "chk", checked: true });
    var selectAll = h("input", { type: "checkbox", class: "chk" });
    var bulkBtn = h("button", { class: "btn btn-outline btn-sm", disabled: true }, "Release selected");

    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function startAuto() { stop(); if (state.auto) timer = setInterval(load, REFRESH_MS); }
    window.App.addCleanup(stop);

    function tab(v, label) {
      return h("div", { class: "tab" + (state.version === v ? " active" : ""),
        onClick: function () { if (state.version !== v) { state.version = v; state.selected = {}; render(); load(); } } }, label);
    }

    function idColLabel() { return state.version === 4 ? "MAC address" : "DUID"; }

    function render() {
      U.clear(container);
      searchInput.value = state.filter;
      autoChk.checked = state.auto;

      container.appendChild(h("div", { class: "page-head" },
        h("div", null,
          h("h1", null, "Active Leases"),
          h("div", { class: "sub" }, "Live view of leases from the Kea lease database")),
        h("div", { class: "actions" },
          h("button", { class: "btn btn-outline", onClick: load }, "↻ Refresh now"))));

      container.appendChild(h("div", { class: "tabs" }, tab(4, "IPv4"), tab(6, "IPv6")));

      container.appendChild(h("div", { class: "toolbar" },
        h("div", { class: "search" },
          h("span", { html: U.icon('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>', 16) }),
          searchInput),
        bulkBtn,
        h("label", { class: "status-pill", style: "cursor:pointer" }, autoChk, "Auto-refresh (5s)"),
        h("div", { class: "grow" }),
        countEl));

      searchInput.oninput = function () { state.filter = searchInput.value.toLowerCase(); renderRows(); };
      autoChk.onchange = function () { state.auto = autoChk.checked; startAuto(); };
      selectAll.onchange = function () {
        var vis = visibleRows();
        vis.forEach(function (r) { state.selected[r.ip] = selectAll.checked; });
        renderRows();
      };
      bulkBtn.onclick = bulkRelease;

      var headCells = [
        h("th", { style: "width:34px" }, selectAll),
        h("th", null, "IP address"), h("th", null, idColLabel()),
        h("th", null, "Hostname"), h("th", null, "State"),
        h("th", null, "Lease start"), h("th", null, "Expires"), h("th", null, "")
      ];
      container.appendChild(h("div", { class: "card" },
        h("div", { class: "table-wrap" },
          h("table", { class: "data" }, h("thead", null, h("tr", null, headCells)), tbody))));

      renderRows();
    }

    function visibleRows() {
      var f = state.filter;
      return state.rows.filter(function (r) {
        if (!f) return true;
        return (r.ip + " " + r.identifier + " " + (r.hostname || "")).toLowerCase().indexOf(f) >= 0;
      });
    }

    function stateBadge(s) {
      var cls = s === "active" ? "green" : s === "expired" ? "amber" : "red";
      return h("span", { class: "badge " + cls }, s);
    }

    function renderRows() {
      U.clear(tbody);
      var rows = visibleRows();
      countEl.textContent = rows.length + " of " + state.rows.length + " lease(s)";
      var selCount = Object.keys(state.selected).filter(function (k) { return state.selected[k]; }).length;
      bulkBtn.disabled = selCount === 0;
      bulkBtn.textContent = selCount ? "Release selected (" + selCount + ")" : "Release selected";
      if (!rows.length) {
        tbody.appendChild(h("tr", null, h("td", { colspan: 8, class: "table-empty" }, "No active leases.")));
        return;
      }
      rows.forEach(function (r) {
        var cb = h("input", { type: "checkbox", class: "chk", checked: !!state.selected[r.ip] });
        cb.onchange = function () { state.selected[r.ip] = cb.checked; renderRows(); };
        tbody.appendChild(h("tr", null,
          h("td", null, cb),
          h("td", { class: "mono" }, r.ip),
          h("td", { class: "mono" }, r.identifier || "—"),
          h("td", null, r.hostname || h("span", { class: "muted" }, "—")),
          h("td", null, stateBadge(r.state)),
          h("td", null, U.fmtTime(r.start)),
          h("td", null, U.fmtTime(r.expire), r.expire ? h("div", { class: "hint" }, U.fmtRelative(r.expire)) : null),
          h("td", null, h("div", { class: "row-actions" },
            h("button", { class: "btn btn-ghost btn-sm", onClick: function () { renew(r.ip); } }, "Renew"),
            h("button", { class: "btn btn-ghost btn-sm", onClick: function () { release([r.ip]); } }, "Release")))));
      });
    }

    function load() {
      api.get("/leases/v" + state.version).then(function (rows) {
        state.rows = rows;
        // Drop selections for leases that no longer exist.
        var present = {}; rows.forEach(function (r) { present[r.ip] = true; });
        Object.keys(state.selected).forEach(function (k) { if (!present[k]) delete state.selected[k]; });
        renderRows();
      }).catch(function (e) {
        countEl.textContent = "Unavailable";
        U.clear(tbody);
        tbody.appendChild(h("tr", null, h("td", { colspan: 8, class: "table-empty" }, "Could not load leases: " + e.message)));
      });
    }

    function renew(ip) {
      api.post("/leases/v" + state.version + "/renew", { ip: ip })
        .then(function () { window.toast.success("Lease renewed: " + ip); load(); })
        .catch(function (e) { window.toast.error(e.message, "Renew lease"); });
    }

    function release(ips) {
      window.confirmDialog("Release " + ips.length + " lease(s)? The address(es) will return to the pool.",
        { title: "Release lease", danger: true, confirmText: "Release" }).then(function (ok) {
        if (!ok) return;
        api.post("/leases/v" + state.version + "/release", { ips: ips }).then(function (res) {
          if (res.errors && res.errors.length)
            window.toast.error(res.errors.length + " lease(s) failed to release", "Release");
          if (res.released && res.released.length)
            window.toast.success(res.released.length + " lease(s) released");
          ips.forEach(function (ip) { delete state.selected[ip]; });
          load();
        }).catch(function (e) { window.toast.error(e.message, "Release lease"); });
      });
    }

    function bulkRelease() {
      var ips = Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
      if (ips.length) release(ips);
    }

    render();
    load();
    startAuto();
  };
})();
