import { cg, fail, HttpError } from './_lib/gecko.js';

const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * GET /api/open?id=<coingecko id>[&interval=1h]
 * Looks up a coin's Solana mint (only when someone clicks it) and redirects to the contract lens.
 */
export default async function handler(req, res) {
  try {
    const id = String(req.query.id || '').trim();
    if (!/^[a-z0-9-]{1,100}$/.test(id)) throw new HttpError(400, 'Invalid coin id.');
    const interval = /^[0-9]{1,2}[smhd]$/.test(String(req.query.interval || '')) ? req.query.interval : '1h';
    let mint = id === 'solana' ? WSOL : null;
    if (!mint) {
      const c = await cg(`/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`, 86_400_000);
      mint = c?.detail_platforms?.solana?.contract_address || c?.platforms?.solana || null;
    }
    if (!mint) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400');
      res.setHeader('Location', `/analyzer?mode=ecosystem&missing=${encodeURIComponent(id)}`);
      return res.status(302).end();
    }
    res.setHeader('Cache-Control', 'public, s-maxage=86400');
    res.setHeader('Location', `/analyzer?ca=${encodeURIComponent(mint)}&interval=${interval}`);
    res.status(302).end();
  } catch (e) { fail(res, e); }
}
