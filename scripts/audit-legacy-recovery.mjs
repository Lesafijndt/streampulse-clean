import { initializeApp, cert, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { decodeServiceAccount, getQueueNamespace } from '../server/firebase-guard.js';
import { getPostgresStore } from '../server/postgres-store.js';
const namespace = getQueueNamespace(), prefix = `artifacts/${namespace}/public/data/`, db = await getPostgresStore(namespace);
const state = await db.readState({ collections: [prefix + 'queue_videos', prefix + 'queue_events'] });
const damaged = Object.entries(state.documents).filter(([path, row]) => path.startsWith(prefix + 'queue_videos/') && Object.keys(row).length === 0);
for (const [path] of damaged) {
  const id = path.split('/').at(-1), events = Object.entries(state.documents).filter(([key, row]) => key.startsWith(prefix + 'queue_events/') && row.mediaId === id).map(([,row]) => row);
  console.log(JSON.stringify({ check: 'unmatched_queue_record', id, events: events.sort((a, b) => b.at - a.at).slice(0, 4).map(event => ({ type: event.type, title: event.title, platform: event.platform })) }));
}
let app, legacy, timer;
try {
  app = initializeApp({ credential: cert(decodeServiceAccount()) }, 'read-only-queue-recovery'); legacy = getFirestore(app);
  const records = damaged.length ? await Promise.race([legacy.getAll(...damaged.map(([path]) => legacy.doc(path))),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('legacy_read_timeout')), 10000); })]) : [];
  console.log(JSON.stringify({ check: 'legacy_recovery_audit', requested: damaged.length, found: records.filter(doc => doc.exists && doc.data()?.url).length }));
  for (const doc of records) if (doc.exists && doc.data()?.url) {
    const row = doc.data(); console.log(JSON.stringify({ check: 'legacy_recovery_candidate', id: doc.id, url: row.url, title: row.title,
      timestamp: row.timestamp, status: row.status, channelRoom: row.channelRoom }));
  }
} catch (error) { console.log(JSON.stringify({ check: 'legacy_recovery_unavailable', code: String(error.code || 'read_failed') })); }
finally { clearTimeout(timer); if (legacy) await legacy.terminate(); if (app) await deleteApp(app); }
