import { initializeApp, cert, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { decodeServiceAccount, getQueueNamespace } from '../server/firebase-guard.js';
import { getPostgresStore } from '../server/postgres-store.js';
const namespace = getQueueNamespace(), prefix = `artifacts/${namespace}/public/data/queue_videos/`, db = await getPostgresStore(namespace);
const state = await db.readState({ collections: [prefix.slice(0, -1)] });
const paths = Object.entries(state.documents).filter(([path, row]) => path.startsWith(prefix) && Object.keys(row).length === 0).map(([path]) => path);
let app, legacy, restored = 0;
try {
  app = initializeApp({ credential: cert(decodeServiceAccount()) }, 'legacy-history-recovery'); legacy = getFirestore(app);
  const records = paths.length ? await legacy.getAll(...paths.map(path => legacy.doc(path))) : [];
  for (const source of records) {
    if (!source.exists) continue;
    const row = JSON.parse(JSON.stringify(source.data()));
    if (row.status !== 'watched' || row.channelRoom !== '2o3a' || !/^https:\/\//.test(row.url || '')) continue;
    const changed = await db.runTransaction(async tx => {
      const ref = db.doc(prefix + source.id), current = (await tx.get(ref)).data();
      if (!current || Object.keys(current).length !== 0) return false;
      tx.set(ref, { ...row, id: source.id, recoveredAt: Date.now(), recoverySource: 'legacy-firestore-history' }); return true;
    });
    if (changed) restored++;
  }
  console.log(JSON.stringify({ check: 'legacy_history_restored', restored, livePlayerUntouched: true }));
} finally { if (legacy) await legacy.terminate(); if (app) await deleteApp(app); }
