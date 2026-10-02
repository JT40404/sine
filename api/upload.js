import { json, readJson } from './_lib/http.js';

/**
 * POST /api/upload — pins a coin's image and metadata JSON to IPFS via Pinata
 * (pump.fun's own upload endpoint is retired; see https://pumpportal.fun/creation).
 * Body: { image: "data:image/png;base64,...", name, symbol, description, twitter, telegram, website }
 * Needs PINATA_JWT in the Vercel environment. Returns { uri, image }.
 */
const MAX_BYTES = 1_000_000;
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return json(res, 503, { error: 'Launching is not set up yet: the site owner needs to add PINATA_JWT in Vercel.' });
  const b = await readJson(req);
  if (!b) return json(res, 400, { error: 'Invalid request.' });
  const name = String(b.name || '').trim().slice(0, 32), symbol = String(b.symbol || '').trim().toUpperCase().slice(0, 10);
  if (!name || !symbol) return json(res, 400, { error: 'Name and symbol are required.' });
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ''));
  if (!m) return json(res, 400, { error: 'Upload a PNG, JPG, GIF or WebP image.' });
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_BYTES) return json(res, 400, { error: 'Image must be 1 MB or smaller.' });

  const clean = (u) => (/^https:\/\/[^\s"<>]{3,200}$/.test(String(u || '')) ? String(u) : undefined);
  try {
    const pin = async (blob, filename) => {
      const fd = new FormData(); fd.append('network', 'public'); fd.append('file', blob, filename);
      const r = await fetch('https://uploads.pinata.cloud/v3/files', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: fd });
      if (!r.ok) throw new Error(`Pinata ${r.status}`);
      return (await r.json())?.data?.cid;
    };
    const imageCid = await pin(new Blob([bytes], { type: m[1] }), `${symbol}.${TYPES[m[1]]}`);
    const image = `https://ipfs.io/ipfs/${imageCid}`;
    const meta = {
      name, symbol, image, showName: true,
      description: String(b.description || '').slice(0, 500),
      twitter: clean(b.twitter), telegram: clean(b.telegram), website: clean(b.website),
      createdOn: 'SINE launchpad',
    };
    const metaCid = await pin(new Blob([JSON.stringify(meta)], { type: 'application/json' }), `${symbol}.json`);
    return json(res, 200, { uri: `https://ipfs.io/ipfs/${metaCid}`, image });
  } catch (e) {
    return json(res, 502, { error: 'Could not store the image and metadata on IPFS. Try again shortly.' });
  }
}
