import { createHash } from 'node:crypto';
import { getQueueNamespace } from './firebase-guard.js';
import { lookupQueueMetadata } from './queue-metadata.js';
import { parseMediaUrl, getMediaIdentityKey } from '../src/mediaUtils.js';
import { isValidMediaDuration } from '../src/durationLookup.js';
export const METADATA_RETRY_DELAYS = [60, 300, 1800, 7200, 21600, 43200];
const lastPruned = new WeakMap();
export function metadataCachePath(url, namespace = getQueueNamespace()) {
  const parsed = parseMediaUrl(url), identity = getMediaIdentityKey(parsed.platform, parsed.videoId, url);
  return `artifacts/${namespace}/public/data/media_metadata/` + createHash('sha256').update(identity).digest('hex');
}
export function sanitizeCachedMetadata(value = {}) {
  return { title: typeof value.title === 'string' ? value.title.slice(0, 400) : '',
    thumbnailUrl: typeof value.thumbnailUrl === 'string' && /^https:\/\//.test(value.thumbnailUrl) ? value.thumbnailUrl.slice(0, 4096) : '',
    durationSec: isValidMediaDuration(value.durationSec) ? Math.round(Number(value.durationSec)) : null,
    durationProvider: String(value.durationProvider || '').slice(0, 80) };
}
export async function lookupCachedQueueMetadata(db, url, { lookup = lookupQueueMetadata, now = Date.now(), namespace } = {}) {
  const ref = db.doc(metadataCachePath(url, namespace)), saved = (await ref.get()).data();
  if (saved && (saved.complete && saved.expiresAt > now || !saved.complete && saved.nextAt > now)) return saved;
  const metadata = sanitizeCachedMetadata(await lookup(url) || {}), attempts = Number(saved?.expiresAt > now ? saved.attempts || 0 : 0) + 1;
  metadata.title ||= saved?.metadata?.title || '';
  metadata.thumbnailUrl ||= saved?.metadata?.thumbnailUrl || '';
  const complete = isValidMediaDuration(metadata.durationSec);
  const entry = { metadata, complete, attempts, nextAt: now + METADATA_RETRY_DELAYS[Math.min(attempts - 1, METADATA_RETRY_DELAYS.length - 1)] * 1000,
    expiresAt: now + 7 * 86400000, updatedAt: now };
  await ref.set(entry);
  if (!lastPruned.has(db) || now - lastPruned.get(db) >= 3600000) {
    lastPruned.set(db, now);
    try {
      const collection = db.collection(ref.path.slice(0, ref.path.lastIndexOf('/')));
      await db.runTransaction(async tx => {
        const expired = await tx.get(collection.where('expiresAt', '<=', now).limit(50));
        expired.docs.forEach(doc => tx.delete(doc.ref));
      });
    } catch { /* Cache maintenance must not prevent accepting a request. */ }
  }
  return entry;
}
