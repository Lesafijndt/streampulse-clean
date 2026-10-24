import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Firebase Admin signs custom tokens when CommonJS require(ESM) is disabled, as in production', () => {
  const script = `
    import { generateKeyPairSync } from 'node:crypto';
    import { initializeApp, cert } from 'firebase-admin/app';
    import { getAuth } from 'firebase-admin/auth';
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const app = initializeApp({ credential: cert({ projectId: 'runtime-test',
      clientEmail: 'test@runtime-test.iam.gserviceaccount.com',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }) });
    const token = await getAuth(app).createCustomToken('runtime-test-user', { yediAuthorized: true });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    if (payload.uid !== 'runtime-test-user' || payload.claims.yediAuthorized !== true) process.exit(1);
    console.log('signed');
  `;
  const result = spawnSync(process.execPath, ['--no-experimental-require-module', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /signed/);
});
