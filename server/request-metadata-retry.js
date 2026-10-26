import { lookupCachedQueueMetadata, metadataCachePath, sanitizeCachedMetadata } from './cached-media-metadata.js';
import { parseMediaUrl, getMediaIdentityKey, getStableMediaDocumentId } from '../src/mediaUtils.js';
import { getQueueNamespace } from './firebase-guard.js';
import { buildMediaMetadataPatch } from '../src/mediaMetadata.js';
import { isValidMediaDuration } from '../src/durationLookup.js';

export async function enrichRequestedMedia(db, lookups) {
  let nextAt = Infinity;
  const prefix = `artifacts/${getQueueNamespace()}/public/data/queue_videos/`;
  for (const [url, cached] of lookups) {
    const media = parseMediaUrl(url), id = getStableMediaDocumentId('2o3a|' + getMediaIdentityKey(media.platform, media.videoId, url));
    const outcome = await db.runTransaction(async tx => {
      const ref = db.doc(prefix + id), row = (await tx.get(ref)).data();
      if (!row || row.channelRoom !== '2o3a' || getMediaIdentityKey(row.platform,row.videoId,row.url) !== getMediaIdentityKey(media.platform,media.videoId,url)) return false;
      const patch = buildMediaMetadataPatch(row, row, cached.metadata);
      if (Object.keys(patch).length) tx.update(ref, patch);
      const seconds = patch.durationSec || row.durationSec;
      if (isValidMediaDuration(seconds) && ['metadata','player'].includes(patch.durationSource || row.durationSource)) {
        if (!cached.complete) tx.set(db.doc(metadataCachePath(url)), { ...cached, complete: true,
          metadata: sanitizeCachedMetadata({ ...cached.metadata, durationSec: seconds, durationProvider: patch.durationProvider || row.durationProvider || row.platform + '-player' }),
          expiresAt: Date.now() + 7 * 86400000, updatedAt: Date.now() });
        return false;
      }
      return !cached.complete && cached.attempts < 6;
    });
    if (outcome) nextAt = Math.min(nextAt, cached.nextAt);
  }
  if (Number.isFinite(nextAt)) throw Object.assign(Error('metadata_retry_pending'), { code: 'metadata_retry_pending', afterSeconds: Math.max(30, Math.ceil((nextAt - Date.now()) / 1000)) });
}

export function createRequestMetadataLookup(db, lookups, lookup) {
  return async url => {
    const cached = await lookupCachedQueueMetadata(db, url, lookup ? { lookup } : {});
    lookups.set(url, cached);
    return cached.metadata;
  };
}
