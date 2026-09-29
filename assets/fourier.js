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
    detrendLog: detrendLog, binPhase: binPhase, corr: corr, wrapDeg: wrapDeg };
})();
