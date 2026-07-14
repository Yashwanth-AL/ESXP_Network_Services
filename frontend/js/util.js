/* Shared helpers + global namespace. Loaded first. No framework, no build. */
(function () {
  "use strict";

  // Tiny hyperscript-style DOM builder.
  //   h('div', {class:'x', onClick: fn}, 'text', childNode)
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "dataset") { for (var d in v) el.dataset[d] = v[d]; }
        else if (k.slice(0, 2) === "on" && typeof v === "function") {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, v);
      }
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    if (typeof child === "string" || typeof child === "number") {
      el.appendChild(document.createTextNode(String(child)));
    } else {
      el.appendChild(child);
    }
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function icon(path, size) {
    var s = size || 18;
    return '<svg class="nav-icon" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round">' + path + "</svg>";
  }

  // Format an ISO8601 timestamp (UTC) into a readable local string.
  function fmtTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  }

  // Relative "in 2h 5m" / "3m ago" from an ISO timestamp.
  function fmtRelative(iso) {
    if (!iso) return "";
    var diff = new Date(iso).getTime() - Date.now();
    var past = diff < 0;
    var s = Math.abs(Math.floor(diff / 1000));
    var parts = [];
    var h = Math.floor(s / 3600); var m = Math.floor((s % 3600) / 60);
    if (h) parts.push(h + "h");
    parts.push(m + "m");
    return (past ? "" : "in ") + parts.join(" ") + (past ? " ago" : "");
  }

  function initials(name) { return (name || "?").slice(0, 2); }

  // Compact human duration from a seconds count, e.g. 4000 -> "1h 6m", 90 -> "1m 30s".
  function fmtDuration(totalSeconds) {
    var s = Number(totalSeconds) || 0;
    if (s <= 0) return "0s";
    var d = Math.floor(s / 86400); s -= d * 86400;
    var hh = Math.floor(s / 3600); s -= hh * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var parts = [];
    if (d) parts.push(d + "d");
    if (hh) parts.push(hh + "h");
    if (m) parts.push(m + "m");
    if (s || !parts.length) parts.push(s + "s");
    return parts.slice(0, 2).join(" ");
  }

  window.U = {
    h: h, clear: clear, icon: icon, fmtTime: fmtTime, fmtRelative: fmtRelative,
    fmtDuration: fmtDuration, initials: initials
  };
  window.h = h;

  // Global app namespace/state.
  window.App = {
    user: null,
    status: { services: { dhcp4: false, dhcp6: false, ctrl_agent: false }, kea_ca_reachable: false },
    views: {},
    route: null
  };
})();
