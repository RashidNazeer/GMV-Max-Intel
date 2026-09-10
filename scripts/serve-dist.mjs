// A static server for dist/, for the browser gates.
//
// `vite preview` kept dying part-way through a gate run, and a gate whose
// server disappears reports "0 failed" for every check it never reached — the
// run that prompted this printed 119 passed / 0 failed while the entire
// campaign-detail section had silently gone missing. A server this simple has
// nothing to die of.
//
// Single-page fallback: any path that is not a real file returns index.html, so
// deep links like /campaigns/123 work the way they do in production.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.argv[2] || 4318);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Normalise before joining, or "../" in a request path escapes dist/.
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(ROOT, rel);

  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(ROOT, 'index.html');
  }

  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(body);
});

server.listen(PORT, () => console.log(`serving dist on http://localhost:${PORT}`));
