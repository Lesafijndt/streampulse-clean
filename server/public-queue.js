import {promotionQuotes} from '../src/promotionPriority.js';
import {readPromotionDetails} from './promotion-details.js';
import { promotionLabel } from '../src/promotion.js';
import { getQueueNamespace } from './firebase-guard.js';
import { getPostgresStore } from './postgres-store.js';

const cache = new WeakMap();
const CACHE_MS = 10_000;
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const rank = (row) => Number.isFinite(Number(row.queueOrder ?? row.timestamp)) ? Number(row.queueOrder ?? row.timestamp) : 0;
const compare = (a, b) => rank(a) - rank(b) || (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0) || a.id.localeCompare(b.id);

export function projectPublicQueue(documents, namespace, updatedAt = Date.now()) {
  const prefix = `artifacts/${namespace}/public/data/queue_videos/`;
  const rows = Object.entries(documents).flatMap(([path, row]) => {
    if (!path.startsWith(prefix) || !path.slice(prefix.length) || path.slice(prefix.length).includes('/') || row?.channelRoom !== '2o3a' || !['queue', 'playing'].includes(row.status)) return [];
    return [{ ...row, id: path.slice(prefix.length) }];
  });
  const ordered=rows.filter(row=>row.status==='queue').sort(compare);
  const quotes=promotionQuotes(ordered,documents['artifacts/'+namespace+'/public/data/room_settings/2o3a']?.promotionPriority);
  const project = (row, position) => ({
    timestamp:Number(row.timestamp || 0),promotionQuote:position>0 ? quotes.get(row.id) || null : null,
    promotionLabel: promotionLabel(row), position, id: row.id, title: text(row.title, 1000),
    url: /^https?:\/\//i.test(text(row.url, 4096)) ? text(row.url, 4096) : '',
    platform: text(row.platform, 40),
    durationSec: Number.isFinite(Number(row.durationSec)) && Number(row.durationSec) > 0 ? Number(row.durationSec) : null,
    requestedBy: text(row.requestedBy, 100)
  });
  const playing = rows.filter(row => row.status === 'playing').sort(compare)[0];
  return { queue: ordered.map((row, index) => project(row, index + 1)),
    playing: playing ? project(playing, 0) : null, updatedAt };
}

export async function handlePublicQueue(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const namespace = dependencies.namespace || getQueueNamespace();
    const db = dependencies.db || await getPostgresStore(namespace);
    if(req.query?.view==='promotion')return res.status(200).json(await readPromotionDetails(db,'artifacts/'+namespace+'/public/data/',req.query));
    const now = (dependencies.now || Date.now)();
    let entry = cache.get(db);
    if (!entry || entry.namespace !== namespace || now - entry.at >= CACHE_MS) {
      const state = await db.readState({ collections: ['queue_videos','room_settings'].map(name=>'artifacts/'+namespace+'/public/data/'+name) });
      entry = { at: now, namespace, body: projectPublicQueue(state.documents, namespace, now) };
      cache.set(db, entry);
    }
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10');
    return res.status(200).json(entry.body);
  } catch(error) {
    if([400,404].includes(error.status))return res.status(error.status).json({error:error.code});
    return res.status(503).json({ error: 'The queue is temporarily unavailable. Please try again.' });
  }
}
