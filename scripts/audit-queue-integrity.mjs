import { getPostgresStore } from '../server/postgres-store.js';
import { getQueueNamespace } from '../server/firebase-guard.js';
const namespace = getQueueNamespace(), db = await getPostgresStore(namespace), prefix = `artifacts/${namespace}/public/data/queue_videos/`;
const state = await db.readState({ collections: [prefix.slice(0, -1)] });
const entries = Object.entries(state.documents).filter(([path]) => path.startsWith(prefix));
const damaged = entries.filter(([,row]) => !row.channelRoom || !row.status || !row.url);
console.log(JSON.stringify({ check: 'queue_integrity', total: entries.length, waiting: entries.filter(([,row]) => row.status === 'queue').length,
  damaged: damaged.length, damagedIds: damaged.map(([path, row]) => ({ id: path.split('/').at(-1), fields: Object.keys(row) })) }));
