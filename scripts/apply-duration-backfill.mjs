import { readFile } from 'node:fs/promises';
import { getPostgresStore } from '../server/postgres-store.js';
import { getQueueNamespace } from '../server/firebase-guard.js';
import { buildMediaMetadataPatch } from '../src/mediaMetadata.js';
const seed = JSON.parse(await readFile(new URL('./duration-backfill-seed.json', import.meta.url), 'utf8'));
if (Date.now() - seed.collectedAt > 86400000 || seed.collectedAt > Date.now() + 60000) throw Error('Duration evidence is expired');
const namespace = getQueueNamespace(), db = await getPostgresStore(namespace), prefix = `artifacts/${namespace}/public/data/queue_videos/`;
let applied = 0;
for (const entry of seed.entries) {
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(entry.id)) throw Error('Invalid media ID');
  const changed = await db.runTransaction(async tx => {
    const ref = db.doc(prefix + entry.id), current = (await tx.get(ref)).data();
    if (!current || current.channelRoom !== '2o3a' || current.url !== entry.url) return;
    const patch = buildMediaMetadataPatch(current, current, entry);
    if (Object.keys(patch).length) { tx.update(ref, patch); return true; }
  });
  if (changed) applied++;
}
const state = await db.readState({ collections: [prefix.slice(0, -1)] });
const rows = Object.values(state.documents).filter(row => row.channelRoom === '2o3a' && row.status === 'queue');
const damagedRows = Object.entries(state.documents).filter(([path, row]) => path.startsWith(prefix) && (!row.channelRoom || !row.status || !row.url)).length;
console.log(JSON.stringify({ check: 'duration_backfill_applied', evidence: seed.entries.length, applied, waiting: rows.length,
  known: rows.filter(row => Number(row.durationSec) > 0).length, missing: rows.filter(row => !(Number(row.durationSec) > 0)).length,
  damagedRows, preservedQueueAndPlayback: true }));
