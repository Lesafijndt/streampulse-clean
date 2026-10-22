import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let cachedDb = null;

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
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
      throw new Error(`Firebase service account is missing the '${field}' field`);
    }
  }

  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  const webProjectId = String(process.env.VITE_FIREBASE_PROJECT_ID || '').trim();
  if (webProjectId && webProjectId !== serviceAccount.project_id) {
    throw new Error('Firebase service account project_id does not match VITE_FIREBASE_PROJECT_ID');
  }
  return serviceAccount;
}

export function getFirebaseAdminApp() {
  const serviceAccount = loadServiceAccount();
  const appName = 'yedi-hub-firebase-admin';
  return getApps().find((app) => app.name === appName) || initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.project_id,
  }, appName);
}

export function getFirebaseAdminDb() {
  if (!cachedDb) cachedDb = getFirestore(getFirebaseAdminApp());
  return cachedDb;
}

export function getFirebaseNamespace() {
  return String(process.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck').trim() || 'streampulse-live-deck';
}
