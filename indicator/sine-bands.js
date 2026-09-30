/*
 * SINE Cycle Bands: reference implementation (plain JS, no dependencies).
 *
 * The same math as indicator/sine-cycle-bands.pine, so the two give the same numbers.
 * On every bar, using only the last `length` closes up to and including that bar:
 *   log price → least-squares line (trend) → Hann window → DFT amplitudes
 *   → the strongest `rhythms` spectral peaks (≥ 2 cycles and ≥ 4 bars per cycle in the window),
 *     refined by parabolic interpolation
 *   → least-squares fit of trend-removed log price to those sine waves
 *   → midline  = trend + fitted rhythms at this bar
 *     bands    = midline × exp(± mult × σ), σ = RMS of what the fit leaves unexplained
 *     strength = share of trend-removed movement the rhythms explain
 * Nothing uses future bars, so past values never repaint.
 *
 * Browser: <script src="sine-bands.js"></script> → window.SineBands
 * Node/ESM: import "./sine-bands.js"; then globalThis.SineBands
 */
(function (root) {
  "use strict";

  var DEFAULTS = { length: 128, rhythms: 3, mult: 2 };

  /** Value of the fitted rhythms (trend-removed log price) at sample n of the window. */
  function fitAt(beta, freqs, n, N) {
    var v = beta[0] + beta[1] * n / N;
    for (var q = 0; q < freqs.length; q++) {
      var g = 2 * Math.PI * freqs[q] * n;
      v += beta[2 + 2 * q] * Math.cos(g) + beta[3 + 2 * q] * Math.sin(g);
    }
    return v;
  }

  /** Solve the least-squares fit d[n] ≈ β0 + β1·n/N + Σ (c cos 2πfn + s sin 2πfn). Returns β or null. */
  function solveFit(d, freqs) {
    var N = d.length, m = 2 + 2 * freqs.length, W = m + 1, A = new Float64Array(m * W), r = new Float64Array(m), n, i, j;
    for (n = 0; n < N; n++) {
      r[0] = 1; r[1] = n / N;
      for (var q = 0; q < freqs.length; q++) { var g = 2 * Math.PI * freqs[q] * n; r[2 + 2 * q] = Math.cos(g); r[3 + 2 * q] = Math.sin(g); }
      for (i = 0; i < m; i++) { for (j = 0; j < m; j++) A[i * W + j] += r[i] * r[j]; A[i * W + m] += r[i] * d[n]; }
    }
    for (var c = 0; c < m; c++) {                      // Gauss–Jordan with partial pivoting
      var p = c;
      for (i = c + 1; i < m; i++) if (Math.abs(A[i * W + c]) > Math.abs(A[p * W + c])) p = i;
      if (p !== c) for (j = 0; j < W; j++) { var t = A[c * W + j]; A[c * W + j] = A[p * W + j]; A[p * W + j] = t; }
      if (Math.abs(A[c * W + c]) < 1e-12) return null;
      for (i = 0; i < m; i++) {
        if (i === c) continue;
        var f = A[i * W + c] / A[c * W + c];
        if (f) for (j = c; j < W; j++) A[i * W + j] -= f * A[c * W + j];
      }
    }
    var beta = [];
    for (i = 0; i < m; i++) beta.push(A[i * W + m] / A[i * W + i]);
    return beta;
  }

  /**
   * Analyze one window of prices (oldest first; the last element is "this bar").
   * Returns null if the window is too short or contains a non-positive price.
   */
  function analyzeWindow(prices, opts) {
    opts = opts || {};
    var rhythms = opts.rhythms || DEFAULTS.rhythms, mult = opts.mult == null ? DEFAULTS.mult : opts.mult;
    var N = prices.length, n, k;
    if (N < 32) return null;
    var y = new Float64Array(N), sy = 0, sxy = 0;
    for (n = 0; n < N; n++) {
      if (!(prices[n] > 0)) return null;
      y[n] = Math.log(prices[n]); sy += y[n]; sxy += n * y[n];
    }
    var sx = N * (N - 1) / 2, sxx = (N - 1) * N * (2 * N - 1) / 6;
    var b = (N * sxy - sx * sy) / (N * sxx - sx * sx), a = (sy - b * sx) / N;

    var d = new Float64Array(N), w = new Float64Array(N), varSum = 0;
    for (n = 0; n < N; n++) {
      d[n] = y[n] - (a + b * n);
      w[n] = d[n] * (0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)));
      varSum += d[n] * d[n];
    }

    // Hann-windowed DFT amplitudes for k = 1 .. kMax + 1 (phasor recurrence instead of cos/sin per sample)
    var kMax = Math.floor(N / 4), amp = new Float64Array(kMax + 2);
    for (k = 1; k <= kMax + 1; k++) {
      var cd = Math.cos(2 * Math.PI * k / N), sd = Math.sin(2 * Math.PI * k / N), c = 1, s = 0, re = 0, im = 0;
      for (n = 0; n < N; n++) {
        re += w[n] * c; im -= w[n] * s;
        var cn = c * cd - s * sd; s = s * cd + c * sd; c = cn;
      }
      amp[k] = 4 * Math.sqrt(re * re + im * im) / N;
    }

    // strongest local maxima with k = 2 .. kMax (≥ 2 cycles, ≥ 4 bars per cycle)
    var chosen = [];
    for (var q = 0; q < rhythms; q++) {
      var best = -1, bestA = 0;
      for (k = 2; k <= kMax; k++) {
        if (amp[k] > amp[k - 1] && amp[k] >= amp[k + 1] && amp[k] > bestA && chosen.indexOf(k) < 0) { best = k; bestA = amp[k]; }
      }
      if (best > 0) chosen.push(best);
    }
    var freqs = chosen.map(function (k) {
      var la = Math.log(Math.max(amp[k - 1], 1e-300)), lb = Math.log(Math.max(amp[k], 1e-300)), lc = Math.log(Math.max(amp[k + 1], 1e-300));
      var den = la - 2 * lb + lc, delta = den !== 0 ? 0.5 * (la - lc) / den : 0;
      delta = Math.max(-0.5, Math.min(0.5, delta));
      return (k + delta) / N;                           // cycles per bar
    });

    var beta = freqs.length ? solveFit(d, freqs) : null;
    if (!beta) { freqs = []; beta = [0, 0]; }
    var rss = 0;
    for (n = 0; n < N; n++) { var e = d[n] - fitAt(beta, freqs, n, N); rss += e * e; }
    var sigma = Math.sqrt(rss / N);
    var fEnd = fitAt(beta, freqs, N - 1, N), fPrev = fitAt(beta, freqs, N - 2, N);
    var midLog = a + b * (N - 1) + fEnd;
    var periodBars = freqs.length ? 1 / freqs[0] : NaN;

    return {
      mid: Math.exp(midLog),
      upper: Math.exp(midLog + mult * sigma),
      lower: Math.exp(midLog - mult * sigma),
      sigma: sigma,
      cycleSlope: fEnd - fPrev,                         // > 0: the rhythm is rising at this bar
      strength: varSum > 0 ? Math.max(0, 1 - rss / varSum) : 0,
      periodBars: periodBars,
      cyclesInWindow: freqs.length ? N * freqs[0] : 0,
      trendPerBar: b,                                   // log-price slope per bar
      periods: freqs.map(function (f) { return 1 / f; }),
      // for projection
      _a: a, _b: b, _beta: beta, _freqs: freqs, _N: N, _midLog: midLog, _lastLog: y[N - 1]
    };
  }

  /**
   * Run the indicator over a whole series. Returns arrays aligned with `closes`
   * (null until `length` bars exist).
   */
  function compute(closes, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var L = opts.length, out = { mid: [], upper: [], lower: [], cycleSlope: [], strength: [], periodBars: [], crest: [], trough: [] };
    var prevSlope = null;
    for (var i = 0; i < closes.length; i++) {
      var r = i >= L - 1 ? analyzeWindow(closes.slice(i - L + 1, i + 1), opts) : null;
      out.mid.push(r ? r.mid : null);
      out.upper.push(r ? r.upper : null);
      out.lower.push(r ? r.lower : null);
      out.cycleSlope.push(r ? r.cycleSlope : null);
      out.strength.push(r ? r.strength : null);
      out.periodBars.push(r ? r.periodBars : null);
      var s = r ? r.cycleSlope : null;
      out.crest.push(prevSlope != null && s != null && prevSlope > 0 && s <= 0);
      out.trough.push(prevSlope != null && s != null && prevSlope < 0 && s >= 0);
      prevSlope = s;
    }
    return out;
  }

  /**
   * "If the pattern holds": extend the fitted trend + rhythms `bars` bars past the last bar,
   * pinned to the last close. bars = 0 → one main cycle, capped at a fifth of the window.
   * Returns [{ h, mid, upper, lower }] for h = 0..bars.
   */
  function project(r, bars, mult) {
    if (!r || !r._freqs.length) return [];
    mult = mult == null ? DEFAULTS.mult : mult;
    var H = bars > 0 ? bars : Math.max(3, Math.round(Math.min(r.periodBars, r._N / 5)));
    var pin = r._lastLog - r._midLog, out = [];
    for (var h = 0; h <= H; h++) {
      var n = r._N - 1 + h, v = r._a + r._b * n + fitAt(r._beta, r._freqs, n, r._N) + pin;
      out.push({ h: h, mid: Math.exp(v), upper: Math.exp(v + mult * r.sigma), lower: Math.exp(v - mult * r.sigma) });
    }
    return out;
  }

  /** Bars until the rhythm's next turn (crest if rising now, trough if falling), searching up to one main cycle. */
  function nextTurn(r) {
    if (!r || !r._freqs.length) return null;
    var rising = r.cycleSlope > 0, lim = Math.ceil(r.periodBars);
    var prev = fitAt(r._beta, r._freqs, r._N - 1, r._N);
    for (var h = 1; h <= lim; h++) {
      var cur = fitAt(r._beta, r._freqs, r._N - 1 + h, r._N);
      if (rising ? cur < prev : cur > prev) return { bars: h - 1, kind: rising ? "crest" : "trough" };
      prev = cur;
    }
    return null;
  }

  var LEVELS = [[0.75, "Very strong"], [0.55, "Strong"], [0.35, "Moderate"], [0.15, "Weak"], [0, "No clear rhythm"]];
  /** Plain-English grade, capped at Moderate below 3 cycles in the window (same thresholds as the SINE site). */
  function grade(r) {
    if (!r) return "No clear rhythm";
    var s = r.strength;
    if (r.cyclesInWindow < 3) s = Math.min(s, 0.549);
    for (var i = 0; i < LEVELS.length; i++) if (s >= LEVELS[i][0]) return LEVELS[i][1];
    return LEVELS[LEVELS.length - 1][1];
  }

  var api = { DEFAULTS: DEFAULTS, analyzeWindow: analyzeWindow, compute: compute, project: project, nextTurn: nextTurn, grade: grade };
  root.SineBands = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
