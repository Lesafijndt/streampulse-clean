import { getPostgresStore } from '../server/postgres-store.js';
import { getQueueNamespace } from '../server/firebase-guard.js';
import { lookupQueueMetadata } from '../server/queue-metadata.js';
import { buildMediaMetadataPatch, videoNeedsMetadataLookup } from '../src/mediaMetadata.js';

// Metadata only: re-read inside each transaction so playing, skips, new requests and custom titles survive.
const namespace = getQueueNamespace(), db = await getPostgresStore(namespace);
const prefix = `artifacts/${namespace}/public/data/queue_videos/`;
const state = await db.readState({ collections: [prefix.slice(0, -1)] });
const candidates = Object.entries(state.documents).filter(([path, row]) => path.startsWith(prefix) &&
  row.channelRoom === '2o3a' && videoNeedsMetadataLookup(row));
candidates.sort((a, b) => Number(!['queue', 'playing'].includes(a[1].status)) - Number(!['queue', 'playing'].includes(b[1].status)));
let cursor = 0, updated = 0, unavailable = 0, stale = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (cursor < candidates.length) {
    const [path, original] = candidates[cursor++];
    const metadata = await lookupQueueMetadata(original.url);
    const applied = await db.runTransaction(async tx => {
      const ref = db.doc(path), current = (await tx.get(ref)).data();
      const patch = buildMediaMetadataPatch(original, current, metadata);
      if (!Object.keys(patch).length) return current ? 'unavailable' : 'stale';
      tx.update(ref, patch); return 'updated';
    });
    if (applied === 'updated') updated++; else if (applied === 'stale') stale++; else unavailable++;
    if ((updated + unavailable + stale) % 20 === 0) console.log(JSON.stringify({ check: 'metadata_backfill_progress', processed: updated + unavailable + stale, total: candidates.length }));
  }
}));
console.log(JSON.stringify({ check: 'metadata_backfill', candidates: candidates.length, updated, unavailable, stale, preservedQueueAndPlayback: true }));
