import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFirebaseHealthError } from '../api/_lib/firebase-health-diagnostic.js';

test('Firebase health diagnostics classify ESM loader errors without exposing raw details', () => {
  const result = classifyFirebaseHealthError(Object.assign(new Error('require() of ES Module /sensitive/internal/path/index.js'), { code: 'ERR_REQUIRE_ESM' }));
  assert.equal(result.code, 'err_require_esm');
  assert.match(result.message, /module loader/i);
  assert.equal(result.message.includes('/sensitive/internal/path'), false);
});

test('Firebase health diagnostics identify service account configuration failures', () => {
  assert.equal(classifyFirebaseHealthError(new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured')).code, 'missing_service_account');
  assert.equal(classifyFirebaseHealthError(new Error('Firebase service account project_id does not match VITE_FIREBASE_PROJECT_ID')).code, 'service_account_project_mismatch');
  assert.equal(classifyFirebaseHealthError(new Error('Firebase service account is not valid JSON or base64 JSON')).code, 'invalid_service_account_json');
});

test('Firebase health diagnostics distinguish Firestore permission, quota, and availability failures', () => {
  assert.equal(classifyFirebaseHealthError(new Error('PERMISSION_DENIED: permission denied')).code, 'firestore_permission_denied');
  assert.equal(classifyFirebaseHealthError(new Error('RESOURCE_EXHAUSTED: quota exceeded')).code, 'firestore_quota_exceeded');
  assert.equal(classifyFirebaseHealthError(Object.assign(new Error('Request failed'), { code: 'resource-exhausted' })).code, 'firestore_quota_exceeded');
  assert.equal(classifyFirebaseHealthError(new Error('UNAVAILABLE: deadline exceeded')).code, 'firestore_unreachable');
});

test('unknown Firebase health errors do not leak server exception text', () => {
  const result = classifyFirebaseHealthError(new Error('secret-ish internal failure from resource /a/b'));
  assert.equal(result.code, 'firestore_health_check_failed');
  assert.doesNotMatch(result.message, /secret-ish|\/a\/b/);
});

test('transaction invalid arguments and preconditions are not misreported as unknown health failures', () => {
  assert.equal(classifyFirebaseHealthError({ code: 9, message: 'FAILED_PRECONDITION' }).code, 'firestore_failed_precondition');
  assert.equal(classifyFirebaseHealthError({ code: 3, message: 'INVALID_ARGUMENT' }).code, 'firestore_invalid_argument');
  assert.equal(classifyFirebaseHealthError({ code: 10, message: 'ABORTED' }).code, 'firestore_transaction_contention');
});
