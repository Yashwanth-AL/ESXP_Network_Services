/* "Coming soon" placeholder for not-yet-implemented network service modules
   (DNS, NTP/SNTP). Routed and reachable, but with no backend logic yet. */
(function () {
  "use strict";
  var h = window.h, U = window.U;

  window.App.views.placeholder = function (container, opts) {
    U.clear(container);
    container.appendChild(h("div", { class: "page-head" },
      h("div", null, h("h1", null, opts.title))));
    container.appendChild(h("div", { class: "card" },
      h("div", { class: "placeholder-wrap" },
        h("div", { class: "pill" }, "Coming soon"),
        h("h2", null, opts.title + " management"),
        h("p", { class: "muted", style: "max-width:440px" }, opts.blurb ||
          ("This module is part of the ESXP Network Services roadmap. " +
           "The navigation, layout and authentication are already in place so the " +
           opts.title + " backend can be added later without restructuring the app.")))));
  };
})();
