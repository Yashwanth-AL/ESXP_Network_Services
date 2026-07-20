/* Toast notifications + modal/confirm dialogs (the single notification system). */
(function () {
  "use strict";
  var h = window.h;

  function show(type, message, title) {
    var root = document.getElementById("toast-root");
    var box = h("div", { class: "toast " + type },
      h("div", null,
        h("div", { class: "t-title" }, title || defaultTitle(type)),
        h("div", { class: "t-msg" }, message || "")),
      h("button", { class: "t-close", title: "Dismiss", onClick: function () { remove(box); } }, "×"));
    root.appendChild(box);
    var ttl = type === "error" ? 8000 : 4000;
    setTimeout(function () { remove(box); }, ttl);
  }
  function remove(box) { if (box && box.parentNode) box.parentNode.removeChild(box); }
  function defaultTitle(type) {
    return type === "success" ? "Success" : type === "error" ? "Error" : "Notice";
  }

  window.toast = {
    success: function (m, t) { show("success", m, t); },
    error: function (m, t) { show("error", m, t); },
    info: function (m, t) { show("info", m, t); }
  };

  // --- Modal infrastructure --------------------------------------------------
  function mountModal(node) {
    var root = document.getElementById("modal-root");
    var backdrop = h("div", { class: "modal-backdrop" }, node);
    backdrop.addEventListener("mousedown", function (e) {
      if (e.target === backdrop) close();
    });
    function esc(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", esc);
    function close() {
      document.removeEventListener("keydown", esc);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
    root.appendChild(backdrop);
    return close;
  }

  // Confirmation dialog -> Promise<boolean>
  window.confirmDialog = function (message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var close;
      var yes = h("button", { class: "btn " + (opts.danger ? "btn-danger" : "btn-primary"),
        onClick: function () { close(); resolve(true); } }, opts.confirmText || "Confirm");
      var no = h("button", { class: "btn btn-outline",
        onClick: function () { close(); resolve(false); } }, "Cancel");
      var modal = h("div", { class: "modal" },
        h("div", { class: "modal-head" }, opts.title || "Please confirm"),
        h("div", { class: "modal-body" }, message),
        h("div", { class: "modal-foot" }, no, yes));
      close = mountModal(modal);
    });
  };

  // Generic form modal. fields: [{name,label,type,value,hint,info,placeholder,required,options}]
  // onSubmit(values) may return a promise; throw to keep the modal open with an error.
  window.openFormModal = function (cfg) {
    var inputs = {};
    var errEl = h("div", { class: "err-text" });
    var grid = h("div", { class: "form-grid" });

    (cfg.fields || []).forEach(function (f) {
      var input;
      if (f.type === "select") {
        input = h("select");
        (f.options || []).forEach(function (o) {
          input.appendChild(h("option", { value: o.value }, o.label));
        });
        input.value = f.value != null ? f.value : "";
      } else {
        input = h("input", { type: f.type || "text", value: f.value != null ? f.value : "",
          placeholder: f.placeholder || "" });
      }
      inputs[f.name] = input;
      grid.appendChild(h("div", { class: "field" },
        h("label", null, f.label + (f.required ? " *" : ""),
          f.info ? window.U.infoTip(f.info) : null),
        input,
        f.hint ? h("div", { class: "hint" }, f.hint) : null));
    });

    var submitBtn = h("button", { class: "btn btn-primary" }, cfg.submitText || "Save");
    var close;

    function collect() {
      var v = {};
      for (var k in inputs) v[k] = inputs[k].value.trim();
      return v;
    }
    function doSubmit() {
      errEl.textContent = "";
      var values = collect();
      var res;
      try { res = cfg.onSubmit(values); }
      catch (e) { errEl.textContent = e.message || String(e); return; }
      if (res && typeof res.then === "function") {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spin"></span>';
        res.then(function () { close(); }).catch(function (e) {
          errEl.textContent = (e && e.message) || "Operation failed";
          submitBtn.disabled = false; submitBtn.textContent = cfg.submitText || "Save";
        });
      } else { close(); }
    }
    submitBtn.addEventListener("click", doSubmit);

    var form = h("form", { onSubmit: function (e) { e.preventDefault(); doSubmit(); } },
      h("div", { class: "modal-body" }, grid, errEl),
      h("div", { class: "modal-foot" },
        h("button", { type: "button", class: "btn btn-outline", onClick: function () { close(); } }, "Cancel"),
        submitBtn));

    var modal = h("div", { class: "modal" },
      h("div", { class: "modal-head" }, cfg.title || "Form"), form);
    close = mountModal(modal);
    // Focus first input.
    var first = cfg.fields && cfg.fields[0];
    if (first && inputs[first.name]) inputs[first.name].focus();
  };
})();
