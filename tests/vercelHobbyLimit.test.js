import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

test('Hobby production deployment never exceeds twelve serverless API entrypoints', () => {
  const root = fileURLToPath(new URL('../api/', import.meta.url));
  function countFiles(folder) {
    return readdirSync(folder).reduce((n, name) => {
      const full = join(folder, name);
      if (statSync(full).isDirectory()) return n + countFiles(full);
      return n + (name.endsWith('.js') ? 1 : 0);
    }, 0);
  }
  const count = countFiles(root);
  assert.ok(count <= 12, 'Vercel Hobby permits 12 functions, found ' + count);
});
