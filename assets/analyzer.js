(function () {
  "use strict";
  var F = window.SineFourier;
  var $ = function (id) { return document.getElementById(id); };
  var colors = ["#7FE3B5", "#F0A857", "#9DB4FF"];
  var names = ["f₁", "f₂", "f₃"];
  var MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var testText = F.testSignal().join("\n");

  var state = { mode: "none", ca: "", window: "7d", timer: null, busy: false };

  /* ---------- formatting ---------- */
  var usd = function (v, compact) {
    if (v === null || v === undefined) return "—";
    var o = { style: "currency", currency: "USD" };
    if (compact) { o.notation = "compact"; o.maximumFractionDigits = 2; }
    else if (Math.abs(v) < 1) o.maximumSignificantDigits = 4;
    return new Intl.NumberFormat("en-US", o).format(v);
  };
  var pct = function (v) { return v === null || v === undefined ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%"; };
  var fmtFreq = function (cph) { return (1e6 * cph / 3600).toFixed(2) + " µHz"; };
  var leadLag = function (deg, periodH) {
    var h = Math.abs(deg) / 360 * periodH;
    if (Math.abs(deg) < 10) return "in phase";
    return (deg > 0 ? "leads " : "lags ") + F.fmtPeriod(h) + " (" + (deg > 0 ? "+" : "") + deg.toFixed(0) + "°)";
  };
  var short = function (a) { return a.length > 16 ? a.slice(0, 6) + "…" + a.slice(-6) : a; };

  function status(msg, kind) {
    var el = $("status");
    el.textContent = msg || "";
    el.className = "notice" + (kind === "info" ? " info" : "");
    el.hidden = !msg;
  }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "Request failed (" + r.status + ").");
        return j;
      });
    });
  }

  function setURL() {
    var p = new URLSearchParams();
    if (state.mode === "contract") p.set("ca", state.ca);
    if (state.mode === "ecosystem") p.set("mode", "ecosystem");
    if (state.mode !== "none" && state.mode !== "own") p.set("window", state.window);
    var q = p.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
  }

  /* ---------- core render ---------- */
  function clear() {
    ["price", "recon", "bars", "peak-bars"].forEach(function (id) { $(id).setAttribute("d", ""); });
    $("rows").textContent = "";
    ["dom-uhz", "dom-period", "s-n", "s-df", "s-nyq", "s-exp", "s-snr"].forEach(function (id) { $(id).textContent = "—"; });
    ["y-top", "y-bot", "x-start", "f-min", "f-max"].forEach(function (id) { $(id).textContent = ""; });
  }

  function render(xs, dt) {
    var res = F.analyze(xs, dt);
    if (!res.peaks.length) throw new Error("No spectral peaks found — the series may be too short or flat.");

    var m = 0;
    res.d.forEach(function (v) { m = Math.max(m, Math.abs(v)); });
    var s = m ? 110 / m : 1;
    $("price").setAttribute("d", F.linePath(res.d, 52, 788, 140, s));
    $("recon").setAttribute("d", F.linePath(res.recon, 52, 788, 140, s));
    $("y-top").textContent = "+" + (m * 100).toFixed(1) + "%";
    $("y-bot").textContent = "−" + (m * 100).toFixed(1) + "%";
    $("x-start").textContent = "−" + F.fmtPeriod(res.T);

    var sp = F.barPaths(res, 12, 348, 176, 150, 40);
    $("bars").setAttribute("d", sp.bars);
    $("peak-bars").setAttribute("d", sp.peakBars);
    $("f-min").textContent = (1e6 * res.df / 3600).toFixed(2);
    $("f-max").textContent = (1e6 * sp.M * res.df / 3600).toFixed(2) + " µHz";

    var rows = $("rows");
    rows.textContent = "";
    res.peaks.forEach(function (p, i) {
      var row = document.createElement("div");
      row.className = "row";
      [names[i], F.fmtPeriod(p.period), p.cpd.toFixed(2), p.uhz.toFixed(2) + " µHz",
        "±" + (p.amp * 100).toFixed(2) + "%", p.phase.toFixed(0) + "°"].forEach(function (c, j) {
        var el = document.createElement("span");
        el.textContent = c;
        if (j === 0) el.style.color = colors[i];
        row.appendChild(el);
      });
      var share = document.createElement("span"), lbl = document.createElement("span");
      var track = document.createElement("span"), fill = document.createElement("span");
      share.className = "sharebar"; track.className = "track"; fill.className = "fill";
      lbl.style.width = "52px";
      lbl.textContent = (p.share * 100).toFixed(1) + "%";
      fill.style.width = Math.min(100, p.share * 100).toFixed(1) + "%";
      fill.style.background = colors[i];
      track.appendChild(fill); share.appendChild(lbl); share.appendChild(track);
      row.appendChild(share);
      rows.appendChild(row);
    });

    var p0 = res.peaks[0];
    $("dom-uhz").textContent = p0.uhz.toFixed(2);
    $("dom-period").textContent = "one full cycle every " + F.fmtPeriod(p0.period);
    $("s-n").textContent = String(res.N);
    $("s-df").textContent = fmtFreq(res.df);
    $("s-nyq").textContent = fmtFreq(res.nyq);
    $("s-exp").textContent = (res.explained * 100).toFixed(1) + "%";
    $("s-snr").textContent = res.snr.toFixed(2) + " : 1";
    return res;
  }

  function showPanels(market, versus, basket) {
    $("market").hidden = !market;
    $("versus").hidden = !versus;
    $("basket").hidden = !basket;
  }

  /* ---------- contract mode ---------- */
  function compareToBasket(m, eco, tokenRes) {
    var idx = new Map();
    eco.timestamps.forEach(function (t, i) { idx.set(t, eco.index[i]); });
    var a = [], b = [];
    m.timestamps.forEach(function (t, i) { if (idx.has(t)) { a.push(m.closes[i]); b.push(idx.get(t)); } });
    if (a.length < 64) { $("v-corr").textContent = "not enough overlap"; return; }
    var da = F.detrendLog(a), db = F.detrendLog(b);
    var P = tokenRes.peaks[0].period, k = Math.max(1, Math.round(a.length * m.intervalHours / P));
    var dphi = F.wrapDeg(F.binPhase(da, k) - F.binPhase(db, k));
    $("v-corr").textContent = F.corr(da, db).toFixed(2);
    $("v-phase").textContent = leadLag(dphi, P);
    try {
      var ecoRes = F.analyze(eco.index, eco.intervalHours);
      $("v-period").textContent = ecoRes.peaks[0] ? F.fmtPeriod(ecoRes.peaks[0].period) : "—";
    } catch (e) { $("v-period").textContent = "—"; }
  }

  function loadContract(quiet) {
    if (state.busy) return;
    state.busy = true;
    if (!quiet) status("Loading live market data…", "info");
    document.querySelector(".app-grid").classList.add("loading");
    getJSON("/api/market?address=" + encodeURIComponent(state.ca) + "&window=" + state.window)
      .then(function (m) {
        var t = m.token;
        $("meta").textContent = "CONTRACT LENS · " + m.closes.length + " × " + m.interval + " · " + m.source.toUpperCase();
        $("title").textContent = t.name || short(state.ca);
        $("ticker").textContent = t.symbol ? "$" + t.symbol : "";
        document.title = (t.symbol ? "$" + t.symbol : short(state.ca)) + " · SINE analyzer";
        $("source").textContent = "live market data";
        $("m-price").textContent = usd(t.priceUsd);
        $("m-change").textContent = pct(t.change24h);
        $("m-change").className = t.change24h === null ? "" : t.change24h >= 0 ? "up" : "down";
        $("m-liq").textContent = usd(t.liquidityUsd, true);
        $("m-vol").textContent = usd(t.volume24hUsd, true);
        $("m-pool").textContent = t.topPool ? t.topPool.name : "—";
        $("m-pool").href = t.topPool ? "https://www.geckoterminal.com/solana/pools/" + t.topPool.address : "#";
        $("s-upd").textContent = new Date(m.updatedAt).toLocaleTimeString();
        var res = render(m.closes, m.intervalHours);
        showPanels(true, true, false);
        status("");
        ["v-corr", "v-phase", "v-period"].forEach(function (id) { $(id).textContent = "loading…"; });
        return getJSON("/api/ecosystem?window=" + state.window)
          .then(function (eco) { compareToBasket(m, eco, res); })
          .catch(function () { ["v-corr", "v-phase", "v-period"].forEach(function (id) { $(id).textContent = "unavailable"; }); });
      })
      .catch(function (e) {
        if (!quiet) { clear(); showPanels(false, false, false); }
        status(e.message);
      })
      .then(function () { state.busy = false; document.querySelector(".app-grid").classList.remove("loading"); });
  }

  /* ---------- ecosystem mode ---------- */
  function loadEcosystem(quiet) {
    if (state.busy) return;
    state.busy = true;
    if (!quiet) status("Loading the Solana basket… this can take a few seconds when the cache is cold.", "info");
    document.querySelector(".app-grid").classList.add("loading");
    getJSON("/api/ecosystem?window=" + state.window)
      .then(function (eco) {
        $("meta").textContent = "ECOSYSTEM PULSE · " + eco.tokens.length + " TOKENS · " + eco.index.length + " × " + eco.interval;
        $("title").textContent = "Solana ecosystem basket";
        $("ticker").textContent = "";
        document.title = "Ecosystem pulse · SINE analyzer";
        $("source").textContent = "live · equal-weight index";
        $("s-upd").textContent = new Date(eco.updatedAt).toLocaleTimeString();
        var res = render(eco.index, eco.intervalHours);
        showPanels(false, false, true);

        var dIdx = F.detrendLog(eco.index), k0 = res.peaks[0].k, P0 = res.peaks[0].period;
        var phIdx = F.binPhase(dIdx, k0);
        var rows = $("basket-rows");
        rows.textContent = "";
        eco.tokens.forEach(function (t) {
          var d = F.detrendLog(t.closes), own = "—", share = "—";
          try {
            var r = F.analyze(t.closes, eco.intervalHours);
            if (r.peaks[0]) own = F.fmtPeriod(r.peaks[0].period);
            var b = r.bins[k0];
            var varD = d.reduce(function (s, v) { return s + v * v; }, 0) / d.length;
            if (b && varD) share = (100 * (r.bins[k0 - 1].pw + b.pw + r.bins[k0 + 1].pw) / varD).toFixed(1) + "%";
          } catch (e) {}
          var row = document.createElement("div");
          row.className = "row";
          ["$" + t.symbol, own, share, F.corr(d, dIdx).toFixed(2), leadLag(F.wrapDeg(F.binPhase(d, k0) - phIdx), P0)]
            .forEach(function (c) { var el = document.createElement("span"); el.textContent = c; row.appendChild(el); });
          rows.appendChild(row);
        });
        var note = "Correlation is between detrended log prices. Phase compares each token to the index at the index’s dominant frequency (" + F.fmtPeriod(P0) + "): “leads” means the token tends to peak earlier.";
        if (eco.dropped && eco.dropped.length) note += " Left out this time: " + eco.dropped.map(function (d) { return d.symbol; }).join(", ") + ".";
        $("basket-note").textContent = note;
        status("");
      })
      .catch(function (e) {
        if (!quiet) { clear(); showPanels(false, false, false); }
        status(e.message);
      })
      .then(function () { state.busy = false; document.querySelector(".app-grid").classList.remove("loading"); });
  }

  /* ---------- own data ---------- */
  function parse(text) {
    var lines = String(text || "").trim().split(/\r?\n/).filter(function (l) { return l.trim(); });
    var toNums = function (l) { return l.split(/[\s,;\t]+/).map(parseFloat).filter(isFinite); };
    if (lines.length > 1) return lines.map(toNums).filter(function (n) { return n.length; }).map(function (n) { return n[n.length - 1]; });
    return lines.length ? toNums(lines[0]) : [];
  }

  function runOwn(isTest) {
    stopAuto();
    state.mode = isTest ? "none" : "own";
    setURL();
    $("error").textContent = "";
    status("");
    var xs = parse($("series").value), dt = parseFloat($("dt").value);
    var fail = function (msg) { clear(); $("error").textContent = msg; };
    if (xs.length < 16) return fail("Need at least 16 prices to resolve any cycles (found " + xs.length + ").");
    if (xs.some(function (v) { return v <= 0; })) return fail("Prices must be positive numbers.");
    if (xs.length > 4096) return fail("Keep it to 4,096 samples or fewer (found " + xs.length + ").");
    try { render(xs, dt); } catch (e) { return fail(e.message); }
    showPanels(false, false, false);
    $("meta").textContent = isTest ? "CONTRACT LENS · DEMO" : "YOUR DATA · " + xs.length + " SAMPLES";
    $("title").textContent = isTest ? "Paste a contract address" : "Your price series";
    $("ticker").textContent = "";
    $("source").textContent = isTest ? "test signal · planted cycles 3.5 d, 33.6 h, 15.3 h" : "your pasted data";
    $("s-upd").textContent = "—";
    if (isTest) status("Showing a test signal. Paste a Solana token address above to analyze live market data.", "info");
  }

  /* ---------- auto-refresh ---------- */
  function stopAuto() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }
  function startAuto() {
    stopAuto();
    if (!$("auto").checked || (state.mode !== "contract" && state.mode !== "ecosystem")) return;
    var ms = state.mode === "ecosystem" ? 300000 : state.window === "1d" ? 60000 : 120000;
    state.timer = setInterval(function () {
      if (document.hidden) return;
      (state.mode === "contract" ? loadContract : loadEcosystem)(true);
    }, ms);
  }

  function go() {
    setURL();
    if (state.mode === "contract") loadContract(false);
    else if (state.mode === "ecosystem") loadEcosystem(false);
    startAuto();
  }

  /* ---------- wiring ---------- */
  $("ca-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("ca").value.trim();
    if (!MINT.test(v)) { status("That doesn’t look like a Solana mint address (32–44 base58 characters)."); return; }
    state.mode = "contract"; state.ca = v;
    go();
  });
  $("eco-link").addEventListener("click", function (e) { e.preventDefault(); state.mode = "ecosystem"; go(); });
  $("window").addEventListener("change", function () { state.window = $("window").value; if (state.mode === "contract" || state.mode === "ecosystem") go(); });
  $("auto").addEventListener("change", startAuto);
  $("run").addEventListener("click", function () { runOwn(false); });
  $("load-test").addEventListener("click", function () { $("series").value = testText; $("dt").value = "0.25"; runOwn(true); });

  /* ---------- start ---------- */
  var params = new URLSearchParams(location.search);
  var w = params.get("window");
  if (w && ["1d", "7d", "30d", "90d"].indexOf(w) >= 0) { state.window = w; $("window").value = w; }
  var ca = (params.get("ca") || "").trim();
  $("series").value = testText;

  if (params.get("mode") === "ecosystem") { state.mode = "ecosystem"; go(); }
  else if (MINT.test(ca)) { state.mode = "contract"; state.ca = ca; $("ca").value = ca; go(); }
  else {
    if (ca) $("ca").value = ca;
    $("own").open = true;
    runOwn(true);
    if (ca) status("That doesn’t look like a Solana mint address (32–44 base58 characters).");
  }
})();
