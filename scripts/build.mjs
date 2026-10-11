// « Build » Netlify : copie uniquement les fichiers publics dans dist/ (liste blanche).
// Rien n'est transformé : le code servi est exactement celui du dépôt.
// Sans cette étape, Netlify publierait aussi node_modules/, server/ et netlify/.
import { cp, readdir, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PUBLIC_DIRS = ['icons', 'vendor'];
const PUBLIC_FILE = /^(?!package(-lock)?\.json$).+\.(html|css|js|json|txt|xml)$|^sessions\.md$|^_headers$/;

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST);

const copied = [];
for (const entry of await readdir(ROOT, { withFileTypes: true })) {
  const publicFile = entry.isFile() && PUBLIC_FILE.test(entry.name);
  const publicDir = entry.isDirectory() && PUBLIC_DIRS.includes(entry.name);
  if (publicFile || publicDir) {
    await cp(join(ROOT, entry.name), join(DIST, entry.name), { recursive: true });
    copied.push(entry.name + (publicDir ? '/' : ''));
  }
}
console.log(`dist/ : ${copied.sort().join(', ')}`);
