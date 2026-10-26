import { getPostgresStore } from '../server/postgres-store.js';
import { getQueueNamespace } from '../server/firebase-guard.js';
import { getDurationEstimate } from '../src/queueLogic.js';
const namespace = getQueueNamespace(), db = await getPostgresStore(namespace), prefix = `artifacts/${namespace}/public/data/queue_videos/`;
const state = await db.readState({ collections: [prefix.slice(0, -1)] });
const entries = Object.entries(state.documents).filter(([path]) => path.startsWith(prefix));
const damaged = entries.filter(([,row]) => !row.channelRoom || !row.status || !row.url);
const waiting = entries.filter(([,row]) => row.channelRoom === '2o3a' && row.status === 'queue');
console.log(JSON.stringify({ check: 'queue_integrity', total: entries.length, waiting: entries.filter(([,row]) => row.status === 'queue').length,
  known: waiting.filter(([,row]) => !getDurationEstimate(row).estimated).length, estimated: waiting.filter(([,row]) => getDurationEstimate(row).estimated).length,
  damaged: damaged.length, damagedIds: damaged.map(([path, row]) => ({ id: path.split('/').at(-1), fields: Object.keys(row) })) }));
