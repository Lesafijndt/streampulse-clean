import { createHash } from 'node:crypto';
import { parseMediaUrl, getMediaIdentityKey, getStableMediaDocumentId,
  detectVideoCategory, detectMusicType } from '../src/mediaUtils.js';
import { getQueueNamespace } from './firebase-guard.js';
import { buildMediaMetadataPatch } from '../src/mediaMetadata.js';

const SUPPORTED = new Set([
  'youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtu.be',
  'tiktok.com','www.tiktok.com','vm.tiktok.com','vt.tiktok.com',
  'twitch.tv','www.twitch.tv','clips.twitch.tv',
  'kick.com','www.kick.com','clip.kick.com',
]);
const BOTS = new Set(['nightbot','streamelements','streamlabs','moobot','fossabot','botrix','gachibot69']);

export function extractChatRequests(text = '') {
  const message = String(text || '').replace(/[\u200b-\u200d\ufeff]/g, '').trim().slice(0, 1500);
  const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|m\.youtube\.com|music\.youtube\.com|youtu\.be|tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|clips\.twitch\.tv|twitch\.tv|kick\.com|clip\.kick\.com)\/[^\s<>]+/gi;
  const links = [];
  const used = new Set();
  for (const match of message.matchAll(regex)) {
    const candidate = String(match[0]).replace(/[.,!?;:)\]}>]+$/g, '');
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(candidate) ? candidate : 'https://' + candidate);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || !SUPPORTED.has(host)) continue;
    } catch { continue; }
    if (used.has(url.href)) continue;
    used.add(url.href);
    links.push(url.href);
    if (links.length === 8) break;
  }
  if (links.length) return { links, titleQuery: null };
  if (!/^!assr(?:\s|$)/i.test(message)) return { links: [], titleQuery: null };
  const argument = message.replace(/^!assr\s*/i, '').trim();
  if (!argument) return { links: [], titleQuery: null };
  const ytId = argument.match(/^(?:(?:youtube|yt)\s+)?([\w-]{11})$/i);
  if (ytId) return { links: ['https://www.youtube.com/watch?v=' + ytId[1]], titleQuery: null };
  return { links: [], titleQuery: argument.slice(0, 180) };
}

export function getEventText(event) {
  const plain = String(event?.message?.text || '').trim();
  const fragments = Array.isArray(event?.message?.fragments)
    ? event.message.fragments.map(x => String(x?.text || '')).join('').trim() : '';
  return extractChatRequests(plain).links.length || !fragments ? plain :
    extractChatRequests(fragments).links.length ? fragments : plain || fragments;
}

function fakeResponse() {
  return {
    statusCode: 200, result: null,
    setHeader() {}, status(n) { this.statusCode = n; return this; },
    json(data) { this.result = data; return this; },
  };
}

async function resolveTitle(query) {
  const { default: search } = await import('../api/search-youtube.js');
  const res = fakeResponse();
  await search({ method: 'GET', query: { q: query } }, res);
  const first = res.result?.results?.[0];
  return res.statusCode === 200 && first?.url
    ? { url: first.url, title: first.title || '' } : null;
}

async function resolveShortTikTok(url) {
  const { default: resolve } = await import('../api/resolve-tiktok.js');
  const res = fakeResponse();
  await resolve({ method: 'GET', query: { url } }, res);
  return res.statusCode === 200 && res.result?.videoId ? res.result : null;
}

export async function makeQueueItems(event) {
  const login = String(event?.chatter_user_login || '').toLowerCase().trim();
  if (!/^[a-z0-9_]{1,25}$/.test(login) || BOTS.has(login)) return { items: [], reason: 'ignored_sender' };
  if (String(event?.broadcaster_user_login || '').toLowerCase() !== '2o3a') {
    return { items: [], reason: 'wrong_broadcaster' };
  }
  const parsed = extractChatRequests(getEventText(event));
  let incoming = parsed.links.map(url => ({ url, title: '' }));
  if (!incoming.length && parsed.titleQuery) {
    const result = await resolveTitle(parsed.titleQuery);
    if (!result) return { items: [], reason: 'title_search_unavailable' };
    incoming = [result];
  }
  if (!incoming.length) return { items: [], reason: 'not_a_request' };
  const items = [];
  const mediaIdentities = new Set();
  for (const item of incoming) {
    let url = item.url;
    let media = parseMediaUrl(url);
    if (media.platform === 'tiktok' && !media.videoId) {
      const resolved = await resolveShortTikTok(url);
      if (!resolved) return { items: [], reason: 'tiktok_resolution_failed' };
      url = resolved.url;
      media = parseMediaUrl(url);
    }
    if (!media.videoId || media.platform === 'web') continue;
    const identity = getMediaIdentityKey(media.platform, media.videoId, url);
    if (mediaIdentities.has(identity)) continue;
    mediaIdentities.add(identity);
    const id = getStableMediaDocumentId('2o3a|' + identity);
    const title = item.title ||
      (media.platform === 'youtube' ? 'YouTube Media (' + media.videoId + ')' :
        media.platform === 'tiktok' ? 'TikTok Short Clip' :
        media.platform === 'twitch' ? 'Twitch Clip (' + media.videoId + ')' :
        'Kick Clip (' + media.videoId + ')');
    const category = detectVideoCategory(url, title, 'Requested via Twitch chat', 'all');
    const mediaType = detectMusicType(url, title, '', category);
    const now = Date.now();
    items.push({
      id, channelRoom: '2o3a', title, url,
      platform: media.platform, videoId: media.videoId,
      category: mediaType === 'Music' ? 'Music' : category,
      categoryManuallySet: false, mediaType, duration: '',
      durationSource: 'unknown', requestedBy: login,
      userRole: 'viewer', status: 'queue', upvotes: 0, voters: [],
      pinned: false, addedAt: new Date(now).toISOString(),
      queueOrder: now, timestamp: now, createdAt: now,
      note: 'Requested via Twitch chat', thumbnail: media.thumbnail || '',
      isVertical: media.platform === 'tiktok' || url.toLowerCase().includes('/shorts/'),
    });
  }
  return { items, reason: items.length ? 'ready' : 'unsupported_media' };
}

/**
 * Transactionally journal a Twitch delivery and create requests. Duplicate
 * webhook retries cannot enqueue twice. Different URLs in the same second
 * do not share a rate limit. Staff permissions are never applied to viewers.
 */
export async function persistChatEvent(db, { event, messageId, subscriptionId }, { lookupMetadata } = {}) {
  const namespace = getQueueNamespace();
  // Message identity is independent of subscription: an old and a replacement
  // webhook may briefly deliver the same Twitch message concurrently.
  const eventKey = createHash('sha256').update('2o3a:' + String(messageId)).digest('hex');
  const base = db.collection('artifacts').doc(namespace).collection('public').doc('data');
  const receiptRef = base.collection('twitch_eventsub_receipts').doc(eventKey);
  const pending = await makeQueueItems(event);
  // Do not spend the Firestore free-tier quota writing a receipt for every
  // ordinary Twitch chat message. Request-shaped messages get durable receipts,
  // including rejected/duplicate cases needed by moderator diagnostics.
  if (['not_a_request', 'ignored_sender', 'wrong_broadcaster'].includes(pending.reason)) {
    return { status: pending.reason, queued: 0 };
  }
  if (lookupMetadata) {
    await Promise.all(pending.items.map(async item => {
      try { Object.assign(item, buildMediaMetadataPatch(item, item, await lookupMetadata(item.url))); }
      catch { /* Metadata failure must never reject an otherwise valid request. */ }
    }));
  }
  const result = await db.runTransaction(async tx => {
    const roomRef = base.collection('room_settings').doc('2o3a');
    const itemRefs = pending.items.map(item => base.collection('queue_videos').doc(item.id));
    const reads = await Promise.all([tx.get(receiptRef),tx.get(roomRef), ...itemRefs.map(ref=>tx.get(ref))]);
    if (reads[0].exists) return { status: 'duplicate_delivery', queued: 0 };
    const roomOpen = reads[1].data()?.streamSettings?.queueOpen !== false;
    let queued = 0;
    let duplicates = 0;
    if (roomOpen) {
      for (let i = 0; i < itemRefs.length; i++) {
        const previous = reads[i + 2].data();
        if (reads[i + 2].exists && ['queue', 'playing', 'watch_later'].includes(previous?.status)) { duplicates++; continue; }
        if (reads[i + 2].exists && previous?.status === 'watched') {
          // Preserve the completed request as history before reusing its active
          // media slot. The new request receives its own timestamp and sender.
          const historyId = 'history-' + createHash('sha256').update(pending.items[i].id + ':' +
            String(previous.timestamp || previous.createdAt || 0)).digest('hex');
          tx.set(base.collection('queue_videos').doc(historyId), { ...previous, id: historyId });
        }
        if (reads[i + 2].exists) tx.set(itemRefs[i], pending.items[i]);
        else tx.create(itemRefs[i], pending.items[i]);
        queued++;
      }
    }
    const status = !roomOpen ? 'closed' : pending.reason === 'ready' ?
      (queued > 0 ? 'queued' : 'duplicate_media') : pending.reason;
    tx.create(receiptRef, {
      messageId: String(messageId).slice(0, 128),
      subscriptionId: String(subscriptionId).slice(0, 128),
      sender: String(event?.chatter_user_login || '').slice(0, 30).toLowerCase(),
      status, queued, duplicates,
      receivedAt: Date.now(),
    });
    return { status, queued, duplicates };
  });
  console.info('twitch_chat_delivery', { status: result.status, queued: result.queued });
  return result;
}
