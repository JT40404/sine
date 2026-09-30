/*
 * SINE Stress: reference implementation (plain JS, no dependencies).
 *
 * A per-bar version of the SINE site's Stress check (stressIndex() in assets/fourier.js), after
 * Jun, Ahn, Kim & Kim (2019), "Signal analysis of global financial crises using Fourier series", Physica A 526:121015.
 * They found the low-frequency Fourier components of index returns surge ahead of financial crises.
 *
 * On every bar, using only the last `length` log returns up to and including that bar:
 *   remove the mean → DFT → share = energy in the slowest length/8 modes ÷ energy in modes 1 .. length/2 − 1
 *   Pure random churn (independent returns) puts length/8 ÷ (length/2 − 1) there, ≈ 27% for length 32.
 *   A surge means returns are persistent: pressure building in one direction.
 *
 *   p       : chance of a share this high if returns were independent. For independent normal returns the
 *             DFT energies are independent exponentials, so share ~ Beta(a, b) with a = length/8,
 *             b = length/2 − 1 − a, and p = P(Binomial(a + b − 1, share) ≤ a − 1), exactly and per bar.
 *             (The site runs a 400-shuffle permutation test once per refresh instead. That is too slow to repeat
 *             on every bar of a chart. The Nyquist mode is left out here so the Beta result is exact.)
 *   histPct : share of the last `history` bars whose value was lower than now ("a surge vs. its own norm")
 *   level   : 2 High (p ≤ 0.05 and histPct ≥ 0.8), 1 Elevated (p ≤ 0.10 or histPct ≥ 0.9), 0 Calm; same rules as the site
 *   move    : price change over the window (the direction of the pressure)
 *
 * Browser: <script src="sine-stress.js"></script> → window.SineStress
 * Node/ESM: import "./sine-stress.js"; then globalThis.SineStress
 */
(function (root) {
  "use strict";

  var DEFAULTS = { length: 32, history: 500 };

  function binomCoef(n, k) { var c = 1; for (var i = 1; i <= k; i++) c = c * (n - k + i) / i; return c; }

  /** P(share ≥ x) for independent normal returns: upper tail of Beta(a, b) via the binomial identity. */
  function pValue(x, L) {
    var a = L / 8, b = L / 2 - 1 - a, n = a + b - 1, p = 0;
    if (x <= 0) return 1;
    if (x >= 1) return 0;
    for (var j = 0; j <= a - 1; j++) p += binomCoef(n, j) * Math.pow(x, j) * Math.pow(1 - x, n - j);
    return Math.min(1, Math.max(0, p));
  }

  /** Share level that independent returns exceed only `alpha` of the time. */
  function threshold(L, alpha) {
    var lo = 0, hi = 1;
    for (var i = 0; i < 60; i++) { var mid = (lo + hi) / 2; if (pValue(mid, L) > alpha) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }

  /** Low-frequency share of one window of L log returns (oldest first). */
  function shareOf(r) {
    var L = r.length, lowK = L / 8, half = L / 2, m = 0, n, k;
    for (n = 0; n < L; n++) m += r[n];
    m /= L;
    var ss = 0, alt = 0;
    for (n = 0; n < L; n++) { var v = r[n] - m; ss += v * v; alt += (n % 2 ? -v : v); }
    var total = (L * ss - alt * alt) / 2;             // Parseval: Σ_{k=1}^{half-1} |X_k|²
    if (!(total > 0)) return 0;
    var low = 0;
    for (k = 1; k <= lowK; k++) {
      var re = 0, im = 0;
      for (n = 0; n < L; n++) { var g = 2 * Math.PI * k * n / L, u = r[n] - m; re += u * Math.cos(g); im -= u * Math.sin(g); }
      low += re * re + im * im;
    }
    return Math.min(1, low / total);
  }

  /**
   * Run over a whole close series. Arrays are aligned with `closes` (null until length + 1 closes exist).
   * opts.length must be a multiple of 8 (16, 32, 64 …).
   */
  function compute(closes, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var L = opts.length, Hn = opts.history;
    if (L % 8 || L < 16) throw new Error("length must be a multiple of 8, at least 16");
    var out = { share: [], p: [], histPct: [], level: [], move: [], expected: (L / 8) / (L / 2 - 1), q95: threshold(L, 0.05), q90: threshold(L, 0.10) };
    for (var i = 0; i < closes.length; i++) {
      var s = null, p = null, hp = null, lvl = null, mv = null;
      if (i >= L) {
        var r = [], ok = true;
        for (var t = i - L + 1; t <= i; t++) {
          if (!(closes[t] > 0 && closes[t - 1] > 0)) { ok = false; break; }
          r.push(Math.log(closes[t] / closes[t - 1]));
        }
        if (ok) {
          s = shareOf(r); p = pValue(s, L);
          var below = 0, cnt = 0;
          for (var j = Math.max(0, i - Hn + 1); j <= i; j++) {
            var v = j === i ? s : out.share[j];
            if (v == null) continue;
            cnt++; if (v < s) below++;
          }
          hp = below / cnt;
          lvl = (p <= 0.05 && hp >= 0.8) ? 2 : (p <= 0.10 || hp >= 0.9) ? 1 : 0;
          mv = closes[i] / closes[i - L] - 1;
        }
      }
      out.share.push(s); out.p.push(p); out.histPct.push(hp); out.level.push(lvl); out.move.push(mv);
    }
    return out;
  }

  var LABELS = ["Calm", "Elevated", "High"];
  var api = { DEFAULTS: DEFAULTS, LABELS: LABELS, compute: compute, shareOf: shareOf, pValue: pValue, threshold: threshold };
  root.SineStress = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
