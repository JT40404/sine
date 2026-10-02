import { json, readJson } from './_lib/http.js';

/**
 * POST /api/rpc — a narrow Solana JSON-RPC relay so the browser can use the site's RPC provider
 * (RPC_URL, e.g. a Helius/QuickNode URL with its key) without exposing it. Only the methods the
 * launchpad needs are allowed; everything is read-only except sending already-SIGNED transactions.
 */
const ALLOWED = new Set([
  'getLatestBlockhash', 'getBalance', 'getAccountInfo', 'getTokenAccountsByOwner', 'getTokenSupply',
  'getSignatureStatuses', 'sendTransaction', 'simulateTransaction', 'getTransaction',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const b = await readJson(req);
  if (!b || !ALLOWED.has(b.method) || !Array.isArray(b.params ?? [])) return json(res, 400, { error: 'RPC method not allowed.' });
  const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: b.method, params: b.params ?? [] }),
    });
    const out = await r.json();
    return json(res, r.ok ? 200 : 502, out);
  } catch (e) {
    return json(res, 502, { error: 'Solana RPC unreachable.' });
  }
}
