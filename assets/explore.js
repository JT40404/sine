/* SINE Forge — explore: every coin launched through SINE, sortable and filterable by pair. */
(function () {
  "use strict";
  var F = window.SineForge, $ = F.$, el = F.el;
  var all = [], tab = "new", pairs = {};

  function load() {
    F.get("/api/registry?limit=200").then(function (j) {
      all = (j.tokens || []).filter(function (t) { return !t.pinned; });
      if (!j.enabled) F.status("The launch list needs storage (Upstash Redis). Until the site owner connects it, coins can still be opened by address on the coin page.", true);
      else F.status(all.length ? "" : "No coins yet. Be the first: create one.", true);
      var qm = {}; all.forEach(function (t) { if (t.quoteMint) qm[t.quoteMint] = 1; });
      Object.keys(qm).filter(function (m) { return !pairs[m]; }).forEach(function (m) {
        pairs[m] = m === F.SOL_MINT ? "SOL" : F.short(m);
        F.quoteInfo(m).then(function (q) { pairs[m] = F.quoteSymbol(q); syncPairs(); render(); }).catch(function () {});
      });
      syncPairs(); render();
    }).catch(function (e) { F.status(e.message); });
  }
  function syncPairs() {
    var sel = $("ex-pair"), cur = sel.value; sel.textContent = "";
    sel.appendChild(el("option", { value: "", text: "All pairs" }));
    sel.appendChild(el("option", { value: "pump", text: "pump.fun (SOL)" }));
    Object.keys(pairs).forEach(function (m) { sel.appendChild(el("option", { value: m, text: pairs[m] })); });
    sel.value = cur;
  }
  function render() {
    var q = $("ex-q").value.trim().toLowerCase(), pair = $("ex-pair").value;
    var list = all.filter(function (t) {
      if (pair === "pump" ? t.engine === "forge" : pair && t.quoteMint !== pair) return false;
      if (q && !((t.name || "").toLowerCase().includes(q) || (t.symbol || "").toLowerCase().includes(q) || t.mint.toLowerCase() === q)) return false;
      if (tab === "hot") return t.engine === "forge" && !t.migrated && (t.progress || 0) > 0;
      if (tab === "grad") return t.migrated;
      return true;
    });
    if (tab === "hot") list.sort(function (a, b) { return (b.progress || 0) - (a.progress || 0); });
    else if (tab === "mc") list.sort(function (a, b) { return (b.marketCapUsd || 0) - (a.marketCapUsd || 0); });
    else list.sort(function (a, b) { return (b.launchedAt || 0) - (a.launchedAt || 0); });
    var g = $("ex-grid"); g.textContent = "";
    list.forEach(function (t) {
      var href = (t.engine === "forge" ? "/coin?mint=" : "/launch?mint=") + encodeURIComponent(t.mint);
      var card = el("a", { class: "panel ex-card", href: href }, [
        el("div", { class: "lp-preview-img ex-img", style: t.image ? "background-image:url(" + t.image + ")" : null }),
        el("div", { class: "ex-body" }, [
          el("div", { class: "ex-top" }, [el("strong", { text: "$" + (t.symbol || F.short(t.mint)) }), el("span", { class: "muted", text: t.name || "" })]),
          el("div", { class: "ex-meta mono" }, [
            "MC " + F.usd(t.marketCapUsd),
            t.change24h !== null && t.change24h !== undefined ? el("span", { class: t.change24h >= 0 ? "tk-up" : "tk-down", text: (t.change24h >= 0 ? " ▲" : " ▼") + Math.abs(t.change24h).toFixed(1) + "%" }) : null,
          ]),
          el("div", { class: "ex-meta muted" }, [(t.engine === "forge" ? "Forge · " + (pairs[t.quoteMint] || "pair") : "pump.fun · SOL") + " · " + age(t.launchedAt)]),
          t.engine === "forge" ? el("div", { class: "cn-bar ex-bar-sm", title: t.migrated ? "Graduated" : Math.round((t.progress || 0) * 100) + "% to graduation" }, [el("span", { style: "width:" + (t.migrated ? 100 : Math.round((t.progress || 0) * 100)) + "%" })]) : null,
        ]),
      ]);
      g.appendChild(card);
    });
    if (!list.length && all.length) g.appendChild(el("p", { class: "muted", text: "Nothing matches." }));
  }
  function age(ts) { if (!ts) return ""; var s = (Date.now() - ts) / 1000; return s < 3600 ? Math.max(1, Math.round(s / 60)) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago"; }
  document.querySelectorAll("#ex-tabs button").forEach(function (b) { b.addEventListener("click", function () { tab = b.getAttribute("data-t"); document.querySelectorAll("#ex-tabs button").forEach(function (x) { x.setAttribute("aria-pressed", x === b); }); render(); }); });
  $("ex-pair").addEventListener("change", render); $("ex-q").addEventListener("input", render);
  load(); setInterval(function () { if (document.visibilityState === "visible") load(); }, 30000);
})();
