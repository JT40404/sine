/*
 * SINE Fourier core (browser).
 * log price → least-squares linear detrend → Hann window → DFT
 * → spectral peaks (≥ 2 full cycles), refined by parabolic interpolation
 * → amplitude, phase, share of detrended variance (Parseval, un-windowed DFT)
 */
(function () {
  "use strict";

  function testSignal() {
    var N = 672, dt = 0.25, out = [], s = 12345;
    function rnd() { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }
    for (var i = 0; i < N; i++) {
      var t = i * dt;
      var g = (rnd() + rnd() + rnd() + rnd() - 2) * 1.2;
      var v = 0.0004 * i
        + 0.04 * Math.sin(2 * Math.PI * t / 84 + 0.7)
        + 0.018 * Math.sin(2 * Math.PI * t / 33.6 + 2.0)
        + 0.009 * Math.sin(2 * Math.PI * t / (168 / 11) + 5.06)
        + 0.008 * g;
      out.push(+(100 * Math.exp(v)).toFixed(4));
    }
    return out;
  }

  function analyze(xs, dt, nPeaks) {
    nPeaks = nPeaks || 3;
    var N = xs.length, i, n, k;
    var y = xs.map(Math.log);
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (i = 0; i < N; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; }
    var b = (N * sxy - sx * sy) / (N * sxx - sx * sx), a = (sy - b * sx) / N;
    var d = y.map(function (v, i) { return v - (a + b * i); });
    var variance = 0;
    for (i = 0; i < N; i++) variance += d[i] * d[i];
    variance /= N;
    var w = d.map(function (v, i) { return v * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1))); });

    var half = Math.floor(N / 2), bins = [];
    for (k = 0; k <= half; k++) {
      var re = 0, im = 0, re2 = 0, im2 = 0;
      for (n = 0; n < N; n++) {
        var g = 2 * Math.PI * k * n / N, c = Math.cos(g), s = Math.sin(g);
        re += w[n] * c; im -= w[n] * s; re2 += d[n] * c; im2 -= d[n] * s;
      }
      bins.push({ k: k, amp: 4 * Math.hypot(re, im) / N, re2: re2, im2: im2, pw: 2 * (re2 * re2 + im2 * im2) / (N * N) });
    }

    var cand = [];
    // ≥ 2 full cycles in the window, ≥ 4 samples per cycle (ignores noise piled up near Nyquist)
    var kMax = Math.min(half - 1, Math.floor(N / 4));
    for (k = 2; k <= kMax; k++) if (bins[k].amp > bins[k - 1].amp && bins[k].amp >= bins[k + 1].amp) cand.push(k);
    cand.sort(function (p, q) { return bins[q].amp - bins[p].amp; });

    var T = N * dt;
    var peaks = cand.slice(0, nPeaks).map(function (k) {
      var la = Math.log(bins[k - 1].amp), lb = Math.log(bins[k].amp), lc = Math.log(bins[k + 1].amp);
      var den = la - 2 * lb + lc;
      var delta = den && isFinite(den) ? 0.5 * (la - lc) / den : 0;
      delta = Math.max(-0.5, Math.min(0.5, delta));
      var period = T / (k + delta);
      return {
        k: k, period: period,
        uhz: 1e6 / (period * 3600), cpd: 24 / period,
        amp: bins[k].amp,
        phase: ((Math.atan2(bins[k].im2, bins[k].re2) * 180 / Math.PI) + 360) % 360,
        theta: Math.atan2(bins[k].im2, bins[k].re2),
        share: variance ? (bins[k - 1].pw + bins[k].pw + bins[k + 1].pw) / variance : 0
      };
    });

    var comps = peaks.map(function (p) {
      var B = bins[p.k];
      return d.map(function (_, n) {
        var g = 2 * Math.PI * p.k * n / N;
        return (2 / N) * (B.re2 * Math.cos(g) - B.im2 * Math.sin(g));
      });
    });
    var recon = d.map(function (_, n) { return comps.reduce(function (s, c) { return s + c[n]; }, 0); });
    var explained = Math.min(0.999, peaks.reduce(function (s, p) { return s + p.share; }, 0));
    return {
      N: N, dt: dt, T: T, d: d, trendA: a, trendB: b, bins: bins, peaks: peaks, comps: comps, recon: recon,
      explained: explained, snr: explained / (1 - explained), df: 1 / T, nyq: 1 / (2 * dt)
    };
  }

  function linePath(arr, x0, w, yMid, s) {
    var n = arr.length, p = "";
    for (var i = 0; i < n; i++) p += (i ? "L" : "M") + (x0 + i * w / (n - 1)).toFixed(1) + " " + (yMid - s * arr[i]).toFixed(1) + " ";
    return p;
  }

  function barPaths(res, x0, W, base, H, minBins) {
    var maxK = res.peaks.reduce(function (m, p) { return Math.max(m, p.k); }, 0);
    var M = Math.min(res.bins.length - 1, Math.max(minBins, Math.ceil(maxK * 1.6)));
    var peakSet = {};
    res.peaks.forEach(function (p) { peakSet[p.k] = true; });
    var top = 0, k;
    for (k = 1; k <= M; k++) top = Math.max(top, res.bins[k].amp);
    var bw = W / M, gap = Math.min(3, bw * 0.25), bars = "", peakBars = "", pos = {};
    for (k = 1; k <= M; k++) {
      var h = top ? H * res.bins[k].amp / top : 0, x = x0 + (k - 1) * bw + gap / 2, y = base - h;
      var seg = "M" + x.toFixed(1) + " " + y.toFixed(1) + "h" + (bw - gap).toFixed(1) + "V" + base + "H" + x.toFixed(1) + "Z ";
      if (peakSet[k]) { peakBars += seg; pos[k] = { x: x + (bw - gap) / 2, y: y - 10 }; } else bars += seg;
    }
    return { bars: bars, peakBars: peakBars, pos: pos, M: M };
  }

  function fmtPeriod(h) {
    if (h < 1) return (h * 60).toFixed(0) + " min";
    if (h >= 72) return (h / 24).toFixed(2) + " d";
    return h.toFixed(1) + " h";
  }

  /**
   * Short-time Fourier transform (spectrogram) of log price.
   * Slides a window of Lw samples along the series (step `hop`), and in each window: removes the
   * linear trend, applies a Hann window and measures amplitude at bins k = 2..kMax
   * (≥ 2 cycles per window, ≥ 4 samples per cycle). frames[f][k - 2] is the amplitude of bin k.
   * Lw is at least a quarter of the series and long enough to hold ~2 cycles of the main rhythm when
   * possible (capped at half the series and 512 samples, to keep it fast enough for live refreshes).
   */
  function stft(xs, dt, mainPeriodH) {
    var N = xs.length, y = xs.map(Math.log);
    var Lw = Math.round(Math.max(N / 4, mainPeriodH ? 2 * mainPeriodH / dt : 0));
    Lw = Math.max(Math.min(32, N), Math.min(Lw, Math.floor(N / 2), 512));
    var kMax = Math.max(2, Math.floor(Lw / 4));
    var hop = Math.max(1, Math.ceil((N - Lw) / 160));
    var cosT = new Float64Array(kMax * Lw), sinT = new Float64Array(kMax * Lw), hann = new Float64Array(Lw), k, n;
    for (k = 1; k <= kMax; k++) for (n = 0; n < Lw; n++) {
      var g = 2 * Math.PI * k * n / Lw;
      cosT[(k - 1) * Lw + n] = Math.cos(g); sinT[(k - 1) * Lw + n] = Math.sin(g);
    }
    for (n = 0; n < Lw; n++) hann[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (Lw - 1));
    var sx = Lw * (Lw - 1) / 2, sxx = (Lw - 1) * Lw * (2 * Lw - 1) / 6, den = Lw * sxx - sx * sx;
    var starts = [];
    for (var st = 0; st + Lw <= N; st += hop) starts.push(st);
    if (starts[starts.length - 1] !== N - Lw) starts.push(N - Lw);
    var frames = [], ends = [], w = new Float64Array(Lw);
    starts.forEach(function (st) {
      var sy = 0, sxy = 0;
      for (n = 0; n < Lw; n++) { sy += y[st + n]; sxy += n * y[st + n]; }
      var b = (Lw * sxy - sx * sy) / den, a = (sy - b * sx) / Lw;
      for (n = 0; n < Lw; n++) w[n] = (y[st + n] - (a + b * n)) * hann[n];
      var amps = new Float32Array(kMax - 1);
      for (k = 2; k <= kMax; k++) {
        var re = 0, im = 0, o = (k - 1) * Lw;
        for (n = 0; n < Lw; n++) { re += w[n] * cosT[o + n]; im -= w[n] * sinT[o + n]; }
        amps[k - 2] = 4 * Math.hypot(re, im) / Lw;
      }
      frames.push(amps); ends.push(st + Lw - 1);
    });
    return { frames: frames, ends: ends, Lw: Lw, kMin: 2, kMax: kMax, hop: hop, dt: dt, N: N };
  }

  /**
   * How persistently a rhythm of period P (hours) shows up across the spectrogram:
   * share = fraction of time slices where its band is at least half as strong as that slice's strongest rhythm;
   * change = band strength in the latest third of slices ÷ the earliest third.
   */
  function persistence(sp, P) {
    var kb = sp.Lw * sp.dt / P;
    if (!(kb >= sp.kMin && kb <= sp.kMax)) return null;
    var kr = Math.round(kb), hits = 0, band = [];
    sp.frames.forEach(function (f) {
      var top = 0, e = 0;
      for (var i = 0; i < f.length; i++) top = Math.max(top, f[i]);
      for (var k = Math.max(sp.kMin, kr - 1); k <= Math.min(sp.kMax, kr + 1); k++) e = Math.max(e, f[k - sp.kMin]);
      if (top && e >= 0.5 * top) hits++;
      band.push(e);
    });
    var third = Math.max(1, Math.floor(band.length / 3)), mean = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };
    return { share: hits / sp.frames.length, change: mean(band.slice(-third)) / Math.max(1e-12, mean(band.slice(0, third))) };
  }

  /* ---------------- projection ---------------- */

  /** Least-squares fit of y[n] ≈ a + b·n + Σ (c_j cos 2πf_j n + d_j sin 2πf_j n); f in cycles per sample. */
  function harmonicFit(y, freqs) {
    var N = y.length, m = 2 + 2 * freqs.length, i, j, n;
    var basis = function (n) {
      var r = [1, n / N];
      for (var q = 0; q < freqs.length; q++) { var g = 2 * Math.PI * freqs[q] * n; r.push(Math.cos(g), Math.sin(g)); }
      return r;
    };
    var A = [];
    for (i = 0; i < m; i++) { A.push(new Array(m + 1).fill(0)); }
    for (n = 0; n < N; n++) {
      var r = basis(n);
      for (i = 0; i < m; i++) { for (j = 0; j < m; j++) A[i][j] += r[i] * r[j]; A[i][m] += r[i] * y[n]; }
    }
    for (var c = 0; c < m; c++) {
      var p = c;
      for (i = c + 1; i < m; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
      var tmp = A[c]; A[c] = A[p]; A[p] = tmp;
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (i = 0; i < m; i++) {
        if (i === c) continue;
        var f = A[i][c] / A[c][c];
        for (j = c; j <= m; j++) A[i][j] -= f * A[c][j];
      }
    }
    var beta = A.map(function (row, i) { return row[m] / row[i]; });
    return function (n) { return basis(n).reduce(function (s, v, i) { return s + v * beta[i]; }, 0); };
  }

  /**
   * Forecast log price h = 0..H steps past the end of `prices`, using only `prices`:
   * find the rhythms (analyze), fit trend + those rhythms by least squares, extend forward,
   * anchored so h = 0 is the last actual close.
   */
  function forecastFrom(prices, dt, H) {
    var res = analyze(prices, dt, 3);
    if (!res.peaks.length) return null;
    var y = prices.map(Math.log), last = y.length - 1;
    var fit = harmonicFit(y, res.peaks.map(function (p) { return dt / p.period; }));
    if (!fit) return null;
    var base = fit(last), out = [];
    for (var h = 0; h <= H; h++) out.push(y[last] + fit(last + h) - base);
    return { path: out, fit: fit, base: base };
  }

  function quantile(arr, q) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var pos = (a.length - 1) * q, i = Math.floor(pos), f = pos - i;
    return a[i] + (a[Math.min(a.length - 1, i + 1)] - a[i]) * f;
  }

  /**
   * "If the pattern holds" projection with an honest track record.
   * Horizon H = the main cycle length, capped at a fifth of the window.
   * Walk-forward test: at up to 12 earlier points, re-run the whole method on the 60% of data
   * before that point only, project H steps, and compare with what actually happened.
   * The band is the 80th percentile of those past misses at each step ahead (or, with too few
   * tests, of typical past price moves over that many steps).
   */
  function project(prices, dt, mainPeriodH) {
    var N = prices.length;
    if (N < 48) return null;
    var H = Math.max(3, Math.round(Math.min(mainPeriodH / dt, N / 5)));
    var main = forecastFrom(prices, dt, H);
    if (!main) return null;
    var y = prices.map(Math.log), h, i;

    var Wfit = Math.max(40, Math.floor(0.6 * N)), span = N - H - Wfit;
    var nOrig = span >= 0 ? Math.min(12, span + 1) : 0;
    var errs = [], hits = 0, dirN = 0, sumModel = 0, sumNaive = 0, tests = 0;
    for (h = 0; h <= H; h++) errs.push([]);
    for (var j = 0; j < nOrig; j++) {
      var o = Wfit + (nOrig === 1 ? span : Math.round(j * span / (nOrig - 1)));
      var fc = forecastFrom(prices.slice(o - Wfit, o), dt, H);
      if (!fc) continue;
      tests++;
      var lastLog = y[o - 1];
      for (h = 1; h <= H; h++) {
        var actual = y[o - 1 + h], e = actual - fc.path[h];
        errs[h].push(Math.abs(e));
        sumModel += Math.abs(e);
        sumNaive += Math.abs(actual - lastLog);
      }
      // direction checked at ¼, ½, ¾ and the full horizon (a full cycle ahead alone would return to the start)
      [Math.round(H / 4), Math.round(H / 2), Math.round(3 * H / 4), H].forEach(function (hh) {
        if (hh < 1) return;
        var aMove = y[o - 1 + hh] - lastLog, fMove = fc.path[hh] - lastLog;
        if (Math.abs(aMove) > 0.001) { dirN++; if ((aMove > 0) === (fMove > 0)) hits++; }
      });
    }
    var tested = tests >= 6;
    var band = [0];
    for (h = 1; h <= H; h++) {
      if (tested) band.push(quantile(errs[h], 0.8));
      else {
        var moves = [];
        for (i = 0; i + h < N; i += Math.max(1, Math.floor(h / 2))) moves.push(Math.abs(y[i + h] - y[i]));
        band.push(quantile(moves, 0.8));
      }
    }
    var backStart = Math.max(0, N - Math.min(N, Math.max(3 * H, Math.round(2 * mainPeriodH / dt), 48)));
    var fitBack = [];
    for (i = backStart; i < N; i++) fitBack.push(main.fit(i));   // the fitted model itself (only the projection is pinned to the last close)
    return {
      H: H, dt: dt, backStart: backStart, center: main.path,
      lo: main.path.map(function (v, h) { return v - band[h]; }),
      hi: main.path.map(function (v, h) { return v + band[h]; }),
      fitBack: fitBack,
      tests: tests, tested: tested, hits: hits, dirN: dirN,
      skill: sumNaive > 0 ? 1 - sumModel / sumNaive : 0
    };
  }

  function detrendLog(xs) {
    var N = xs.length, sx = 0, sy = 0, sxx = 0, sxy = 0, i;
    var y = xs.map(Math.log);
    for (i = 0; i < N; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; }
    var b = (N * sxy - sx * sy) / (N * sxx - sx * sx), a = (sy - b * sx) / N;
    return y.map(function (v, i) { return v - (a + b * i); });
  }

  /** Phase (degrees) of a single DFT bin k of series d. */
  function binPhase(d, k) {
    var N = d.length, re = 0, im = 0;
    for (var n = 0; n < N; n++) { var g = 2 * Math.PI * k * n / N; re += d[n] * Math.cos(g); im -= d[n] * Math.sin(g); }
    return Math.atan2(im, re) * 180 / Math.PI;
  }

  function corr(a, b) {
    var n = Math.min(a.length, b.length), ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var sab = 0, saa = 0, sbb = 0;
    for (i = 0; i < n; i++) { var x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
  }

  /** Wrap an angle difference to (−180, 180]. */
  function wrapDeg(x) { x = ((x + 180) % 360 + 360) % 360 - 180; return x === -180 ? 180 : x; }

  window.SineFourier = { testSignal: testSignal, analyze: analyze, linePath: linePath, barPaths: barPaths, fmtPeriod: fmtPeriod,
    detrendLog: detrendLog, binPhase: binPhase, stft: stft, persistence: persistence, project: project, harmonicFit: harmonicFit, corr: corr, wrapDeg: wrapDeg };
})();
