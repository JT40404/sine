import BASKET, { TOP } from './_lib/basket.js';
import { INTERVALS, secondsAvailable, sourceName, cgSourceName, keyInfo, gecko, cg } from './_lib/gecko.js';

const WSOL = 'So11111111111111111111111111111111111111112';

async function probe(fn) {
  const t0 = Date.now();
  try { await fn(); return { ok: true, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message }; }
}

/**
 * GET /api/health            — deployment check + available candle intervals
 * GET /api/health?check=1    — also calls both data providers and reports any error
 */
export default async function handler(req, res) {
  const body = {
    ok: true,
    key: keyInfo(),
    onchainSource: sourceName(),
    rankingSource: cgSourceName(),
    secondsAvailable: secondsAvailable(),
    intervals: Object.entries(INTERVALS)
      .filter(([, iv]) => !iv.pro || secondsAvailable())
      .map(([id, iv]) => ({ id, label: iv.label, seconds: iv.sec, candles: iv.count })),
    topBasket: { size: TOP.size, category: TOP.category },
    coreBasket: BASKET.map((b) => b.symbol),
  };
  if (req.query.check) {
    body.checks = {
      onchain: await probe(() => gecko(`/networks/solana/tokens/${WSOL}`)),
      rankings: await probe(() => cg('/coins/markets?vs_currency=usd&ids=solana')),
    };
    body.ok = body.checks.onchain.ok && body.checks.rankings.ok;
    body.onchainSource = sourceName();   // may have self-corrected during the checks
    body.rankingSource = cgSourceName();
    body.key = keyInfo();
  }
  res.setHeader('Cache-Control', req.query.check ? 'no-store' : 'public, s-maxage=300');
  res.status(200).json(body);
}
