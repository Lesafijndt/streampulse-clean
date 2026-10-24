// All administrative queue writes must use exactly the same Firebase project
// as the deployed Vite client. The human Google account logged into the browser
// is irrelevant: Firebase Auth credentials + project ID determine access.
export const EXPECTED_FIREBASE_PROJECT = 'streampulse-cloud-5fdbd';

export function decodeServiceAccount(raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  if (!raw) throw Object.assign(new Error('Firebase service account missing'), { code: 'firebase_admin_missing' });
  let key;
  try { key = JSON.parse(raw); }
  catch {
    try { key = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { throw Object.assign(new Error('Firebase service account format invalid'), { code: 'firebase_admin_invalid' }); }
  }
  const webProject = String(process.env.VITE_FIREBASE_PROJECT_ID || '');
  if (webProject !== EXPECTED_FIREBASE_PROJECT ||
      key?.project_id !== EXPECTED_FIREBASE_PROJECT) {
    console.error('Firebase project mismatch: refusing administrative queue access', {
      configuredWebProjectMatches: webProject === EXPECTED_FIREBASE_PROJECT,
      configuredAdminProjectMatches: key?.project_id === EXPECTED_FIREBASE_PROJECT,
    });
    throw Object.assign(new Error('Firebase web and admin projects must match'), { code: 'firebase_project_mismatch' });
  }
  if (!key.client_email || !key.private_key) {
    throw Object.assign(new Error('Firebase Admin credential incomplete'), { code: 'firebase_admin_invalid' });
  }
  return { ...key, private_key: String(key.private_key).replace(/\\n/g, '\n') };
}

export async function getVerifiedFirestore() {
  const serviceAccount = decodeServiceAccount();
  const [{ cert, getApps, initializeApp }, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'), import('firebase-admin/firestore'),
  ]);
  const appName = 'streampulse-verified-queue';
  const app = getApps().find(item => item.name === appName) ||
    initializeApp({
      credential: cert(serviceAccount),
      projectId: EXPECTED_FIREBASE_PROJECT,
    }, appName);
  const db = getFirestore(app);
  // Any Firestore error propagates to the webhook so Twitch can retry.
  return db;
}

export function getQueueNamespace() {
  const namespace = process.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck';
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(namespace)) {
    throw Object.assign(new Error('Invalid Firestore namespace'), { code: 'firebase_namespace_invalid' });
  }
  return namespace;
}
