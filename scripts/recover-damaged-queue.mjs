import { getPostgresStore } from '../server/postgres-store.js';
import { getQueueNamespace } from '../server/firebase-guard.js';
import { makeQueueItems } from '../server/webhook-queue.js';
import { getMediaIdentityKey, getStableMediaDocumentId } from '../src/mediaUtils.js';
const namespace = getQueueNamespace(), db = await getPostgresStore(namespace), prefix = `artifacts/${namespace}/public/data/`;
const state = await db.readState({ collections: [prefix + 'queue_videos', prefix + 'queue_events'] });
const damaged = Object.entries(state.documents).filter(([path, row]) => path.startsWith(prefix + 'queue_videos/') && Object.keys(row).length === 0);
const events = Object.entries(state.documents).filter(([path]) => path.startsWith(prefix + 'queue_events/')).map(([,row]) => row);
const apply = process.argv.includes('--apply'), candidates = [], unmatched = [];
// Three URLs recorded in the public queue audit before the corruption.
const observedIds = ['XcKtI0Mxzv4', 'VAw_LbbUmQ0', 'cEw-P9Sahq8'];
for (const [path] of damaged) {
  const id = path.split('/').at(-1), history = events.filter(event => event.mediaId === id).sort((a, b) => b.at - a.at);
  const ids = new Set(observedIds);
  for (const event of history) for (const match of String(event.title || '').matchAll(/(?:Media|Video|Clip)\s*\(([\w-]{11})\)|(?:v=|youtu\.be\/)([\w-]{11})/gi)) ids.add(match[1] || match[2]);
  const videoId = [...ids].find(candidate => getStableMediaDocumentId('2o3a|' + getMediaIdentityKey('youtube', candidate, 'https://youtu.be/' + candidate)) === id);
  const request = history.find(event => event.type === 'request_added');
  if (!videoId || !request || history[0]?.type === 'request_removed') {
    unmatched.push({ id, events: history.slice(0, 3).map(event => ({ type: event.type, title: event.title, platform: event.platform })) }); continue;
  }
  const outcome = await makeQueueItems({ broadcaster_user_login: '2o3a', chatter_user_login: request.requester || request.actor,
    message: { text: 'https://www.youtube.com/watch?v=' + videoId } });
  const row = outcome.items[0];
  if (!row || row.id !== id) { unmatched.push({ id, reason: 'identity_or_requester_unavailable' }); continue; }
  const laterPlayback = history.find(event => event.at >= request.at && ['playback_completed', 'track_skipped', 'play_started'].includes(event.type));
  Object.assign(row, { timestamp: request.at, createdAt: request.at, addedAt: new Date(request.at).toISOString(), queueOrder: request.at,
    status: laterPlayback ? 'watched' : 'queue', title: history.find(event => event.title && !/YouTube Media \(/i.test(event.title))?.title || row.title,
    recoverySource: 'verified-media-identity-and-activity', recoveredAt: Date.now() });
  candidates.push({ id, status: row.status });
  if (apply) await db.runTransaction(async tx => {
    const ref = db.doc(path), current = (await tx.get(ref)).data();
    if (current && Object.keys(current).length === 0) tx.set(ref, row);
  });
}
console.log(JSON.stringify({ check: 'damaged_queue_recovery', apply, damaged: damaged.length, matched: candidates.length,
  candidates, unmatched, livePlayerUntouched: true }));
