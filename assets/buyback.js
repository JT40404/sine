/*
 * SINE buyback timing — decides WHEN a creator's fees should buy back (and burn) their token,
 * using the same Fourier analysis as the analyzer. Pure logic: no wallet, no network.
 *
 *   BUY    real rhythm (Weak+ and p ≤ maxP vs. random walks) AND price in the trough of its cycle, turning up
 *          AND no high downward stress (don't catch a falling knife)
 *   DCA    no qualifying trough within maxWaitHours → buy anyway, so fees never sit idle
 *   WAIT   otherwise (with the reason)
 */
(function (root) {
  "use strict";

  var DEFAULTS = { maxP: 0.3, minLevel: 1, phaseFrom: 0.85, phaseTo: 0.25, maxWaitHours: 24, tranchePct: 50 };

  /** Rhythm strength 0–4, same rules as the analyzer (explained share, repetitions, random-walk p). */
  function strength(res) {
    if (!res || !res.peaks || !res.peaks.length) return 0;
    var e = res.explained, lvl = e >= 0.75 ? 4 : e >= 0.55 ? 3 : e >= 0.35 ? 2 : e >= 0.15 ? 1 : 0;
    var seen = res.T / res.peaks[0].period;
    if (seen < 2) lvl = Math.min(lvl, 1); else if (seen < 3) lvl = Math.min(lvl, 2);
    var p = res.sig ? res.sig.pTop : null;
    if (p !== null) { if (p > 0.3) lvl = 0; else if (p > 0.15) lvl = Math.min(lvl, 1); else if (p > 0.05) lvl = Math.min(lvl, 2); }
    return lvl;
  }

  /** Cycle position of the main rhythm at the last sample: frac 0 = trough, 0.5 = crest; rising when frac < 0.5. */
  function phaseOf(res) {
    var p0 = res.peaks[0];
    var psi = 2 * Math.PI * p0.k * (res.N - 1) / res.N + p0.theta;
    psi = Math.atan2(Math.sin(psi), Math.cos(psi));
    return { frac: (psi + Math.PI) / (2 * Math.PI), rising: psi < 0 };
  }

  function inWindow(x, from, to) { return from <= to ? x >= from && x <= to : x >= from || x <= to; }

  /**
   * @param res     analysis from SineFourier.analyze (or null when there is not enough history)
   * @param stress  stress reading from SineFourier.stressIndex (or null)
   * @param state   { lastBuyAt: ms timestamp or null, now: ms }
   * @param opts    overrides of DEFAULTS
   * @returns { action: 'buy'|'dca'|'wait', reasons: [..], level, phase, hoursSinceLast, waitLeftHours }
   */
  function decide(res, stress, state, opts) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in (opts || {})) if (opts[k] !== undefined && opts[k] !== null && opts[k] !== "") o[k] = Number(opts[k]);
    var now = (state && state.now) || Date.now();
    var last = state && state.lastBuyAt;
    var hours = last ? (now - last) / 3600000 : Infinity;
    var waitLeft = Math.max(0, o.maxWaitHours - hours);
    var out = { action: "wait", reasons: [], level: 0, phase: null, hoursSinceLast: hours, waitLeftHours: waitLeft, opts: o };

    if (!res || !res.peaks || !res.peaks.length) {
      out.reasons.push("not enough price history yet for Fourier timing");
    } else {
      out.level = strength(res);
      out.phase = phaseOf(res);
      var p = res.sig ? res.sig.pTop : null;
      if (out.level < o.minLevel) out.reasons.push("no clear rhythm right now");
      if (p !== null && p > o.maxP) out.reasons.push("rhythm could be chance (p " + p.toFixed(2) + ")");
      if (!inWindow(out.phase.frac, o.phaseFrom, o.phaseTo)) out.reasons.push("not in the trough of the cycle");
      else if (!out.phase.rising) out.reasons.push("still falling into the trough");
      if (stress && stress.level === 2 && stress.lastMove < 0) out.reasons.push("high downward pressure — waiting for it to ease");
      if (!out.reasons.length) { out.action = "buy"; out.reasons.push("price is in the trough of a real rhythm and turning up"); return out; }
    }
    if (hours >= o.maxWaitHours) {
      out.action = "dca";
      out.reasons.unshift(last ? "no good trough in " + Math.floor(hours) + " h — fallback buyback so fees don't sit idle" : "first buyback — no history of waiting yet");
    }
    return out;
  }

  /** Lamports to spend this round: tranchePct of the available budget, never more than the budget. */
  function trancheLamports(budgetLamports, tranchePct) {
    var pct = Math.min(100, Math.max(1, Number(tranchePct) || DEFAULTS.tranchePct));
    return Math.floor(budgetLamports * pct / 100);
  }

  root.SineBuyback = { decide: decide, strength: strength, phaseOf: phaseOf, trancheLamports: trancheLamports, DEFAULTS: DEFAULTS };
})(typeof window !== "undefined" ? window : globalThis);
