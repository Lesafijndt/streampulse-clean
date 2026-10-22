import { createSign } from 'node:crypto';

const FIREBASE_CUSTOM_TOKEN_AUDIENCE =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

export function loadFirebaseServiceAccount(raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    try {
      serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON or base64 JSON');
    }
  }
  if (!serviceAccount || typeof serviceAccount !== 'object' || Array.isArray(serviceAccount)) {
    throw new Error('Firebase service account must be a JSON object');
  }
  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (typeof serviceAccount[field] !== 'string' || !serviceAccount[field].trim()) {
      throw new Error("Firebase service account is missing the '" + field + "' field");
    }
  }
  const normalized = { ...serviceAccount, private_key: serviceAccount.private_key.replace(/\\n/g, '\n') };
  const webProjectId = String(process.env.VITE_FIREBASE_PROJECT_ID || '').trim();
  if (webProjectId && webProjectId !== normalized.project_id) {
    throw new Error('Firebase service account project_id does not match VITE_FIREBASE_PROJECT_ID');
  }
  return normalized;
}

/**
 * Signs a Firebase custom auth token directly with the service-account RSA key.
 * This avoids loading firebase-admin/auth in the login endpoint, where that import
 * path was failing in the deployed serverless bundle with ERR_REQUIRE_ESM.
 */
export function createFirebaseCustomToken(uid, claims = {}, serviceAccount = loadFirebaseServiceAccount(), now = Date.now()) {
  const userId = String(uid || '').trim();
  if (!userId || userId.length > 128) throw new Error('Firebase custom token UID must be 1-128 characters');
  if (!serviceAccount || typeof serviceAccount.client_email !== 'string' || !serviceAccount.client_email.trim() ||
      typeof serviceAccount.private_key !== 'string' || !serviceAccount.private_key.trim()) {
    throw new Error('Firebase service account is missing token-signing credentials');
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('Firebase custom claims must be an object');
  const issuedAt = Math.floor(Number(now) / 1000);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) throw new Error('Firebase custom token issue time is invalid');
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: FIREBASE_CUSTOM_TOKEN_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + 3600,
    uid: userId,
    claims,
  })).toString('base64url');
  const unsigned = header + '.' + payload;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const privateKey = serviceAccount.private_key.replace(/\\n/g, '\n');
  return unsigned + '.' + signer.sign(privateKey).toString('base64url');
}