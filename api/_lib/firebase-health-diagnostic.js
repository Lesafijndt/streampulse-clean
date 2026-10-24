export function classifyFirebaseHealthError(error) {
  const message = String(error?.message || '');
  const code = String(error?.code || '').toLowerCase();
  if (/FIREBASE_SERVICE_ACCOUNT_JSON is not configured/i.test(message)) {
    return { code: 'missing_service_account', message: 'The Firebase Admin service-account environment variable is not configured.' };
  }
  if (/not valid JSON or base64 JSON|must be a JSON object/i.test(message)) {
    return { code: 'invalid_service_account_json', message: 'The Firebase Admin service-account JSON is invalid.' };
  }
  if (/does not match VITE_FIREBASE_PROJECT_ID/i.test(message)) {
    return { code: 'service_account_project_mismatch', message: 'The Firebase Admin service account and web app point to different Firebase projects.' };
  }
  if (/ERR_REQUIRE_ESM|require\(\) of ES Module/i.test(message) || code === 'err_require_esm') {
    return { code: 'err_require_esm', message: 'The deployed Firebase Admin module loader is incompatible. The server function needs a clean rebuild.' };
  }
  if (/ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module|firebase-admin.*(?:load|import)/i.test(message)) {
    return { code: 'firebase_admin_sdk_unavailable', message: 'The Firebase Admin SDK could not be loaded by the server function.' };
  }
  if (/PERMISSION_DENIED|permission denied|insufficient permissions|not authorized|\b403\b/i.test(message) ||
      code === 'permission-denied' || code === '7') {
    return { code: 'firestore_permission_denied', message: 'Firestore denied access. Check the service account and the target Firebase project.' };
  }
  if (/RESOURCE_EXHAUSTED|resource[- ]exhausted|quota|rate limit/i.test(message) ||
      code === 'resource-exhausted' || code === '8') {
    return {
      code: 'firestore_quota_exceeded',
      message: 'Firestore returned RESOURCE_EXHAUSTED. This can mean a daily project quota or regional capacity limit; check Firebase Console → Firestore → Usage and Cloud Firestore API quotas.',
    };
  }
  if (/UNAVAILABLE|ECONNRESET|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|deadline exceeded|timed? ?out|network/i.test(message) ||
      code === 'unavailable' || code === '14') {
    return { code: 'firestore_unreachable', message: 'The Firestore health check could not reach Firebase. Check service availability and network errors.' };
  }
  if (/private.?key|PEM|invalid_grant|invalid credentials/i.test(message)) {
    return { code: 'invalid_service_account_credentials', message: 'The Firebase service-account credentials could not be used to authenticate.' };
  }
  if (/FAILED_PRECONDITION|failed.?precondition|missing (?:composite )?index/i.test(message) || code === '9' || code === 'failed-precondition') {
    return { code: 'firestore_failed_precondition', message: 'Firestore rejected a queue precondition or requires an index. Check server logs for the underlying operation.' };
  }
  if (/INVALID_ARGUMENT|invalid argument|must not contain undefined/i.test(message) || code === '3' || code === 'invalid-argument') {
    return { code: 'firestore_invalid_argument', message: 'The queue request contains a value Firestore cannot store. This is a backend data-validation issue.' };
  }
  if (/ABORTED|transaction aborted/i.test(message) || code === '10' || code === 'aborted') {
    return { code: 'firestore_transaction_contention', message: 'Concurrent queue changes aborted the transaction. Retry the request.' };
  }
  if (/INTERNAL|internal error/i.test(message) || code === '13' || code === 'internal') {
    return { code: 'firestore_server_internal', message: 'The Firestore backend returned an internal error.' };
  }
  // Do not send raw backend exception text, which could include project paths or environment details.
  const safeCode = code.replace(/[^a-z0-9_/-]/g, '').slice(0, 48);
  return {
    code: safeCode || 'firestore_health_check_failed',
    message: 'Firestore health check failed. Check the Firebase Admin credentials, project configuration, and Firestore availability.'
  };
}
