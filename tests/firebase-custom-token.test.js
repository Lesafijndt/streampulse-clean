import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createFirebaseCustomToken, loadFirebaseServiceAccount } from '../api/_lib/firebase-custom-token.js';

function makeServiceAccount() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    serviceAccount: {
      project_id: 'test-project',
      client_email: 'firebase-admin@test-project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

test('Firebase custom tokens have the expected claims and a verifiable RS256 signature', () => {
  const { serviceAccount, publicKey } = makeServiceAccount();
  const now = Date.parse('2026-10-23T00:00:00.000Z');
  const token = createFirebaseCustomToken('twitch_12345', { yediAuthorized: true, twitchLogin: '2o3a', role: 'streamer' }, serviceAccount, now);
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  assert.ok(encodedHeader && encodedPayload && encodedSignature);
  const signingInput = encodedHeader + '.' + encodedPayload;
  assert.equal(verify('RSA-SHA256', Buffer.from(signingInput), publicKey, Buffer.from(encodedSignature, 'base64url')), true);
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(payload.uid, 'twitch_12345');
  assert.equal(payload.iss, serviceAccount.client_email);
  assert.equal(payload.sub, serviceAccount.client_email);
  assert.equal(payload.aud, 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit');
  assert.equal(payload.iat, Math.floor(now / 1000));
  assert.equal(payload.exp, Math.floor(now / 1000) + 3600);
  assert.deepEqual(payload.claims, { yediAuthorized: true, twitchLogin: '2o3a', role: 'streamer' });
});

test('Firebase service-account configuration failures are reported safely', () => {
  assert.throws(() => loadFirebaseServiceAccount(''), /not configured/);
  assert.throws(() => loadFirebaseServiceAccount('{bad'), /not valid JSON/);
  assert.throws(() => createFirebaseCustomToken('', {}, { client_email: 'firebase-admin@test-project.iam.gserviceaccount.com', private_key: 'not a private key' }), /UID must be/);
});