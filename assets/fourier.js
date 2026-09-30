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

  /* ---------------- FFT (radix-2 + Bluestein for any length) ---------------- */
  function fftPow2(re, im) {
    var n = re.length, i, j, len, t;
    for (i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
      for (i = 0; i < n; i += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < h; k++) {
          var a = i + k, b = a + h, vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
          var nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }
  var chirpCache = {};
  /** DFT of a real series of any length N: X_k = Σ x_n e^{−2πikn/N}. Returns {re, im} (length N). */
  function dft(x) {
    var N = x.length, n, k;
    if ((N & (N - 1)) === 0) {
      var r0 = Float64Array.from(x), i0 = new Float64Array(N); fftPow2(r0, i0); return { re: r0, im: i0 };
    }
    var M = 1; while (M < 2 * N - 1) M <<= 1;
    var ch = chirpCache[N];
    if (!ch) {                                  // Bluestein chirp w_n = e^{−iπn²/N}, and FFT of its conjugate
      var wr = new Float64Array(N), wi = new Float64Array(N);
      for (n = 0; n < N; n++) { var ang = Math.PI * ((n * n) % (2 * N)) / N; wr[n] = Math.cos(ang); wi[n] = -Math.sin(ang); }
      var br = new Float64Array(M), bi = new Float64Array(M);
      br[0] = wr[0]; bi[0] = -wi[0];
      for (n = 1; n < N; n++) { br[n] = br[M - n] = wr[n]; bi[n] = bi[M - n] = -wi[n]; }
      fftPow2(br, bi);
      ch = chirpCache[N] = { wr: wr, wi: wi, br: br, bi: bi, M: M };
    }
    var ar = new Float64Array(M), ai = new Float64Array(M);
    for (n = 0; n < N; n++) { ar[n] = x[n] * ch.wr[n]; ai[n] = x[n] * ch.wi[n]; }
    fftPow2(ar, ai);
    for (k = 0; k < M; k++) {                   // multiply, then inverse FFT via conjugation
      var pr = ar[k] * ch.br[k] - ai[k] * ch.bi[k], pi = ar[k] * ch.bi[k] + ai[k] * ch.br[k];
      ar[k] = pr; ai[k] = -pi;
    }
    fftPow2(ar, ai);
    var re = new Float64Array(N), im = new Float64Array(N);
    for (k = 0; k < N; k++) {
      var cr = ar[k] / M, ci = -ai[k] / M;
      re[k] = cr * ch.wr[k] - ci * ch.wi[k]; im[k] = cr * ch.wi[k] + ci * ch.wr[k];
    }
    return { re: re, im: im };
  }

  /* ---------------- small least-squares helpers ---------------- */
  function solve(A, b) {                        // Gaussian elimination with partial pivoting
    var m = b.length, M = A.map(function (r, i) { return r.slice().concat([b[i]]); }), i, j, c;
    for (c = 0; c < m; c++) {
      var p = c; for (i = c + 1; i < m; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
      var t = M[c]; M[c] = M[p]; M[p] = t;
      if (Math.abs(M[c][c]) < 1e-300) return null;
      for (i = 0; i < m; i++) { if (i === c) continue; var f = M[i][c] / M[c][c]; for (j = c; j <= m; j++) M[i][j] -= f * M[c][j]; }
    }
    return M.map(function (r, i) { return r[m] / r[i]; });
  }
  /** OLS of y on the given columns. Returns {beta, ssr}. */
  function ols(cols, y) {
    var m = cols.length, N = y.length, XtX = [], Xty = [], i, j, n;
    for (i = 0; i < m; i++) { XtX.push(new Array(m).fill(0)); Xty.push(0); }
    for (n = 0; n < N; n++) for (i = 0; i < m; i++) { var ci = cols[i][n]; Xty[i] += ci * y[n]; for (j = i; j < m; j++) XtX[i][j] += ci * cols[j][n]; }
    for (i = 0; i < m; i++) for (j = 0; j < i; j++) XtX[i][j] = XtX[j][i];
    var beta = solve(XtX, Xty); if (!beta) return null;
    var ssr = 0; for (n = 0; n < N; n++) { var f = 0; for (i = 0; i < m; i++) f += beta[i] * cols[i][n]; ssr += (y[n] - f) * (y[n] - f); }
    return { beta: beta, ssr: ssr };
  }

  /**
   * Flexible Fourier trend (Enders & Lee 2011; fractional frequency): y_t = a + b·t + c·cos(2πk*t/N) + s·sin(2πk*t/N).
   * k* is searched over 0.1 … 1.5 (fewer than 1.5 cycles per window, so it can never absorb a repeating rhythm)
   * by minimum SSR. F compares it with a straight-line trend.
   */
  function fourierTrend(y) {
    var N = y.length, one = new Array(N).fill(1), t = y.map(function (_, i) { return i; });
    var lin = ols([one, t], y), best = null;
    for (var k10 = 1; k10 <= 15; k10++) {
      var kk = k10 / 10, c = new Array(N), s = new Array(N);
      for (var i = 0; i < N; i++) { var g = 2 * Math.PI * kk * i / N; c[i] = Math.cos(g); s[i] = Math.sin(g); }
      var f = ols([one, t, c, s], y);
      if (f && (!best || f.ssr < best.ssr)) best = { k: kk, beta: f.beta, ssr: f.ssr };
    }
    var at = function (n) { var g = 2 * Math.PI * best.k * n / N; return best.beta[0] + best.beta[1] * n + best.beta[2] * Math.cos(g) + best.beta[3] * Math.sin(g); };
    var F = ((lin.ssr - best.ssr) / 2) / (best.ssr / Math.max(1, N - 4));
    var breakAmp = Math.hypot(best.beta[2], best.beta[3]);
    return { k: best.k, a: best.beta[0], b: best.beta[1], at: at, F: F, breakAmp: breakAmp, ssrLin: lin.ssr, ssr: best.ssr };
  }

  /**
   * Fourier KSS nonlinear unit-root test (Kapetanios, Shin & Snell 2003; Christopoulos & León-Ledesma 2010):
   * Δe_t = φ·e³_{t−1} + Σ_{j=1..p} α_j·Δe_{t−j} + ε_t on the Fourier-trend residuals e. Returns the t-statistic of φ
   * (more negative = stronger evidence that price pulls back toward its trend instead of wandering like a random walk).
   */
  function kssT(e) {
    var N = e.length, p = Math.max(1, Math.floor(4 * Math.pow(N / 100, 0.25))), i, j;
    var sd = Math.sqrt(e.reduce(function (s, v) { return s + v * v; }, 0) / N) || 1;
    var z = e.map(function (v) { return v / sd; }), dz = [0];
    for (i = 1; i < N; i++) dz.push(z[i] - z[i - 1]);
    var cols = [[]], y = [];
    for (j = 0; j < p; j++) cols.push([]);
    for (i = p + 1; i < N; i++) {
      y.push(dz[i]); cols[0].push(Math.pow(z[i - 1], 3));
      for (j = 1; j <= p; j++) cols[j].push(dz[i - j]);
    }
    var m = cols.length, n = y.length, XtX = [], Xty = [];
    for (i = 0; i < m; i++) { XtX.push(new Array(m).fill(0)); Xty.push(0); }
    for (var r = 0; r < n; r++) for (i = 0; i < m; i++) { Xty[i] += cols[i][r] * y[r]; for (j = 0; j < m; j++) XtX[i][j] += cols[i][r] * cols[j][r]; }
    var beta = solve(XtX, Xty); if (!beta) return 0;
    var ssr = 0; for (r = 0; r < n; r++) { var f = 0; for (i = 0; i < m; i++) f += beta[i] * cols[i][r]; ssr += (y[r] - f) * (y[r] - f); }
    var e0 = new Array(m).fill(0); e0[0] = 1; var inv0 = solve(XtX, e0); if (!inv0) return 0;
    var se = Math.sqrt((ssr / Math.max(1, n - m)) * inv0[0]);
    return se > 0 ? beta[0] / se : 0;
  }

  /* ---------------- random-walk null (Monte Carlo, cached per length) ---------------- */
  var nullCache = {};
  function nullDist(N) {
    if (nullCache[N]) return nullCache[N];
    if (typeof window !== 'undefined' && window.SINE_NULL && window.SINE_NULL[N]) return (nullCache[N] = window.SINE_NULL[N]);   // precomputed
    var M = 200, s = 2024 + N, top = [], expl = [], kss = [], F = [], prom = [];
    function rnd() { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }
    for (var m = 0; m < M; m++) {
      var lp = 0, xs = new Array(N);
      for (var i = 0; i < N; i++) { lp += 0.01 * (rnd() + rnd() + rnd() + rnd() - 2) * 1.73; xs[i] = Math.exp(lp); }
      var r = analyze(xs, 1, 3, { skipNull: true });
      top.push(r.peaks[0] ? r.peaks[0].share : 0); expl.push(r.explained); kss.push(r.kssT); F.push(r.trend.F); prom.push(r.maxProm);
    }
    var srt = function (a) { return a.slice().sort(function (x, y) { return x - y; }); };
    return (nullCache[N] = { M: M, top: srt(top), expl: srt(expl), kss: srt(kss), F: srt(F), prom: srt(prom) });
  }
  function upperP(sorted, v) { var c = 0; for (var i = 0; i < sorted.length; i++) if (sorted[i] >= v) c++; return (c + 1) / (sorted.length + 1); }
  function lowerP(sorted, v) { var c = 0; for (var i = 0; i < sorted.length; i++) if (sorted[i] <= v) c++; return (c + 1) / (sorted.length + 1); }

  /**
   * Fourier analysis of a price series (any length ≥ 16).
   *   log price → flexible Fourier trend (line + slow wave, removes smooth regime shifts)
   *   → Hann window → FFT → peaks (≥ 2 cycles, ≥ 4 samples/cycle) refined by parabolic interpolation
   *   → share of variance (Parseval), Fourier KSS mean-reversion test,
   *   → significance of both against 200 simulated random walks of the same length (weak-form efficiency null).
   */
  function analyze(xs, dt, nPeaks, opts) {
    nPeaks = nPeaks || 3; opts = opts || {};
    var N = xs.length, i, k;
    var y = xs.map(Math.log);
    var tr = fourierTrend(y);
    var d = y.map(function (v, i) { return v - tr.at(i); });
    var variance = 0;
    for (i = 0; i < N; i++) variance += d[i] * d[i];
    variance /= N;
    var w = d.map(function (v, i) { return v * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1))); });
    var W = dft(w), R = dft(d);
    var half = Math.floor(N / 2), bins = [];
    for (k = 0; k <= half; k++) {
      bins.push({ k: k, amp: 4 * Math.hypot(W.re[k], W.im[k]) / N, re2: R.re[k], im2: R.im[k], pw: 2 * (R.re[k] * R.re[k] + R.im[k] * R.im[k]) / (N * N) });
    }
    var cand = [], kMax = Math.min(half - 1, Math.floor(N / 4));
    for (k = 2; k <= kMax; k++) if (bins[k].amp > bins[k - 1].amp && bins[k].amp >= bins[k + 1].amp) cand.push(k);
    // prominence: a real rhythm is a sharp spike above its neighbouring frequencies, not a broad slope
    var P2 = bins.map(function (b) { return b.amp * b.amp; });
    var prom = function (k) {
      var nb = [];
      for (var j = Math.max(1, k - 8); j <= Math.min(half, k + 8); j++) if (Math.abs(j - k) > 1) nb.push(P2[j]);
      nb.sort(function (a, b) { return a - b; });
      return P2[k] / Math.max(nb[Math.floor(nb.length / 2)] || 0, 1e-30);
    };
    var promOf = {}, maxProm = 0;
    cand.forEach(function (k) { promOf[k] = prom(k); if (promOf[k] > maxProm) maxProm = promOf[k]; });
    var nd = (!opts.skipNull && N >= 32) ? nullDist(N) : null;
    var pOf = {};
    cand.forEach(function (k) { pOf[k] = nd ? upperP(nd.prom, promOf[k]) : null; });
    // ranking: significant rhythms (vs. random walks, look-elsewhere corrected) that repeat ≥ 3 times first,
    // then significant 2-cycle swings (hard to tell from a slow regime shift), then the rest — each by amplitude
    var tier = function (k) { var sig = nd && pOf[k] <= 0.05; return sig ? (k >= 3 ? 0 : 1) : 2; };
    cand.sort(function (p, q) { return tier(p) - tier(q) || bins[q].amp - bins[p].amp; });

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
        share: variance ? (bins[k - 1].pw + bins[k].pw + bins[k + 1].pw) / variance : 0,
        prom: promOf[k], p: pOf[k]
      };
    });

    var comps = peaks.map(function (p) {
      var B = bins[p.k];
      return d.map(function (_, n) { var g = 2 * Math.PI * p.k * n / N; return (2 / N) * (B.re2 * Math.cos(g) - B.im2 * Math.sin(g)); });
    });
    var recon = d.map(function (_, n) { return comps.reduce(function (s, c) { return s + c[n]; }, 0); });
    var explained = Math.min(0.999, peaks.reduce(function (s, p) { return s + p.share; }, 0));
    var kt = kssT(d);

    var res = {
      N: N, dt: dt, T: T, d: d, trendA: tr.a, trendB: tr.b, trendAt: tr.at, trend: tr,
      bins: bins, peaks: peaks, comps: comps, recon: recon,
      explained: explained, snr: explained / (1 - explained), df: 1 / T, nyq: 1 / (2 * dt), kssT: kt, maxProm: maxProm
    };
    if (nd) {
      res.sig = {
        pTop: peaks[0] ? peaks[0].p : 1,                           // chance a random walk shows ANY rhythm this prominent
        pExplained: upperP(nd.expl, explained),
        pKss: lowerP(nd.kss, kt),                                   // chance a random walk looks this mean-reverting
        pBreak: upperP(nd.F, tr.F),                                 // chance a random walk shows a slow shift this strong
        sims: nd.M
      };
    }
    return res;
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
    var res = analyze(prices, dt, 3, { skipNull: true });
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

  /**
   * Stress check — rolling Fourier spectrum of RETURNS, after Jun, Ahn, Kim & Kim (2019, Physica A 526:121015),
   * who found that low-frequency components of stock-index returns surge ahead of global financial crises.
   * For each sliding window of L log-returns (step 1): FFT → share of return energy in the slowest L/8 modes.
   * Pure random churn spreads energy evenly (share ≈ 25%); a surge means persistent, one-directional pressure.
   *   p       : permutation test — how often THIS token's own returns, randomly re-ordered, give a share this high
   *             (keeps fat tails and volatility level, removes only timing structure)
   *   histPct : where the current share sits within its own history over the window (a "surge" vs. its norm)
   */
  function stressIndex(xs) {
    var r = [], i, t, k;
    for (i = 1; i < xs.length; i++) if (xs[i] > 0 && xs[i - 1] > 0) r.push(Math.log(xs[i] / xs[i - 1]));
    var L = r.length >= 160 ? 32 : 16;
    if (r.length < L + 16) return null;
    var lowK = L / 8, half = L / 2;
    function share(seg) {
      var mean = seg.reduce(function (a, b) { return a + b; }, 0) / L;
      var re = Float64Array.from(seg, function (v) { return v - mean; }), im = new Float64Array(L);
      fftPow2(re, im);
      var lo = 0, tot = 0;
      for (k = 1; k <= half; k++) { var e = (re[k] * re[k] + im[k] * im[k]) * (k === half ? 0.5 : 1); tot += e; if (k <= lowK) lo += e; }
      return tot > 0 ? lo / tot : 0;
    }
    var series = [];
    for (t = L; t <= r.length; t++) series.push(share(r.slice(t - L, t)));
    var now = series[series.length - 1];
    var sorted = series.slice().sort(function (a, b) { return a - b; });
    var below = 0; for (i = 0; i < sorted.length; i++) if (sorted[i] < now) below++;
    var histPct = below / sorted.length;
    // permutation null from the token's own returns (seeded, so repeated refreshes are stable)
    var seed = 7 + r.length, M = 400, ge = 0, nullv = [];
    function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
    for (i = 0; i < M; i++) {
      var seg = new Array(L);
      for (t = 0; t < L; t++) seg[t] = r[Math.floor(rnd() * r.length)];
      var sh = share(seg); nullv.push(sh); if (sh >= now) ge++;
    }
    nullv.sort(function (a, b) { return a - b; });
    var p = (ge + 1) / (M + 1);
    var q95 = nullv[Math.floor(0.95 * M)];
    var level = (p <= 0.05 && histPct >= 0.8) ? 2 : (p <= 0.10 || histPct >= 0.9) ? 1 : 0;
    var lastMove = 0; for (t = r.length - L; t < r.length; t++) lastMove += r[t];
    return { series: series, now: now, p: p, histPct: histPct, q95: q95, expected: lowK / half, L: L, lowK: lowK, level: level, lastMove: Math.exp(lastMove) - 1 };
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

  window.SineFourier = { testSignal: testSignal, analyze: analyze, dft: dft, nullDist: nullDist, stressIndex: stressIndex, linePath: linePath, barPaths: barPaths, fmtPeriod: fmtPeriod,
    detrendLog: detrendLog, binPhase: binPhase, stft: stft, persistence: persistence, project: project, harmonicFit: harmonicFit, corr: corr, wrapDeg: wrapDeg };
})();
