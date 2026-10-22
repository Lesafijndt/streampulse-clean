import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  getTwitchAuthAction,
  SUPPORTED_TWITCH_AUTH_ACTIONS,
} from '../api/twitch/auth.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(root, '../api');

function listVercelFunctions(directory = apiRoot, relative = '') {
  const entries = readdirSync(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    // Vercel treats underscore-prefixed API directories as private modules, not routes.
    if (entry.name.startsWith('_')) continue;
    const relativePath = path.posix.join(relative, entry.name);
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...listVercelFunctions(fullPath, relativePath));
    } else if (/\.(?:js|mjs|cjs|ts)$/.test(entry.name)) {
      results.push(relativePath);
    }
  }
  return results;
}

test('serverless API count stays within Vercel Hobby limit', () => {
  const functions = listVercelFunctions();
  assert.ok(
    functions.length <= 12,
    `Found ${functions.length} serverless functions; Vercel Hobby allows at most 12. Consolidate API routes before adding more.\n${functions.join('\n')}`
  );
  assert.ok(functions.includes('twitch/auth.js'), 'The shared Twitch auth route must be deployed.');
  for (const oldRoute of [
    'twitch/login.js',
    'twitch/logout.js',
    'twitch/bot-login.js',
    'twitch/bot-logout.js',
  ]) {
    assert.ok(!functions.includes(oldRoute), `${oldRoute} must stay consolidated to avoid spending a function slot.`);
  }
});

test('legacy Twitch auth paths rewrite to the shared handler and preserve action selection', () => {
  const config = JSON.parse(readFileSync(path.resolve(root, '../vercel.json'), 'utf8'));
  const rewrites = new Map((config.rewrites || []).map((rule) => [rule.source, rule.destination]));
  const expected = {
    '/api/twitch/login': '/api/twitch/auth?action=login',
    '/api/twitch/logout': '/api/twitch/auth?action=logout',
    '/api/twitch/bot-login': '/api/twitch/auth?action=bot-login',
    '/api/twitch/bot-logout': '/api/twitch/auth?action=bot-logout',
  };
  for (const [source, destination] of Object.entries(expected)) {
    assert.equal(rewrites.get(source), destination, source);
    const action = destination.split('action=')[1];
    assert.ok(SUPPORTED_TWITCH_AUTH_ACTIONS.includes(action), `No handler is registered for ${action}.`);
    assert.equal(getTwitchAuthAction({ query: { action } }), action);
  }
  assert.equal(getTwitchAuthAction({ query: {} }), '');
  assert.equal(getTwitchAuthAction({ query: { action: ['bot-login', 'unexpected'] } }), 'bot-login');
});
