/* Thin fetch wrapper. Centralises JSON handling, auth (401) redirect, and
   turning backend error payloads into throwable messages the UI can toast. */
(function () {
  "use strict";

  function ApiError(message, status) { this.message = message; this.status = status; }
  ApiError.prototype = Object.create(Error.prototype);

  async function request(method, path, body) {
    var opts = { method: method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    var res;
    try {
      res = await fetch("/api" + path, opts);
    } catch (e) {
      throw new ApiError("Network error: cannot reach the dashboard server", 0);
    }

    if (res.status === 401) {
      // Session expired / not logged in. Let the app switch to the login view,
      // unless this *is* the login attempt (handled by caller catching the error).
      if (!path.startsWith("/auth/login")) {
        window.dispatchEvent(new CustomEvent("app:unauthorized"));
      }
      var d401 = await safeJson(res);
      throw new ApiError((d401 && d401.detail) || "Not authenticated", 401);
    }

    var data = await safeJson(res);
    if (!res.ok) {
      var msg = (data && (data.detail || data.message)) || ("Request failed (" + res.status + ")");
      if (Array.isArray(msg)) msg = msg.map(function (m) { return m.msg || JSON.stringify(m); }).join("; ");
      throw new ApiError(msg, res.status);
    }
    return data;
  }

  async function safeJson(res) {
    try { return await res.json(); } catch (e) { return null; }
  }

  window.ApiError = ApiError;
  window.api = {
    get: function (p) { return request("GET", p); },
    post: function (p, b) { return request("POST", p, b === undefined ? {} : b); },
    put: function (p, b) { return request("PUT", p, b === undefined ? {} : b); },
    del: function (p) { return request("DELETE", p); }
  };
})();
