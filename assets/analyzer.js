(function () {
  "use strict";
  var F = window.SineFourier;
  var $ = function (id) { return document.getElementById(id); };
  var colors = ["#7FE3B5", "#F0A857", "#9DB4FF"];
  var names = ["f₁", "f₂", "f₃"];
  var MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var INTERVAL_IDS = ["1s", "15s", "30s", "1m", "5m", "15m", "1h", "4h", "12h", "1d"];
  var SECONDS = { "1s": 1, "15s": 15, "30s": 30, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "12h": 43200, "1d": 86400 };
  // How often the page asks for fresh data (ms). Matches the server's cache for each interval.
  var POLL = { "1s": 2000, "15s": 5000, "30s": 10000, "1m": 15000, "5m": 30000, "15m": 60000, "1h": 120000, "4h": 300000, "12h": 600000, "1d": 900000 };
  var reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var testText = F.testSignal().join("\n");

  var state = { mode: "none", ca: "", interval: "15m", timer: null, busy: false, updatedAt: null, eco: null, secondsOK: false };
  var view = { key: null, chart: null, bars: null, dom: null, cycle: null };

  /* ================= formatting ================= */
  var usd = function (v, compact) {
    if (v === null || v === undefined) return "—";
    var o = { style: "currency", currency: "USD" };
    if (compact) { o.notation = "compact"; o.maximumFractionDigits = 2; }
    else if (Math.abs(v) < 1) o.maximumSignificantDigits = 4;
    return new Intl.NumberFormat("en-US", o).format(v);
  };
  var pct = function (v) { return v === null || v === undefined ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%"; };
  var fmtFreq = function (cph) { return (1e6 * cph / 3600).toFixed(2) + " µHz"; };
  var fmtUhz = function (u) { return u >= 1e4 ? u.toFixed(0) : u >= 100 ? u.toFixed(1) : u.toFixed(2); };
  var fmtDur = function (h) { return h < 1 / 60 ? (h * 3600).toFixed(0) + " s" : F.fmtPeriod(h); };
  var leadLag = function (deg, periodH) {
    if (Math.abs(deg) < 10) return "in phase";
    return (deg > 0 ? "leads " : "lags ") + fmtDur(Math.abs(deg) / 360 * periodH) + " (" + (deg > 0 ? "+" : "") + deg.toFixed(0) + "°)";
  };
  var short = function (a) { return a.length > 16 ? a.slice(0, 6) + "…" + a.slice(-6) : a; };

  function status(msg, kind) {
    var el = $("status");
    el.textContent = msg || "";
    el.className = "notice" + (kind === "info" ? " info" : "");
    el.hidden = !msg;
  }
  function setSource(text, live) {
    $("source-text").textContent = text;
    $("source").classList.toggle("is-live", !!live);
  }
  function getJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
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
    if (state.mode === "contract" || state.mode === "ecosystem") p.set("interval", state.interval);
    var q = p.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
  }

  /* ================= tween engine ================= */
  var tweens = {};
  var ease = function (t) { return 1 - Math.pow(1 - t, 3); };
  function tween(key, ms, fn) {
    if (tweens[key]) { tweens[key].fn(1); delete tweens[key]; }
    if (reduceMotion || !ms) { fn(1); return; }
    tweens[key] = { t0: performance.now(), ms: ms, fn: fn };
  }
  function frame(now) {
    Object.keys(tweens).forEach(function (k) {
      var tw = tweens[k], t = Math.min(1, (now - tw.t0) / tw.ms);
      tw.fn(ease(t));
      if (t >= 1) delete tweens[k];
    });
    drawCycle(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  var lerp = function (a, b, e) { return a + (b - a) * e; };
  function resample(arr, n) {
    if (arr.length === n) return arr.slice();
    return Array.from({ length: n }, function (_, i) { return arr[Math.round(i * (arr.length - 1) / Math.max(1, n - 1))]; });
  }

  /* ================= chart geometry ================= */
  var X0 = 52, W = 760, MID = 140, LIVE_X = 830;
  function pathFrom(ys) {
    var n = ys.length, step = W / (n - 1), p = "";
    for (var i = 0; i < n; i++) p += (i ? "L" : "M") + (X0 + i * step).toFixed(1) + " " + ys[i].toFixed(1) + " ";
    return p;
  }
  function clampY(y) { return Math.max(8, Math.min(272, y)); }

  function animateChart(target, shift, fresh) {
    var n = target.py.length, step = W / (n - 1);
    var from = view.chart;
    if (!from || fresh) from = { py: target.py.map(function () { return MID; }), ry: target.ry.map(function () { return MID; }), liveY: MID };
    var fp = resample(from.py, n), fr = resample(from.ry, n);
    if (shift > 0 && shift < n / 4) {
      fp = fp.map(function (_, i) { return fp[Math.min(n - 1, i + shift)]; });
      fr = fr.map(function (_, i) { return fr[Math.min(n - 1, i + shift)]; });
    } else shift = 0;
    var plot = $("plot"), fromLive = from.liveY == null ? MID : from.liveY;
    var dot = $("live-dot"), ring = $("live-ring"), tail = $("live-tail");
    var hasLive = target.liveY != null;
    [dot, ring, tail].forEach(function (el) { el.setAttribute("visibility", hasLive ? "visible" : "hidden"); });
    $("x-live").textContent = hasLive ? "now" : "";

    tween("chart", fresh ? 900 : 650, function (e) {
      var py = target.py.map(function (y, i) { return lerp(fp[i], y, e); });
      var ry = target.ry.map(function (y, i) { return lerp(fr[i], y, e); });
      $("price").setAttribute("d", pathFrom(py));
      $("recon").setAttribute("d", pathFrom(ry));
      plot.setAttribute("transform", "translate(" + (shift * step * (1 - e)).toFixed(2) + ",0)");
      if (hasLive) {
        var ly = lerp(fromLive, target.liveY, e);
        dot.setAttribute("cx", LIVE_X); dot.setAttribute("cy", ly.toFixed(1));
        ring.setAttribute("cx", LIVE_X); ring.setAttribute("cy", ly.toFixed(1));
        tail.setAttribute("x1", X0 + W); tail.setAttribute("y1", py[n - 1].toFixed(1));
        tail.setAttribute("x2", LIVE_X); tail.setAttribute("y2", ly.toFixed(1));
      }
    });
    view.chart = { py: target.py, ry: target.ry, liveY: hasLive ? target.liveY : null };
  }

  function animateBars(res, fresh) {
    var sp = F.barPaths(res, 12, 348, 176, 150, 40), M = sp.M;
    var top = 0, k;
    for (k = 1; k <= M; k++) top = Math.max(top, res.bins[k].amp);
    var to = [], peak = {};
    for (k = 1; k <= M; k++) to.push(top ? 150 * res.bins[k].amp / top : 0);
    res.peaks.forEach(function (p) { peak[p.k] = true; });
    var from = view.bars && !fresh ? resample(view.bars, M) : to.map(function () { return 0; });
    var bw = 348 / M, gap = Math.min(3, bw * 0.25);
    tween("bars", fresh ? 900 : 650, function (e) {
      var a = "", b = "";
      for (var i = 0; i < M; i++) {
        var h = lerp(from[i], to[i], e), x = 12 + i * bw + gap / 2, y = 176 - h;
        var seg = "M" + x.toFixed(1) + " " + y.toFixed(1) + "h" + (bw - gap).toFixed(1) + "V176H" + x.toFixed(1) + "Z ";
        if (peak[i + 1]) b += seg; else a += seg;
      }
      $("bars").setAttribute("d", a);
      $("peak-bars").setAttribute("d", b);
    });
    view.bars = to;
    $("f-min").textContent = fmtUhz(1e6 * res.df / 3600);
    $("f-max").textContent = fmtUhz(1e6 * M * res.df / 3600) + " µHz";
  }

  function animateNumber(el, to, fmt) {
    var from = parseFloat(el.getAttribute("data-v"));
    el.setAttribute("data-v", to);
    if (!isFinite(from)) from = 0;
    tween("num-" + el.id, 700, function (e) { el.textContent = fmt(lerp(from, to, e)); });
  }

  /* ================= cycle position (advances in real time at f₁) ================= */
  var CX0 = 16, CW = 340, CMID = 65, CAMP = 45;
  (function drawCycleWave() {
    var p = "";
    for (var i = 0; i <= 120; i++) {
      var psi = -Math.PI + 2 * Math.PI * i / 120;
      p += (i ? "L" : "M") + (CX0 + CW * i / 120).toFixed(1) + " " + (CMID - CAMP * Math.cos(psi)).toFixed(1) + " ";
    }
    $("cyc-wave").setAttribute("d", p);
  })();
  var lastCycText = "";
  function drawCycle(now) {
    var c = view.cycle;
    if (!c) return;
    var elapsedH = c.tEnd ? (Date.now() / 1000 - c.tEnd) / 3600 : 0;
    var psi = c.psi0 + 2 * Math.PI * elapsedH / c.P;
    psi = Math.atan2(Math.sin(psi), Math.cos(psi)); // wrap to (−π, π]
    var frac = (psi + Math.PI) / (2 * Math.PI);
    var x = CX0 + CW * frac, y = CMID - CAMP * Math.cos(psi);
    $("cyc-dot").setAttribute("cx", x.toFixed(1));
    $("cyc-dot").setAttribute("cy", y.toFixed(1));
    var p = "", steps = Math.max(1, Math.round(120 * frac));
    for (var i = 0; i <= steps; i++) {
      var q = -Math.PI + (psi + Math.PI) * i / steps;
      p += (i ? "L" : "M") + (CX0 + CW * (q + Math.PI) / (2 * Math.PI)).toFixed(1) + " " + (CMID - CAMP * Math.cos(q)).toFixed(1) + " ";
    }
    $("cyc-done").setAttribute("d", p);
    var toCrest = ((2 * Math.PI - psi) % (2 * Math.PI)) / (2 * Math.PI) * c.P;
    var txt = (psi < 0 ? "Rising toward crest" : "Falling toward trough") +
      " · cycle length " + fmtDur(c.P) + " · next crest in ~" + fmtDur(toCrest) +
      (c.tEnd ? " if the cycle holds" : " (static data — not advancing)");
    if (txt !== lastCycText) { $("cyc-text").textContent = txt; lastCycText = txt; }
  }

  /* ================= analysis + render ================= */
  function clear() {
    ["price", "recon", "bars", "peak-bars", "cyc-done"].forEach(function (id) { $(id).setAttribute("d", ""); });
    ["live-dot", "live-ring", "live-tail"].forEach(function (id) { $(id).setAttribute("visibility", "hidden"); });
    $("rows").textContent = "";
    ["dom-uhz", "dom-period", "s-n", "s-df", "s-nyq", "s-exp", "s-snr", "cyc-text"].forEach(function (id) { $(id).textContent = "—"; });
    $("dom-uhz").removeAttribute("data-v");
    ["y-top", "y-bot", "x-start", "f-min", "f-max", "x-live"].forEach(function (id) { $(id).textContent = ""; });
    view = { key: null, chart: null, bars: null, dom: null, cycle: null };
  }

  /**
   * opts: { key, timestamps?, sec?, live? }  — key identifies the data stream; a new key
   * means a fresh draw-in, the same key means an animated update (slide + morph).
   */
  function render(xs, dtHours, opts) {
    opts = opts || {};
    var res = F.analyze(xs, dtHours);
    if (!res.peaks.length) throw new Error("No spectral peaks found — the series may be too short or flat.");
    var fresh = view.key !== opts.key;

    var m = 0;
    res.d.forEach(function (v) { m = Math.max(m, Math.abs(v)); });
    var s = m ? 110 / m : 1;
    var target = {
      py: res.d.map(function (v) { return MID - s * v; }),
      ry: res.recon.map(function (v) { return MID - s * v; }),
      liveY: null
    };
    if (opts.live && opts.live.c > 0) {
      var dLive = Math.log(opts.live.c) - (res.trendA + res.trendB * res.N);
      target.liveY = clampY(MID - s * dLive);
    }
    var shift = 0, ts = opts.timestamps;
    if (!fresh && ts && view.lastT && opts.sec) shift = Math.max(0, Math.round((ts[ts.length - 1] - view.lastT) / opts.sec));
    view.lastT = ts ? ts[ts.length - 1] : null;
    view.key = opts.key;

    animateChart(target, shift, fresh);
    animateBars(res, fresh);
    $("y-top").textContent = "+" + (m * 100).toFixed(1) + "%";
    $("y-bot").textContent = "−" + (m * 100).toFixed(1) + "%";
    $("x-start").textContent = "−" + fmtDur(res.T);

    var rows = $("rows");
    rows.textContent = "";
    res.peaks.forEach(function (p, i) {
      var row = document.createElement("div");
      row.className = "row";
      [names[i], fmtDur(p.period), p.cpd.toFixed(2), fmtUhz(p.uhz) + " µHz",
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
    animateNumber($("dom-uhz"), p0.uhz, fmtUhz);
    $("dom-period").textContent = "one full cycle every " + fmtDur(p0.period);
    $("s-n").textContent = String(res.N);
    $("s-df").textContent = fmtFreq(res.df);
    $("s-nyq").textContent = fmtFreq(res.nyq);
    $("s-exp").textContent = (res.explained * 100).toFixed(1) + "%";
    $("s-snr").textContent = res.snr.toFixed(2) + " : 1";

    view.cycle = {
      psi0: 2 * Math.PI * p0.k * (res.N - 1) / res.N + p0.theta,
      P: p0.period,
      tEnd: ts && opts.sec ? ts[ts.length - 1] + opts.sec : null
    };
    return res;
  }

  function showPanels(market, versus, basket) {
    $("market").hidden = !market;
    $("versus").hidden = !versus;
    $("basket").hidden = !basket;
  }

  /* ================= contract lens ================= */
  function compareToBasket(m, eco, tokenRes) {
    var idx = new Map();
    eco.timestamps.forEach(function (t, i) { idx.set(t, eco.index[i]); });
    var a = [], b = [];
    m.timestamps.forEach(function (t, i) { if (idx.has(t)) { a.push(m.closes[i]); b.push(idx.get(t)); } });
    if (a.length < 64) { ["v-corr", "v-phase", "v-period"].forEach(function (id) { $(id).textContent = "not enough overlap"; }); return; }
    var da = F.detrendLog(a), db = F.detrendLog(b);
    var P = tokenRes.peaks[0].period, k = Math.max(1, Math.round(a.length * m.intervalHours / P));
    $("v-corr").textContent = F.corr(da, db).toFixed(2);
    $("v-phase").textContent = leadLag(F.wrapDeg(F.binPhase(da, k) - F.binPhase(db, k)), P);
    try {
      var ecoRes = F.analyze(eco.index, eco.intervalHours);
      $("v-period").textContent = ecoRes.peaks[0] ? fmtDur(ecoRes.peaks[0].period) : "—";
    } catch (e) { $("v-period").textContent = "—"; }
  }

  function setText(id, text) {
    var el = $(id);
    if (el.textContent !== text) { el.textContent = text; el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  }

  function loadContract(quiet) {
    if (state.busy) return;
    state.busy = true;
    var key = "c:" + state.ca + ":" + state.interval;
    if (!quiet) { status("Loading live market data…", "info"); $("app-grid").classList.add("loading"); }
    getJSON("/api/market?address=" + encodeURIComponent(state.ca) + "&interval=" + state.interval)
      .then(function (m) {
        if (key !== "c:" + state.ca + ":" + state.interval) return; // user switched meanwhile
        var t = m.token;
        $("meta").textContent = "CONTRACT LENS · " + m.closes.length + " × " + m.intervalLabel + " CANDLES · " + m.source.toUpperCase();
        $("title").textContent = t.name || short(state.ca);
        $("ticker").textContent = t.symbol ? "$" + t.symbol : "";
        document.title = (t.symbol ? "$" + t.symbol : short(state.ca)) + " · SINE analyzer";
        setSource("live market data", $("auto").checked);
        var price = m.live ? m.live.c : t.priceUsd;
        setText("m-price", usd(price));
        setText("m-change", pct(t.change24h));
        $("m-change").className = t.change24h === null ? "" : t.change24h >= 0 ? "up" : "down";
        setText("m-liq", usd(t.liquidityUsd, true));
        setText("m-vol", usd(t.volume24hUsd, true));
        $("m-pool").textContent = t.topPool ? t.topPool.name : "—";
        $("m-pool").href = t.topPool ? "https://www.geckoterminal.com/solana/pools/" + t.topPool.address : "#";
        state.updatedAt = Date.parse(m.updatedAt);
        var res = render(m.closes, m.intervalHours, { key: key, timestamps: m.timestamps, sec: m.intervalSec, live: m.live });
        showPanels(true, true, false);
        status("");

        if (m.intervalSec < 60) {
          ["v-corr", "v-phase", "v-period"].forEach(function (id) { $(id).textContent = "1-min candles and up"; });
          return;
        }
        var fresh = state.eco && state.eco.interval === state.interval && Date.now() - state.eco.at < 300000;
        var got = fresh ? Promise.resolve(state.eco.data) : getJSON("/api/ecosystem?interval=" + state.interval).then(function (e) {
          state.eco = { interval: state.interval, at: Date.now(), data: e };
          return e;
        });
        return got.then(function (eco) { compareToBasket(m, eco, res); })
          .catch(function () { ["v-corr", "v-phase", "v-period"].forEach(function (id) { $(id).textContent = "unavailable"; }); });
      })
      .catch(function (e) {
        if (!quiet) { clear(); showPanels(false, false, false); setSource("no data", false); }
        status(e.message);
      })
      .then(function () { state.busy = false; $("app-grid").classList.remove("loading"); });
  }

  /* ================= ecosystem pulse ================= */
  function loadEcosystem(quiet) {
    if (state.busy) return;
    if (SECONDS[state.interval] < 60) { state.interval = "1m"; $("interval").value = "1m"; setURL(); }
    state.busy = true;
    var key = "e:" + state.interval;
    if (!quiet) { status("Loading the Solana basket… this can take a few seconds when the cache is cold.", "info"); $("app-grid").classList.add("loading"); }
    getJSON("/api/ecosystem?interval=" + state.interval)
      .then(function (eco) {
        if (key !== "e:" + state.interval) return;
        $("meta").textContent = "ECOSYSTEM PULSE · " + eco.tokens.length + " TOKENS · " + eco.index.length + " × " + eco.intervalLabel + " CANDLES";
        $("title").textContent = "Solana ecosystem basket";
        $("ticker").textContent = "";
        document.title = "Ecosystem pulse · SINE analyzer";
        setSource("live · equal-weight index", $("auto").checked);
        state.updatedAt = Date.parse(eco.updatedAt);
        var res = render(eco.index, eco.intervalHours, { key: key, timestamps: eco.timestamps, sec: eco.intervalSec });
        showPanels(false, false, true);

        var dIdx = F.detrendLog(eco.index), k0 = res.peaks[0].k, P0 = res.peaks[0].period;
        var phIdx = F.binPhase(dIdx, k0);
        var rows = $("basket-rows");
        rows.textContent = "";
        eco.tokens.forEach(function (t) {
          var d = F.detrendLog(t.closes), own = "—", share = "—";
          try {
            var r = F.analyze(t.closes, eco.intervalHours);
            if (r.peaks[0]) own = fmtDur(r.peaks[0].period);
            var varD = d.reduce(function (s, v) { return s + v * v; }, 0) / d.length;
            if (r.bins[k0 + 1] && varD) share = (100 * (r.bins[k0 - 1].pw + r.bins[k0].pw + r.bins[k0 + 1].pw) / varD).toFixed(1) + "%";
          } catch (e) {}
          var row = document.createElement("div");
          row.className = "row";
          ["$" + t.symbol, own, share, F.corr(d, dIdx).toFixed(2), leadLag(F.wrapDeg(F.binPhase(d, k0) - phIdx), P0)]
            .forEach(function (c) { var el = document.createElement("span"); el.textContent = c; row.appendChild(el); });
          rows.appendChild(row);
        });
        var note = "Correlation is between detrended log prices. Phase compares each token to the index at the index’s dominant frequency (" + fmtDur(P0) + "): “leads” means the token tends to peak earlier.";
        if (eco.dropped && eco.dropped.length) note += " Left out this time: " + eco.dropped.map(function (d) { return d.symbol; }).join(", ") + ".";
        $("basket-note").textContent = note;
        status("");
      })
      .catch(function (e) {
        if (!quiet) { clear(); showPanels(false, false, false); setSource("no data", false); }
        status(e.message);
      })
      .then(function () { state.busy = false; $("app-grid").classList.remove("loading"); });
  }

  /* ================= your own data ================= */
  function parse(text) {
    var lines = String(text || "").trim().split(/\r?\n/).filter(function (l) { return l.trim(); });
    var toNums = function (l) { return l.split(/[\s,;\t]+/).map(parseFloat).filter(isFinite); };
    if (lines.length > 1) return lines.map(toNums).filter(function (n) { return n.length; }).map(function (n) { return n[n.length - 1]; });
    return lines.length ? toNums(lines[0]) : [];
  }

  function runOwn(isTest) {
    stopPolling();
    state.mode = isTest ? "none" : "own";
    state.updatedAt = null;
    setURL();
    $("error").textContent = "";
    status("");
    var xs = parse($("series").value), dt = parseFloat($("dt").value);
    var fail = function (msg) { clear(); $("error").textContent = msg; };
    if (xs.length < 16) return fail("Need at least 16 prices to resolve any cycles (found " + xs.length + ").");
    if (xs.some(function (v) { return v <= 0; })) return fail("Prices must be positive numbers.");
    if (xs.length > 4096) return fail("Keep it to 4,096 samples or fewer (found " + xs.length + ").");
    try { render(xs, dt, { key: "own:" + xs.length + ":" + xs[0] + ":" + xs[xs.length - 1] + ":" + dt }); } catch (e) { return fail(e.message); }
    showPanels(false, false, false);
    $("meta").textContent = isTest ? "CONTRACT LENS · DEMO" : "YOUR DATA · " + xs.length + " SAMPLES";
    $("title").textContent = isTest ? "Paste a contract address" : "Your price series";
    $("ticker").textContent = "";
    setSource(isTest ? "test signal · planted cycles 3.5 d, 33.6 h, 15.3 h" : "your pasted data", false);
    if (isTest) status("Showing a test signal. Paste a Solana token address above to analyze live market data.", "info");
  }

  /* ================= live polling ================= */
  function stopPolling() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }
  function tick() {
    if (document.hidden) return;
    if (state.mode === "contract") loadContract(true);
    else if (state.mode === "ecosystem") loadEcosystem(true);
  }
  function startPolling() {
    stopPolling();
    var live = $("auto").checked && (state.mode === "contract" || state.mode === "ecosystem");
    $("source").classList.toggle("is-live", live);
    if (!live) return;
    var ms = POLL[state.interval];
    if (state.mode === "ecosystem") ms = Math.max(60000, ms);
    state.timer = setInterval(tick, ms);
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });

  setInterval(function () {
    if (!state.updatedAt) { $("s-upd").textContent = "—"; return; }
    var s = Math.max(0, Math.round((Date.now() - state.updatedAt) / 1000));
    $("s-upd").textContent = s < 60 ? s + " s ago" : Math.round(s / 60) + " min ago";
  }, 1000);

  function go() {
    setURL();
    if (state.mode === "contract") loadContract(false);
    else if (state.mode === "ecosystem") loadEcosystem(false);
    startPolling();
  }

  /* ================= wiring ================= */
  $("ca-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("ca").value.trim();
    if (!MINT.test(v)) { status("That doesn’t look like a Solana mint address (32–44 base58 characters)."); return; }
    state.mode = "contract"; state.ca = v;
    go();
  });
  $("eco-link").addEventListener("click", function (e) { e.preventDefault(); state.mode = "ecosystem"; go(); });
  $("interval").addEventListener("change", function () {
    state.interval = $("interval").value;
    if (state.mode === "ecosystem" && SECONDS[state.interval] < 60) status("Ecosystem pulse uses 1-minute candles and longer — switched to 1 min.", "info");
    if (state.mode === "contract" || state.mode === "ecosystem") go();
  });
  $("auto").addEventListener("change", function () { startPolling(); if ($("auto").checked) tick(); });
  $("run").addEventListener("click", function () { runOwn(false); });
  $("load-test").addEventListener("click", function () { $("series").value = testText; $("dt").value = "0.25"; runOwn(true); });

  function applyCapabilities(secondsOK) {
    state.secondsOK = secondsOK;
    document.querySelectorAll("#interval option[data-pro]").forEach(function (o) {
      o.disabled = !secondsOK;
      o.textContent = o.textContent.replace(/ · Pro API$/, "") + (secondsOK ? "" : " · Pro API");
    });
  }

  /* ================= start ================= */
  var params = new URLSearchParams(location.search);
  var legacy = { "1d": "5m", "7d": "15m", "30d": "1h", "90d": "4h" };
  var iv = params.get("interval") || legacy[params.get("window") || ""] || "15m";
  if (INTERVAL_IDS.indexOf(iv) < 0) iv = "15m";
  var ca = (params.get("ca") || "").trim();
  $("series").value = testText;
  applyCapabilities(false);

  getJSON("/api/health").then(function (h) { return !!h.secondsAvailable; }).catch(function () { return false; }).then(function (ok) {
    applyCapabilities(ok);
    if (SECONDS[iv] < 60 && !ok) {
      status("1–30 second candles need a CoinGecko Pro API key on the server — showing 1-minute candles instead.", "info");
      iv = "1m";
    }
    state.interval = iv;
    $("interval").value = iv;
    if (params.get("mode") === "ecosystem") { state.mode = "ecosystem"; go(); }
    else if (MINT.test(ca)) { state.mode = "contract"; state.ca = ca; $("ca").value = ca; go(); }
    else {
      if (ca) $("ca").value = ca;
      $("own").open = true;
      runOwn(true);
      if (ca) status("That doesn’t look like a Solana mint address (32–44 base58 characters).");
    }
  });
})();
