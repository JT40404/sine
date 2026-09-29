/**
 * Market data client: GeckoTerminal / CoinGecko On-chain DEX API.
 * - No key: GeckoTerminal public API (low, per-IP rate limits).
 * - COINGECKO_API_KEY (+ COINGECKO_PLAN=demo|pro): CoinGecko on-chain endpoints, per-key limits.
 */
const KEY = process.env.COINGECKO_API_KEY || '';
const PRO = (process.env.COINGECKO_PLAN || '').toLowerCase() === 'pro';
const BASE = !KEY
  ? 'https://api.geckoterminal.com/api/v2'
  : PRO ? 'https://pro-api.coingecko.com/api/v3/onchain' : 'https://api.coingecko.com/api/v3/onchain';

export const SOURCE = !KEY ? 'GeckoTerminal (public)' : PRO ? 'CoinGecko Pro' : 'CoinGecko Demo';

/**
 * Candle intervals. `count` candles are analyzed; `cache` is the CDN/memory cache in seconds,
 * which also sets how "live" the chart can be. Second-level candles are a CoinGecko Pro feature.
 */
export const INTERVALS = {
  '1s':  { tf: 'second', agg: 1,  sec: 1,     count: 600, cache: 1,   pro: true,  label: '1 sec' },
  '15s': { tf: 'second', agg: 15, sec: 15,    count: 720, cache: 5,   pro: true,  label: '15 sec' },
  '30s': { tf: 'second', agg: 30, sec: 30,    count: 720, cache: 10,  pro: true,  label: '30 sec' },
  '1m':  { tf: 'minute', agg: 1,  sec: 60,    count: 720, cache: 15,  label: '1 min' },
  '5m':  { tf: 'minute', agg: 5,  sec: 300,   count: 576, cache: 30,  label: '5 min' },
  '15m': { tf: 'minute', agg: 15, sec: 900,   count: 672, cache: 60,  label: '15 min' },
  '1h':  { tf: 'hour',   agg: 1,  sec: 3600,  count: 720, cache: 120, label: '1 hour' },
  '4h':  { tf: 'hour',   agg: 4,  sec: 14400, count: 540, cache: 300, label: '4 hours' },
  '12h': { tf: 'hour',   agg: 12, sec: 43200, count: 730, cache: 600, label: '12 hours' },
  '1d':  { tf: 'day',    agg: 1,  sec: 86400, count: 365, cache: 900, label: '1 day' },
};
export const SECONDS_AVAILABLE = Boolean(KEY) && PRO;
export const MIN_CANDLES = 64;

/** Accepts ?interval=… (preferred) or the old ?window=1d|7d|30d|90d. */
export function pickInterval(query) {
  const legacy = { '1d': '5m', '7d': '15m', '30d': '1h', '90d': '4h' };
  const id = query.interval ? String(query.interval) : legacy[String(query.window || '')] || '15m';
  const iv = INTERVALS[id];
  if (!iv) throw new HttpError(400, `Interval must be one of ${Object.keys(INTERVALS).join(', ')}.`);
  if (iv.pro && !SECONDS_AVAILABLE) throw new HttpError(400, 'Second-level candles (1s, 15s, 30s) need a CoinGecko Pro API key on the server.');
  return { id, ...iv };
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const isMint = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));

// Per-instance memory cache (warm functions reuse it); the CDN cache does the heavy lifting.
const memo = new Map();

export async function gecko(path, ttlMs = 0) {
  if (ttlMs) {
    const hit = memo.get(path);
    if (hit && hit.exp > Date.now()) return hit.value;
  }
  const headers = { accept: 'application/json' };
  if (KEY) headers[PRO ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = KEY;

  let wait = 1500;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(BASE + path, { headers });
    if (res.status === 429) { if (attempt < 3) { await sleep(wait); wait *= 2; } continue; }
    if (res.status === 404) throw new HttpError(404, 'Token or pool not found on GeckoTerminal.');
    if (!res.ok) throw new HttpError(502, `Market data provider returned ${res.status}.`);
    const value = await res.json();
    if (ttlMs) memo.set(path, { value, exp: Date.now() + ttlMs });
    return value;
  }
  throw new HttpError(503, 'Market data provider is rate-limiting requests. Try again in a minute.');
}

function poolFromIncluded(p) {
  const a = p.attributes || {};
  return {
    address: a.address,
    name: a.name,
    liquidityUsd: num(a.reserve_in_usd) || 0,
    change24h: num(a.price_change_percentage?.h24),
    volume24hUsd: num(a.volume_usd?.h24),
    dex: p.relationships?.dex?.data?.id || '',
  };
}

/** Token metadata + its pools, most liquid first. */
export async function tokenWithPools(address) {
  const j = await gecko(`/networks/solana/tokens/${address}?include=top_pools`, 60_000);
  const a = j?.data?.attributes || {};
  const pools = (j?.included || []).filter((x) => x.type === 'pool').map(poolFromIncluded)
    .sort((p, q) => q.liquidityUsd - p.liquidityUsd);
  return {
    address,
    name: a.name || '',
    symbol: a.symbol || '',
    priceUsd: num(a.price_usd),
    fdvUsd: num(a.fdv_usd),
    marketCapUsd: num(a.market_cap_usd),
    volume24hUsd: num(a.volume_usd?.h24),
    liquidityUsd: num(a.total_reserve_in_usd),
    change24h: pools[0]?.change24h ?? null,
    topPool: pools[0] || null,
  };
}

/**
 * Completed, evenly spaced candles for `token`'s price in `pool`, oldest first, plus the
 * still-forming candle (`live`) for real-time display. Gaps (no trades) are forward-filled so
 * the Fourier analysis sees even sampling; the forming candle is never analyzed.
 */
export async function candles(pool, token, iv) {
  const limit = Math.min(1000, iv.count + 3);
  const j = await gecko(
    `/networks/solana/pools/${pool}/ohlcv/${iv.tf}?aggregate=${iv.agg}&limit=${limit}&currency=usd&token=${token}`,
    iv.cache * 1000,
  );
  const now = Date.now() / 1000;
  const all = (j?.data?.attributes?.ohlcv_list || [])
    .map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
    .filter((c) => c.c > 0)
    .sort((a, b) => a.t - b.t);
  const done = all.filter((c) => c.t + iv.sec <= now);
  const forming = all.filter((c) => c.t + iv.sec > now).pop() || null;

  const out = [];
  for (const c of done) {
    const prev = out[out.length - 1];
    if (prev && c.t === prev.t) continue;
    if (prev) for (let t = prev.t + iv.sec; t < c.t; t += iv.sec) out.push({ t, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 });
    out.push(c);
  }
  return { bars: out.slice(-iv.count), live: forming ? { t: forming.t, c: forming.c } : null };
}

export function send(res, body, sMaxAge) {
  res.setHeader('Cache-Control', `public, s-maxage=${sMaxAge}, stale-while-revalidate=${Math.max(5, sMaxAge * 5)}`);
  res.status(200).json(body);
}

export function fail(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : 'Unexpected server error.';
  if (!(err instanceof HttpError)) console.error(err);
  res.setHeader('Cache-Control', status === 404 ? 'public, s-maxage=60' : 'no-store');
  res.status(status).json({ error: message });
}
