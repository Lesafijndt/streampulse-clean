import * as legacy from 'firebase/firestore';

export const getFirestore = legacy.getFirestore;
export async function resetPrivateCloud(db, scope) {
  if (!db?.privateCloud) throw new Error('Cloud reset requires an active cloud session');
  // Use the snapshot the user reviewed. Refreshing here could silently include
  // requests arriving after the backup/confirmation in a destructive reset.
  if (!Number.isSafeInteger(db.version) || db.version < 0) throw new Error('Wait for cloud sync before resetting');
  const response = await fetch('/api/twitch/session?action=store', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'reset', scope,
      confirmation: 'RESET', expectedVersion: db.version }), signal: AbortSignal.timeout(20000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) throw new Error(body.code === 'conflict' ? 'Queue changed; review it and confirm reset again.' : body.code || 'Reset could not be saved');
  await refresh(db, true);
  return body;
}
let privateMode = false;
export function createPrivateCloudDb(options = {}) {
  privateMode = true;
  return { privateCloud: true, version: -1, collections: {}, watchers: new Set(), timer: null, inFlight: null,
    legacyVideos: options.legacyVideos || [], importAttempted: false };
}
function cloud(ref) { return ref?.privateCloud ? ref : ref?.cloudDb; }
function reference(kind, first, parts) {
  const db = cloud(first);
  return { cloudDb: db, path: [first.path, ...parts].filter(Boolean).join('/'), kind };
}
export function collection(first, ...parts) { return cloud(first) ? reference('collection', first, parts) : legacy.collection(first, ...parts); }
export function doc(first, ...parts) { return cloud(first) ? reference('doc', first, parts) : legacy.doc(first, ...parts); }
export const increment = value => privateMode ? ({ __op: 'increment', value }) : legacy.increment(value);
export const arrayUnion = (...values) => privateMode ? ({ __op: 'arrayUnion', values }) : legacy.arrayUnion(...values);
function snapshot(ref, data) {
  return { id: ref.path.split('/').at(-1), ref, exists: () => data !== undefined,
    data: () => data === undefined ? undefined : structuredClone(data), get: key => data?.[key],
    metadata: { fromCache: false, hasPendingWrites: false } };
}
function result(ref) {
  const db = cloud(ref); const pieces = ref.path.split('/');
  const name = pieces[4]; const rows = db.collections[name] || [];
  if (ref.kind === 'doc') return snapshot(ref, rows.find(row => row.id === pieces[5])?.data);
  const docs = rows.map(row => snapshot(doc(ref, row.id), row.data));
  return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
}
function validatedCollections(body, db) {
  const validData = data => data && typeof data === 'object' && !Array.isArray(data);
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id);
  const invalid = () => { throw Object.assign(new Error('Cloud session unavailable; sign in again'), { code: 'invalid_cloud_session', status: 401 }); };
  if (!Number.isSafeInteger(body.version) || body.version < 0 || body.version < db.version) invalid();
  if (body.unchanged === true) {
    if (db.version < 0 || body.version !== db.version) invalid();
    return db.collections;
  }
  if (body.delta === true) {
    if (db.version < 0 || !Array.isArray(body.changes)) invalid();
    for (const change of body.changes) {
      if (!change || !['queue_videos', 'room_settings'].includes(change.collection) || !validId(change.id) ||
          (change.data !== null && !validData(change.data)) ||
          (change.collection === 'room_settings' && change.id !== '2o3a') ||
          (change.collection === 'queue_videos' && change.data && change.data.channelRoom !== '2o3a')) invalid();
    }
    const next = structuredClone(db.collections);
    for (const change of body.changes) {
      const rows = new Map((next[change.collection] || []).map(row => [row.id, row]));
      if (change.data === null) rows.delete(change.id);
      else rows.set(change.id, { id: change.id, data: structuredClone(change.data) });
      next[change.collection] = [...rows.values()];
    }
    return next;
  }
  if (!body.collections || !['queue_videos', 'room_settings'].every(name => Array.isArray(body.collections[name]) &&
      body.collections[name].every(row => row && validId(row.id) && validData(row.data)))) invalid();
  return structuredClone(body.collections);
}
function publish(db) {
  for (const watch of db.watchers) {
    const value = result(watch.ref);
    const key = JSON.stringify(watch.ref.kind === 'doc' ? value.data() : value.docs.map(row => [row.id, row.data()]));
    if (key !== watch.last || !watch.delivered) {
      watch.last = key; watch.delivered = true; watch.next(value);
    }
  }
}
async function refresh(db, force = false) {
  if (db.inFlight) {
    await db.inFlight;
    if (!force) return;
  }
  const promise = (async () => {
    const response = await fetch('/api/twitch/session?action=store&since=' + db.version, {
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.code || 'Cloud queue unavailable'), { code: body.code, status: response.status });
    let nextCollections = validatedCollections(body, db);
    if (!body.legacyImported && body.delta !== true && body.unchanged !== true && !db.importAttempted && db.legacyVideos.length) {
      const imported = await fetch('/api/twitch/session?action=store', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'import-cache', videos: db.legacyVideos }),
        signal: AbortSignal.timeout(20000) });
      if (!imported.ok) throw new Error('Saved queue import could not be confirmed');
      db.importAttempted = true;
      const fresh = await fetch('/api/twitch/session?action=store&since=-1', { credentials: 'same-origin', cache: 'no-store' });
      const after = await fresh.json().catch(() => ({}));
      if (!fresh.ok || !Number.isSafeInteger(after.version) || !Array.isArray(after.collections?.queue_videos)) throw new Error('Imported queue refresh failed');
      nextCollections = validatedCollections(after, db);
      Object.assign(body, after);
    }
    db.collections = nextCollections;
    db.version = body.version; publish(db);
  })();
  db.inFlight = promise;
  try { await promise; } finally { if (db.inFlight === promise) db.inFlight = null; }
}
function schedule(db) {
  if (db.timer || !db.watchers.size || (typeof document !== 'undefined' && document.hidden)) return;
  db.timer = setTimeout(async () => {
    db.timer = null;
    try { await refresh(db); } catch (error) { for (const watch of db.watchers) watch.error?.(error); }
    schedule(db);
  }, 5000);
}
export function onSnapshot(ref, options, next, error) {
  if (!cloud(ref)) return legacy.onSnapshot(...[ref, options, next, error].filter(value => value !== undefined));
  if (typeof options === 'function') { error = next; next = options; }
  const db = cloud(ref); const watch = { ref, next, error, last: '', delivered: false };
  db.watchers.add(watch);
  if (!db.visibilityListener && typeof document !== 'undefined') {
    db.visibilityListener = () => {
      clearTimeout(db.timer); db.timer = null;
      if (!document.hidden) void refresh(db).catch(reason => {
        for (const current of db.watchers) current.error?.(reason);
      }).finally(() => schedule(db));
    };
    document.addEventListener('visibilitychange', db.visibilityListener);
  }
  if (typeof document === 'undefined' || !document.hidden) void refresh(db).catch(reason => error?.(reason)).finally(() => schedule(db));
  return () => { db.watchers.delete(watch); if (!db.watchers.size) { clearTimeout(db.timer); db.timer = null;
    if (db.visibilityListener) { document.removeEventListener('visibilitychange', db.visibilityListener); db.visibilityListener = null; }
  } };
}
export async function getDocs(ref) {
  if (!cloud(ref)) return legacy.getDocs(ref);
  await refresh(cloud(ref), true); return result(ref);
}
async function commit(db, operations, expectedVersion = db.version, baseline = null) {
  if (expectedVersion < 0) { await refresh(db, true); expectedVersion = db.version; }
  baseline ||= structuredClone(db.collections);
  const expectations = {};
  operations = operations.map(operation => {
    const ref = { cloudDb: { ...db, collections: baseline }, path: operation.path, kind: 'doc' };
    const current = result(ref).data();
    expectations[operation.path] = { exists: current !== undefined,
      ...(current ? { status: current.status, timestamp: Number(current.timestamp || 0), queueOpen: current.streamSettings?.queueOpen } : {}) };
    if (operation.type === 'set' && operation.merge && current) {
      // Existing transition helpers supply a full row. Send only changed
      // fields so simultaneous metadata enrichment is never reverted.
      return { ...operation, data: Object.fromEntries(Object.entries(operation.data)
        .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key]))) };
    }
    return operation;
  });
  const response = await fetch('/api/twitch/session?action=store', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operations, expectedVersion, expectations }), signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 409) await refresh(db, true);
    throw Object.assign(new Error(body.code || 'Cloud queue write failed'), { code: body.code, status: response.status });
  }
  // Do not advance the cached snapshot version until its data is fetched.
  await refresh(db, true);
  return body;
}
export function setDoc(ref, data, options = {}) {
  return cloud(ref) ? commit(cloud(ref), [{ type: 'set', path: ref.path, data, merge: options.merge === true }]) : legacy.setDoc(ref, data, options);
}
export function updateDoc(ref, data) { return cloud(ref) ? commit(cloud(ref), [{ type: 'update', path: ref.path, data }]) : legacy.updateDoc(ref, data); }
export function deleteDoc(ref) { return cloud(ref) ? commit(cloud(ref), [{ type: 'delete', path: ref.path }]) : legacy.deleteDoc(ref); }
export function writeBatch(db) {
  if (!cloud(db)) return legacy.writeBatch(db);
  const operations = []; const version = db.version; const baseline = version < 0 ? null : structuredClone(db.collections);
  const batch = {
    set(ref, data, options = {}) { operations.push({ type: 'set', path: ref.path, data, merge: options.merge === true }); return batch; },
    update(ref, data) { operations.push({ type: 'update', path: ref.path, data }); return batch; },
    delete(ref) { operations.push({ type: 'delete', path: ref.path }); return batch; },
    commit() { return operations.length ? commit(db, operations, version, baseline) : Promise.resolve(); },
  };
  return batch;
}
export async function runTransaction(db, callback) {
  if (!cloud(db)) return legacy.runTransaction(db, callback);
  for (let attempt = 0; attempt < 5; attempt++) {
    await refresh(db, true); const version = db.version; const operations = [];
    const baseline = structuredClone(db.collections);
    const tx = { get: async ref => result({ ...ref, cloudDb: { ...db, collections: baseline } }),
      set(ref, data, options = {}) { operations.push({ type: 'set', path: ref.path, data, merge: options.merge === true }); },
      update(ref, data) { operations.push({ type: 'update', path: ref.path, data }); },
      delete(ref) { operations.push({ type: 'delete', path: ref.path }); },
    };
    const value = await callback(tx);
    try { if (operations.length) await commit(db, operations, version, baseline); return value; }
    catch (error) { if (error.status !== 409 || attempt === 4) throw error; }
  }
}
