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

  var state = { mode: "none", ca: "", interval: "15m", basket: "top-cap", timer: null, busy: false, updatedAt: null, eco: null, secondsOK: false };
  var BASKETS = ["top-cap", "top-equal", "core"];
  var isTop = function () { return state.basket !== "core"; };
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
  var fmtDur = function (h) {
    if (h < 1 / 60) return (h * 3600).toFixed(0) + " s";
    if (h >= 72) { var d = h / 24; return (d >= 10 ? d.toFixed(0) : d.toFixed(1)) + " d"; }
    return F.fmtPeriod(h);
  };
  var leadLag = function (deg, periodH) {
    if (Math.abs(deg) < 10) return "in phase";
    return (deg > 0 ? "leads " : "lags ") + fmtDur(Math.abs(deg) / 360 * periodH) + " (" + (deg > 0 ? "+" : "") + deg.toFixed(0) + "°)";
  };
  function fmtUnit(v) {
    if (!isFinite(v)) return "—";
    if (state.units === "usd") return usd(v);
    if (state.units === "index") return v.toFixed(2);
    return Math.abs(v) >= 1000 ? v.toFixed(0) : v.toPrecision(5);
  }
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
    if (state.mode === "ecosystem") { p.set("mode", "ecosystem"); p.set("basket", state.basket); }
    if (state.mode === "contract" || (state.mode === "ecosystem" && !isTop())) p.set("interval", state.interval);
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


  /* ================= glossary popovers ================= */
  var GLOSSARY = {
    strength: ["Rhythm strength", "How regular the price’s movement has been. It comes from how much of the ups and downs the main rhythms explain, reduced if the rhythm has only repeated a few times. Strong means a clear, repeating pattern; none means mostly random movement."],
    frequency: ["Frequency / main rhythm", "How often the strongest rhythm repeats. Simple view shows it as a time (‘every 38 h’). Detailed view shows µHz — millionths of a cycle per second — which lets you compare rhythms across any timeframe."],
    period: ["Period", "The time one full cycle takes, from high to high."],
    amplitude: ["Amplitude", "How big the swing is. ±4% means price has typically risen about 4% above its trend and fallen about 4% below it over each cycle."],
    phase: ["Phase", "Where the cycle stood at the start of the window, in degrees (0° = at a high, 180° = at a low). Mainly useful for comparing when different tokens peak."],
    share: ["Share", "How much of the price’s up-and-down movement this one rhythm explains. Above ~50% is a dominant rhythm; below ~15% it’s barely there."],
    explained: ["Variance explained", "How much of the movement the top three rhythms explain together. The rest is noise: news, big trades, randomness."],
    snr: ["Signal-to-noise", "Rhythmic movement compared with everything else. Above 1 the rhythms outweigh the randomness; below 1 randomness dominates."],
    resolution: ["Frequency resolution", "The smallest difference in rhythm speed this window can tell apart. Longer windows give finer resolution."],
    nyquist: ["Nyquist limit", "The fastest rhythm this candle size can detect (two candles per cycle). SINE only reports rhythms of at least four candles, to stay clear of noise at this edge."],
    detrended: ["What this chart shows", "Price with its overall drift up or down removed (on a log scale, so moves are in %). That leaves just the swings, which is what rhythm analysis works on."],
    position: ["Cycle position", "Where price sits in its main rhythm right now, moving forward in real time at the measured speed. It says where past highs and lows formed — not where the next ones must."],
    projection: ["If the pattern holds", "SINE extends the current trend and rhythms forward from the last close. It’s a “what if the recent pattern continues”, not a prediction. The band shows how far off this kind of projection has typically been on this same chart."],
    record: ["Track record", "SINE re-ran its projection at up to 12 earlier points in this chart, each time using only the data available then, and checked what happened next: how often the direction was right, and whether it beat simply assuming the price stays put."],
    spectrogram: ["Spectrogram (heatmap)", "The Fourier transform run again and again on a window sliding through time, like an audio frequency analyzer. It shows not just which rhythms exist but when: steady, emerging, fading or changing speed."],
    spectrum: ["Spectrum", "The result of the Fourier transform: how strong each possible rhythm is, from slow (left) to fast (right)."],
    correlation: ["Correlation", "From −1 to 1: how much two prices move together once their trends are removed. 0.7+ is close, around 0.4 is partial, near 0 is independent, negative means opposite."],
    leadlag: ["Leads / lags", "Whether this token’s rhythm tends to peak before (leads) or after (lags) the market’s at the same speed. It’s a tendency seen in the window, not a rule."],
    liquidity: ["Liquidity", "Money sitting in the trading pool. Low liquidity means bigger price impact per trade and prices that are easier to push around — patterns in thin markets are less trustworthy."],
    volume: ["24h volume", "Dollar value traded in the last 24 hours. Rhythms in actively traded tokens are more meaningful than in quiet ones."],
    index: ["Index level", "The basket’s value, set to 100 at the start of the window. 104 means the basket is up 4% over the window."],
    breadth: ["Breadth", "How many tokens rose vs. fell over 24 hours. Moves with broad participation tend to be sturdier than moves carried by a few tokens."],
    trend: ["Trend", "The average drift per day underneath the rhythm. SINE fits it as a straight line plus one slow wave, so gradual regime shifts don’t get mistaken for rhythms."],
    stress: ["Stress check", "The share of recent return energy in slow, persistent moves (measured with a rolling Fourier spectrum of returns). Normal random churn puts about 25% there; a surge means pressure is building in one direction. Jun, Ahn, Kim & Kim (2019, Physica A) found this low-frequency surge in stock-index returns ahead of major financial crises. SINE compares it with this token’s own returns shuffled into random order, so big candles alone don’t trigger it. It flags pressure, not direction or timing."],
    randomwalk: ["Rhythm vs. random walk", "A random walk (pure chance) often shows swings that look like cycles. SINE runs 200 simulated random walks through the exact same analysis. The p-value is how often chance alone produced a rhythm this distinct: below 0.05 means the rhythm is very unlikely to be a fluke."],
    kss: ["Mean reversion (Fourier KSS test)", "Asks whether price pulls back toward its underlying trend or just wanders off like a random walk. Pull-back is what makes cycles usable; pure wandering is what an efficient market looks like. The test allows for slow regime shifts and non-linear behaviour, following Kapetanios–Shin–Snell (2003) and Christopoulos & León-Ledesma (2010), as used by Öztürk (2025) for crypto."],
    smoothbreak: ["Slow regime shift", "A gradual change in a token’s behaviour across the window — a slow boom-and-bust or a step up. SINE fits it with a single slow wave (the Enders & Lee Fourier method, frequency k*) and removes it first, so it can’t pose as a rhythm. The p-value says whether the shift is bigger than random walks produce."]
  };
  var pop = $("tip-pop"), openTip = null;
  function closeTip() { if (openTip) openTip.setAttribute("aria-expanded", "false"); openTip = null; pop.hidden = true; }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest(".tip") : null;
    if (!btn) { if (!pop.contains(e.target)) closeTip(); return; }
    e.preventDefault();
    if (openTip === btn) { closeTip(); return; }
    closeTip();
    var g = GLOSSARY[btn.getAttribute("data-tip")];
    if (!g) return;
    pop.textContent = "";
    var h = document.createElement("strong"); h.textContent = g[0];
    var t = document.createElement("span"); t.textContent = g[1];
    pop.appendChild(h); pop.appendChild(t);
    pop.hidden = false;
    var r = btn.getBoundingClientRect(), w = Math.min(300, window.innerWidth - 24);
    var left = Math.max(12, Math.min(window.scrollX + r.left - 12, window.scrollX + window.innerWidth - w - 12));
    pop.style.left = left + "px";
    pop.style.top = (window.scrollY + r.bottom + 8) + "px";
    btn.setAttribute("aria-expanded", "true");
    openTip = btn;
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && openTip) { var b = openTip; closeTip(); b.focus(); } });
  window.addEventListener("resize", closeTip);

  /* ================= simple / detailed ================= */
  function setView(v) {
    document.body.classList.toggle("view-simple", v === "simple");
    document.body.classList.toggle("view-detailed", v === "detailed");
    document.querySelectorAll("[data-view]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === v)); });
    try { localStorage.setItem("sine-view", v); } catch (e) {}
  }
  var savedView = "simple";
  try { savedView = localStorage.getItem("sine-view") || "simple"; } catch (e) {}
  setView(savedView === "detailed" ? "detailed" : "simple");
  var savedChart = "waves";
  try { savedChart = localStorage.getItem("sine-chart") || "waves"; } catch (e) {}
  setChart(savedChart === "spec" ? "spec" : "waves");
  document.querySelectorAll("[data-view]").forEach(function (b) { b.addEventListener("click", function () { setView(b.getAttribute("data-view")); }); });

  /* ================= chart style: waves / heatmap ================= */
  function setChart(v) {
    document.body.classList.toggle("chart-waves", v !== "spec");
    document.body.classList.toggle("chart-spec", v === "spec");
    document.querySelectorAll("[data-chart]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-chart") === v)); });
    try { localStorage.setItem("sine-chart", v); } catch (e) {}
    if (v === "spec" && view.stft) drawSpectrogram(false);
  }
  document.querySelectorAll("[data-chart]").forEach(function (b) { b.addEventListener("click", function () { setChart(b.getAttribute("data-chart")); }); });

  /* ================= spectrogram renderer ================= */
  // "magma" colour map: black → purple → red → orange → pale yellow
  var MAGMA = [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]];
  function heat(t) {
    t = Math.max(0, Math.min(1, t));
    var x = t * (MAGMA.length - 1), i = Math.min(MAGMA.length - 2, Math.floor(x)), f = x - i, a = MAGMA[i], b = MAGMA[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  var SP = { x0: 52, y0: 20, w: 760, h: 230, dB: 36 };
  // Log-frequency axis (like audio analyzers): each doubling of rhythm speed gets equal height.
  function kToY(sp, k) {
    var lo = Math.log(sp.kMin - 0.5), hi = Math.log(sp.kMax + 0.5);
    return SP.y0 + (hi - Math.log(k)) / (hi - lo) * SP.h;
  }
  function specImage(sp) {
    var Fn = sp.frames.length, R = SP.h, off = document.createElement("canvas");
    off.width = Fn; off.height = R;
    var octx = off.getContext("2d"), img = octx.createImageData(Fn, R), top = 0;
    sp.frames.forEach(function (f) { for (var i = 0; i < f.length; i++) top = Math.max(top, f[i]); });
    var lo = Math.log(sp.kMin - 0.5), hi = Math.log(sp.kMax + 0.5), last = sp.kMax - sp.kMin;
    for (var r = 0; r < R; r++) {
      var kf = Math.exp(hi - (r + 0.5) / R * (hi - lo)) - sp.kMin;       // fractional bin index for this pixel row
      kf = Math.max(0, Math.min(last, kf));
      var i0 = Math.floor(kf), i1 = Math.min(last, i0 + 1), t = kf - i0;
      for (var fi = 0; fi < Fn; fi++) {
        var fr = sp.frames[fi], a = fr[i0] * (1 - t) + fr[i1] * t;
        var db = a > 0 && top > 0 ? 20 * Math.log10(a / top) : -SP.dB;
        var c = heat(1 + db / SP.dB), o = (r * Fn + fi) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return off;
  }
  function drawSpectrogram(animate) {
    var sp = view.stft, res = view.res || state.lastRes;
    if (!sp) return;
    var cv = $("spec-canvas"), dpr = Math.min(3, window.devicePixelRatio || 1);
    if (cv.width !== 860 * dpr) { cv.width = 860 * dpr; cv.height = 280 * dpr; }
    var ctx = cv.getContext("2d");
    var next = specImage(sp), prev = animate ? view.specImg : null;
    view.specImg = next;
    // tick marks at even steps on the log axis
    var ticks = [], lo = Math.log(sp.kMin), hi = Math.log(sp.kMax);
    for (var i = 0; i < 5; i++) {
      var k = Math.exp(lo + (hi - lo) * i / 4);
      if (!ticks.length || Math.abs(kToY(sp, k) - kToY(sp, ticks[ticks.length - 1])) > 18) ticks.push(k);
    }
    var paint = function (e) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, 860, 280);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      if (prev && e < 1) { ctx.globalAlpha = 1; ctx.drawImage(prev, SP.x0, SP.y0, SP.w, SP.h); }
      ctx.globalAlpha = prev ? e : 1;
      ctx.drawImage(next, SP.x0, SP.y0, SP.w, SP.h);
      ctx.globalAlpha = 1;
      ctx.font = "11px 'IBM Plex Mono', monospace";
      ctx.fillStyle = "#8A8F98";
      ctx.textAlign = "right";
      ticks.forEach(function (k) {
        var y = kToY(sp, k);
        ctx.fillText(fmtDur(sp.Lw * sp.dt / k), SP.x0 - 6, y + 4);
        ctx.fillRect(SP.x0 - 3, y - 0.5, 3, 1);
      });
      ctx.textAlign = "left";
      ctx.fillText("cycle length", 0, 10);
      ctx.textAlign = "left";
      ctx.fillText("−" + fmtDur((sp.N - sp.Lw) * sp.dt), SP.x0, 272);
      ctx.textAlign = "right";
      ctx.fillText("now", SP.x0 + SP.w, 272);
      ctx.textAlign = "center";
      ctx.fillText("← time →", SP.x0 + SP.w / 2, 272);
      if (res && res.peaks[0]) {
        var kf = sp.Lw * sp.dt / res.peaks[0].period;
        if (kf >= sp.kMin - 0.5 && kf <= sp.kMax + 0.5) {
          var yy = kToY(sp, kf);
          ctx.setLineDash([6, 5]);
          ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.75)";
          ctx.beginPath(); ctx.moveTo(SP.x0, yy); ctx.lineTo(SP.x0 + SP.w, yy); ctx.stroke();
          ctx.lineWidth = 1.2; ctx.strokeStyle = "#ECE9E2";
          ctx.beginPath(); ctx.moveTo(SP.x0, yy); ctx.lineTo(SP.x0 + SP.w, yy); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#ECE9E2"; ctx.textAlign = "left"; ctx.fillText("f₁", SP.x0 + SP.w + 6, yy + 4);
        } else {
          ctx.fillStyle = "#8A8F98"; ctx.textAlign = "left";
          ctx.fillText("f₁ ↓", SP.x0 + SP.w + 6, SP.y0 + SP.h - 2);
        }
      }
    };
    tween("spec", prev ? 600 : 0, paint);
    var pers = res && res.peaks[0] ? F.persistence(sp, res.peaks[0].period) : null;
    $("spec-canvas").setAttribute("aria-label", "Spectrogram of rhythm strength over time" +
      (pers ? ": the main rhythm was clearly present in " + Math.round(pers.share * 100) + "% of the window." : "."));
  }

  /* ================= projection ================= */
  function projVerdict(pr) {
    if (!pr.tested) return { kind: "none", text: "Not enough history to test this projection here. The band shows typical past price moves over this horizon instead — treat the line as illustration only." };
    var dir = pr.dirN ? pr.hits / pr.dirN : 0;
    if (pr.skill >= 0.15 && dir >= 0.6) return { kind: "good", text: "This kind of projection has worked reasonably well on this chart so far — but past patterns can stop at any time." };
    if (pr.skill > 0 && dir >= 0.5) return { kind: "some", text: "A slight edge over assuming no change on this chart. Use it as a loose guide at most." };
    return { kind: "none", text: "On this chart, this projection has done no better than assuming the price stays put. Don’t rely on it." };
  }

  /** Projected high and low within the horizon (h ≥ 1), with their ranges. */
  function turningPoints(pr) {
    var hiH = 1, loH = 1;
    for (var h = 1; h <= pr.H; h++) { if (pr.center[h] > pr.center[hiH]) hiH = h; if (pr.center[h] < pr.center[loH]) loH = h; }
    var last = Math.exp(pr.center[0]);
    var pt = function (h) { var v = Math.exp(pr.center[h]); return { h: h, v: v, pct: (v / last - 1) * 100, lo: Math.exp(pr.lo[h]), hi: Math.exp(pr.hi[h]) }; };
    return { high: pt(hiH), low: pt(loH), end: pt(pr.H), last: last };
  }

  function drawProjection(xs) {
    var pr = view.proj, fig = $("proj-fig");
    if (!pr) { fig.hidden = true; return; }
    fig.hidden = false;
    var hist = xs.slice(pr.backStart), nh = hist.length, H = pr.H, total = nh - 1 + H;
    var X0 = 64, W = 784, Y0 = 30, YH = 184;
    var up = pr.hi.map(Math.exp), dn = pr.lo.map(Math.exp), mid = pr.center.map(Math.exp), fit = pr.fitBack.map(Math.exp);
    var all = hist.concat(up, dn), lo = Math.min.apply(null, all), hi = Math.max.apply(null, all), pad = (hi - lo) * 0.06 || hi * 0.01;
    lo -= pad; hi += pad;
    var X = function (i) { return X0 + i / total * W; }, Y = function (v) { return Y0 + (hi - v) / (hi - lo) * YH; };
    var line = function (vals, off) { return vals.map(function (v, i) { return (i ? "L" : "M") + X(off + i).toFixed(1) + " " + Y(v).toFixed(1); }).join(" "); };
    var nowX = X(nh - 1);
    $("pj-hist").setAttribute("d", line(hist, 0));
    $("pj-fit").setAttribute("d", line(fit, 0));
    $("pj-center").setAttribute("d", line(mid, nh - 1));
    var band = up.map(function (v, h) { return (h ? "L" : "M") + X(nh - 1 + h).toFixed(1) + " " + Y(v).toFixed(1); }).join(" ") + " " +
      dn.slice().reverse().map(function (v, i) { return "L" + X(nh - 1 + H - i).toFixed(1) + " " + Y(v).toFixed(1); }).join(" ") + " Z";
    $("pj-band").setAttribute("d", band);
    $("pj-shade").setAttribute("x", nowX.toFixed(1));
    $("pj-shade").setAttribute("width", (X0 + W - nowX).toFixed(1));
    $("pj-now").setAttribute("x1", nowX.toFixed(1)); $("pj-now").setAttribute("x2", nowX.toFixed(1));
    $("pj-xnow").setAttribute("x", nowX.toFixed(1));
    $("pj-tag").setAttribute("x", (nowX + 6).toFixed(1));
    $("pj-ytop").textContent = fmtUnit(hi); $("pj-ymid").textContent = fmtUnit((hi + lo) / 2); $("pj-ybot").textContent = fmtUnit(lo);
    $("pj-xstart").textContent = "−" + fmtDur((nh - 1) * pr.dt);
    $("pj-xend").textContent = "+" + fmtDur(H * pr.dt);

    var v = projVerdict(pr), weak = v.kind === "none";
    $("pj-center").setAttribute("stroke", weak ? "#8A8F98" : "#7FE3B5");
    $("pj-band").setAttribute("fill", weak ? "#8A8F98" : "#7FE3B5");
    var tp = turningPoints(pr), sg = function (x) { return (x >= 0 ? "+" : "") + x.toFixed(1) + "%"; };
    var blk = function (id, label, q) {
      $(id + "-label").textContent = label;
      $(id).textContent = fmtUnit(q.v) + " (" + sg(q.pct) + ")";
      $(id + "-sub").textContent = "in ~" + fmtDur(q.h * pr.dt) + " · range " + fmtUnit(q.lo) + " – " + fmtUnit(q.hi);
    };
    // show whichever turning point comes first on the left
    if (tp.high.h <= tp.low.h) { blk("pj-a", "Projected high", tp.high); blk("pj-b", "Projected low", tp.low); }
    else { blk("pj-a", "Projected low", tp.low); blk("pj-b", "Projected high", tp.high); }
    var end = tp.end.v;
    if (pr.tested) {
      $("pj-record").textContent = "direction right " + Math.round(100 * pr.hits / Math.max(1, pr.dirN)) + "%";
      $("pj-skill").textContent = pr.hits + " of " + pr.dirN + " checks across " + pr.tests + " past tests · " +
        (pr.skill >= 0 ? Math.round(pr.skill * 100) + "% more accurate than “no change”" : Math.round(-pr.skill * 100) + "% less accurate than “no change”");
    } else {
      $("pj-record").textContent = "not enough history";
      $("pj-skill").textContent = "use a shorter candle interval for a longer record";
    }
    $("pj-verdict").textContent = v.text;
    $("pj-verdict").setAttribute("data-kind", v.kind);
    $("pj-svg").setAttribute("aria-label", "Price over the last " + fmtDur((nh - 1) * pr.dt) + " with a projection " + fmtDur(H * pr.dt) + " ahead: " +
      fmtUnit(end) + ", likely range " + fmtUnit(dn[H]) + " to " + fmtUnit(up[H]) + ". " + v.text);
  }

  /* ================= stress check (low-frequency surge in returns) ================= */
  var STRESS_LABEL = ["Calm", "Elevated", "High"];
  function drawStress(st, dtHours) {
    var fig = $("stress-fig");
    if (!st) { fig.hidden = true; $("s-stress").textContent = "—"; return; }
    fig.hidden = false;
    var X0 = 12, W = 348, Y0 = 10, YH = 100, n = st.series.length;
    var top = Math.max(0.6, st.q95 * 1.15, Math.max.apply(null, st.series) * 1.05);
    var Y = function (v) { return Y0 + (1 - v / top) * YH; };
    var d = "", step = Math.max(1, Math.floor(n / 240));
    for (var i = 0; i < n; i += step) d += (i ? "L" : "M") + (X0 + W * i / (n - 1)).toFixed(1) + " " + Y(st.series[i]).toFixed(1) + " ";
    d += "L" + (X0 + W).toFixed(1) + " " + Y(st.now).toFixed(1);
    var col = ["#9DB4FF", "#F0A857", "#F07A6A"][st.level];
    $("st-line").setAttribute("d", d); $("st-line").setAttribute("stroke", col);
    $("st-dot").setAttribute("cx", X0 + W); $("st-dot").setAttribute("cy", Y(st.now).toFixed(1)); $("st-dot").setAttribute("fill", col);
    ["st-q95", "st-exp"].forEach(function (id, j) { var y = Y(j ? st.expected : st.q95).toFixed(1); $(id).setAttribute("y1", y); $(id).setAttribute("y2", y); });
    $("st-q95-t").setAttribute("y", (Y(st.q95) - 4).toFixed(1)); $("st-exp-t").setAttribute("y", (Y(st.expected) + 12).toFixed(1));
    $("st-x0").textContent = "−" + fmtDur((n - 1) * dtHours);
    $("st-chip").textContent = STRESS_LABEL[st.level]; $("st-chip").setAttribute("data-level", String(st.level));
    var mv = st.lastMove * 100;
    $("st-text").textContent = Math.round(st.now * 100) + "% slow moves (random ≈ " + Math.round(st.expected * 100) + "%) · last " + st.L + " candles " + (mv >= 0 ? "+" : "") + mv.toFixed(1) + "%";
    $("s-stress").textContent = Math.round(st.now * 100) + "% · p = " + (st.p < 0.01 ? "<0.01" : st.p.toFixed(2)) + " · " + Math.round(st.histPct * 100) + "th pct of window · " + STRESS_LABEL[st.level].toLowerCase();
    $("st-svg").setAttribute("aria-label", "Stress check: " + STRESS_LABEL[st.level] + ". " + $("st-text").textContent);
  }

  /* ================= plain-English summary ================= */
  var LEVELS = ["No clear rhythm", "Weak", "Moderate", "Strong", "Very strong"];
  function strengthOf(res) {
    var e = res.explained, lvl = e >= 0.75 ? 4 : e >= 0.55 ? 3 : e >= 0.35 ? 2 : e >= 0.15 ? 1 : 0;
    var seen = res.T / res.peaks[0].period;
    if (seen < 2) lvl = Math.min(lvl, 1);        // seen fewer than twice: could be coincidence
    else if (seen < 3) lvl = Math.min(lvl, 2);   // fewer than three repeats: at most moderate
    var p = res.sig ? res.sig.pTop : null;        // chance a random walk shows a rhythm this distinct
    if (p !== null) { if (p > 0.30) lvl = 0; else if (p > 0.15) lvl = Math.min(lvl, 1); else if (p > 0.05) lvl = Math.min(lvl, 2); }
    return { level: lvl, seen: seen, p: p };
  }
  function cycleNow() {
    var c = view.cycle;
    if (!c || !c.tEnd) return null;
    var psi = c.psi0 + 2 * Math.PI * ((Date.now() / 1000 - c.tEnd) / 3600) / c.P;
    psi = Math.atan2(Math.sin(psi), Math.cos(psi));
    var toCrest = ((2 * Math.PI - psi) % (2 * Math.PI)) / (2 * Math.PI) * c.P;
    var toTrough = ((3 * Math.PI - psi) % (2 * Math.PI)) / (2 * Math.PI) * c.P;
    return { rising: psi < 0, toCrest: toCrest, toTrough: toTrough, P: c.P, frac: (psi + Math.PI) / (2 * Math.PI) };
  }
  var corrPhrase = function (r, label) {
    return r >= 0.7 ? "It moves closely with the " + label : r >= 0.4 ? "It partly moves with the " + label :
      r >= 0.15 ? "It moves only loosely with the " + label : r > -0.15 ? "It moves largely independently of the " + label :
      "It tends to move opposite to the " + label;
  };

  /**
   * ctx: { kind: "contract"|"top"|"core"|"own"|"test", name, vs?: { corr, dphi, P, label }, eco?: { up, down, count, change24h, leaders, followers } }
   */
  function summarize(res, ctx) {
    state.lastRes = res; state.ctx = ctx;
    var st = strengthOf(res), p0 = res.peaks[0], out = [];
    var name = ctx.name, P = fmtDur(p0.period), win = fmtDur(res.T);
    var amp = (p0.amp * 100).toFixed(1), sharePct = Math.round(p0.share * 100), explPct = Math.round(res.explained * 100);
    var seen = Math.floor(st.seen);

    // 1. the rhythm
    var r1;
    var pct = function (p) { return p < 0.01 ? "under 1%" : "about " + Math.round(p * 100) + "%"; };
    if (st.level === 0 && st.p !== null && st.p > 0.30) {
      r1 = name + "’s swings over the last " + win + " are the kind a random walk produces by itself: in 200 simulated random walks, a rhythm this distinct turned up " + pct(st.p) + " of the time. Patterns you think you see on the chart are probably noise.";
    } else if (st.level === 0) {
      r1 = name + "’s moves over the last " + win + " look mostly random: no rhythm explains more than " + Math.max(sharePct, 1) + "% of them. Patterns you think you see on the chart are probably noise.";
    } else {
      r1 = name + " has moved in a " + LEVELS[st.level].toLowerCase() + " rhythm: roughly every " + P + " it swings about ±" + amp + "% around its trend. " +
        "That one rhythm accounts for " + sharePct + "% of the movement over the last " + win + " (the top three together: " + explPct + "%). " +
        (st.seen < 3 ? "It only repeated about " + st.seen.toFixed(1) + " times in this window — too few to lean on, so the rating is marked down."
          : "It repeated about " + seen + " times in this window" + (st.seen >= 6 ? ", enough to take seriously." : "."));
    }
    var pers = view.stft && st.level > 0 ? F.persistence(view.stft, p0.period) : null;
    if (pers) {
      var ps = Math.round(pers.share * 100);
      r1 += " Over time it has been " + (pers.share >= 0.7 ? "steady — clearly present in " + ps + "% of the window" :
        pers.share >= 0.4 ? "present most of the time (" + ps + "% of the window)" : "on and off — clearly present in only " + ps + "% of the window") +
        (pers.change >= 1.4 ? ", and it has been getting stronger lately." : pers.change <= 0.7 ? ", and it has been fading lately." : ".");
    }
    if (st.level > 0 && st.p !== null) {
      r1 += st.p <= 0.05 ? " Tested against 200 simulated random walks, a rhythm this distinct appeared by chance " + pct(st.p) + " of the time — it’s statistically real."
        : " In 200 simulated random walks a rhythm this distinct appeared " + pct(st.p) + " of the time, so it’s suggestive rather than proven.";
    }
    out.push(["The rhythm", r1]);

    // 1b. random or not? (Fourier KSS mean-reversion test + smooth regime shift, after Öztürk 2025)
    if (res.sig) {
      var rk = res.sig.pKss <= 0.05
        ? "Price tends to pull back toward its underlying trend instead of wandering off (Fourier KSS test, " + (res.sig.pKss < 0.01 ? "p < 0.01" : "p ≈ " + res.sig.pKss.toFixed(2)) + "). That non-random behaviour is what makes cycles usable at all — a 2025 study found the same for most major coins."
        : (st.p !== null && st.p <= 0.05
          ? "The pull-back test is inconclusive here (Fourier KSS test, p ≈ " + res.sig.pKss.toFixed(2) + "): between swings, price drifts rather than snapping back toward its trend. The rhythm itself is real, but its timing may slip."
          : "Price wanders around its trend much like a random walk (Fourier KSS test, p ≈ " + res.sig.pKss.toFixed(2) + "), which is what an efficient market looks like. Expect any cycle here to be unreliable.");
      if (res.sig.pBreak <= 0.05) rk += " SINE also found a slow regime shift over the window (about " + res.trend.k.toFixed(1) + " of a cycle) and removed it before measuring the rhythms, so it can’t pose as one.";
      out.push(["Random or not?", rk]);
    }

    // 1c. stress check (low-frequency surge in returns, after Jun et al. 2019)
    var sx = view.stress;
    if (sx) {
      var shp = Math.round(sx.now * 100), ex = Math.round(sx.expected * 100), mv = sx.lastMove * 100;
      var dir = Math.abs(mv) < 0.5 ? "" : " The recent pressure has been " + (mv > 0 ? "upward" : "downward") + " (" + (mv > 0 ? "+" : "") + mv.toFixed(1) + "% over the last " + sx.L + " candles).";
      var rs = sx.level === 2
        ? "High. Recent returns are dominated by slow, persistent moves: " + shp + "% of their energy, against about " + ex + "% for normal random churn, which is more than shuffled versions of this token’s own returns produce " + (sx.p < 0.01 ? "over 99%" : "about " + Math.round((1 - sx.p) * 100) + "%") + " of the time, and near the top of its own recent history. Research on stock indices found this kind of low-frequency surge building ahead of major crises. It signals pressure building in one direction — not how far it runs or when it breaks."
        : sx.level === 1
        ? "Elevated. Slow, persistent moves make up " + shp + "% of recent return energy (normal random churn ≈ " + ex + "%), above what’s usual for this token. Worth watching."
        : "Calm. Recent returns look like normal back-and-forth churn: slow moves make up " + shp + "% of their energy, close to the ≈ " + ex + "% expected by chance.";
      out.push(["Stress check", rs + (sx.level > 0 ? dir : "")]);
    }

    // 2. right now + trend
    var dtH = res.dt, trendDay = (Math.exp(res.trendB * 24 / dtH) - 1) * 100;
    var trendTxt = Math.abs(trendDay) < 0.05 ? "Underneath the swings the overall trend is flat." :
      "Underneath the swings the overall trend is " + (trendDay > 0 ? "up" : "down") + " about " + Math.abs(trendDay).toFixed(2) + "% per day.";
    var cn = cycleNow(), r2;
    if (st.level === 0) r2 = trendTxt + " With no reliable rhythm, the trend and the wider market say more than any cycle timing.";
    else if (cn) {
      var phaseTxt = cn.rising
        ? "Right now it’s in the rising half of the cycle; if the rhythm holds, the next high would come in about " + fmtDur(cn.toCrest) + "."
        : "Right now it’s in the falling half of the cycle; if the rhythm holds, the next low would come in about " + fmtDur(cn.toTrough) + ".";
      if (cn.frac > 0.4 && cn.frac < 0.6) phaseTxt = "Right now it’s near where past highs formed in this rhythm.";
      if (cn.frac < 0.08 || cn.frac > 0.92) phaseTxt = "Right now it’s near where past lows formed in this rhythm.";
      r2 = phaseTxt + " " + trendTxt;
    } else r2 = trendTxt + " (Pasted data has no timestamps, so SINE can’t place it in the cycle in real time.)";
    out.push(["Right now", r2]);

    var pr = view.proj;
    if (pr && isFinite(pr.center[pr.H])) {
      var pv = projVerdict(pr), tp = turningPoints(pr), sgn = function (x) { return (x >= 0 ? "+" : "") + x.toFixed(1) + "%"; };
      var desc = function (q, word) { return word + " around " + fmtUnit(q.v) + " (" + sgn(q.pct) + ") in about " + fmtDur(q.h * pr.dt); };
      var first = tp.high.h <= tp.low.h ? desc(tp.high, "peak") : desc(tp.low, "dip");
      var second = tp.high.h <= tp.low.h ? desc(tp.low, "dip") : desc(tp.high, "peak");
      var monotone = tp.high.h === pr.H || tp.low.h === pr.H ? (tp.end.pct >= 0 ? "drift up" : "drift down") : null;
      var rp = "If the recent pattern holds, over the next " + fmtDur(pr.H * pr.dt) + " SINE’s projection would " +
        (Math.min(tp.high.h, tp.low.h) === 1 && monotone ? monotone + " to around " + fmtUnit(tp.end.v) + " (" + sgn(tp.end.pct) + ")" : first + ", then " + second) +
        ". The likely range widens the further out you look. ";
      if (!pr.tested) rp += "There isn’t enough history here to test how reliable that is, so treat it as illustration only.";
      else if (pv.kind === "good") rp += "Tested at " + pr.tests + " earlier points on this chart, this kind of projection got the direction right " + Math.round(100 * pr.hits / pr.dirN) + "% of the time and beat assuming no change — a useful guide while the pattern lasts.";
      else if (pv.kind === "some") rp += "In past tests on this chart it only slightly beat assuming no change, so it’s a loose guide at most.";
      else rp += "But in past tests on this chart it did no better than assuming the price stays put — don’t rely on it.";
      out.push(["If it holds", rp]);
    }

    // 3. market context
    if (ctx.vs && isFinite(ctx.vs.corr)) {
      var v = ctx.vs, lead = Math.abs(v.dphi) < 10 ? "peaks at about the same time as the market" :
        (v.dphi > 0 ? "tends to peak about " + fmtDur(Math.abs(v.dphi) / 360 * v.P) + " before the market" : "tends to peak about " + fmtDur(Math.abs(v.dphi) / 360 * v.P) + " after the market");
      var r3 = corrPhrase(v.corr, v.label) + " (correlation " + v.corr.toFixed(2) + ")";
      r3 += v.corr >= 0.4 ? " and " + lead + ". Because it tracks the market, the market’s direction matters for it." :
        ". Its own story — news, holders, liquidity — matters more than the market’s mood.";
      out.push(["Against the market", r3]);
    } else if (ctx.eco) {
      var e = ctx.eco, frac = e.count ? e.up / e.count : 0;
      var breadth = frac >= 0.7 ? "broad strength" : frac <= 0.3 ? "broad weakness" : "a mixed market";
      var r3e = (e.count ? e.up + " of " + e.count + " tokens rose in the last 24 hours — " + breadth + "." : "How the basket’s tokens relate to its rhythm:") +
        (isFinite(e.change24h) ? " The index is " + (e.change24h >= 0 ? "up " : "down ") + Math.abs(e.change24h).toFixed(2) + "% on the day." : "");
      if (e.leaders.length) r3e += " Tend to move first: " + e.leaders.join(", ") + ".";
      if (e.followers.length) r3e += " Tend to follow: " + e.followers.join(", ") + ".";
      if (!e.leaders.length && !e.followers.length) r3e += " No token clearly moves ahead of or behind the index right now.";
      out.push(["Across the market", r3e]);
    } else if (ctx.kind === "contract") {
      out.push(["Against the market", ctx.vsNote || "Comparing with the market…"]);
    }

    // 4. how to use it
    var r4;
    if (st.level >= 3) r4 = "A rhythm this regular is useful timing context: buying late in a rising half means buying close to where past highs formed, and holding for much less than " + fmtDur(p0.period / 2) + " mostly captures noise inside the swing. If the strength drops sharply on a later refresh, the pattern is breaking down — often a sign news or a new trend has taken over.";
    else if (st.level === 2) r4 = "There’s a real rhythm, but other forces matter as much. Use it as one input alongside the trend and the market’s direction, not as a timer.";
    else r4 = "Price here is driven more by news, flows and the wider market than by a repeating rhythm. Lean on the trend and the market comparison, and treat chart ‘patterns’ with suspicion.";
    if (ctx.kind === "top" || ctx.kind === "core") r4 += " Tokens that tend to move first can hint at where the market is heading; tokens that follow may be slower to react — these relationships shift, so re-check them.";
    out.push(["How to use it", r4]);

    var body = $("summary-body");
    body.textContent = "";
    out.forEach(function (pair) {
      var para = document.createElement("p"), b = document.createElement("strong");
      b.textContent = pair[0];
      para.appendChild(b);
      para.appendChild(document.createTextNode(pair[1]));
      body.appendChild(para);
    });
    $("strength").setAttribute("data-level", String(st.level));
    $("strength-label").textContent = LEVELS[st.level];
    $("summary").hidden = false;
  }
  function refreshSummary(patch) {
    if (!state.lastRes || !state.ctx) return;
    for (var k in patch) state.ctx[k] = patch[k];
    summarize(state.lastRes, state.ctx);
  }

  /* ================= analysis + render ================= */
  function clear() {
    ["price", "recon", "bars", "peak-bars", "cyc-done"].forEach(function (id) { $(id).setAttribute("d", ""); });
    ["live-dot", "live-ring", "live-tail"].forEach(function (id) { $(id).setAttribute("visibility", "hidden"); });
    $("rows").textContent = "";
    $("summary").hidden = true;
    state.lastRes = null;
    ["dom-uhz", "dom-simple", "dom-swing", "dom-period", "s-n", "s-df", "s-nyq", "s-exp", "s-snr", "s-sig", "s-kss", "s-break", "s-stress", "cyc-text"].forEach(function (id) { $(id).textContent = "—"; });
    $("dom-uhz").removeAttribute("data-v");
    ["y-top", "y-bot", "x-start", "f-min", "f-max", "x-live"].forEach(function (id) { $(id).textContent = ""; });
    view = { key: null, chart: null, bars: null, dom: null, cycle: null, stft: null, specImg: null, proj: null };
    $("proj-fig").hidden = true; $("stress-fig").hidden = true;
    var cv = $("spec-canvas"); cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
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
      var dLive = Math.log(opts.live.c) - res.trendAt(res.N);
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
    $("dom-simple").textContent = "every " + fmtDur(p0.period);
    $("dom-swing").textContent = "swings about ±" + (p0.amp * 100).toFixed(1) + "% each cycle";
    $("s-n").textContent = String(res.N);
    $("s-df").textContent = fmtFreq(res.df);
    $("s-nyq").textContent = fmtFreq(res.nyq);
    $("s-exp").textContent = (res.explained * 100).toFixed(1) + "%";
    $("s-snr").textContent = res.snr.toFixed(2) + " : 1";
    var fp = function (p) { return p < 0.01 ? "p < 0.01" : "p = " + p.toFixed(2); };
    if (res.sig) {
      $("s-sig").textContent = fp(res.sig.pTop) + (res.sig.pTop <= 0.05 ? " · significant" : " · not significant");
      $("s-kss").textContent = "t = " + res.kssT.toFixed(2) + " · " + fp(res.sig.pKss) + (res.sig.pKss <= 0.05 ? " · mean-reverting" : " · random-walk-like");
      $("s-break").textContent = "k* = " + res.trend.k.toFixed(1) + " · " + fp(res.sig.pBreak) + (res.sig.pBreak <= 0.05 ? " · removed" : " · minor");
    } else { ["s-sig", "s-kss", "s-break"].forEach(function (id) { $(id).textContent = "—"; }); }

    try { view.stft = F.stft(xs, dtHours, p0.period); } catch (e) { view.stft = null; }
    try {
      // stress = slow pressure the rhythms DON'T explain: with a real rhythm (moderate+), remove it first
      var useResid = strengthOf(res).level >= 2;
      var model = useResid ? F.harmonicFit(xs.map(Math.log), res.peaks.map(function (pk) { return dtHours / pk.period; })) : null;
      var sIn = model ? xs.map(function (c, i) { return Math.exp(Math.log(c) - model(i)); }) : xs;   // exact least-squares fit at the refined frequencies
      view.stress = F.stressIndex(sIn);
      if (view.stress && useResid) view.stress.lastMove = xs[xs.length - 1] / xs[Math.max(0, xs.length - 1 - view.stress.L)] - 1;
    } catch (e) { view.stress = null; }
    drawStress(view.stress, dtHours);
    view.res = res;
    if (fresh) { view.proj = null; $("proj-fig").hidden = true; }
    var projKey = opts.key, projXs = xs;
    setTimeout(function () {
      if (view.key !== projKey) return;
      try { view.proj = F.project(projXs, dtHours, p0.period); } catch (e) { view.proj = null; }
      drawProjection(projXs);
      refreshSummary({});
    }, 30);
    if (document.body.classList.contains("chart-spec")) drawSpectrogram(!fresh);
    else view.specImg = null;

    view.cycle = {
      psi0: 2 * Math.PI * p0.k * (res.N - 1) / res.N + p0.theta,
      P: p0.period,
      tEnd: ts && opts.sec ? ts[ts.length - 1] + opts.sec : null
    };
    return res;
  }

  function showPanels(market, versus, basket, ecoStrip) {
    $("market").hidden = !market;
    $("versus").hidden = !versus;
    $("basket").hidden = !basket;
    $("eco-strip").hidden = !ecoStrip;
  }

  /** Basket/interval controls depend on the mode. */
  function syncControls() {
    var eco = state.mode === "ecosystem";
    $("basket-label").hidden = !eco;
    $("basket-select").hidden = !eco;
    $("basket-select").value = state.basket;
    var locked = eco && isTop();
    $("interval").disabled = locked;
    $("interval").value = locked ? "1h" : state.interval;
    $("interval").title = locked ? "The Top 20 index is built from CoinGecko's hourly 7-day price history." : "";
  }

  /** columns: [{ label, width }]; rows: arrays of cells (string or { text, href }). */
  function basketTable(columns, rows) {
    var tpl = columns.map(function (c) { return c.width || "1fr"; }).join(" ");
    var head = $("basket-head");
    head.textContent = "";
    head.style.gridTemplateColumns = tpl;
    columns.forEach(function (c) { var el = document.createElement("span"); el.textContent = c.label; head.appendChild(el); });
    var body = $("basket-rows");
    body.textContent = "";
    rows.forEach(function (cells) {
      var row = document.createElement("div");
      row.className = "row";
      row.style.gridTemplateColumns = tpl;
      cells.forEach(function (c) {
        var el;
        if (c && c.href) { el = document.createElement("a"); el.href = c.href; el.textContent = c.text; }
        else { el = document.createElement("span"); el.textContent = c && c.text !== undefined ? c.text : c; if (c && c.cls) el.className = c.cls; }
        var cell = document.createElement("span");
        cell.appendChild(el);
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
  }

  function leadersFollowers(list) {
    var rel = list.filter(function (x) { return x.v.corrN >= 0.4; });
    var lead = rel.filter(function (x) { return x.v.dphiN >= 20; }).sort(function (a, b) { return b.v.dphiN - a.v.dphiN; }).slice(0, 3);
    var foll = rel.filter(function (x) { return x.v.dphiN <= -20; }).sort(function (a, b) { return a.v.dphiN - b.v.dphiN; }).slice(0, 3);
    var nm = function (x) { return "$" + x.sym; };
    return { leaders: lead.map(nm), followers: foll.map(nm) };
  }

  /** Per-token cycle stats against an index series (same length, same timestamps). */
  function tokenVsIndex(closes, index, dtHours, k0, P0, phIdx, dIdx) {
    var d = F.detrendLog(closes), own = "—", share = "—";
    try {
      var r = F.analyze(closes, dtHours);
      if (r.peaks[0]) own = fmtDur(r.peaks[0].period);
      var varD = d.reduce(function (s, v) { return s + v * v; }, 0) / d.length;
      if (r.bins[k0 + 1] && varD) share = (100 * (r.bins[k0 - 1].pw + r.bins[k0].pw + r.bins[k0 + 1].pw) / varD).toFixed(1) + "%";
    } catch (e) {}
    var cN = F.corr(d, dIdx), dN = F.wrapDeg(F.binPhase(d, k0) - phIdx);
    return { own: own, share: share, corr: cN.toFixed(2), phase: leadLag(dN, P0), corrN: cN, dphiN: dN };
  }

  /* ================= contract lens ================= */
  function compareToBasket(m, eco, tokenRes) {
    var idx = new Map();
    eco.timestamps.forEach(function (t, i) { idx.set(t, eco.index[i]); });
    var a = [], b = [];
    m.timestamps.forEach(function (t, i) { if (idx.has(t)) { a.push(m.closes[i]); b.push(idx.get(t)); } });
    if (a.length < 64) { ["v-corr", "v-phase", "v-period"].forEach(function (id) { $(id).textContent = "not enough overlap"; }); refreshSummary({ vsNote: "Not enough overlapping history with the market basket to compare." }); return; }
    var da = F.detrendLog(a), db = F.detrendLog(b);
    var P = tokenRes.peaks[0].period, k = Math.max(1, Math.round(a.length * m.intervalHours / P));
    var cr = F.corr(da, db), dphi = F.wrapDeg(F.binPhase(da, k) - F.binPhase(db, k));
    $("v-corr").textContent = cr.toFixed(2);
    $("v-phase").textContent = leadLag(dphi, P);
    refreshSummary({ vs: { corr: cr, dphi: dphi, P: P, label: m.intervalSec === 3600 ? "Solana top-20 index" : "core Solana basket" } });
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
        state.units = "usd";
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
        showPanels(true, true, false, false);
        var prevVs = state.ctx && state.ctx.kind === "contract" && state.ctx.key === key ? state.ctx.vs : null;
        summarize(res, { kind: "contract", key: key, name: t.symbol ? "$" + t.symbol : (t.name || "This token"), vs: prevVs,
          vsNote: m.intervalSec < 60 ? "Market comparison is available on 1-minute candles and longer." : "Comparing with the market…" });
        status("");

        if (m.intervalSec < 60) {
          ["v-corr", "v-phase", "v-period"].forEach(function (id) { $(id).textContent = "1-min candles and up"; });
          return;
        }
        var useTop = state.interval === "1h";
        var ecoKey = useTop ? "top" : state.interval;
        $("v-corr-label").textContent = "Correlation with " + (useTop ? "Top 20 index" : "core basket index");
        $("v-phase-label").textContent = "Phase vs. " + (useTop ? "Top 20" : "core basket") + " at this token’s f₁";
        $("v-period-label").textContent = (useTop ? "Top 20" : "Core basket") + "’s own dominant period";
        var fresh = state.eco && state.eco.key === ecoKey && Date.now() - state.eco.at < 300000;
        var got = fresh ? Promise.resolve(state.eco.data) : getJSON(useTop ? "/api/top?weight=cap" : "/api/ecosystem?interval=" + state.interval).then(function (e) {
          state.eco = { key: ecoKey, at: Date.now(), data: e };
          return e;
        });
        return got.then(function (eco) { compareToBasket(m, eco, res); })
          .catch(function () { ["v-corr", "v-phase", "v-period"].forEach(function (id) { $(id).textContent = "unavailable"; }); refreshSummary({ vsNote: "The market comparison is unavailable right now." }); });
      })
      .catch(function (e) {
        if (!quiet) { clear(); showPanels(false, false, false, false); setSource("no data", false); }
        status(e.message);
      })
      .then(function () { state.busy = false; $("app-grid").classList.remove("loading"); });
  }

  /* ================= ecosystem pulse ================= */
  function loadEcosystem(quiet) { return isTop() ? loadTop(quiet) : loadCore(quiet); }

  function loadTop(quiet) {
    if (state.busy) return;
    state.busy = true;
    var weight = state.basket === "top-equal" ? "equal" : "cap";
    var key = "t:" + weight;
    if (!quiet) { status("Loading the top Solana tokens…", "info"); $("app-grid").classList.add("loading"); }
    getJSON("/api/top?weight=" + weight)
      .then(function (eco) {
        if (key !== "t:" + (state.basket === "top-equal" ? "equal" : "cap") || !isTop()) return;
        state.units = "index";
        var wlabel = weight === "cap" ? "MARKET-CAP WEIGHTED, " + Math.round(eco.capLimit * 100) + "% CAP" : "EQUAL WEIGHTED";
        $("meta").textContent = "ECOSYSTEM PULSE · TOP " + eco.count + " SOLANA TOKENS · " + wlabel + " · HOURLY, 7 DAYS";
        $("title").textContent = "Solana market · Top " + eco.count;
        $("ticker").textContent = "";
        document.title = "Solana Top " + eco.count + " · SINE analyzer";
        setSource("live · " + eco.source, $("auto").checked);
        state.updatedAt = Date.parse(eco.updatedAt);
        var res = render(eco.index, 1, { key: key, timestamps: eco.timestamps, sec: 3600, live: eco.live });
        showPanels(false, false, true, true);

        var st = eco.stats, trendDay = (Math.exp(res.trendB * 24) - 1) * 100;
        setText("e-level", eco.live.c.toFixed(2));
        setText("e-24h", pct(st.change24h));
        $("e-24h").className = st.change24h >= 0 ? "up" : "down";
        setText("e-7d", pct(st.change7d));
        $("e-7d").className = st.change7d >= 0 ? "up" : "down";
        setText("e-breadth", st.up24h + " up · " + st.down24h + " down");
        setText("e-trend", (trendDay >= 0 ? "Up " : "Down ") + Math.abs(trendDay).toFixed(2) + "%/day");
        $("e-trend").className = trendDay >= 0 ? "up" : "down";

        var dIdx = F.detrendLog(eco.index), k0 = res.peaks[0].k, P0 = res.peaks[0].period, phIdx = F.binPhase(dIdx, k0);
        var rel = [];
        var rows = eco.tokens.map(function (t) {
          var v = tokenVsIndex(t.closes, eco.index, 1, k0, P0, phIdx, dIdx);
          rel.push({ sym: t.symbol, v: v });
          var sym = { text: "$" + t.symbol, href: "/api/open?id=" + encodeURIComponent(t.id) + "&interval=1h" };
          return [String(t.rank || "—"), sym, (t.weight * 100).toFixed(1) + "%",
            { text: pct(t.change24h), cls: t.change24h === null ? "" : t.change24h >= 0 ? "up" : "down" },
            v.own, v.corr, v.phase];
        });
        $("basket-title").textContent = "The " + eco.count + " tokens in the index";
        basketTable([
          { label: "rank", width: "0.5fr" }, { label: "token", width: "1fr" }, { label: "weight", width: "0.8fr" },
          { label: "24h", width: "0.8fr" }, { label: "own f₁ period", width: "1fr" }, { label: "correlation", width: "0.8fr" },
          { label: "phase vs. index f₁", width: "1.5fr" }], rows);
        var note = "Ranked by market cap from CoinGecko’s Solana ecosystem list. Left out: stablecoins, wrapped BTC/ETH, tokenized gold, and liquid-staking tokens (anything whose price tracks SOL almost exactly)" +
          (eco.skipped && eco.skipped.length ? " — this time: " + eco.skipped.map(function (x) { return "$" + x.symbol; }).join(", ") : "") + ". " +
          (weight === "cap" ? "Weights follow market cap, capped at " + Math.round(eco.capLimit * 100) + "% per token so SOL doesn’t become the whole index. " : "Every token counts equally. ") +
          "Correlation is between detrended log prices; phase compares each token to the index at its dominant frequency (" + fmtDur(P0) + "). Click a token to open it in the contract lens.";
        $("basket-note").textContent = note;
        var lf = leadersFollowers(rel);
        summarize(res, { kind: "top", name: "The Solana top-" + eco.count + " index",
          eco: { up: st.up24h, down: st.down24h, count: eco.count, change24h: st.change24h, leaders: lf.leaders, followers: lf.followers } });
        status("");
      })
      .catch(function (e) {
        if (!quiet) { clear(); showPanels(false, false, false, false); setSource("no data", false); }
        status(e.message);
      })
      .then(function () { state.busy = false; $("app-grid").classList.remove("loading"); });
  }

  function loadCore(quiet) {
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
        state.units = "index";
        $("ticker").textContent = "";
        document.title = "Ecosystem pulse · SINE analyzer";
        setSource("live · equal-weight index", $("auto").checked);
        state.updatedAt = Date.parse(eco.updatedAt);
        var res = render(eco.index, eco.intervalHours, { key: key, timestamps: eco.timestamps, sec: eco.intervalSec });
        showPanels(false, false, true, false);

        var dIdx = F.detrendLog(eco.index), k0 = res.peaks[0].k, P0 = res.peaks[0].period, phIdx = F.binPhase(dIdx, k0);
        $("basket-title").textContent = "Core basket tokens against the index";
        var coreRel = [];
        basketTable([{ label: "token" }, { label: "own f₁ period" }, { label: "share of index f₁" }, { label: "correlation" }, { label: "phase vs. index f₁", width: "1.4fr" }],
          eco.tokens.map(function (t) {
            var v = tokenVsIndex(t.closes, eco.index, eco.intervalHours, k0, P0, phIdx, dIdx);
            coreRel.push({ sym: t.symbol, v: v });
            return [{ text: "$" + t.symbol, href: "/analyzer?ca=" + encodeURIComponent(t.mint) + "&interval=" + state.interval }, v.own, v.share, v.corr, v.phase];
          }));
        var note = "Correlation is between detrended log prices. Phase compares each token to the index at the index’s dominant frequency (" + fmtDur(P0) + "): “leads” means the token tends to peak earlier.";
        if (eco.dropped && eco.dropped.length) note += " Left out this time: " + eco.dropped.map(function (d) { return d.symbol; }).join(", ") + ".";
        $("basket-note").textContent = note;
        var lfc = leadersFollowers(coreRel);
        summarize(res, { kind: "core", name: "The core Solana basket",
          eco: { up: NaN, down: 0, count: 0, change24h: NaN, leaders: lfc.leaders, followers: lfc.followers } });
        status("");
      })
      .catch(function (e) {
        if (!quiet) { clear(); showPanels(false, false, false, false); setSource("no data", false); }
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
    syncControls();
    state.updatedAt = null;
    setURL();
    $("error").textContent = "";
    status("");
    var xs = parse($("series").value), dt = parseFloat($("dt").value);
    var fail = function (msg) { clear(); $("error").textContent = msg; };
    if (xs.length < 16) return fail("Need at least 16 prices to resolve any cycles (found " + xs.length + ").");
    if (xs.some(function (v) { return v <= 0; })) return fail("Prices must be positive numbers.");
    if (xs.length > 4096) return fail("Keep it to 4,096 samples or fewer (found " + xs.length + ").");
    state.units = "raw";
    var ownRes;
    try { ownRes = render(xs, dt, { key: "own:" + xs.length + ":" + xs[0] + ":" + xs[xs.length - 1] + ":" + dt }); } catch (e) { return fail(e.message); }
    showPanels(false, false, false, false);
    summarize(ownRes, { kind: isTest ? "test" : "own", name: isTest ? "This test signal" : "Your series" });
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
    if (state.mode === "ecosystem") ms = isTop() ? 120000 : Math.max(60000, ms);
    state.timer = setInterval(tick, ms);
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });

  setInterval(function () { if (state.lastRes && state.ctx) summarize(state.lastRes, state.ctx); }, 30000);
  setInterval(function () {
    if (!state.updatedAt) { $("s-upd").textContent = "—"; return; }
    var s = Math.max(0, Math.round((Date.now() - state.updatedAt) / 1000));
    $("s-upd").textContent = s < 60 ? s + " s ago" : Math.round(s / 60) + " min ago";
  }, 1000);

  function go() {
    syncControls();
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
    if (state.mode === "ecosystem" && !isTop() && SECONDS[state.interval] < 60) status("Ecosystem pulse uses 1-minute candles and longer — switched to 1 min.", "info");
    if (state.mode === "contract" || state.mode === "ecosystem") go();
  });
  $("basket-select").addEventListener("change", function () { state.basket = $("basket-select").value; if (state.mode === "ecosystem") go(); });
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
  var bk = { "top50-cap": "top-cap", "top50-equal": "top-equal" }[params.get("basket")] || params.get("basket");
  if (bk && BASKETS.indexOf(bk) >= 0) state.basket = bk;
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
    if (params.get("mode") === "ecosystem") {
      state.mode = "ecosystem"; go();
      var missing = params.get("missing");
      if (missing) setTimeout(function () { status("CoinGecko doesn’t list a Solana contract address for “" + missing + "”, so it can’t be opened in the contract lens.", "info"); }, 2500);
    }
    else if (MINT.test(ca)) { state.mode = "contract"; state.ca = ca; $("ca").value = ca; go(); }
    else {
      if (ca) $("ca").value = ca;
      $("own").open = true;
      runOwn(true);
      if (ca) status("That doesn’t look like a Solana mint address (32–44 base58 characters).");
    }
  });
})();
