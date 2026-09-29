import { tokenWithPools, candles, pickInterval, isMint, send, fail, HttpError, sourceName, MIN_CANDLES } from './_lib/gecko.js';

/**
 * GET /api/market?address=<mint>&interval=1s|15s|30s|1m|5m|15m|1h|4h|12h|1d
 * Token info + completed candles from its most liquid pool + the forming candle.
 */
export default async function handler(req, res) {
  try {
    const address = String(req.query.address || '').trim();
    if (!isMint(address)) throw new HttpError(400, 'Enter a valid Solana token mint address.');
    const iv = pickInterval(req.query);

    const token = await tokenWithPools(address);
    if (!token.topPool) throw new HttpError(404, 'No trading pools found for this token.');
    const { bars, live } = await candles(token.topPool.address, address, iv);
    if (bars.length < MIN_CANDLES) {
      throw new HttpError(422, `Only ${bars.length} ${iv.label} candles of history — pick a shorter interval.`);
    }

    send(res, {
      token,
      interval: iv.id,
      intervalLabel: iv.label,
      intervalSec: iv.sec,
      intervalHours: iv.sec / 3600,
      source: sourceName(),
      updatedAt: new Date().toISOString(),
      timestamps: bars.map((c) => c.t),
      closes: bars.map((c) => c.c),
      volumes: bars.map((c) => c.v),
      live,
    }, iv.cache);
  } catch (e) { fail(res, e); }
}
