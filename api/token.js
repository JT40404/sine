import { tokenWithPools, isMint, send, fail, HttpError, SOURCE } from './_lib/gecko.js';

/** GET /api/token?address=<mint> — live price, 24h change, liquidity, volume, top pool. */
export default async function handler(req, res) {
  try {
    const address = String(req.query.address || '').trim();
    if (!isMint(address)) throw new HttpError(400, 'Enter a valid Solana token mint address.');
    const token = await tokenWithPools(address);
    send(res, { token, source: SOURCE, updatedAt: new Date().toISOString() }, 30);
  } catch (e) { fail(res, e); }
}
