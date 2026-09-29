import BASKET from './_lib/basket.js';
import { SOURCE, INTERVALS, SECONDS_AVAILABLE } from './_lib/gecko.js';

/** GET /api/health — deployment check + which candle intervals this server can serve. */
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=300');
  res.status(200).json({
    ok: true,
    source: SOURCE,
    secondsAvailable: SECONDS_AVAILABLE,
    intervals: Object.entries(INTERVALS)
      .filter(([, iv]) => !iv.pro || SECONDS_AVAILABLE)
      .map(([id, iv]) => ({ id, label: iv.label, seconds: iv.sec, candles: iv.count })),
    basket: BASKET.map((b) => b.symbol),
  });
}
