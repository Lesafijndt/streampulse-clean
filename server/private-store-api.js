import { getQueueNamespace } from './firebase-guard.js';
import { getPostgresStore } from './postgres-store.js';
import { normalizeActivityEvent } from '../src/activityLog.js';
import { buildMediaMetadataPatch } from '../src/mediaMetadata.js';
import { getPlaybackGeneration } from '../src/playerBridge.js';
import { buildShuffleQueueTransition } from '../src/queueShuffle.js';

const STAFF = new Set(['2o3a', 'paim_beach_pete']);
const SAFE_ID = /^[A-Za-z0-9_-]{1,180}$/;
function fail(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
export async function handlePrivateStore(req, res, identity, dependencies = {}) {
  if (!STAFF.has(identity?.login)) return res.status(403).json({ code: 'staff_required' });
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ code: 'method_not_allowed' });
  const namespace = dependencies.namespace || getQueueNamespace();
  const prefix = `artifacts/${namespace}/public/data/`;
  try {
    const db = dependencies.db || await getPostgresStore(namespace);
    if (req.method === 'GET') {
      const since = Number(req.query?.since ?? -1);
      const version = await db.getVersion();
      if (since === version) return res.status(200).json({ version, unchanged: true });
      if (Number.isSafeInteger(since) && since >= 0 && db.readChanges) {
        const delta = await db.readChanges(since, { collections: ['queue_videos', 'room_settings'].map(name => prefix + name) });
        if (!delta.reset) {
          const changes = [];
          for (const [path, data] of Object.entries(delta.documents)) {
            if (!path.startsWith(prefix)) continue;
            const parts = path.slice(prefix.length).split('/');
            if (parts.length !== 2 || !['queue_videos', 'room_settings'].includes(parts[0])) continue;
            if (parts[0] === 'room_settings' && parts[1] !== '2o3a') continue;
            // A row moved out of this room must disappear from the cached view.
            changes.push({ collection: parts[0], id: parts[1], data:
              parts[0] === 'queue_videos' && data && data.channelRoom !== '2o3a' ? null : data });
          }
          return res.status(200).json({ version: delta.version, delta: true, changes });
        }
      }
      const state = await db.readState({ collections: ['queue_videos', 'room_settings', 'system_diagnostics'].map(name => prefix + name) });
      const collections = { queue_videos: [], room_settings: [] };
      for (const [path, data] of Object.entries(state.documents)) {
        if (!path.startsWith(prefix)) continue;
        const parts = path.slice(prefix.length).split('/');
        if (parts.length !== 2 || !Object.hasOwn(collections, parts[0])) continue;
        if (parts[0] === 'room_settings' && parts[1] !== '2o3a') continue;
        if (parts[0] === 'queue_videos' && data.channelRoom !== '2o3a') continue;
        collections[parts[0]].push({ id: parts[1], data });
      }
      return res.status(200).json({ version: state.version, collections,
        legacyImported: Boolean(state.documents[prefix + 'system_diagnostics/legacy-browser-import']) });
    }
    const origin = new URL(process.env.TWITCH_APP_URL || 'https://' + req.headers.host).origin;
    if (req.headers.origin !== origin) throw fail('origin_denied', 403);
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (body?.operation === 'shuffle') {
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) throw fail('version_required');
      const state = await db.readState({ collections: [prefix + 'queue_videos'] });
      if (state.version !== body.expectedVersion) throw fail('conflict', 409);
      const videos = Object.entries(state.documents).flatMap(([path, data]) => {
        if (!path.startsWith(prefix + 'queue_videos/') || path.slice((prefix + 'queue_videos/').length).includes('/') || data?.channelRoom !== '2o3a') return [];
        return [{ ...data, id: path.split('/').at(-1) }];
      });
      const { updates } = buildShuffleQueueTransition(videos, dependencies.random || Math.random);
      const operations = [...updates].map(([id, data]) => ({ type: 'update', path: prefix + 'queue_videos/' + id, data }));
      const result = await db.commitOperations(operations, { expectedVersion: state.version });
      return res.status(200).json({ ok: true, version: result.version });
    }
    if (body?.operation === 'enrich-metadata') {
      if (!SAFE_ID.test(body.id || '') || typeof body.url !== 'string' || typeof body.generation !== 'string' || !body.patch || JSON.stringify(body.patch).length > 10000) throw fail('invalid_metadata');
      const applied = await db.runTransaction(async tx => {
        const ref = db.doc(prefix + 'queue_videos/' + body.id);
        const row = (await tx.get(ref)).data();
        if (!row || row.channelRoom !== '2o3a' || row.url !== body.url || getPlaybackGeneration(row) !== body.generation) return false;
        const patch = buildMediaMetadataPatch(row, row, { title: body.patch.title, thumbnailUrl: body.patch.thumbnail,
          durationSec: body.patch.durationSec, durationProvider: body.patch.durationProvider });
        if (!Object.keys(patch).length) return false;
        tx.update(ref, patch);return true;
      });
      return res.status(200).json({ ok: true, applied });
    }
    if (body?.operation === 'claim-chat-command') {
      if (!SAFE_ID.test(body.id || '') || !['audio', 'reply'].includes(body.kind)) throw fail('invalid_command_claim');
      if (identity.login !== (body.kind === 'audio' ? '2o3a' : 'paim_beach_pete')) throw fail('command_role_required', 403);
      const claimed = await db.runTransaction(async tx => {
        const settings = (await tx.get(db.doc(prefix + 'room_settings/2o3a'))).data();
        const packet = settings?.chatCommandFeed?.find(entry => entry.id === body.id && entry.at > Date.now() - 120000);
        if (!packet || !(body.kind === 'audio' ? packet.volumeCommand : packet.reply)) return false;
        const ref = db.doc(prefix + 'system_diagnostics/' + body.id + '-' + body.kind);
        if ((await tx.get(ref)).exists) return false;
        tx.create(ref, { at: Date.now(), claimedBy: identity.login });return true;
      });
      return res.status(200).json({ ok: true, claimed });
    }
    if (body?.operation === 'reset') {
      if (!['queue', 'history', 'statistics', 'all'].includes(body.scope) || body.confirmation !== 'RESET') throw fail('reset_confirmation_required');
      if (body.scope === 'statistics' && identity.login !== 'paim_beach_pete') throw fail('moderator_required', 403);
      const state = await db.readState();
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion !== state.version) throw fail('conflict', 409);
      const now = Date.now(), operations = [];
      for (const [path, data] of Object.entries(state.documents)) {
        if (!path.startsWith(prefix)) continue;
        const [name, , extra] = path.slice(prefix.length).split('/');
        if (extra || data.channelRoom !== '2o3a' || name !== 'queue_videos') continue;
        if (body.scope === 'all' || (body.scope === 'queue' && ['queue', 'watch_later'].includes(data.status)) ||
            (body.scope === 'history' && data.status === 'watched')) operations.push({ type: 'delete', path });
      }
      const settingsPath = prefix + 'room_settings/2o3a';
      const settings = state.documents[settingsPath] || { channelRoom: '2o3a' };
      const resetStatistics = ['statistics', 'all'].includes(body.scope);
      // Retain an epoch rather than deleting the journal: stale tabs cannot resurrect old statistics.
      operations.push({ type: 'set', path: settingsPath, data: { ...settings, updatedAt: now,
        ...(resetStatistics ? { statisticsResetAt: now } : {}), lastResetAt: now, lastResetScope: body.scope } });
      // Prevent an old browser importing deleted rows after an intentional reset.
      if (['queue', 'history', 'all'].includes(body.scope)) operations.push({ type: 'set',
        path: prefix + 'system_diagnostics/legacy-browser-import', data: { importedAt: now, resetBy: identity.login } });
      await db.commitOperations(operations, { expectedVersion: state.version });
      return res.status(200).json({ ok: true, version: state.version + 1, resetAt: now,
        statisticsResetAt: resetStatistics ? now : Number(settings.statisticsResetAt || 0) });
    }
    if (body?.operation === 'import-cache') {
      if (!Array.isArray(body.videos) || body.videos.length < 1 || body.videos.length > 2000 || JSON.stringify(body).length > 2_000_000) throw fail('invalid_import');
      const incoming = body.videos.filter(row => row && SAFE_ID.test(row.id || '') && row.channelRoom === '2o3a' &&
        ['queue', 'playing', 'watched', 'watch_later'].includes(row.status) && /^https?:\/\//i.test(String(row.url || '')));
      if (incoming.length !== body.videos.length) throw fail('invalid_import');
      await db.runTransaction(async tx => {
        const marker = db.doc(prefix + 'system_diagnostics/legacy-browser-import');
        if ((await tx.get(marker)).exists) return;
        const refs = incoming.map(row => db.doc(prefix + 'queue_videos/' + row.id));
        const existing = await Promise.all(refs.map(ref => tx.get(ref)));
        incoming.forEach((row, i) => { if (!existing[i].exists) tx.create(refs[i], row); });
        tx.set(marker, { importedBy: identity.login, importedAt: Date.now(), rows: incoming.length });
      });
      return res.status(200).json({ ok: true, version: await db.getVersion() });
    }
    if (!body || JSON.stringify(body).length > 2_000_000 || !Array.isArray(body.operations) ||
        !body.operations.length || body.operations.length > 400) throw fail('invalid_operations');
    const operations = body.operations;
    for (const op of operations) {
      if (!['set', 'update', 'delete', 'create'].includes(op.type) || typeof op.path !== 'string') throw fail('invalid_operation');
      if (!op.path.startsWith(prefix)) throw fail('path_not_allowed', 403);
      const [collection, id, extra] = op.path.slice(prefix.length).split('/');
      if (extra || !SAFE_ID.test(id || '') || !['queue_videos', 'room_settings', 'queue_events'].includes(collection)) throw fail('path_not_allowed', 403);
      if (collection === 'room_settings' && (identity.login !== 'paim_beach_pete' || id !== '2o3a' || op.type === 'delete')) throw fail('moderator_required', 403);
      if (collection === 'queue_events' && op.type === 'delete') throw fail('activity_append_only', 403);
      if (op.type !== 'delete' && (!op.data || typeof op.data !== 'object' || Array.isArray(op.data) || JSON.stringify(op.data).length > 32768)) throw fail('invalid_document');
      if (op.data?.channelRoom && op.data.channelRoom !== '2o3a') throw fail('wrong_room', 403);
      if (op.data?.room && op.data.room !== '2o3a') throw fail('wrong_room', 403);
      if (collection === 'queue_events') {
        const event = normalizeActivityEvent(op.data);
        if (!event || event.id !== id || event.room !== '2o3a' || !event.mediaId || !Number.isSafeInteger(event.at)) throw fail('invalid_activity_event');
        op.data = event;
        op.type = 'create';
      }
      if (collection === 'room_settings') {
        if (op.data.streamSettings && typeof op.data.streamSettings.queueOpen !== 'boolean') throw fail('invalid_queue_setting');
        op.data = { channelRoom: '2o3a',
          ...(op.data.streamSettings ? { streamSettings: { queueOpen: op.data.streamSettings.queueOpen } } : {}), updatedAt: Date.now() };
      }
      if (collection === 'queue_videos' && op.type !== 'delete') {
        if (op.data.id && op.data.id !== id) throw fail('document_id_mismatch');
        if (op.data.status && !['queue', 'playing', 'watched', 'watch_later'].includes(op.data.status)) throw fail('invalid_status');
        if (op.data.url && !/^https?:\/\//i.test(String(op.data.url))) throw fail('invalid_media_url');
      }
    }
    // The browser's observed version prevents stale tabs from overwriting a
    // new request or playback transition. All writes share one atomic commit.
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) throw fail('version_required');
    if (!body.expectations || typeof body.expectations !== 'object') throw fail('preconditions_required');
    await db.runTransaction(async tx => {
      const refs = operations.map(op => db.doc(op.path));
      const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));
      for (let index = 0; index < operations.length; index++) {
        const op = operations[index], current = snapshots[index], expected = body.expectations[op.path];
        if (!expected || typeof expected.exists !== 'boolean') throw fail('preconditions_required');
        if (op.path.includes('/queue_events/') && current.exists) throw fail('activity_append_only', 403);
        if (current.exists !== expected.exists) throw fail('conflict', 409);
        if (current.exists) {
          const data = current.data();
          if (op.path.includes('/queue_videos/') && (data.status !== expected.status || Number(data.timestamp || 0) !== Number(expected.timestamp || 0))) throw fail('conflict', 409);
          if (op.path.includes('/room_settings/') && Boolean(data.streamSettings?.queueOpen) !== Boolean(expected.queueOpen)) throw fail('conflict', 409);
        }
      }
      operations.forEach((op, index) => {
        if (op.type === 'delete') tx.delete(refs[index]);
        else if (op.type === 'set') tx.set(refs[index], op.data, { merge: op.merge === true });
        else tx[op.type](refs[index], op.data);
      });
    });
    return res.status(200).json({ ok: true, version: await db.getVersion() });
  } catch (error) {
    const status = Number(error.status || error.statusCode) || 503;
    return res.status([400, 403, 409].includes(status) ? status : 503).json({
      code: [400, 403, 409].includes(status) ? error.code : 'queue_storage_unavailable',
    });
  }
}
