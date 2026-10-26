import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getPlaybackGeneration } from '../src/playerBridge.js';

const FIELDS = ['queueOrder', 'pinned', 'status', 'playedAt'];
export const RECOVERY_LIMIT = 12;
export function buildQueueRecovery(documents, operations, prefix, { actor = 'system', action, now = Date.now() } = {}) {
  const entries = [];
  for (const op of operations) {
    if (!op.path.startsWith(prefix + 'queue_videos/')) continue;
    const before = documents[op.path];
    if (!before?.url || before.channelRoom !== '2o3a') continue;
    if (op.type === 'delete') { entries.push({ id: op.path.split('/').at(-1), before, after: null }); continue; }
    const after = op.type === 'set' && !op.merge ? op.data : { ...before, ...op.data };
    if (!after?.url || after.channelRoom !== '2o3a') continue;
    const keys = FIELDS.filter(key => !isDeepStrictEqual(before[key], after[key]));
    const interesting = keys.includes('queueOrder') || keys.includes('pinned') || keys.includes('status') && after.status === 'watch_later';
    if (interesting) entries.push({ id: op.path.split('/').at(-1), before, after, keys });
  }
  if (!entries.length) return [];
  const id = 'recovery-' + now + '-' + randomUUID();
  const record = { id, at: now, actor, action: action || (entries.some(entry => entry.after === null) ? 'Remove requests' : 'Change queue order'), entries, affected: entries.length };
  if (JSON.stringify(record).length > 1_000_000) throw Object.assign(Error('recovery_snapshot_too_large'), { code: 'recovery_snapshot_too_large', status: 400 });
  const result = [{ type: 'create', path: prefix + 'queue_recovery/' + id, data: record },
    { type: 'create', path: prefix + 'queue_actions/' + id, data: { id, at: now, actor, action: record.action, affected: entries.length } }];
  for (const [collection, limit] of [['queue_recovery', RECOVERY_LIMIT], ['queue_actions', 100]]) {
    const older = Object.entries(documents).filter(([path]) => path.startsWith(prefix + collection + '/')).sort((a, b) => b[1].at - a[1].at);
    for (const [path] of older.slice(limit - 1)) result.push({ type: 'delete', path });
  }
  return result;
}

export async function recordQueueRecovery(tx, db, prefix, operations, before, options) {
  // Metadata, arrivals, and ordinary playback transitions do not create snapshots.
  if (!buildQueueRecovery(before, operations, prefix, options).length) return;
  const records = await Promise.all(['queue_recovery', 'queue_actions'].map(name => tx.get(db.collection(prefix + name))));
  const documents = { ...before };
  records.forEach((snapshot, index) => snapshot.docs.forEach(doc => { documents[prefix + ['queue_recovery', 'queue_actions'][index] + '/' + doc.id] = doc.data(); }));
  for (const op of buildQueueRecovery(documents, operations, prefix, options)) {
    if (op.type === 'delete') tx.delete(db.doc(op.path)); else tx.create(db.doc(op.path), op.data);
  }
}

export async function undoQueueRecovery(db, prefix, id, actor) {
  return db.runTransaction(async tx => {
    const ref = db.doc(prefix + 'queue_recovery/' + id), snapshot = (await tx.get(ref)).data();
    if (!snapshot || snapshot.restoredAt) return { restored: 0, skipped: 0 };
    const refs = snapshot.entries.map(entry => db.doc(prefix + 'queue_videos/' + entry.id));
    const current = await Promise.all(refs.map(ref => tx.get(ref)));
    const actions = await tx.get(db.collection(prefix + 'queue_actions'));
    let restored = 0, skipped = 0;
    snapshot.entries.forEach((entry, index) => {
      const row = current[index].data();
      if (entry.after === null) {
        if (current[index].exists) { skipped++; return; }
        const value = { ...entry.before };
        if (value.status === 'playing') Object.assign(value, { status: 'queue', playedAt: 0, queueOrder: Date.now() });
        tx.create(refs[index], value); restored++; return;
      }
      if (!row || row.channelRoom !== '2o3a' || row.status === 'playing' || row.status !== entry.after.status || row.url !== entry.after.url || getPlaybackGeneration(row) !== getPlaybackGeneration(entry.after) ||
          entry.keys.some(key => !isDeepStrictEqual(row[key], entry.after[key]))) { skipped++; return; }
      const patch = Object.fromEntries(entry.keys.map(key => [key, entry.before[key] ?? (key === 'queueOrder' ? Number(entry.before.timestamp || 0) : key === 'pinned' ? false : 0)]));
      if (patch.status === 'playing') patch.status = 'queue';
      tx.update(refs[index], patch); restored++;
    });
    tx.update(ref, { restoredAt: Date.now(), restoredBy: actor, restored, skipped });
    const actionId = 'undo-' + id;
    tx.create(db.doc(prefix + 'queue_actions/' + actionId), { id: actionId, at: Date.now(), actor, action: 'Undo ' + snapshot.action, affected: restored });
    actions.docs.sort((a,b) => b.data().at-a.data().at).slice(99).forEach(doc => tx.delete(doc.ref));
    return { restored, skipped };
  });
}
