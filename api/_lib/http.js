/** Shared helpers for the launchpad API routes. */
export const isAddress = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));
export function json(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}
export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return null; } }
  return null;
}
