import { json, readJson } from './_lib/http.js';

/**
 * Coin image + metadata → IPFS via Pinata (pump.fun's own upload endpoint is retired; see pumpportal.fun/creation).
 *
 *   POST /api/upload   { image: "data:image/png;base64,...", name, symbol, description, twitter, telegram, website }
 *                      → { uri, image }
 *   GET  /api/upload?check=1   → diagnoses the Pinata setup without uploading anything
 *
 * Uses Pinata's v3 Files API, and falls back to the classic pinning API when a key lacks v3 permissions.
 * Needs PINATA_JWT in Vercel → Settings → Environment Variables (then redeploy).
 */
const MAX_BYTES = 1_000_000;
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Accepts the JWT even if pasted with quotes, a "Bearer " prefix or stray whitespace. */
function pinataJwt() {
  return String(process.env.PINATA_JWT || '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
}
function looksLikeJwt(t) { return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t); }

class PinataError extends Error { constructor(status, detail) { super(detail); this.status = status; } }
async function failure(r) {
  const body = (await r.text().catch(() => '')).slice(0, 300);
  let detail = body;
  try { const j = JSON.parse(body); detail = j?.error?.reason || j?.error?.details || j?.error || j?.message || body; } catch {}
  return new PinataError(r.status, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function pinV3(jwt, blob, filename) {
  const fd = new FormData(); fd.append('network', 'public'); fd.append('file', blob, filename);
  const r = await fetch('https://uploads.pinata.cloud/v3/files', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: fd });
  if (!r.ok) throw await failure(r);
  const cid = (await r.json())?.data?.cid;
  if (!cid) throw new PinataError(502, 'Pinata returned no CID');
  return cid;
}
async function pinLegacyFile(jwt, blob, filename) {
  const fd = new FormData(); fd.append('file', blob, filename);
  const r = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: fd });
  if (!r.ok) throw await failure(r);
  return (await r.json())?.IpfsHash;
}
async function pinLegacyJson(jwt, obj, name) {
  const r = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinataContent: obj, pinataMetadata: { name } }),
  });
  if (!r.ok) throw await failure(r);
  return (await r.json())?.IpfsHash;
}

function explain(e) {
  if (e.status === 401) return 'Pinata rejected the key. In Vercel, PINATA_JWT must be the long JWT (three parts separated by dots), not the API Key or Secret. Then redeploy.';
  if (e.status === 403) return 'The Pinata key is not allowed to upload. Create a new key in Pinata with Admin access (or file upload permissions), update PINATA_JWT, and redeploy.';
  if (e.status === 429) return 'Pinata is rate-limiting uploads right now. Wait a minute and try again.';
  if (e.status === 413) return 'The image is too large for Pinata. Use one under 1 MB.';
  return `Pinata upload failed (${e.status || 'network'}${e.message ? ': ' + String(e.message).slice(0, 120) : ''}). Try again shortly.`;
}

export default async function handler(req, res) {
  const jwt = pinataJwt();

  if (req.method === 'GET') {                                     // setup diagnostics, no upload
    if (!jwt) return json(res, 200, { ok: false, problem: 'PINATA_JWT is not set in this deployment. Add it in Vercel → Settings → Environment Variables (Production), then redeploy.' });
    if (!looksLikeJwt(jwt)) return json(res, 200, { ok: false, problem: 'PINATA_JWT does not look like a JWT. Copy the long JWT that Pinata shows when you create the key (not the API Key or Secret), then redeploy.' });
    const out = { ok: false, jwtLooksValid: true };
    try {
      const a = await fetch('https://api.pinata.cloud/data/testAuthentication', { headers: { Authorization: `Bearer ${jwt}` } });
      out.authentication = a.ok ? 'ok' : `failed (${a.status})`;
      const v = await fetch('https://api.pinata.cloud/v3/files/public?limit=1', { headers: { Authorization: `Bearer ${jwt}` } });
      out.v3Files = v.ok ? 'ok' : `no access (${v.status}) — uploads will use the classic API`;
      out.ok = a.ok;
      if (!a.ok) out.problem = a.status === 401 ? 'Pinata rejected the key: the JWT is wrong or was revoked.' : `Pinata answered ${a.status}.`;
    } catch (e) { out.problem = 'Could not reach Pinata from the server.'; }
    return json(res, 200, out);
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!jwt) return json(res, 503, { error: 'Launching is not set up yet: the site owner needs to add PINATA_JWT in Vercel and redeploy.' });
  const b = await readJson(req);
  if (!b) return json(res, 400, { error: 'Invalid request.' });
  const name = String(b.name || '').trim().slice(0, 32), symbol = String(b.symbol || '').trim().toUpperCase().slice(0, 10);
  if (!name || !symbol) return json(res, 400, { error: 'Name and symbol are required.' });
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(b.image || ''));
  if (!m) return json(res, 400, { error: 'Upload a PNG, JPG, GIF or WebP image.' });
  const bytes = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length) return json(res, 400, { error: 'The image appears to be empty.' });
  if (bytes.length > MAX_BYTES) return json(res, 400, { error: 'Image must be 1 MB or smaller.' });

  const clean = (u) => (/^https:\/\/[^\s"<>]{3,200}$/.test(String(u || '')) ? String(u) : undefined);
  const ext = TYPES[m[1]], imgBlob = new Blob([bytes], { type: m[1] });
  let route = 'v3';
  try {
    let imageCid;
    try { imageCid = await pinV3(jwt, imgBlob, `${symbol}.${ext}`); }
    catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e;
      route = 'classic';                                          // key without v3 Files permission → classic pinning API
      imageCid = await pinLegacyFile(jwt, imgBlob, `${symbol}.${ext}`);
    }
    const image = `https://ipfs.io/ipfs/${imageCid}`;
    const meta = {
      name, symbol, image, showName: true,
      description: String(b.description || '').slice(0, 500),
      twitter: clean(b.twitter), telegram: clean(b.telegram), website: clean(b.website),
      createdOn: 'SINE launchpad',
    };
    const metaCid = route === 'v3'
      ? await pinV3(jwt, new Blob([JSON.stringify(meta)], { type: 'application/json' }), `${symbol}.json`)
      : await pinLegacyJson(jwt, meta, `${symbol}.json`);
    return json(res, 200, { uri: `https://ipfs.io/ipfs/${metaCid}`, image, route });
  } catch (e) {
    console.error('upload failed', route, e.status, e.message);       // visible in Vercel → Logs
    return json(res, e.status === 429 ? 429 : 502, { error: explain(e) });
  }
}
