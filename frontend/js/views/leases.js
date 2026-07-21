/* Active Leases view: two live sections -- devices reachable on the network
   right now ("Connected"), and everything else ("Other leases"). Search, renew
   and release (single + bulk) work across both. IPv4 / IPv6 tabs. */
(function () {
  "use strict";
  var h = window.h, U = window.U, api = window.api;
  var REFRESH_MS = 5000;

  window.App.views.leases = function (container) {
    var state = { version: 4, rows: [], filter: "", auto: true, selected: {} };
    var timer = null;
    var reqSeq = 0;   // bumped per load(); stale responses are discarded

    var searchInput = h("input", { type: "search", placeholder: "Search IP, MAC/DUID, or hostname…" });
    var autoChk = h("input", { type: "checkbox", class: "chk", checked: true });
    var countEl = h("span", { class: "muted" });
    var bulkBtn = h("button", { class: "btn btn-outline btn-sm", disabled: true }, "Release selected");

    // Two independent sections, each with its own table body, count and header
    // select-all. `connected` = reachable on the wire now (ARP/ping).
    var sections = {
      connected: { body: h("tbody"), count: h("span", { class: "sec-count" }),
        all: h("input", { type: "checkbox", class: "chk" }) },
      other: { body: h("tbody"), count: h("span", { class: "sec-count" }),
        all: h("input", { type: "checkbox", class: "chk" }) }
    };

    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function startAuto() { stop(); if (state.auto) timer = setInterval(load, REFRESH_MS); }
    window.App.addCleanup(stop);

    function tab(v, label) {
      return h("div", { class: "tab" + (state.version === v ? " active" : ""),
        onClick: function () { if (state.version !== v) { state.version = v; state.selected = {}; render(); load(); } } }, label);
    }

    function idColLabel() { return state.version === 4 ? "MAC address" : "DUID"; }

    function headRow(selectAllBox) {
      return h("tr", null,
        h("th", { style: "width:34px" }, selectAllBox),
        h("th", null, "IP address"), h("th", null, idColLabel()),
        h("th", null, "Hostname"), h("th", null, "Lease state"),
        h("th", null, "Lease start"), h("th", null, "Expires"), h("th", null, ""));
    }

    function sectionCard(key, title, subtitle, tone) {
      var s = sections[key];
      s.all.onchange = function () {
        rowsFor(key).forEach(function (r) { state.selected[r.ip] = s.all.checked; });
        renderRows();
      };
      return h("div", { class: "card lease-section" },
        h("div", { class: "card-head" },
          h("h3", null, h("span", { class: "sec-dot " + tone }), title,
            " ", s.count),
          h("div", { class: "actions" }, h("span", { class: "muted sec-sub" }, subtitle))),
        h("div", { class: "table-wrap" },
          h("table", { class: "data" }, h("thead", null, headRow(s.all)), s.body)));
    }

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
          h("span", { unsafeHTML: U.icon('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>', 16) }),
          searchInput),
        bulkBtn,
        h("label", { class: "status-pill", style: "cursor:pointer" }, autoChk, "Auto-refresh (5s)"),
        h("div", { class: "grow" }),
        countEl));

      searchInput.oninput = function () { state.filter = searchInput.value.toLowerCase(); renderRows(); };
      autoChk.onchange = function () { state.auto = autoChk.checked; startAuto(); };
      bulkBtn.onclick = bulkRelease;

      container.appendChild(h("div", { class: "lease-sections" },
        sectionCard("connected", "Connected devices", "reachable on the network now", "green"),
        sectionCard("other", "Other leases", "leased, not reachable right now", "gray")));

      renderRows();
    }

    function visibleRows() {
      var f = state.filter;
      return state.rows.filter(function (r) {
        if (!f) return true;
        return (r.ip + " " + r.identifier + " " + (r.hostname || "")).toLowerCase().indexOf(f) >= 0;
      });
    }

    function rowsFor(key) {
      return visibleRows().filter(function (r) { return key === "connected" ? r.connected : !r.connected; });
    }

    function stateBadge(s) {
      var cls = s === "active" ? "green" : s === "expired" ? "amber" : "red";
      return h("span", { class: "badge " + cls }, s);
    }

    function leaseRow(r) {
      var cb = h("input", { type: "checkbox", class: "chk", checked: !!state.selected[r.ip] });
      cb.onchange = function () { state.selected[r.ip] = cb.checked; renderRows(); };
      var ipCell = r.connected
        ? h("td", { class: "mono" }, h("span", { class: "sec-dot green live" }), r.ip)
        : h("td", { class: "mono" }, r.ip);
      return h("tr", null,
        h("td", null, cb),
        ipCell,
        h("td", { class: "mono" }, r.identifier || "—"),
        h("td", null, r.hostname || h("span", { class: "muted" }, "—")),
        h("td", null, stateBadge(r.state)),
        h("td", null, U.fmtTime(r.start)),
        h("td", null, U.fmtTime(r.expire), r.expire ? h("div", { class: "hint" }, U.fmtRelative(r.expire)) : null),
        h("td", null, h("div", { class: "row-actions" },
          h("button", { class: "btn btn-ghost btn-sm", onClick: function () { renew(r.ip); } }, "Renew"),
          h("button", { class: "btn btn-ghost btn-sm", onClick: function () { release([r.ip]); } }, "Release"))));
    }

    function fillSection(key, emptyText) {
      var s = sections[key];
      var rows = rowsFor(key);
      U.clear(s.body);
      s.count.textContent = "(" + rows.length + ")";
      if (!rows.length) {
        s.body.appendChild(h("tr", null, h("td", { colspan: 8, class: "table-empty" }, emptyText)));
        s.all.checked = false; s.all.disabled = true;
        return;
      }
      s.all.disabled = false;
      s.all.checked = rows.every(function (r) { return state.selected[r.ip]; });
      rows.forEach(function (r) { s.body.appendChild(leaseRow(r)); });
    }

    function renderRows() {
      var total = state.rows.length;
      var shown = visibleRows().length;
      countEl.textContent = shown + " of " + total + " lease(s)";
      fillSection("connected", "No leased devices are reachable right now.");
      fillSection("other", "No other leases.");
      var selCount = Object.keys(state.selected).filter(function (k) { return state.selected[k]; }).length;
      bulkBtn.disabled = selCount === 0;
      bulkBtn.textContent = selCount ? "Release selected (" + selCount + ")" : "Release selected";
    }

    function load() {
      // Tag each request so a slow response for the tab we just left cannot
      // overwrite the tab we are now on: switching v4 -> v6 quickly leaves two
      // fetches in flight, and without this the last one to land wins and we
      // render v4 leases (MAC) under the v6 (DUID) headers.
      var seq = ++reqSeq;
      var version = state.version;
      api.get("/leases/v" + version).then(function (rows) {
        if (seq !== reqSeq) return;
        state.rows = rows;
        var present = {}; rows.forEach(function (r) { present[r.ip] = true; });
        Object.keys(state.selected).forEach(function (k) { if (!present[k]) delete state.selected[k]; });
        renderRows();
      }).catch(function (e) {
        if (seq !== reqSeq) return;
        countEl.textContent = "Unavailable";
        U.clear(sections.connected.body); U.clear(sections.other.body);
        sections.other.body.appendChild(h("tr", null,
          h("td", { colspan: 8, class: "table-empty" }, "Could not load leases: " + e.message)));
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
