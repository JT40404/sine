import BASKET from './_lib/basket.js';
import { gecko, candles, WINDOWS, send, fail, HttpError, SOURCE } from './_lib/gecko.js';

/**
 * GET /api/ecosystem?window=1d|7d|30d|90d
 * Aligned closes for every basket token plus an equal-weight index:
 *   index_t = 100 · exp( mean_i log(close_i,t / close_i,0) )
 */
export default async function handler(req, res) {
  try {
    const win = String(req.query.window || '7d');
    const w = WINDOWS[win];
    if (!w) throw new HttpError(400, 'Window must be one of 1d, 7d, 30d, 90d.');

    const multi = await gecko(`/networks/solana/tokens/multi/${BASKET.map((b) => b.mint).join(',')}?include=top_pools`, 600_000);
    const meta = new Map();
    for (const d of multi?.data || []) {
      const poolId = d.relationships?.top_pools?.data?.[0]?.id || '';
      meta.set(d.attributes?.address, { name: d.attributes?.name, pool: poolId.replace(/^solana_/, '') });
    }

    const series = [], dropped = [];
    for (const b of BASKET) {
      const m = meta.get(b.mint);
      if (!m?.pool) { dropped.push({ symbol: b.symbol, reason: 'no pool' }); continue; }
      try {
        const cs = await candles(m.pool, b.mint, win);
        if (cs.length < w.count * 0.8) { dropped.push({ symbol: b.symbol, reason: 'not enough history' }); continue; }
        series.push({ ...b, name: m.name, pool: m.pool, map: new Map(cs.map((c) => [c.t, c.c])), first: cs[0].t, last: cs[cs.length - 1].t });
      } catch (e) {
        dropped.push({ symbol: b.symbol, reason: e.message });
      }
    }
    if (series.length < 2) throw new HttpError(503, 'Not enough basket data right now. Try again shortly.');

    const start = Math.max(...series.map((s) => s.first));
    const end = Math.min(...series.map((s) => s.last));
    const timestamps = [];
    for (let t = start; t <= end; t += w.sec) timestamps.push(t);
    const grid = timestamps.slice(-w.count);

    const tokens = series.map((s) => {
      let last = null;
      const closes = grid.map((t) => (last = s.map.get(t) ?? last));
      return { symbol: s.symbol, name: s.name, mint: s.mint, pool: s.pool, closes };
    }).filter((t) => t.closes.every((c) => c > 0));

    const index = grid.map((_, i) => {
      const mean = tokens.reduce((acc, t) => acc + Math.log(t.closes[i] / t.closes[0]), 0) / tokens.length;
      return +(100 * Math.exp(mean)).toFixed(6);
    });

    send(res, {
      window: win, interval: w.label, intervalHours: w.sec / 3600,
      source: SOURCE, updatedAt: new Date().toISOString(),
      timestamps: grid, index, tokens, dropped,
    }, 300);
  } catch (e) { fail(res, e); }
}
