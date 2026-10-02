import { gecko, isMint } from './_lib/gecko.js';

/**
 * Coins launched through the SINE launchpad (for the live ticker).
 *
 *   GET  /api/registry[?pin=<mint>]  → { enabled, tokens: [{ mint, symbol, name, image, priceUsd, marketCapUsd, change24h, volume24hUsd, launchedAt }] }
 *   POST /api/registry  { sig, mint, creator, name, symbol, image }  → records a launch AFTER verifying it on-chain
 *
 * Storage: Upstash Redis REST (Vercel → Storage / Marketplace → Upstash). Reads either
 * KV_REST_API_URL + KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
 * Without storage the ticker still works for the pinned main token.
 */
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const KEY_SET = 'sine:launches', KEY_DATA = 'sine:launch:';

function store() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const pipe = async (cmds) => {
    const r = await fetch(url.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
    if (!r.ok) throw new Error(`storage ${r.status}`);
    return (await r.json()).map((x) => x.result);
  };
  return { pipe };
}

async function rpc(method, params) {
  const r = await fetch(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json())?.result ?? null;
}

/** The launch must be a successful pump.fun transaction signed by both the new mint and the creator. */
async function verifyLaunch(sig, mint, creator) {
  for (let i = 0; i < 4; i++) {
    const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (tx) {
      if (tx.meta?.err) return 'transaction failed';
      const keys = tx.transaction?.message?.accountKeys || [];
      const signer = (k) => keys.some((a) => a.pubkey === k && a.signer);
      if (!signer(mint) || !signer(creator)) return 'not signed by this coin and creator';
      const progs = new Set([...keys.map((a) => a.pubkey), ...(tx.transaction?.message?.instructions || []).map((x) => x.programId)]);
      if (!progs.has(PUMP_PROGRAM)) return 'not a pump.fun launch';
      return null;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 'transaction not found yet';
}

const clean = (s, n) => String(s || '').replace(/[^\p{L}\p{N} $._-]/gu, '').trim().slice(0, n);

async function marketData(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const j = await gecko(`/networks/solana/tokens/multi/${batch.join(',')}?include=top_pools`, 30_000);
      const pools = new Map((j?.included || []).filter((x) => x.type === 'pool').map((p) => [p.id, p.attributes]));
      for (const t of j?.data || []) {
        const a = t.attributes || {}, top = (t.relationships?.top_pools?.data || [])[0];
        const pa = top ? pools.get(top.id) : null;
        const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
        out.set(a.address, {
          symbol: a.symbol, name: a.name, priceUsd: n(a.price_usd),
          marketCapUsd: n(a.market_cap_usd) ?? n(a.fdv_usd),
          volume24hUsd: n(a.volume_usd?.h24), change24h: pa ? n(pa.price_change_percentage?.h24) : null,
        });
      }
    } catch { /* market data is best-effort; the ticker still lists the coin */ }
  }
  return out;
}

export default async function handler(req, res) {
  const s = store();

  if (req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (!isMint(b.mint) || !isMint(b.creator) || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(b.sig || '')) return res.status(400).json({ error: 'Invalid launch details.' });
    if (!s) return res.status(200).json({ stored: false, reason: 'The launch ticker is not set up yet (no storage configured).' });
    const problem = await verifyLaunch(b.sig, b.mint, b.creator);
    if (problem) return res.status(400).json({ stored: false, reason: `Not recorded: ${problem}.` });
    const image = /^https:\/\/ipfs\.io\/ipfs\/[A-Za-z0-9]{20,80}$/.test(b.image || '') ? b.image : null;
    const rec = { mint: b.mint, creator: b.creator, sig: b.sig, name: clean(b.name, 32), symbol: clean(b.symbol, 10).toUpperCase(), image, launchedAt: Date.now() };
    await s.pipe([['SET', KEY_DATA + b.mint, JSON.stringify(rec)], ['ZADD', KEY_SET, 'NX', rec.launchedAt, b.mint], ['ZREMRANGEBYRANK', KEY_SET, 0, -501]]);
    return res.status(200).json({ stored: true });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET or POST' });
  const pin = isMint(req.query.pin) ? req.query.pin : null;
  let recs = [];
  if (s) {
    try {
      const [mints] = await s.pipe([['ZREVRANGE', KEY_SET, 0, 39]]);
      if (mints?.length) {
        const vals = (await s.pipe([['MGET', ...mints.map((m) => KEY_DATA + m)]]))[0] || [];
        recs = vals.map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
      }
    } catch { /* storage hiccup: fall through with what we have */ }
  }
  if (pin && !recs.some((r) => r.mint === pin)) recs.unshift({ mint: pin, pinned: true });
  const md = await marketData(recs.map((r) => r.mint));
  const tokens = recs.map((r) => ({ ...r, ...(md.get(r.mint) || {}), symbol: (md.get(r.mint)?.symbol || r.symbol || '').toUpperCase(), name: md.get(r.mint)?.name || r.name || '' }))
    .map(({ creator, sig, ...pub }) => pub);
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=90');
  return res.status(200).json({ enabled: Boolean(s), tokens });
}
