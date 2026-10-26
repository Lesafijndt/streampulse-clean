import { writeFile } from 'node:fs/promises';
import { lookupQueueMetadata } from '../server/queue-metadata.js';
import { isValidMediaDuration } from '../src/durationLookup.js';
// Public media IDs and lengths only. No credentials, viewers, cookies or titles are exported.
const response = await fetch('https://streampulse-clean.vercel.app/api/twitch/session?action=queue-view');
if (!response.ok) throw Error('Public queue unavailable');
const queue = await response.json(), rows = [...queue.queue, ...(queue.playing ? [queue.playing] : [])];
const candidates = rows.filter(row => !isValidMediaDuration(row.durationSec));
const entries = []; let cursor = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (cursor < candidates.length) {
    const row = candidates[cursor++], metadata = await lookupQueueMetadata(row.url);
    if (isValidMediaDuration(metadata?.durationSec)) entries.push({ id: row.id, url: row.url,
      durationSec: metadata.durationSec, durationProvider: metadata.durationProvider });
  }
}));
await writeFile(new URL('./duration-backfill-seed.json', import.meta.url), JSON.stringify({ collectedAt: Date.now(), entries }, null, 2) + '\n');
console.log(JSON.stringify({ check: 'verified_duration_collection', missing: candidates.length, resolved: entries.length, unresolved: candidates.length - entries.length }));
