import { TOP } from './_lib/basket.js';
import { cg, send, fail, HttpError, CG_SOURCE } from './_lib/gecko.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const DAY = 86_400_000;

async function excludedIds() {
  const ids = new Set(TOP.alwaysExclude);
  for (const cat of TOP.excludeCategories) {
    try {
      const list = await cg(`/coins/markets?vs_currency=usd&category=${encodeURIComponent(cat)}&per_page=250&page=1`, DAY);
      if (Array.isArray(list)) list.forEach((c) => ids.add(c.id));
    } catch { /* unknown or unavailable category: skip it */ }
  }
  return ids;
}

async function solanaMints() {
  try {
    const list = await cg('/coins/list?include_platform=true', DAY);
    const map = new Map();
    for (const c of list) if (c.platforms && c.platforms.solana) map.set(c.id, c.platforms.solana);
    return map;
  } catch { return null; }
}

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

const sig = (v) => (v === 0 ? 0 : +v.toPrecision(8));

/**
 * GET /api/top50?weight=cap|equal
 * Top Solana tokens by market cap (stablecoins, LSTs, wrapped/bridged assets excluded),
 * their 7-day hourly prices, and a market index built from them.
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
    if (!Array.isArray(markets) || !markets.length) throw new HttpError(502, 'No ranking data from CoinGecko.');
    const excluded = await excludedIds();
    const mints = await solanaMints();

    const picked = [], skipped = [];
    for (const c of markets) {
      if (picked.length >= TOP.size) break;
      const spark = c.sparkline_in_7d?.price || [];
      const sym = String(c.symbol || '').toUpperCase();
      const flat = spark.length && Math.max(...spark) / Math.max(1e-12, Math.min(...spark.filter((x) => x > 0))) < 1.03;
      let reason = '';
      if (excluded.has(c.id)) reason = 'excluded category';
      else if (/USD|EUR|GBP/.test(sym) || (Math.abs(c.current_price - 1) < 0.03 && flat)) reason = 'stablecoin';
      else if (!(c.market_cap > 0) || !(c.current_price > 0)) reason = 'no market cap';
      else if (spark.filter((x) => x > 0).length < 120) reason = 'not enough history';
      else if (mints && c.id !== 'solana' && !mints.has(c.id)) reason = 'no Solana contract';
      if (reason) { skipped.push({ symbol: sym, reason }); continue; }
      picked.push({
        id: c.id, symbol: sym, name: c.name, rank: c.market_cap_rank,
        mint: c.id === 'solana' ? WSOL : (mints && mints.get(c.id)) || null,
        marketCap: c.market_cap, price: c.current_price,
        change24h: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h ?? null,
        change7d: c.price_change_percentage_7d_in_currency ?? null,
        spark,
      });
    }
    if (picked.length < 5) throw new HttpError(503, 'Not enough eligible tokens right now. Try again shortly.');

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
    const at24 = index[Math.max(0, L - 25)];

    send(res, {
      weighting, capLimit: TOP.capLimit, count: picked.length,
      interval: '1h', intervalLabel: '1 hour', intervalSec: 3600, intervalHours: 1,
      source: CG_SOURCE, updatedAt: new Date().toISOString(),
      timestamps, index,
      live: { t: Math.floor(Date.now() / 1000), c: liveLevel },
      stats: {
        change24h: (liveLevel / at24 - 1) * 100,
        change7d: (liveLevel / index[0] - 1) * 100,
        up24h: ch.filter((x) => x > 0).length,
        down24h: ch.filter((x) => x < 0).length,
        median24h: ch.length ? ch[Math.floor(ch.length / 2)] : null,
      },
      tokens: picked,
      skipped: skipped.slice(0, 40),
    }, 120);
  } catch (e) { fail(res, e); }
}
