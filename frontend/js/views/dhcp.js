/* DHCP Configuration view: IPv4 / IPv6 tabs, two-pane subnet editor with an
   inline reservations table. Talks to /api/dhcp4/* and /api/dhcp6/*. */
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

  window.App.views.dhcpConfig = function (container) {
    var state = { version: 4, subnets: [], selectedId: null, mode: "empty" };

    var listBody = h("div", { class: "subnet-list" });
    var detail = h("div");

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
        h("div", { class: "two-pane" },
          h("div", { class: "card" },
            h("div", { class: "card-head" },
              h("h3", null, "Subnets"),
              h("div", { class: "actions" },
                h("button", { class: "btn btn-primary btn-sm", onClick: newSubnet }, "+ New"))),
            listBody),
          h("div", { class: "card" }, detail)));
      renderList();
      renderDetail();
    }

    function loadSubnets() {
      U.clear(listBody);
      listBody.appendChild(h("div", { class: "center-load" }, h("span", { class: "spin spin-dark" }), "Loading…"));
      api.get(base(state.version) + "/subnets").then(function (rows) {
        state.subnets = rows;
        renderList();
        if (state.selectedId != null && !rows.some(function (s) { return s.id === state.selectedId; })) {
          state.selectedId = null; state.mode = "empty";
        }
        renderDetail();
      }).catch(function (e) {
        U.clear(listBody);
        listBody.appendChild(h("div", { class: "table-empty" }, "Could not load subnets."));
        window.toast.error(e.message, "DHCPv" + state.version);
      });
    }

    function renderList() {
      U.clear(listBody);
      if (!state.subnets.length) {
        listBody.appendChild(h("div", { class: "empty" }, "No subnets configured yet. Click “+ New”."));
        return;
      }
      state.subnets.forEach(function (s) {
        var meta = state.version === 4
          ? (s.pool_start ? s.pool_start + " – " + s.pool_end : "no pool")
          : (s.pool_start ? s.pool_start + " – " + s.pool_end : "no pool");
        listBody.appendChild(
          h("div", {
            class: "item" + (state.selectedId === s.id && state.mode === "edit" ? " active" : ""),
            onClick: function () { selectSubnet(s.id); }
          },
            h("span", { class: "cidr" }, s.subnet),
            h("span", { class: "meta" }, meta + " · " + (s.reservation_count || 0) + " reserved")));
      });
    }

    function newSubnet() { state.mode = "new"; state.selectedId = null; renderList(); renderDetail(); }
    function selectSubnet(id) { state.mode = "edit"; state.selectedId = id; renderList(); renderDetail(); }

    function currentSubnet() {
      return state.subnets.filter(function (s) { return s.id === state.selectedId; })[0] || null;
    }

    // --- detail pane ---------------------------------------------------------
    function renderDetail() {
      U.clear(detail);
      if (state.mode === "empty") {
        detail.appendChild(h("div", { class: "card-body" },
          h("div", { class: "table-empty" }, "Select a subnet to view or edit, or create a new one.")));
        return;
      }
      var isNew = state.mode === "new";
      var s = isNew ? {} : currentSubnet();
      if (!isNew && !s) { detail.appendChild(h("div", { class: "card-body" }, "Subnet not found.")); return; }

      detail.appendChild(h("div", { class: "card-head" },
        h("h3", null, isNew ? "New IPv" + state.version + " subnet" : "Subnet " + s.subnet)));

      var form = state.version === 4 ? form4(s) : form6(s);
      detail.appendChild(h("div", { class: "card-body" }, form.el));

      if (!isNew) renderReservations();
    }

    function saveBar(onSave, isNew, onDelete) {
      var saveBtn = h("button", { class: "btn btn-primary" }, isNew ? "Create subnet" : "Save changes");
      saveBtn.addEventListener("click", function () { onSave(saveBtn); });
      var children = [saveBtn];
      if (!isNew) {
        children.push(h("button", { class: "btn btn-danger btn-outline", onClick: onDelete }, "Delete subnet"));
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
      var valid = h("input", { type: "number", value: s.valid_lifetime != null ? s.valid_lifetime : 4000 });
      var renew = h("input", { type: "number", value: s.renew_timer != null ? s.renew_timer : 1000 });
      var rebind = h("input", { type: "number", value: s.rebind_timer != null ? s.rebind_timer : 2000 });
      var errEl = h("div", { class: "err-text" });

      function read() {
        return {
          subnet: subnet.value.trim(), pool_start: poolStart.value.trim(), pool_end: poolEnd.value.trim(),
          gateway: gateway.value.trim(),
          dns_servers: dns.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean),
          valid_lifetime: Number(valid.value), renew_timer: Number(renew.value), rebind_timer: Number(rebind.value)
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
          field("Subnet (CIDR)", subnet, { req: true, full: false }),
          field("Subnet mask", netmask, { hint: "Derived from the prefix" }),
          field("Pool start", poolStart, { req: true }),
          field("Pool end", poolEnd, { req: true }),
          field("Default gateway", gateway, { hint: "Optional (routers option)" }),
          field("DNS servers", dns, { hint: "Comma-separated" }),
          field("Valid lifetime (s)", valid),
          field("Renew timer (s)", renew),
          field("Rebind timer (s)", rebind)),
        errEl,
        saveBar(function (btn) { submitSubnet(read, validate, errEl, btn); }, isNew, deleteSubnet));
      return { el: el };
    }

    // IPv6 form
    function form6(s) {
      var subnet = h("input", { type: "text", value: s.subnet || "", placeholder: "2001:db8:1::/64" });
      var poolStart = h("input", { type: "text", value: s.pool_start || "", placeholder: "2001:db8:1::1000" });
      var poolEnd = h("input", { type: "text", value: s.pool_end || "", placeholder: "2001:db8:1::ffff" });
      var dns = h("input", { type: "text", value: (s.dns_servers || []).join(", "), placeholder: "2001:4860:4860::8888" });
      var pref = h("input", { type: "number", value: s.preferred_lifetime != null ? s.preferred_lifetime : 3000 });
      var valid = h("input", { type: "number", value: s.valid_lifetime != null ? s.valid_lifetime : 4000 });
      var renew = h("input", { type: "number", value: s.renew_timer != null ? s.renew_timer : 1000 });
      var rebind = h("input", { type: "number", value: s.rebind_timer != null ? s.rebind_timer : 2000 });
      var errEl = h("div", { class: "err-text" });

      function read() {
        return {
          subnet: subnet.value.trim(), pool_start: poolStart.value.trim(), pool_end: poolEnd.value.trim(),
          dns_servers: dns.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean),
          preferred_lifetime: Number(pref.value), valid_lifetime: Number(valid.value),
          renew_timer: Number(renew.value), rebind_timer: Number(rebind.value)
        };
      }
      function validate(p) {
        var e = V.cidr(p.subnet, 6); if (e) return e;
        e = V.pool(p.pool_start, p.pool_end, p.subnet, 6); if (e) return e;
        for (var i = 0; i < p.dns_servers.length; i++) { e = V.ip(p.dns_servers[i], 6); if (e) return "DNS " + e; }
        e = V.timers(p.valid_lifetime, p.renew_timer, p.rebind_timer); if (e) return e;
        if (Number(p.preferred_lifetime) < 0) return "Preferred lifetime must be non-negative";
        if (p.valid_lifetime && Number(p.preferred_lifetime) > p.valid_lifetime)
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
          field("Preferred lifetime (s)", pref),
          field("Valid lifetime (s)", valid),
          field("Renew timer (s)", renew),
          field("Rebind timer (s)", rebind)),
        errEl,
        saveBar(function (btn) { submitSubnet(read, validate, errEl, btn); }, isNew, deleteSubnet));
      return { el: el };
    }

    function submitSubnet(read, validate, errEl, btn) {
      errEl.textContent = "";
      var payload = read();
      var err = validate(payload);
      if (err) { errEl.textContent = err; return; }
      var isNew = state.mode === "new";
      btn.disabled = true; var label = btn.textContent; btn.innerHTML = '<span class="spin"></span>';
      var req = isNew
        ? api.post(base(state.version) + "/subnets", payload)
        : api.put(base(state.version) + "/subnets/" + state.selectedId, payload);
      req.then(function (created) {
        window.toast.success((isNew ? "Subnet created: " : "Subnet updated: ") + payload.subnet);
        var newId = created && created.id;
        api.get(base(state.version) + "/subnets").then(function (rows) {
          state.subnets = rows;
          if (isNew && newId != null) { state.mode = "edit"; state.selectedId = newId; }
          renderList(); renderDetail();
        });
      }).catch(function (e) {
        errEl.textContent = e.message; btn.disabled = false; btn.textContent = label;
        window.toast.error(e.message, "DHCPv" + state.version);
      });
    }

    function deleteSubnet() {
      var s = currentSubnet(); if (!s) return;
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
      detail.appendChild(card);

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
            loadSubnets(); renderReservationsRefresh();
          });
        }
      });
    }

    // Re-render only the reservation table (detail already has the subnet form).
    function renderReservationsRefresh() {
      // Remove the last card (reservations) then re-add.
      var cards = detail.querySelectorAll(".card");
      if (cards.length) { /* the reservations card is appended last in detail */ }
      // Simplest: fully re-render detail (keeps form + reloads reservations).
      renderDetail();
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
