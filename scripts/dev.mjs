/**
 * Local dev server: serves the static pages with clean URLs (like Vercel) and runs /api/* handlers.
 *   node scripts/dev.mjs                → http://localhost:3000
 *   node scripts/dev.mjs --mock-chain   → same, with Solana reads stubbed (UI testing without network)
 * Reads .env if present. Network calls (RPC, GeckoTerminal, Pinata) go to the real services.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);
if (fs.existsSync(path.join(root, '.env'))) {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
if (process.argv.includes('--mock-chain')) await import('./mock-chain.mjs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, '');
      const file = path.join(root, 'api', name + '.js');
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      let body = raw; try { body = raw ? JSON.parse(raw) : undefined; } catch { /* keep string */ }
      const shim = Object.assign(res, {
        status(code) { res.statusCode = code; return shim; },
        json(obj) { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return shim; },
        send(s) { res.end(typeof s === 'string' ? s : JSON.stringify(s)); return shim; },
      });
      const mod = await import(pathToFileURL(file).href);
      return await mod.default(Object.assign(req, { query: Object.fromEntries(url.searchParams), body }), shim);
    }
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    let file = path.join(root, p);
    if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e); if (!res.headersSent) res.writeHead(500); res.end(String(e.message || e));
  }
}).listen(port, () => console.log(`SINE dev server on http://localhost:${port}`));
