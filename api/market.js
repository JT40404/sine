import { tokenWithPools, candles, WINDOWS, isMint, send, fail, HttpError, SOURCE } from './_lib/gecko.js';

/** GET /api/market?address=<mint>&window=1d|7d|30d|90d — token info + candles from its most liquid pool. */
export default async function handler(req, res) {
  try {
    const address = String(req.query.address || '').trim();
    const win = String(req.query.window || '7d');
    if (!isMint(address)) throw new HttpError(400, 'Enter a valid Solana token mint address.');
    if (!WINDOWS[win]) throw new HttpError(400, 'Window must be one of 1d, 7d, 30d, 90d.');

    const token = await tokenWithPools(address);
    if (!token.topPool) throw new HttpError(404, 'No trading pools found for this token.');
    const cs = await candles(token.topPool.address, address, win);
    if (cs.length < 64) throw new HttpError(422, `Only ${cs.length} candles of history for this window — try a shorter window.`);

    send(res, {
      token,
      window: win,
      interval: WINDOWS[win].label,
      intervalHours: WINDOWS[win].sec / 3600,
      source: SOURCE,
      updatedAt: new Date().toISOString(),
      timestamps: cs.map((c) => c.t),
      closes: cs.map((c) => c.c),
      volumes: cs.map((c) => c.v),
    }, win === '1d' ? 60 : 120);
  } catch (e) { fail(res, e); }
}
