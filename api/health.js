import BASKET from './_lib/basket.js';
import { SOURCE } from './_lib/gecko.js';

/** GET /api/health — quick check that functions deployed and which data source is active. */
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, source: SOURCE, basket: BASKET.map((b) => b.symbol) });
}
