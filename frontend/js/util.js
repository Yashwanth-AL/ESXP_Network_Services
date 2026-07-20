/* Shared helpers + global namespace. Loaded first. No framework, no build. */
(function () {
  "use strict";

  // Tiny hyperscript-style DOM builder.
  //   h('div', {class:'x', onClick: fn}, 'text', childNode)
  //
  // Text children go through createTextNode (see append), so anything from the
  // server -- hostnames, Kea error text, audit detail -- is escaped by default.
  // The one bypass is `unsafeHTML`, which assigns innerHTML verbatim: pass only
  // markup this codebase itself authored (icon SVG), never server or user data.
  // It is deliberately named so misuse is obvious at the call site.
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "unsafeHTML") el.innerHTML = v;
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

  // A small ⓘ that reveals `text` on hover (or focus, for keyboard/touch): a
  // tidy way to explain a field without cluttering the form with always-on
  // hint text. `text` is a plain string, rendered via createTextNode -- safe.
  function infoTip(text) {
    var svg = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/>' +
      '<line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    return h("span", { class: "infotip", tabindex: "0", role: "note", "aria-label": text },
      h("span", { class: "infotip-ic", unsafeHTML: svg }),
      h("span", { class: "infotip-bubble" }, text));
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
    h: h, clear: clear, icon: icon, infoTip: infoTip, fmtTime: fmtTime,
    fmtRelative: fmtRelative, fmtDuration: fmtDuration, initials: initials
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
