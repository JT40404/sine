/* Shared: official token address + footer links from config.js */
(function () {
  "use strict";
  var cfg = window.SINE_CONFIG || {};
  var ca = (cfg.tokenAddress || "").trim();
  var valid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca);

  document.querySelectorAll("[data-sine-symbol]").forEach(function (el) { el.textContent = cfg.tokenSymbol || "$SINE"; });
  document.querySelectorAll("[data-sine-ca]").forEach(function (el) {
    el.textContent = valid ? ca : "Address announced at launch";
  });
  document.querySelectorAll("[data-sine-ca-only]").forEach(function (el) { el.hidden = !valid; });

  var copy = document.querySelector("[data-copy-ca]");
  if (copy) {
    copy.hidden = !valid;
    copy.addEventListener("click", function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(ca).then(function () {
        copy.textContent = "Copied";
        setTimeout(function () { copy.textContent = "Copy address"; }, 1600);
      }).catch(function () {});
    });
  }

  var links = cfg.links || {};
  document.querySelectorAll("[data-link]").forEach(function (a) {
    var url = links[a.getAttribute("data-link")];
    if (url) a.href = url; else a.hidden = true;
  });
})();
