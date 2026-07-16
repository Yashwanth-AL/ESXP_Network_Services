/* DHCP Configuration view: IPv4 / IPv6 tabs, full-width subnet table with a
   stacked detail panel (subnet form + reservations) below it. Talks to
   /api/dhcp4/* and /api/dhcp6/*. */
(function () {
  "use strict";
  var h = window.h, U = window.U, V = window.V, api = window.api;

  function base(version) { return version === 4 ? "/dhcp4" : "/dhcp6"; }

  function netmaskFromCidr(cidrStr) {
    var slash = String(cidrStr).split("/");
    if (slash.length !== 2 || !V.isIPv4(slash[0])) return "";
    var p = Number(slash[1]);
    if (!(p >= 0 && p <= 32)) return "";
    var mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
    return [(mask >>> 24) & 255, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255].join(".");
  }

  function field(label, input, opts) {
    opts = opts || {};
    return h("div", { class: "field" + (opts.full ? " full" : "") },
      h("label", null, label + (opts.req ? " *" : "")),
      input,
      opts.hint ? h("div", { class: "hint" }, opts.hint) : null);
  }

  // --- duration helpers (seconds <-> friendly amount+unit) -------------------
  // Kea's API wants plain integer seconds. These helpers let the operator pick
  // an amount plus a unit (minutes/hours/days) instead of typing raw seconds.
  var UNIT_SECONDS = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
  var UNIT_ORDER = ["days", "hours", "minutes", "seconds"];

  function decomposeSeconds(sec) {
    sec = Number(sec) || 0;
    if (sec === 0) return { amount: 0, unit: "seconds" };
    for (var i = 0; i < UNIT_ORDER.length; i++) {
      var unit = UNIT_ORDER[i];
      var factor = UNIT_SECONDS[unit];
      if (sec % factor === 0) return { amount: sec / factor, unit: unit };
    }
    return { amount: sec, unit: "seconds" };
  }

  function toSeconds(amount, unit) {
    var factor = UNIT_SECONDS[unit] || 1;
    var n = Number(amount);
    if (!isFinite(n) || n < 0) n = 0;
    return Math.round(n * factor);
  }

  // A "field" whose control is [number amount] + [unit select], returning the
  // total in seconds via getSeconds(). Drop-in alongside field() in a form-grid.
  function durationField(label, seconds, opts) {
    opts = opts || {};
    var d = decomposeSeconds(seconds);
    var amountInput = h("input", { type: "number", min: "0", value: String(d.amount) });
    var unitSelect = h("select");
    UNIT_ORDER.slice().reverse().forEach(function (u) {
      var opt = h("option", { value: u }, u.charAt(0).toUpperCase() + u.slice(1));
      if (u === d.unit) opt.selected = true;
      unitSelect.appendChild(opt);
    });
    var wrap = h("div", { class: "field" + (opts.full ? " full" : "") },
      h("label", null, label + (opts.req ? " *" : "")),
      h("div", { class: "duration-row" }, amountInput, unitSelect),
      opts.hint ? h("div", { class: "hint" }, opts.hint) : null);
    return { el: wrap, getSeconds: function () { return toSeconds(amountInput.value, unitSelect.value); } };
  }

  window.App.views.dhcpConfig = function (container) {
    var state = { version: 4, subnets: [], selectedId: null, mode: "empty" };
    var reqSeq = 0;   // bumped per loadSubnets(); stale responses are discarded

    var listBody = h("tbody"); // persists across renderShell() calls; repopulated by renderList()
    var detailWrap = h("div"); // holds the config card + reservations card, stacked full-width

    function tabButton(v, label) {
      return h("div", {
        class: "tab" + (state.version === v ? " active" : ""),
        onClick: function () {
          if (state.version === v) return;
          state.version = v; state.selectedId = null; state.mode = "empty";
          renderShell(); loadSubnets();
        }
      }, label);
    }

    function theadRow() {
      return state.version === 4
        ? h("tr", null, h("th", null, "Subnet"), h("th", null, "Pool range"),
            h("th", null, "Gateway"), h("th", null, "DNS servers"),
            h("th", null, "Valid lifetime"), h("th", null, "Reserved"), h("th", null, ""))
        : h("tr", null, h("th", null, "Subnet"), h("th", null, "Pool range"),
            h("th", null, "DNS servers"), h("th", null, "Preferred / Valid"),
            h("th", null, "Reserved"), h("th", null, ""));
    }
    function colCount() { return state.version === 4 ? 7 : 6; }

    function renderShell() {
      U.clear(container);
      container.appendChild(
        h("div", { class: "page-head" },
          h("div", null,
            h("h1", null, "DHCP Configuration"),
            h("div", { class: "sub" }, "Manage subnets and static reservations for the Kea DHCP server"))));
      container.appendChild(
        h("div", { class: "tabs" }, tabButton(4, "IPv4"), tabButton(6, "IPv6")));

      container.appendChild(
        h("div", { class: "card" },
          h("div", { class: "card-head" },
            h("h3", null, "Subnets"),
            h("div", { class: "actions" },
              h("button", { class: "btn btn-primary btn-sm", onClick: newSubnet }, "+ New subnet"))),
          h("div", { class: "table-wrap" },
            h("table", { class: "data" }, h("thead", null, theadRow()), listBody))));

      container.appendChild(detailWrap);
      renderList();
      renderDetail();
    }

    function loadSubnets() {
      U.clear(listBody);
      listBody.appendChild(h("tr", null,
        h("td", { colspan: colCount(), class: "center-load" }, h("span", { class: "spin spin-dark" }), "Loading…")));
      // Tag each request so a slow response for the tab we just left cannot
      // overwrite the tab we are now on (switch IPv4 -> IPv6 fast enough and the
      // last response to land wins, rendering the wrong family's subnets).
      var seq = ++reqSeq;
      var version = state.version;
      api.get(base(version) + "/subnets").then(function (rows) {
        if (seq !== reqSeq) return;
        state.subnets = rows;
        renderList();
        if (state.selectedId != null && !rows.some(function (s) { return s.id === state.selectedId; })) {
          state.selectedId = null; state.mode = "empty";
        }
        renderDetail();
      }).catch(function (e) {
        if (seq !== reqSeq) return;
        U.clear(listBody);
        listBody.appendChild(h("tr", null, h("td", { colspan: colCount(), class: "table-empty" }, "Could not load subnets.")));
        window.toast.error(e.message, "DHCPv" + version);
      });
    }

    function renderList() {
      U.clear(listBody);
      if (!state.subnets.length) {
        listBody.appendChild(h("tr", null,
          h("td", { colspan: colCount(), class: "table-empty" }, "No subnets configured yet. Click “+ New subnet”.")));
        return;
      }
      state.subnets.forEach(function (s) {
        var selected = state.selectedId === s.id && state.mode === "edit";
        var pool = s.pool_start ? (s.pool_start + " – " + s.pool_end) : "—";
        var dns = (s.dns_servers && s.dns_servers.length) ? s.dns_servers.join(", ") : "—";
        var actions = h("div", { class: "row-actions" },
          h("button", {
            class: "btn btn-ghost btn-sm",
            onClick: function (e) { e.stopPropagation(); selectSubnet(s.id); }
          }, "Configure"),
          h("button", {
            class: "btn btn-ghost btn-sm",
            onClick: function (e) { e.stopPropagation(); deleteSubnet(s); }
          }, "Delete"));

        var cells = state.version === 4
          ? [h("td", { class: "mono subnet-cidr" }, s.subnet), h("td", null, pool),
             h("td", null, s.gateway || "—"), h("td", null, dns),
             h("td", null, U.fmtDuration(s.valid_lifetime)),
             h("td", null, String(s.reservation_count || 0)), h("td", null, actions)]
          : [h("td", { class: "mono subnet-cidr" }, s.subnet), h("td", null, pool),
             h("td", null, dns),
             h("td", null, U.fmtDuration(s.preferred_lifetime) + " / " + U.fmtDuration(s.valid_lifetime)),
             h("td", null, String(s.reservation_count || 0)), h("td", null, actions)];

        listBody.appendChild(h("tr", {
          class: "clickable" + (selected ? " selected" : ""),
          onClick: function () { selectSubnet(s.id); }
        }, cells));
      });
    }

    function newSubnet() { state.mode = "new"; state.selectedId = null; renderList(); renderDetail(); }
    function selectSubnet(id) { state.mode = "edit"; state.selectedId = id; renderList(); renderDetail(); }
    function closeDetail() { state.mode = "empty"; state.selectedId = null; renderList(); renderDetail(); }

    function currentSubnet() {
      return state.subnets.filter(function (s) { return s.id === state.selectedId; })[0] || null;
    }

    // --- detail (config form + reservations), stacked below the table --------
    function renderDetail() {
      U.clear(detailWrap);
      if (state.mode === "empty") {
        if (state.subnets.length) {
          detailWrap.appendChild(h("div", { class: "muted", style: "padding:10px 2px" },
            "Select a subnet above to configure it, or click “+ New subnet”."));
        }
        return;
      }
      var isNew = state.mode === "new";
      var s = isNew ? {} : currentSubnet();
      if (!isNew && !s) return;

      var card = h("div", { class: "card" },
        h("div", { class: "card-head" },
          h("h3", null, isNew ? "New IPv" + state.version + " subnet" : "Configure " + s.subnet),
          h("div", { class: "actions" },
            h("button", { class: "btn btn-ghost btn-sm", onClick: closeDetail }, "Close"))));
      var form = state.version === 4 ? form4(s) : form6(s);
      card.appendChild(h("div", { class: "card-body" }, form.el));
      detailWrap.appendChild(card);

      if (!isNew) renderReservations();
    }

    // The editor surfaces a single pool, but Kea allows several per subnet
    // (pre-dashboard or hand-added ones are preserved on save). When more
    // exist, say so -- otherwise the operator has no way to know the pool
    // fields only cover the first one.
    function multiPoolNote(s) {
      if (!s || !(s.pool_count > 1)) return null;
      var others = s.pool_count - 1;
      var tail = others === 1 ? "the other pool is kept as-is when you save."
        : "the other " + others + " pools are kept as-is when you save.";
      return h("div", { class: "banner", style: "margin-top:14px" },
        h("span", null, "This subnet has " + s.pool_count + " address pools in Kea. " +
          "The fields above edit only the first pool; " + tail));
    }

    // statusWrap shows the outcome of Verify (and of a failed/succeeded Save)
    // right next to the buttons that triggered it.
    function showStatus(statusWrap, ok, message) {
      U.clear(statusWrap);
      if (!message) return;
      statusWrap.appendChild(h("div", { class: "banner " + (ok ? "success" : "error") },
        h("strong", null, ok ? "Valid" : "Invalid"), h("span", null, message)));
    }

    function saveBar(onVerify, onSave, isNew, onDelete) {
      var verifyBtn = h("button", { class: "btn btn-outline" }, "Verify");
      verifyBtn.addEventListener("click", function () { onVerify(verifyBtn); });
      var saveBtn = h("button", { class: "btn btn-primary" }, isNew ? "Create subnet" : "Save changes");
      saveBtn.addEventListener("click", function () { onSave(saveBtn); });
      var children = [verifyBtn, saveBtn];
      if (!isNew) {
        children.push(h("button", { class: "btn btn-danger btn-outline", onClick: function () { onDelete(); } }, "Delete subnet"));
      }
      return h("div", { class: "form-actions" }, children);
    }

    // IPv4 form
    function form4(s) {
      var subnet = h("input", { type: "text", value: s.subnet || "", placeholder: "192.168.10.0/24" });
      var netmask = h("input", { type: "text", value: s.netmask || netmaskFromCidr(s.subnet || ""), disabled: true });
      subnet.addEventListener("input", function () { netmask.value = netmaskFromCidr(subnet.value); });
      var poolStart = h("input", { type: "text", value: s.pool_start || "", placeholder: "192.168.10.50" });
      var poolEnd = h("input", { type: "text", value: s.pool_end || "", placeholder: "192.168.10.200" });
      var gateway = h("input", { type: "text", value: s.gateway || "", placeholder: "192.168.10.1" });
      var dns = h("input", { type: "text", value: (s.dns_servers || []).join(", "), placeholder: "8.8.8.8, 8.8.4.4" });
      var validD = durationField("Valid lifetime", s.valid_lifetime != null ? s.valid_lifetime : 4000);
      var renewD = durationField("Renew timer", s.renew_timer != null ? s.renew_timer : 1000);
      var rebindD = durationField("Rebind timer", s.rebind_timer != null ? s.rebind_timer : 2000);
      var errEl = h("div", { class: "err-text" });
      var statusWrap = h("div");

      function read() {
        return {
          subnet: subnet.value.trim(), pool_start: poolStart.value.trim(), pool_end: poolEnd.value.trim(),
          gateway: gateway.value.trim(),
          dns_servers: dns.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean),
          valid_lifetime: validD.getSeconds(), renew_timer: renewD.getSeconds(), rebind_timer: rebindD.getSeconds()
        };
      }
      function validate(p) {
        var e = V.cidr(p.subnet, 4); if (e) return e;
        e = V.pool(p.pool_start, p.pool_end, p.subnet, 4); if (e) return e;
        if (p.gateway) { e = V.inSubnet(p.gateway, p.subnet, 4); if (e) return "Gateway " + e; }
        for (var i = 0; i < p.dns_servers.length; i++) { e = V.ip(p.dns_servers[i], 4); if (e) return "DNS " + e; }
        return V.timers(p.valid_lifetime, p.renew_timer, p.rebind_timer);
      }
      var isNew = state.mode === "new";
      var el = h("div", null,
        h("div", { class: "form-grid" },
          field("Subnet (CIDR)", subnet, { req: true }),
          field("Subnet mask", netmask, { hint: "Derived from the prefix" }),
          field("Pool start", poolStart, { req: true }),
          field("Pool end", poolEnd, { req: true }),
          field("Default gateway", gateway, { hint: "Optional (routers option)" }),
          field("DNS servers", dns, { hint: "Comma-separated" }),
          validD.el, renewD.el, rebindD.el),
        multiPoolNote(s),
        errEl, statusWrap,
        saveBar(
          function (btn) { verifySubnet(read, validate, errEl, statusWrap, btn); },
          function (btn) { submitSubnet(read, validate, errEl, statusWrap, btn); },
          isNew, deleteSubnet));
      return { el: el };
    }

    // IPv6 form
    function form6(s) {
      var subnet = h("input", { type: "text", value: s.subnet || "", placeholder: "2001:db8:1::/64" });
      var poolStart = h("input", { type: "text", value: s.pool_start || "", placeholder: "2001:db8:1::1000" });
      var poolEnd = h("input", { type: "text", value: s.pool_end || "", placeholder: "2001:db8:1::ffff" });
      var dns = h("input", { type: "text", value: (s.dns_servers || []).join(", "), placeholder: "2001:4860:4860::8888" });
      var prefD = durationField("Preferred lifetime", s.preferred_lifetime != null ? s.preferred_lifetime : 3000);
      var validD = durationField("Valid lifetime", s.valid_lifetime != null ? s.valid_lifetime : 4000);
      var renewD = durationField("Renew timer", s.renew_timer != null ? s.renew_timer : 1000);
      var rebindD = durationField("Rebind timer", s.rebind_timer != null ? s.rebind_timer : 2000);
      var errEl = h("div", { class: "err-text" });
      var statusWrap = h("div");

      function read() {
        return {
          subnet: subnet.value.trim(), pool_start: poolStart.value.trim(), pool_end: poolEnd.value.trim(),
          dns_servers: dns.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean),
          preferred_lifetime: prefD.getSeconds(), valid_lifetime: validD.getSeconds(),
          renew_timer: renewD.getSeconds(), rebind_timer: rebindD.getSeconds()
        };
      }
      function validate(p) {
        var e = V.cidr(p.subnet, 6); if (e) return e;
        e = V.pool(p.pool_start, p.pool_end, p.subnet, 6); if (e) return e;
        for (var i = 0; i < p.dns_servers.length; i++) { e = V.ip(p.dns_servers[i], 6); if (e) return "DNS " + e; }
        e = V.timers(p.valid_lifetime, p.renew_timer, p.rebind_timer); if (e) return e;
        if (p.valid_lifetime && p.preferred_lifetime > p.valid_lifetime)
          return "Preferred lifetime must not exceed valid lifetime";
        return null;
      }
      var isNew = state.mode === "new";
      var el = h("div", null,
        h("div", { class: "form-grid" },
          field("Subnet prefix (CIDR)", subnet, { req: true, full: true }),
          field("Pool start", poolStart, { req: true }),
          field("Pool end", poolEnd, { req: true }),
          field("DNS servers", dns, { hint: "Comma-separated", full: true }),
          prefD.el, validD.el, renewD.el, rebindD.el),
        multiPoolNote(s),
        errEl, statusWrap,
        saveBar(
          function (btn) { verifySubnet(read, validate, errEl, statusWrap, btn); },
          function (btn) { submitSubnet(read, validate, errEl, statusWrap, btn); },
          isNew, deleteSubnet));
      return { el: el };
    }

    function verifySubnet(read, validate, errEl, statusWrap, btn) {
      errEl.textContent = ""; U.clear(statusWrap);
      var payload = read();
      var err = validate(payload);
      if (err) { errEl.textContent = err; return; }
      var isNew = state.mode === "new";
      btn.disabled = true; var label = btn.textContent; btn.innerHTML = '<span class="spin spin-dark"></span>';
      var path = base(state.version) + "/subnets" + (isNew ? "/verify" : "/" + state.selectedId + "/verify");
      api.post(path, payload).then(function (res) {
        showStatus(statusWrap, res.ok, res.message);
        if (!res.ok) window.toast.error(res.message, "Validation failed");
      }).catch(function (e) {
        showStatus(statusWrap, false, e.message);
        window.toast.error(e.message, "DHCPv" + state.version);
      }).then(function () { btn.disabled = false; btn.textContent = label; });
    }

    function submitSubnet(read, validate, errEl, statusWrap, btn) {
      errEl.textContent = ""; U.clear(statusWrap);
      var payload = read();
      var err = validate(payload);
      if (err) { errEl.textContent = err; return; }
      var isNew = state.mode === "new";
      var version = state.version;
      btn.disabled = true; var label = btn.textContent; btn.innerHTML = '<span class="spin"></span>';
      var req = isNew
        ? api.post(base(version) + "/subnets", payload)
        : api.put(base(version) + "/subnets/" + state.selectedId, payload);
      req.then(function (created) {
        window.toast.success((isNew ? "Subnet created: " : "Subnet updated: ") + payload.subnet);
        var newId = created && created.id;
        // The save itself already succeeded. If this follow-up refresh fails we
        // must still restore the button -- renderDetail() is what would normally
        // rebuild it, so without this the Save button stays spinning forever and
        // the only way out is to leave and re-enter the view.
        // The refresh joins the same stale-response sequence as loadSubnets():
        // without the seq/version check, switching to the other family tab while
        // this GET is in flight would repaint the old family's rows (and, on a
        // create, select an id from the wrong family) once it lands.
        var seq = ++reqSeq;
        return api.get(base(version) + "/subnets").then(function (rows) {
          if (seq !== reqSeq || version !== state.version) return;
          state.subnets = rows;
          if (isNew && newId != null) { state.mode = "edit"; state.selectedId = newId; }
          renderList(); renderDetail();
        }).catch(function (e) {
          if (seq !== reqSeq || version !== state.version) return;
          btn.disabled = false; btn.textContent = label;
          window.toast.error("Saved, but the subnet list could not be refreshed: " + e.message,
            "DHCPv" + version);
        });
      }).catch(function (e) {
        errEl.textContent = e.message; btn.disabled = false; btn.textContent = label;
        window.toast.error(e.message, "DHCPv" + version);
      });
    }

    function deleteSubnet(target) {
      var s = target || currentSubnet(); if (!s) return;
      window.confirmDialog("Delete subnet " + s.subnet + " and all its reservations?",
        { title: "Delete subnet", danger: true, confirmText: "Delete" }).then(function (ok) {
        if (!ok) return;
        api.del(base(state.version) + "/subnets/" + s.id).then(function () {
          window.toast.success("Subnet deleted: " + s.subnet);
          state.mode = "empty"; state.selectedId = null; loadSubnets();
        }).catch(function (e) { window.toast.error(e.message, "Delete subnet"); });
      });
    }

    // --- reservations --------------------------------------------------------
    function renderReservations() {
      var idType = state.version === 4 ? "MAC" : "DUID";
      var tbody = h("tbody");
      var card = h("div", { class: "card", style: "margin-top:18px" },
        h("div", { class: "card-head" },
          h("h3", null, "Reservations"),
          h("div", { class: "actions" },
            h("button", { class: "btn btn-primary btn-sm", onClick: function () { reservationModal(null); } }, "+ Add reservation"))),
        h("div", { class: "table-wrap" },
          h("table", { class: "data" },
            h("thead", null, h("tr", null,
              h("th", null, idType), h("th", null, "Reserved IP"), h("th", null, "Hostname"), h("th", null, ""))),
            tbody)));
      detailWrap.appendChild(card);

      api.get(base(state.version) + "/subnets/" + state.selectedId + "/reservations").then(function (rows) {
        U.clear(tbody);
        if (!rows.length) {
          tbody.appendChild(h("tr", null, h("td", { colspan: 4, class: "table-empty" }, "No reservations.")));
          return;
        }
        rows.forEach(function (r) {
          var idVal = state.version === 4 ? r.mac : r.duid;
          tbody.appendChild(h("tr", null,
            h("td", { class: "mono" }, idVal),
            h("td", { class: "mono" }, r.ip),
            h("td", null, r.hostname || h("span", { class: "muted" }, "—")),
            h("td", null, h("div", { class: "row-actions" },
              h("button", { class: "btn btn-ghost btn-sm", onClick: function () { reservationModal(r); } }, "Edit"),
              h("button", { class: "btn btn-ghost btn-sm", onClick: function () { deleteReservation(idVal); } }, "Delete")))));
        });
      }).catch(function (e) {
        U.clear(tbody);
        tbody.appendChild(h("tr", null, h("td", { colspan: 4, class: "table-empty" }, "Could not load reservations.")));
        window.toast.error(e.message, "Reservations");
      });
    }

    function reservationModal(existing) {
      var v = state.version;
      var idField = v === 4
        ? { name: "id", label: "MAC address", value: existing ? existing.mac : "", placeholder: "aa:bb:cc:dd:ee:ff", required: true }
        : { name: "id", label: "DUID", value: existing ? existing.duid : "", placeholder: "00:01:00:01:...", required: true };
      window.openFormModal({
        title: (existing ? "Edit" : "Add") + " reservation",
        submitText: existing ? "Save" : "Add",
        fields: [
          idField,
          { name: "ip", label: "Reserved IP", value: existing ? existing.ip : "", required: true,
            placeholder: v === 4 ? "192.168.10.20" : "2001:db8:1::20" },
          { name: "hostname", label: "Hostname", value: existing ? existing.hostname : "", placeholder: "optional" }
        ],
        onSubmit: function (vals) {
          var err = v === 4 ? V.mac(vals.id) : V.duid(vals.id);
          if (err) throw new Error(err);
          err = V.ip(vals.ip, v); if (err) throw new Error(err);
          err = V.inSubnet(vals.ip, currentSubnet().subnet, v); if (err) throw new Error(err);
          err = V.hostname(vals.hostname); if (err) throw new Error(err);
          var payload = v === 4
            ? { mac: vals.id, ip: vals.ip, hostname: vals.hostname }
            : { duid: vals.id, ip: vals.ip, hostname: vals.hostname };
          var path = base(v) + "/subnets/" + state.selectedId + "/reservations";
          var req = existing
            ? api.put(path + "/" + encodeURIComponent(v === 4 ? existing.mac : existing.duid), payload)
            : api.post(path, payload);
          return req.then(function () {
            window.toast.success("Reservation " + (existing ? "updated" : "added"));
            loadSubnets(); renderDetail();
          });
        }
      });
    }

    function deleteReservation(idVal) {
      window.confirmDialog("Delete reservation " + idVal + "?",
        { title: "Delete reservation", danger: true, confirmText: "Delete" }).then(function (ok) {
        if (!ok) return;
        var path = base(state.version) + "/subnets/" + state.selectedId + "/reservations/" + encodeURIComponent(idVal);
        api.del(path).then(function () {
          window.toast.success("Reservation deleted");
          loadSubnets(); renderDetail();
        }).catch(function (e) { window.toast.error(e.message, "Delete reservation"); });
      });
    }

    renderShell();
    loadSubnets();
  };
})();
