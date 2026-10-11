// Lance toute la suite de tests et affiche un bilan.
//   npm test                        → en local (copie du projet servie par server/server.mjs)
//   npm test -- https://<url>       → contre un déploiement (tests sans serveur local)
// Navigateur : Edge par défaut sous Windows ; sinon BROWSER_PATH=/chemin/vers/chrome.
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TESTS = fileURLToPath(new URL('.', import.meta.url));
const remote = process.argv[2];

function run(file, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(TESTS, file), ...args], { env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => resolve(out));
  });
}

async function waitForServer(url) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`Serveur injoignable : ${url}`);
}

const suites = [];
let server;
let copy;

if (remote) {
  const base = remote.replace(/\/$/, '');
  suites.push(['Installable et hors ligne (sprint 1)', 'sprint1.e2e.mjs', [base]]);
  suites.push(['Séances locales IndexedDB (sprint 2)', 'sprint2.e2e.mjs', [base]]);
  suites.push(['Capacités de l\'appareil (sprint 6)', 'sprint6.e2e.mjs', [base]]);
  suites.push(['Conflits If-Match (bonus, T9)', 'conflicts.e2e.mjs', [base]]);
  suites.push(['Synchronisation de bout en bout', 'remote-sync.e2e.mjs', [base]]);
} else {
  // Copie du projet : le test de mise à jour modifie sw.js pour simuler un redéploiement.
  copy = await mkdtemp(join(tmpdir(), 'pulsetrack-test-'));
  const skip = ['.git', 'node_modules', 'dist', join('server', 'data'), 'tests'];
  await cp(ROOT, copy, {
    recursive: true,
    filter: (src) => !skip.some((s) => relative(ROOT, src) === s || relative(ROOT, src).startsWith(s + sep)),
  });
  // Dépendances du serveur (web-push) : lien vers node_modules plutôt qu'une copie (jonction sous Windows).
  await symlink(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'junction');
  const port = Number(process.env.TEST_PORT) || 3101;
  const base = `http://localhost:${port}`;
  server = spawn(process.execPath, [join(copy, 'server', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), DATA_FILE: join(copy, 'db.json'), PUSH_EXTRA_HOSTS: 'localhost' },
  });
  await waitForServer(base);
  suites.push(['API (unitaires)', 'api.test.mjs', []]);
  suites.push(['Rappels push, serveur (unitaires)', 'push.test.mjs', []]);
  suites.push(['Installable et hors ligne (sprint 1)', 'sprint1.e2e.mjs', [base]]);
  suites.push(['Séances locales IndexedDB (sprint 2)', 'sprint2.e2e.mjs', [base]]);
  suites.push(['Mise à jour proposée (sprint 3)', 'sprint3.e2e.mjs', [base, join(copy, 'sw.js')]]);
  suites.push(['Capacités de l\'appareil (sprint 6)', 'sprint6.e2e.mjs', [base]]);
  suites.push(['Conflits If-Match (bonus, T9)', 'conflicts.e2e.mjs', [base]]);
  suites.push(['Rappels push de bout en bout (bonus, T16)', 'push.e2e.mjs', [base]]);
  suites.push(['Synchronisation et outbox (sprint 4)', 'sprint4.e2e.mjs', []]);
}

let failed = 0;
let passed = 0;
try {
  for (const [name, file, args] of suites) {
    const out = await run(file, args);
    const ok = (out.match(/^OK /gm) || []).length;
    const ko = (out.match(/^FAIL/gm) || []).length;
    passed += ok;
    failed += ko;
    console.log(`${ko ? '✗' : '✓'} ${name} : ${ok}/${ok + ko}`);
    if (ko || !ok) console.log(out.split('\n').filter((l) => !l.startsWith('OK ')).join('\n'));
  }
} finally {
  server?.kill();
  if (copy) await rm(copy, { recursive: true, force: true }).catch(() => {});
}
console.log(`\n${passed} vérifications réussies, ${failed} en échec.`);
process.exit(failed ? 1 : 0);
