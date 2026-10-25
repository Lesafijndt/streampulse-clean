import { getVerifiedFirestore, getQueueNamespace } from '../server/firebase-guard.js';
const db = await getVerifiedFirestore();
const state = await db.readState();
const prefix = `artifacts/${getQueueNamespace()}/public/data/`;
const entries = Object.entries(state.documents);
const videos = entries.filter(([path]) => path.startsWith(prefix + 'queue_videos/')).map(([, value]) => value);
const receipts = entries.filter(([path]) => path.startsWith(prefix + 'twitch_eventsub_receipts/'))
  .map(([, value]) => value).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 5)
  .map(value => ({ sender: value.sender, status: value.status, queued: value.queued, receivedAt: value.receivedAt }));
console.log(JSON.stringify({ check: 'live_queue_state', version: state.version,
  totalRows: videos.length, waiting: videos.filter(row => row.status === 'queue').length,
  playing: videos.filter(row => row.status === 'playing').length,
  importedRows: state.documents[prefix + 'system_diagnostics/legacy-browser-import']?.rows,
  receipts }));
