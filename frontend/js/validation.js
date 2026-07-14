/* Client-side validation mirroring backend/app/validation.py.
   Each function returns an error string, or null when the value is acceptable.
   The server re-validates everything; the client checks are a fast first gate.
   When a value can't be parsed confidently (some IPv6 forms), we return null
   and defer to the server rather than risk blocking valid input. */
(function () {
  "use strict";

  var MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
  var HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

  function required(v, label) {
    return (v == null || String(v).trim() === "") ? (label + " is required") : null;
  }

  // --- IPv4 ------------------------------------------------------------------
  function isIPv4(s) {
    var p = String(s).split(".");
    if (p.length !== 4) return false;
    for (var i = 0; i < 4; i++) {
      if (!/^\d{1,3}$/.test(p[i])) return false;
      var n = Number(p[i]);
      if (n < 0 || n > 255) return false;
      if (p[i].length > 1 && p[i][0] === "0") return false;
    }
    return true;
  }
  function ipv4ToInt(s) {
    var p = s.split(".");
    return ((Number(p[0]) << 24) >>> 0) + (Number(p[1]) << 16) + (Number(p[2]) << 8) + Number(p[3]);
  }

  // --- IPv6 (BigInt) ---------------------------------------------------------
  function v6ToBigInt(addr) {
    try {
      addr = String(addr).split("%")[0];
      if (addr.indexOf(":") < 0) return null;
      var dbl = addr.split("::");
      if (dbl.length > 2) return null;
      function expand(seg) {
        if (!seg) return [];
        var parts = seg.split(":");
        var out = [];
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          if (part.indexOf(".") >= 0) { // embedded IPv4
            if (!isIPv4(part)) return null;
            var n = ipv4ToInt(part);
            out.push(((n >>> 16) & 0xffff).toString(16));
            out.push((n & 0xffff).toString(16));
          } else {
            if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
            out.push(part);
          }
        }
        return out;
      }
      var head = expand(dbl[0]);
      var tail = dbl.length === 2 ? expand(dbl[1]) : [];
      if (head === null || tail === null) return null;
      var hextets;
      if (dbl.length === 2) {
        var fill = 8 - head.length - tail.length;
        if (fill < 1) return null;
        hextets = head.concat(Array(fill).fill("0")).concat(tail);
      } else {
        hextets = head;
      }
      if (hextets.length !== 8) return null;
      var val = 0n;
      for (var j = 0; j < 8; j++) val = (val << 16n) + BigInt(parseInt(hextets[j], 16));
      return val;
    } catch (e) { return null; }
  }

  // --- CIDR ------------------------------------------------------------------
  function cidr(value, version) {
    var s = String(value || "").trim();
    var slash = s.split("/");
    if (slash.length !== 2) return "Enter a CIDR subnet, e.g. " + (version === 4 ? "192.168.10.0/24" : "2001:db8:1::/64");
    var prefix = Number(slash[1]);
    if (version === 4) {
      if (!isIPv4(slash[0])) return "'" + slash[0] + "' is not a valid IPv4 address";
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return "Prefix must be 0-32";
    } else {
      if (v6ToBigInt(slash[0]) === null) return "'" + slash[0] + "' is not a valid IPv6 address";
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return "Prefix must be 0-128";
    }
    return null;
  }

  function ip(value, version) {
    var s = String(value || "").trim();
    if (version === 4) return isIPv4(s) ? null : "'" + s + "' is not a valid IPv4 address";
    return v6ToBigInt(s) !== null ? null : "'" + s + "' is not a valid IPv6 address";
  }

  function inSubnet(ipStr, cidrStr, version) {
    var c = cidr(cidrStr, version);
    if (c) return null; // subnet itself invalid; that error is reported elsewhere
    var slash = cidrStr.split("/");
    var prefix = Number(slash[1]);
    if (version === 4) {
      if (!isIPv4(ipStr)) return "'" + ipStr + "' is not a valid IPv4 address";
      var mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      if ((ipv4ToInt(ipStr) & mask) >>> 0 !== (ipv4ToInt(slash[0]) & mask) >>> 0)
        return ipStr + " is not inside subnet " + cidrStr;
      return null;
    }
    var ipVal = v6ToBigInt(ipStr);
    var netVal = v6ToBigInt(slash[0]);
    if (ipVal === null || netVal === null) return null; // defer to server
    var maskBits = 128 - prefix;
    var m = maskBits === 128 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(maskBits));
    if ((ipVal & m) !== (netVal & m)) return ipStr + " is not inside subnet " + cidrStr;
    return null;
  }

  function pool(start, end, cidrStr, version) {
    var e = ip(start, version); if (e) return "Pool start: " + e;
    e = ip(end, version); if (e) return "Pool end: " + e;
    e = inSubnet(start, cidrStr, version); if (e) return "Pool start " + e;
    e = inSubnet(end, cidrStr, version); if (e) return "Pool end " + e;
    if (version === 4) {
      if (ipv4ToInt(start) > ipv4ToInt(end)) return "Pool start must be <= pool end";
    } else {
      var a = v6ToBigInt(start), b = v6ToBigInt(end);
      if (a !== null && b !== null && a > b) return "Pool start must be <= pool end";
    }
    return null;
  }

  function mac(value) {
    return MAC_RE.test(String(value || "").trim()) ? null
      : "MAC must look like aa:bb:cc:dd:ee:ff";
  }

  function duid(value) {
    var raw = String(value || "").trim().toLowerCase();
    if (!raw) return "DUID is required";
    if (raw.indexOf(":") >= 0 || raw.indexOf("-") >= 0) {
      var parts = raw.split(/[:-]/);
      for (var i = 0; i < parts.length; i++) if (!/^[0-9a-f]{1,2}$/.test(parts[i])) return "Invalid DUID";
      if (parts.length < 3) return "DUID is too short";
    } else {
      if (!/^[0-9a-f]+$/.test(raw) || raw.length % 2 !== 0) return "DUID must be hex (even length)";
      if (raw.length < 6) return "DUID is too short";
    }
    return null;
  }

  function hostname(value) {
    var s = String(value || "").trim();
    if (!s) return null; // optional
    if (s.length > 253 || !HOST_RE.test(s)) return "'" + s + "' is not a valid hostname";
    return null;
  }

  function timers(valid, renew, rebind) {
    var vs = [["Valid lifetime", valid], ["Renew timer", renew], ["Rebind timer", rebind]];
    for (var i = 0; i < vs.length; i++) {
      var n = Number(vs[i][1]);
      if (!Number.isInteger(n) || n < 0) return vs[i][0] + " must be a non-negative integer";
    }
    if (Number(renew) && Number(rebind) && Number(renew) >= Number(rebind))
      return "Renew timer must be less than rebind timer";
    if (Number(rebind) && Number(valid) && Number(rebind) >= Number(valid))
      return "Rebind timer must be less than valid lifetime";
    return null;
  }

  window.V = {
    required: required, cidr: cidr, ip: ip, inSubnet: inSubnet, pool: pool,
    mac: mac, duid: duid, hostname: hostname, timers: timers, isIPv4: isIPv4
  };
})();
