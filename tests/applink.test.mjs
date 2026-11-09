// App Link Android : le site doit publier /.well-known/assetlinks.json, tel que l'OS le lit.
// Usage : node tests/applink.test.mjs <url de base>
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const PACKAGE = 'corsica.universita.pulsetrack';
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

try {
  // L'OS refuse une redirection : la réponse doit venir directement de cette adresse.
  const res = await fetch(`${base}/.well-known/assetlinks.json`, { redirect: 'manual' });
  check('assetlinks.json servi en 200, sans redirection', res.status === 200, String(res.status));
  check('Content-Type JSON', (res.headers.get('content-type') || '').startsWith('application/json'), res.headers.get('content-type'));
  const body = await res.json();
  const statement = Array.isArray(body) && body.find((s) => s.target?.package_name === PACKAGE);
  check('Déclaration pour le paquet de l\'app', Boolean(statement));
  check('Relation handle_all_urls', statement?.relation?.includes('delegate_permission/common.handle_all_urls'));
  const prints = statement?.target?.sha256_cert_fingerprints || [];
  check('Empreintes SHA-256 bien formées (debug + release)', prints.length === 2 && prints.every((p) => FINGERPRINT.test(p)), prints.length + ' empreinte(s)');

  // L'exception .well-known ne doit ouvrir aucun autre fichier caché.
  for (const path of ['/.git/config', '/.env', '/.well-known/../.git/config', '/.well-known/%2e%2e/.git/config']) {
    const r = await fetch(base + path, { redirect: 'manual' });
    check(`${path} non servi`, r.status === 404, String(r.status));
  }
} catch (e) {
  check('Exécution du test', false, e.message);
}
console.log(results.join('\n'));
