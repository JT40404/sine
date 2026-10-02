import { json, readJson, isAddress } from './_lib/http.js';

/**
 * POST /api/pump — builds an UNSIGNED pump.fun transaction via PumpPortal's Local Transaction API
 * (https://pumpportal.fun/local-trading-api/trading-api) and returns it base64-encoded.
 * The user's wallet signs it in the browser; this server never sees a private key.
 * Allowed actions: create · buy · collectCreatorFee
 */
const ALLOWED = new Set(['create', 'buy', 'collectCreatorFee']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const b = await readJson(req);
  if (!b || !ALLOWED.has(b.action)) return json(res, 400, { error: 'Unknown action.' });
  if (!isAddress(b.publicKey)) return json(res, 400, { error: 'Missing or invalid wallet address.' });

  const body = { publicKey: b.publicKey, action: b.action, priorityFee: clamp(b.priorityFee, 0, 0.01, 0.00005) };
  if (b.action === 'create' || b.action === 'buy') {
    if (!isAddress(b.mint)) return json(res, 400, { error: 'Invalid mint address.' });
    body.mint = b.mint;
    body.denominatedInSol = 'true';
    body.amount = clamp(b.amount, 0, 50, 0);
    body.slippage = clamp(b.slippage, 1, 50, 10);
    body.pool = b.action === 'create' ? 'pump' : 'auto';           // buys route to the bonding curve or, after graduation, the AMM
  }
  if (b.action === 'create') {
    const m = b.tokenMetadata || {};
    if (!m.name || !m.symbol || !/^https:\/\//.test(m.uri || '')) return json(res, 400, { error: 'Token name, symbol and metadata URI are required.' });
    body.tokenMetadata = { name: String(m.name).slice(0, 32), symbol: String(m.symbol).slice(0, 10), uri: m.uri };
  }
  if (b.action === 'buy' && !(body.amount > 0)) return json(res, 400, { error: 'Buy amount must be above zero.' });

  try {
    const r = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status !== 200) {
      const msg = (await r.text().catch(() => '')).slice(0, 200) || r.statusText;
      return json(res, 502, { error: `PumpPortal could not build the transaction: ${msg}` });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return json(res, 200, { tx: buf.toString('base64') });
  } catch (e) {
    return json(res, 502, { error: 'PumpPortal is unreachable right now. Try again shortly.' });
  }
}

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
