import { promotionLabel } from '../src/promotion.js';
import { getQueueNamespace } from './firebase-guard.js';
import { getPostgresStore } from './postgres-store.js';

const cache = new WeakMap();
const CACHE_MS = 10_000;
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const rank = (row) => Number.isFinite(Number(row.queueOrder ?? row.timestamp)) ? Number(row.queueOrder ?? row.timestamp) : 0;
const compare = (a, b) => rank(a) - rank(b) || (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0) || a.id.localeCompare(b.id);

export function projectPublicQueue(documents, namespace, updatedAt = Date.now()) {
  const prefix = `artifacts/${namespace}/public/data/queue_videos/`;
  const rows = Object.entries(documents).flatMap(([path, row]) => {
    if (!path.startsWith(prefix) || !path.slice(prefix.length) || path.slice(prefix.length).includes('/') || row?.channelRoom !== '2o3a' || !['queue', 'playing'].includes(row.status)) return [];
    return [{ ...row, id: path.slice(prefix.length) }];
  });
  const project = (row, position) => ({
    promotionLabel: promotionLabel(row), position, id: row.id, title: text(row.title, 1000),
    url: /^https?:\/\//i.test(text(row.url, 4096)) ? text(row.url, 4096) : '',
    platform: text(row.platform, 40),
    durationSec: Number.isFinite(Number(row.durationSec)) && Number(row.durationSec) > 0 ? Number(row.durationSec) : null,
    requestedBy: text(row.requestedBy, 100)
  });
  const playing = rows.filter(row => row.status === 'playing').sort(compare)[0];
  return { queue: rows.filter(row => row.status === 'queue').sort(compare).map((row, index) => project(row, index + 1)),
    playing: playing ? project(playing, 0) : null, updatedAt };
}

export async function handlePublicQueue(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const namespace = dependencies.namespace || getQueueNamespace();
    const db = dependencies.db || await getPostgresStore(namespace);
    const now = (dependencies.now || Date.now)();
    let entry = cache.get(db);
    if (!entry || entry.namespace !== namespace || now - entry.at >= CACHE_MS) {
      const state = await db.readState({ collections: [`artifacts/${namespace}/public/data/queue_videos`] });
      entry = { at: now, namespace, body: projectPublicQueue(state.documents, namespace, now) };
      cache.set(db, entry);
    }
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10');
    return res.status(200).json(entry.body);
  } catch {
    return res.status(503).json({ error: 'The queue is temporarily unavailable. Please try again.' });
  }
}
