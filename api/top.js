import { TOP } from './_lib/basket.js';
import { cg, send, fail, HttpError, cgSourceName } from './_lib/gecko.js';

const sig = (v) => (v === 0 ? 0 : +v.toPrecision(8));

function cappedWeights(caps, limit) {
  const n = caps.length;
  let w = caps.map((c) => c / caps.reduce((a, b) => a + b, 0));
  if (limit * n < 1) return w.map(() => 1 / n);
  for (let iter = 0; iter < 50; iter++) {
    const over = w.map((x) => x > limit + 1e-12);
    if (!over.some(Boolean)) break;
    const excess = w.reduce((s, x, i) => s + (over[i] ? x - limit : 0), 0);
    const freeSum = w.reduce((s, x, i) => s + (over[i] || x >= limit ? 0 : x), 0);
    w = w.map((x, i) => (over[i] ? limit : x >= limit ? x : x + (freeSum ? excess * x / freeSum : 0)));
  }
  return w;
}

function logReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) if (prices[i] > 0 && prices[i - 1] > 0) out.push(Math.log(prices[i] / prices[i - 1]));
  return out;
}
function corr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 24) return 0;
  a = a.slice(-n); b = b.slice(-n);
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

function exclusionReason(c, spark, solReturns) {
  if (TOP.alwaysInclude.includes(c.id)) return '';
  if (TOP.alwaysExclude.includes(c.id)) return 'excluded by config';
  const sym = String(c.symbol || '').toUpperCase(), name = String(c.name || '');
  const valid = spark.filter((x) => x > 0);
  if (/USD|EUR|GBP/.test(sym) || /\bUSD\b|stablecoin/i.test(name)) return 'stablecoin';
  if (valid.length && Math.abs(c.current_price - 1) < 0.03 && Math.max(...valid) / Math.min(...valid) < 1.03) return 'stablecoin';
  if (/BTC|ETH/.test(sym) && c.id !== 'solana') return 'wrapped BTC/ETH';
  if (/XAU|PAXG|GOLD/.test(sym)) return 'tokenized gold';
  if (c.id !== 'solana' && solReturns && corr(logReturns(spark), solReturns) > TOP.solTrackingCorr) return 'tracks SOL (liquid staking)';
  if (!(c.market_cap > 0) || !(c.current_price > 0)) return 'no market cap';
  if (valid.length < 120) return 'not enough history';
  return '';
}

/**
 * GET /api/top?weight=cap|equal
 * Top Solana tokens by market cap and a market index built from their 7-day hourly prices.
 * One upstream call per refresh.
 *   cap:   I_t = 100 · Σ w_i · p_i,t / p_i,0     (weights ∝ market cap, each capped at TOP.capLimit)
 *   equal: I_t = 100 · exp( mean_i log(p_i,t / p_i,0) )
 */
export default async function handler(req, res) {
  try {
    const weighting = req.query.weight === 'equal' ? 'equal' : 'cap';
    const markets = await cg(
      `/coins/markets?vs_currency=usd&category=${TOP.category}&order=market_cap_desc&per_page=${TOP.candidates}&page=1&sparkline=true&price_change_percentage=24h,7d`,
      110_000,
    );
    if (!Array.isArray(markets) || !markets.length) throw new HttpError(502, 'CoinGecko returned no ranking data.');

    const sol = markets.find((c) => c.id === 'solana');
    const solReturns = sol ? logReturns(sol.sparkline_in_7d?.price || []) : null;

    const picked = [], skipped = [];
    for (const c of markets) {
      if (picked.length >= TOP.size) break;
      const spark = c.sparkline_in_7d?.price || [];
      const reason = exclusionReason(c, spark, solReturns);
      const sym = String(c.symbol || '').toUpperCase();
      if (reason) { skipped.push({ symbol: sym, reason }); continue; }
      picked.push({
        id: c.id, symbol: sym, name: c.name, rank: c.market_cap_rank,
        marketCap: c.market_cap, price: c.current_price,
        change24h: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h ?? null,
        change7d: c.price_change_percentage_7d_in_currency ?? null,
        spark,
      });
    }
    if (picked.length < 5) throw new HttpError(503, 'Not enough eligible tokens in CoinGecko\'s response right now. Try again shortly.');

    // Align hourly sparklines from the end; fill gaps with the previous valid price.
    const L = Math.min(...picked.map((p) => p.spark.length));
    for (const p of picked) {
      const s = p.spark.slice(-L);
      let last = s.find((x) => x > 0);
      p.closes = s.map((x) => (x > 0 ? (last = x) : last)).map(sig);
      delete p.spark;
    }
    const endHour = Math.floor(Date.now() / 3_600_000) * 3600;
    const timestamps = Array.from({ length: L }, (_, i) => endHour - (L - 1 - i) * 3600);

    const w = weighting === 'cap' ? cappedWeights(picked.map((p) => p.marketCap), TOP.capLimit) : picked.map(() => 1 / picked.length);
    picked.forEach((p, i) => { p.weight = +w[i].toFixed(6); });
    const level = (priceAt) => weighting === 'cap'
      ? 100 * picked.reduce((s, p, i) => s + w[i] * priceAt(p) / p.closes[0], 0)
      : 100 * Math.exp(picked.reduce((s, p) => s + Math.log(priceAt(p) / p.closes[0]), 0) / picked.length);
    const index = timestamps.map((_, t) => sig(level((p) => p.closes[t])));
    const liveLevel = sig(level((p) => p.price));
    const ch = picked.map((p) => p.change24h).filter((x) => x !== null).sort((a, b) => a - b);

    send(res, {
      weighting, capLimit: TOP.capLimit, count: picked.length, size: TOP.size,
      interval: '1h', intervalLabel: '1 hour', intervalSec: 3600, intervalHours: 1,
      source: cgSourceName(), updatedAt: new Date().toISOString(),
      timestamps, index,
      live: { t: Math.floor(Date.now() / 1000), c: liveLevel },
      stats: {
        change24h: (liveLevel / index[Math.max(0, L - 25)] - 1) * 100,
        change7d: (liveLevel / index[0] - 1) * 100,
        up24h: ch.filter((x) => x > 0).length,
        down24h: ch.filter((x) => x < 0).length,
        median24h: ch.length ? ch[Math.floor(ch.length / 2)] : null,
      },
      tokens: picked,
      skipped,
    }, 120);
  } catch (e) { fail(res, e); }
}
