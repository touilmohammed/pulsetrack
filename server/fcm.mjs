// Rappels vers l'app Android : Firebase Cloud Messaging, API HTTP v1.
// Pas de SDK Firebase côté serveur : un compte de service signe un JWT (RS256) avec node:crypto,
// échangé contre un jeton d'accès OAuth 2, puis chaque message part par fetch.
import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// Les trois valeurs utiles du JSON du compte de service, en variables d'environnement séparées :
// le JSON entier (2,3 Ko) pèserait trop dans la limite de 4 Ko de variables d'une fonction AWS Lambda.
export function fcmCredentialsFromEnv(env = process.env) {
  const { FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY } = env;
  if (!FCM_PROJECT_ID || !FCM_CLIENT_EMAIL || !FCM_PRIVATE_KEY) return null;
  return {
    projectId: FCM_PROJECT_ID,
    clientEmail: FCM_CLIENT_EMAIL,
    // Copiée depuis le JSON, la clé garde souvent ses « \n » littéraux : on les rend à la ligne.
    privateKey: FCM_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
}

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export function signJwt(claims, privateKey) {
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');
  return `${unsigned}.${signature}`;
}

// Renvoie send(token, payload). tokenUrl et apiBase sont remplaçables pour les tests (faux Google local).
export function createFcmSender({ projectId, clientEmail, privateKey }, {
  fetchImpl = fetch,
  tokenUrl = 'https://oauth2.googleapis.com/token',
  apiBase = 'https://fcm.googleapis.com',
  now = () => Date.now(),
} = {}) {
  let cached = null;

  // Un jeton d'accès vaut une heure : on le garde, une minute de marge avant son expiration.
  async function accessToken() {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const assertion = signJwt({ iss: clientEmail, scope: SCOPE, aud: tokenUrl, iat, exp: iat + 3600 }, privateKey);
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!response.ok) {
      const error = new Error(`Jeton FCM refusé : ${response.status}`);
      error.statusCode = 503; // problème de configuration du serveur, pas de l'abonnement
      error.body = await response.text().catch(() => '');
      throw error;
    }
    const { access_token: token, expires_in: expiresIn = 3600 } = await response.json();
    cached = { token, expiresAt: now() + expiresIn * 1000 };
    return token;
  }

  return async (token, payload) => {
    const response = await fetchImpl(`${apiBase}/v1/projects/${projectId}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          // Message « data » : l'app construit elle-même la notification (canal, clic), même tuée.
          data: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])),
          // Priorité haute : le message traverse Doze, comme un message WhatsApp.
          android: { priority: 'HIGH', ttl: '3600s' },
        },
      }),
    });
    if (response.ok) return { statusCode: response.status };
    const body = await response.text().catch(() => '');
    if (response.status === 401) cached = null;
    const error = new Error(`FCM : ${response.status}`);
    // Jeton désinstallé (UNREGISTERED, 404) ou invalide : comme un abonnement Web Push expiré (404/410).
    const gone = response.status === 404 || /UNREGISTERED|registration token is not a valid/i.test(body);
    error.statusCode = gone ? 404 : response.status;
    error.body = body;
    throw error;
  };
}
