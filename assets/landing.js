(function () {
  "use strict";
  var F = window.SineFourier;

  // Mode toggle
  var buttons = document.querySelectorAll("[data-mode]");
  buttons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var mode = btn.getAttribute("data-mode");
      buttons.forEach(function (b) { b.setAttribute("aria-pressed", String(b === btn)); });
      document.querySelectorAll("[data-panel]").forEach(function (p) { p.hidden = p.getAttribute("data-panel") !== mode; });
    });
  });

  var yr = document.getElementById("year");
  if (yr) yr.textContent = new Date().getFullYear();

  // Real analysis of the test series
  var res = F.analyze(F.testSignal(), 0.25);
  var m = 0;
  res.d.forEach(function (v) { m = Math.max(m, Math.abs(v)); });
  var sc = 34 / (res.peaks[0] ? res.peaks[0].amp : 1);
  var set = function (id, d) { var el = document.getElementById(id); if (el) el.setAttribute("d", d); };
  set("hero-composite", F.linePath(res.d, 110, 466, 88, m ? 60 / m : 1));
  ["hero-c1", "hero-c2", "hero-c3"].forEach(function (id, i) {
    set(id, res.comps[i] ? F.linePath(res.comps[i], 110, 466, [234, 314, 384][i], sc) : "");
  });

  var sp = F.barPaths(res, 48, 572, 250, 210, 48);
  set("spec-bars", sp.bars);
  set("spec-peaks", sp.peakBars);
  var labels = document.getElementById("spec-labels");
  var NS = "http://www.w3.org/2000/svg";
  res.peaks.forEach(function (p, i) {
    var pos = sp.pos[p.k];
    if (!pos) return;
    var t = document.createElementNS(NS, "text");
    t.setAttribute("x", pos.x.toFixed(1));
    t.setAttribute("y", pos.y.toFixed(1));
    t.textContent = ["f₁", "f₂", "f₃"][i];
    labels.appendChild(t);
  });

  var colors = ["#7FE3B5", "#F0A857", "#9DB4FF"];
  var rows = document.getElementById("readout-rows");
  res.peaks.forEach(function (p, i) {
    var row = document.createElement("div");
    row.className = "row";
    [["f" + "₁₂₃"[i], colors[i]], [F.fmtPeriod(p.period)], [p.uhz.toFixed(2) + " µHz"],
     ["±" + (p.amp * 100).toFixed(2) + "%"], [(p.share * 100).toFixed(1) + "%"]].forEach(function (c) {
      var s = document.createElement("span");
      s.textContent = c[0];
      if (c[1]) s.style.color = c[1];
      row.appendChild(s);
    });
    rows.appendChild(row);
  });
})();

/* Live stats for the official SINE token (only when config.js has a valid address and it trades). */
(function () {
  "use strict";
  var ca = ((window.SINE_CONFIG || {}).tokenAddress || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return;
  var usd = function (v, compact) {
    if (v === null || v === undefined) return "—";
    var opts = { style: "currency", currency: "USD" };
    if (compact) { opts.notation = "compact"; opts.maximumFractionDigits = 2; }
    else if (Math.abs(v) < 1) opts.maximumSignificantDigits = 4;
    return new Intl.NumberFormat("en-US", opts).format(v);
  };
  function load() {
    fetch("/api/token?address=" + encodeURIComponent(ca)).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.token || j.token.priceUsd === null) return;
      var t = j.token, ch = document.getElementById("sine-change");
      document.getElementById("sine-price").textContent = usd(t.priceUsd);
      document.getElementById("sine-liq").textContent = usd(t.liquidityUsd, true);
      document.getElementById("sine-vol").textContent = usd(t.volume24hUsd, true);
      ch.textContent = t.change24h === null ? "—" : (t.change24h >= 0 ? "+" : "") + t.change24h.toFixed(2) + "%";
      ch.className = t.change24h === null ? "" : t.change24h >= 0 ? "up" : "down";
      document.getElementById("sine-live").hidden = false;
    }).catch(function () {});
  }
  load();
  setInterval(load, 60000);
})();
