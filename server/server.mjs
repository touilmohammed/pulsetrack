// Serveur de développement : sert la PWA et l'API sur la même origine, comme Netlify en production.
// Usage : npm start  (PORT=3000 par défaut, données dans server/data/db.json)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { createFileStore } from './store-file.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const api = createApi(await createFileStore(join(ROOT, 'server', 'data', 'db.json')));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};
// Jamais servis : code serveur, fonctions, dépendances, fichiers cachés (.git, .env…).
const PRIVATE = new Set(['server', 'netlify', 'node_modules']);

async function serveStatic(pathname, res) {
  const relative = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^[/\\]+/, '');
  const segments = relative.split(sep);
  if (segments.some((s) => s === '..' || s.startsWith('.')) || PRIVATE.has(segments[0])) return false;
  const file = join(ROOT, relative);
  try {
    if (!(await stat(file)).isFile()) return false;
  } catch {
    return false;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    // Comme Netlify : toujours revalidé, indispensable pour la détection des mises à jour du SW.
    'Cache-Control': 'public, max-age=0, must-revalidate',
  });
  res.end(await readFile(file));
  return true;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      const response = await api(new Request(url, { method: req.method, headers: req.headers, body }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method) || !(await serveStatic(url.pathname, res))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — introuvable');
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 — erreur interne');
  }
}).listen(PORT, () => {
  console.log(`PulseTrack : http://localhost:${PORT}`);
});
