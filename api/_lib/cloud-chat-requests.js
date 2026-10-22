import { extractSupportedMediaUrl } from '../../src/chatCommands.js';
import {
  detectMusicType,
  detectVideoCategory,
  getMediaIdentityKey,
  getStableMediaDocumentId,
  parseMediaUrl,
  parseMediaStartSeconds,
  stripMediaTimestampSuffix,
  isMediaHistoryCooldownExpired,
  getMediaHistoryCooldownRemainingMs,
} from '../../src/mediaUtils.js';
import { getFirebaseAdminDb, getFirebaseNamespace } from './firebase-admin.js';

const PRIVATE_CHANNEL = '2o3a';
const KNOWN_CHAT_BOTS = new Set([
  'nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot',
  'botrix', 'deepbot', 'sery_bot', 'serybot', 'mixitup', 'soundalerts',
  'commanderroot', 'tangia', 'firebot', 'own3d', 'botisimo', 'blerp',
  'pretzelrocks', 'monstercat', 'vivbot', 'ankhbot', 'ohbot', 'phantombot',
  'streamcaptain', 'streamstickers', 'gachibot69',
]);

let cachedReplyAppToken = { value: '', expiresAt: 0 };
let cachedBotUserId = '';

async function getReplyAppToken() {
  if (cachedReplyAppToken.value && cachedReplyAppToken.expiresAt > Date.now() + 60000) {
    return cachedReplyAppToken.value;
  }
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Twitch OAuth is not configured');
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(2500),
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) throw new Error('Could not obtain Twitch app access token for chat replies');
  cachedReplyAppToken = {
    value: result.access_token,
    expiresAt: Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000,
  };
  return cachedReplyAppToken.value;
}

async function sendEventSubChatReply(event, message) {
  try {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const accessToken = await getReplyAppToken();
    if (!clientId || !event?.broadcaster_user_id) return false;
    if (!cachedBotUserId) {
      const usersResponse = await fetch('https://api.twitch.tv/helix/users?login=gachibot69', {
        headers: { 'Client-Id': clientId, Authorization: 'Bearer ' + accessToken },
        signal: AbortSignal.timeout(1800),
        cache: 'no-store',
      });
      const users = await usersResponse.json().catch(() => ({}));
      if (!usersResponse.ok || !users.data?.[0]?.id) throw new Error('Could not resolve the chat bot user ID');
      cachedBotUserId = String(users.data[0].id);
    }

    const response = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        broadcaster_id: String(event.broadcaster_user_id),
        sender_id: cachedBotUserId,
        message: String(message || '').slice(0, 450),
      }),
      signal: AbortSignal.timeout(2200),
      cache: 'no-store',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.data?.[0]?.is_sent === false) {
      console.warn('Twitch cloud chat reply failed:', {
        status: response.status,
        reason: String(result.message || result.data?.[0]?.drop_reason?.message || 'send failed').slice(0, 180),
      });
      return false;
    }
    return true;
  } catch (error) {
    // Replies are best-effort. A reply outage must never prevent the request from being queued.
    console.warn('Twitch cloud chat reply failed:', String(error?.message || error).slice(0, 240));
    return false;
  }
}

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '');
}

function getPublicOrigin() {
  const configured = String(process.env.TWITCH_APP_URL || '').trim();
  // Internal calls should use the stable public production hostname, not VERCEL_URL's
  // deployment-specific hostname (which may be protected or point at an expired preview).
  const candidate = configured || 'https://streampulse-clean.vercel.app';
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('TWITCH_APP_URL must be a public HTTPS origin');
  }
  return parsed.origin;
}

async function getJson(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    return response.ok ? body : null;
  } catch {
    return null;
  }
}

function formatDuration(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function isAlreadyExists(error) {
  return error?.code === 6 ||
    error?.code === 'already-exists' ||
    /already exists|ALREADY_EXISTS/i.test(String(error?.message || ''));
}

async function resolveTiktokIfNeeded(url, parsed, origin, event, requester) {
  if (parsed.platform !== 'tiktok' || parsed.videoId) return { url, parsed, metadataUrl: url };
  const endpoint = new URL('/api/resolve-tiktok?url=' + encodeURIComponent(url), origin);
  let response;
  try {
    response = await fetch(endpoint, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5200),
    });
  } catch {
    throw new Error('TikTok short-link resolution timed out');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.videoId || !result.url) {
    if (response.status >= 500) throw new Error('TikTok short-link resolution is temporarily unavailable');
    await sendEventSubChatReply(event, `@${requester} TikTok link failed; try the full /video/ URL.`);
    return null;
  }
  const normalizedUrl = String(result.url);
  const normalizedParsed = parseMediaUrl(normalizedUrl);
  if (normalizedParsed.platform !== 'tiktok' || !normalizedParsed.videoId) {
    throw new Error('TikTok resolver returned an invalid video URL');
  }
  return {
    url: normalizedUrl,
    parsed: normalizedParsed,
    metadataUrl: typeof result.metadataUrl === 'string' && result.metadataUrl.startsWith('https://')
      ? result.metadataUrl
      : normalizedUrl,
  };
}


const CHAT_COMMANDS = new Set([
  'assr', 'remove', 'unrequest', 'queue', 'when', 'position', 'myqueue',
  'queueposition', 'bigcock', 'help', 'skip'
]);
const pendingInboxIds = new Set();

function normalizeEventMessageId(messageId) {
  return String(messageId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}
function inboxPath(appId) {
  return 'artifacts/' + appId + '/public/data/chat_request_inbox';
}
function queuePath(appId) {
  return 'artifacts/' + appId + '/public/data/queue_videos';
}
function settingsPath(appId) {
  return 'artifacts/' + appId + '/public/data/room_settings/' + PRIVATE_CHANNEL;
}
function eventsPath(appId) {
  return 'artifacts/' + appId + '/public/data/queue_events';
}
function eventDocumentId(messageId) {
  return 'eventsub-' + normalizeEventMessageId(messageId).slice(0, 105);
}
function sortedQueue(items) {
  return items.slice().sort((a, b) =>
    (Number(a.queueOrder) || Number.MAX_SAFE_INTEGER) - (Number(b.queueOrder) || Number.MAX_SAFE_INTEGER) ||
    (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0)
  );
}
function formatEta(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? hours + 'h ' + minutes + 'm' : minutes + 'm';
}
function durationSeconds(video) {
  const stored = Number(video?.durationSec);
  if (Number.isFinite(stored) && stored > 0 && stored <= 86400) return Math.round(stored);
  const parts = String(video?.duration || '').split(':').map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] > 0 && parts[0] <= 86400 ? parts[0] : 0;
}
function isStaffEvent(event) {
  return Boolean(event?.chatter_is_moderator || event?.chatter_is_broadcaster ||
    normalizeLogin(event?.chatter_user_login) === PRIVATE_CHANNEL ||
    String(event?.chatter_user_id || '') === String(event?.broadcaster_user_id || ''));
}
function activityEvent({ id, type, at, item, requester }) {
  return {
    id, type, room: PRIVATE_CHANNEL, at, sessionId: 'twitch-eventsub',
    mediaId: String(item?.id || ''),
    title: String(item?.title || '').slice(0, 180),
    requester: String(requester || '').slice(0, 64),
    actor: String(requester || '').slice(0, 64),
    platform: String(item?.platform || 'external').slice(0, 32),
    category: String(item?.category || 'General').slice(0, 64),
    source: 'twitch-chat',
  };
}
export function versionUpdate(settings, at, healthPatch = null) {
  const oldHealth = settings?.chatIntakeHealth && typeof settings.chatIntakeHealth === 'object'
    ? settings.chatIntakeHealth : {};
  return {
    queueVersion: (Number(settings?.queueVersion) || 0) + 1,
    queueUpdatedAt: at,
    // Every successful transactional queue mutation refreshes the write heartbeat,
    // including remove/vote/skip, not only brand-new media requests.
    chatIntakeHealth: {
      ...oldHealth,
      lastWriteAt: at,
      lastWriteStatus: 'ok',
      ...(healthPatch || {}),
    },
  };
}
async function readRoomQueue(db, appId) {
  const snapshot = await db.collection(queuePath(appId))
    .where('channelRoom', '==', PRIVATE_CHANNEL).get();
  return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
}

/** Persist only media requests and supported commands, not every ordinary chat message. */
export function isEventSubChatCandidate(event) {
  const broadcaster = normalizeLogin(event?.broadcaster_user_login);
  const requester = normalizeLogin(event?.chatter_user_login);
  const text = String(event?.message?.text || '').trim();
  if (broadcaster !== PRIVATE_CHANNEL || !requester || !text || KNOWN_CHAT_BOTS.has(requester)) return false;
  if (extractSupportedMediaUrl(text) || /^!assr(?:\s|$)/i.test(text)) return true;
  const command = text.match(/^!([a-z0-9_]+)(?:\s|$)/i)?.[1]?.toLowerCase();
  return Boolean(command && CHAT_COMMANDS.has(command));
}

/**
 * Inbox write is the webhook's only critical work. If it fails, Twitch receives 503 and
 * retries. Once saved, slow third-party lookups run after acknowledgement via waitUntil.
 */
export async function persistEventSubInbox({ event, messageId }) {
  if (!event || !messageId) throw new Error('EventSub inbox requires an event and message ID');
  const db = await getFirebaseAdminDb();
  const appId = getFirebaseNamespace();
  const safeId = normalizeEventMessageId(messageId);
  if (!safeId) throw new Error('EventSub message ID is invalid');
  const inboxRef = db.doc(inboxPath(appId) + '/' + safeId);
  const roomSettingsRef = db.doc(settingsPath(appId));
  const receivedAt = Date.now();
  await db.runTransaction(async (tx) => {
    const inboxSnapshot = await tx.get(inboxRef);
    const settingsSnapshot = await tx.get(roomSettingsRef);
    const settings = settingsSnapshot.exists ? settingsSnapshot.data() : {};
    const health = settings?.chatIntakeHealth && typeof settings.chatIntakeHealth === 'object'
      ? settings.chatIntakeHealth : {};
    if (!inboxSnapshot.exists) {
      tx.create(inboxRef, {
        id: safeId, messageId: String(messageId), event, status: 'pending',
        attempts: 0, receivedAt,
      });
    }
    tx.set(roomSettingsRef, {
      chatIntakeHealth: {
        ...health, lastWebhookAt: receivedAt,
        lastWebhookStatus: inboxSnapshot.exists ? 'duplicate' : 'persisted',
      },
    }, { merge: true });
  });
  return { id: safeId };
}

async function claimInboxItem(db, ref) {
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return null;
    const data = snapshot.data() || {};
    const stale = data.status === 'processing' && Date.now() - (Number(data.claimedAt) || 0) > 60000;
    if (data.status !== 'pending' && !stale) return null;
    tx.update(ref, { status: 'processing', claimedAt: Date.now(), attempts: (Number(data.attempts) || 0) + 1 });
    return data;
  });
}

/** Bounded durable inbox worker; failed messages stay pending for a later EventSub delivery. */
export async function processPendingEventSubChatMessages(limit = 5) {
  const db = await getFirebaseAdminDb();
  const appId = getFirebaseNamespace();
  const path = inboxPath(appId);
  const max = Math.max(1, Math.min(10, Math.floor(Number(limit) || 5)));
  const stuck = await db.collection(path).where('status', '==', 'processing').limit(max * 2).get();
  const staleRefs = stuck.docs.filter((entry) =>
    Date.now() - (Number(entry.data()?.claimedAt) || 0) > 60000
  ).slice(0, max).map((entry) => entry.ref);
  const pending = await db.collection(path).where('status', '==', 'pending').limit(max).get();
  const refs = [...pending.docs.map((entry) => entry.ref), ...staleRefs]
    .filter((ref, index, all) => all.findIndex((other) => other.path === ref.path) === index)
    .slice(0, max);
  let completed = 0;
  for (const ref of refs) {
    if (pendingInboxIds.has(ref.id)) continue;
    pendingInboxIds.add(ref.id);
    try {
      const data = await claimInboxItem(db, ref);
      if (!data?.event || !data?.messageId) continue;
      try {
        const outcome = await processEventSubChatMessage({ event: data.event, messageId: data.messageId });
        await ref.update({
          status: 'processed', processedAt: Date.now(),
          result: String(outcome?.reason || (outcome?.queued ? 'queued' : outcome?.ignored ? 'ignored' : 'handled')).slice(0, 80),
          lastError: null,
        });
        completed += 1;
      } catch (error) {
        const failure = String(error?.message || error).slice(0, 400);
        const attemptNumber = (Number(data.attempts) || 0) + 1;
        const nextStatus = attemptNumber >= 3 ? 'failed' : 'pending';
        await ref.update({
          status: nextStatus,
          lastError: failure,
          lastFailedAt: Date.now(),
          failedAt: nextStatus === 'failed' ? Date.now() : null,
        }).catch(() => {});
        const settingsRef = db.doc(settingsPath(appId));
        const settingsSnapshot = await settingsRef.get().catch(() => null);
        const settings = settingsSnapshot?.exists ? settingsSnapshot.data() : {};
        const health = settings?.chatIntakeHealth && typeof settings.chatIntakeHealth === 'object'
          ? settings.chatIntakeHealth : {};
        await settingsRef.set({
          chatIntakeHealth: { ...health, lastProcessingError: failure, lastProcessingErrorAt: Date.now() },
        }, { merge: true }).catch(() => {});
        console.error('EventSub inbox processing failed; retry status:', { status: nextStatus, attempts: attemptNumber, failure });
      }
    } finally {
      pendingInboxIds.delete(ref.id);
    }
  }
  return { found: refs.length, completed };
}

async function processCloudChatCommand({ db, appId, event, messageId, requester, rawText }) {
  const matched = rawText.match(/^!([a-z0-9_]+)(?:\s+([\s\S]*))?$/i);
  if (!matched) return { ignored: true };
  const name = matched[1].toLowerCase();
  const argument = String(matched[2] || '').trim();
  const settingsRef = db.doc(settingsPath(appId));
  const at = Date.now();
  const eventId = eventDocumentId(messageId);
  const activityRef = db.doc(eventsPath(appId) + '/' + eventId);
  const staff = isStaffEvent(event);

  if (name === 'help') {
    await sendEventSubChatReply(event, 'Requests: !assr <URL or title> or post a link; YouTube timestamps work. !queue, !when, !remove, !bigcock [#]. History videos can be requested again after 16 hours. Mods: !skip. Volume commands require the player dashboard open.');
    return { handled: true, reason: 'help' };
  }

  if (name === 'queue' || ['when', 'position', 'myqueue', 'queueposition'].includes(name)) {
    const items = await readRoomQueue(db, appId);
    const playing = items.find((item) => item.status === 'playing') || null;
    const queued = sortedQueue(items.filter((item) => item.status === 'queue'));
    if (name === 'queue') {
      const top = queued.slice(0, 3).map((item, index) =>
        '#' + (index + 1) + ' ' + String(item.title || 'Untitled').slice(0, 27)
      );
      const mine = queued.filter((item) => normalizeLogin(item.requestedBy) === requester).length;
      await sendEventSubChatReply(event, '@' + requester + ' ' +
        (playing ? 'Now: "' + String(playing.title || 'Untitled').slice(0, 35) + '"' : 'Nothing playing') +
        ' | ' + queued.length + ' waiting (' + mine + ' yours). Next: ' + (top.length ? top.join(', ') : 'empty') + '.');
      return { handled: true, reason: 'queue' };
    }
    const mine = queued.map((item, index) => ({ item, position: index + 1 }))
      .filter(({ item }) => normalizeLogin(item.requestedBy) === requester);
    if (!mine.length) {
      await sendEventSubChatReply(event, '@' + requester + ' No upcoming requests. Use !assr <URL/title>.');
      return { handled: true, reason: 'position_empty' };
    }
    let secondsAhead = playing ? durationSeconds(playing) : 0;
    const waitById = new Map();
    for (const item of queued) {
      waitById.set(String(item.id), secondsAhead);
      secondsAhead += durationSeconds(item);
    }
    const summary = mine.slice(0, 3).map(({ item, position }) =>
      '#' + position + ' "' + String(item.title || item.platform || 'video').slice(0, 35) +
      '" (ETA ' + formatEta(waitById.get(String(item.id)) || 0) + ')'
    );
    await sendEventSubChatReply(event, '@' + requester + ' ' + summary.join('; ') + '.');
    return { handled: true, reason: 'position' };
  }

  if (name === 'remove' || name === 'unrequest') {
    const candidates = (await readRoomQueue(db, appId)).filter((item) =>
      item.status === 'queue' && normalizeLogin(item.requestedBy) === requester
    ).sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
    const target = candidates[0];
    if (!target) {
      await sendEventSubChatReply(event, '@' + requester + ' No waiting request to remove.');
      return { handled: true, reason: 'remove_empty' };
    }
    const itemRef = db.doc(queuePath(appId) + '/' + target.id);
    const activity = activityEvent({ id: eventId, type: 'request_removed', at, item: target, requester });
    const outcome = await db.runTransaction(async (tx) => {
      const [settingsSnap, itemSnap, priorEvent] = await Promise.all([
        tx.get(settingsRef), tx.get(itemRef), tx.get(activityRef),
      ]);
      if (priorEvent.exists) return 'duplicate';
      if (!itemSnap.exists || itemSnap.data()?.status !== 'queue' ||
          normalizeLogin(itemSnap.data()?.requestedBy) !== requester) return 'changed';
      const settings = settingsSnap.exists ? settingsSnap.data() : {};
      tx.delete(itemRef);
      tx.create(activityRef, activity);
      tx.set(settingsRef, versionUpdate(settings, at), { merge: true });
      return 'removed';
    });
    await sendEventSubChatReply(event, outcome === 'removed'
      ? '@' + requester + ' Removed your latest waiting request.'
      : outcome === 'duplicate' ? '@' + requester + ' Your remove command was already processed.'
      : '@' + requester + ' No waiting request to remove.');
    return { handled: true, reason: 'remove_' + outcome };
  }

  if (name === 'bigcock') {
    const queued = sortedQueue((await readRoomQueue(db, appId)).filter((item) => item.status === 'queue'));
    if (!queued.length) {
      await sendEventSubChatReply(event, '@' + requester + ' No waiting videos to vote for.');
      return { handled: true, reason: 'vote_empty' };
    }
    const explicit = argument.match(/^(\d{1,4})$/);
    const index = explicit ? Number(explicit[1]) - 1 : 0;
    const target = index >= 0 && index < queued.length ? queued[index] : null;
    if (!target) {
      await sendEventSubChatReply(event, '@' + requester + ' That queue position does not exist.');
      return { handled: true, reason: 'vote_position_invalid' };
    }
    if (normalizeLogin(target.requestedBy) === requester) {
      await sendEventSubChatReply(event, '@' + requester + ' You cannot upvote your own request.');
      return { handled: true, reason: 'vote_own_request' };
    }
    const itemRef = db.doc(queuePath(appId) + '/' + target.id);
    const activity = activityEvent({ id: eventId, type: 'vote_added', at, item: target, requester });
    const outcome = await db.runTransaction(async (tx) => {
      const [settingsSnap, itemSnap, priorEvent] = await Promise.all([
        tx.get(settingsRef), tx.get(itemRef), tx.get(activityRef),
      ]);
      if (priorEvent.exists) return 'duplicate';
      if (!itemSnap.exists || itemSnap.data()?.status !== 'queue') return 'changed';
      const item = itemSnap.data();
      const voters = Array.isArray(item.voters) ? item.voters.map(normalizeLogin) : [];
      if (voters.includes(requester)) return 'already_voted';
      const settings = settingsSnap.exists ? settingsSnap.data() : {};
      tx.update(itemRef, { voters: [...voters, requester], upvotes: (Number(item.upvotes) || 0) + 1 });
      tx.create(activityRef, activity);
      tx.set(settingsRef, versionUpdate(settings, at), { merge: true });
      return 'voted';
    });
    const replies = {
      voted: '@' + requester + ' Upvoted "' + String(target.title || 'video').slice(0, 35) + '".',
      already_voted: '@' + requester + ' You already voted for that video.',
      duplicate: '@' + requester + ' Your vote command was already processed.',
      changed: '@' + requester + ' That video has left the waiting queue.',
    };
    await sendEventSubChatReply(event, replies[outcome] || replies.changed);
    return { handled: true, reason: 'vote_' + outcome };
  }

  if (name === 'skip') {
    if (!staff) {
      await sendEventSubChatReply(event, '@' + requester + ' Only a moderator or broadcaster can use !skip.');
      return { handled: true, reason: 'skip_unauthorized' };
    }
    const items = await readRoomQueue(db, appId);
    const queued = sortedQueue(items.filter((item) => item.status === 'queue'));
    const playing = items.find((item) => item.status === 'playing') || queued[0] || null;
    if (!playing) {
      await sendEventSubChatReply(event, '@' + requester + ' Nothing is playing.');
      return { handled: true, reason: 'skip_empty' };
    }
    const nextOne = queued.find((item) => String(item.id) !== String(playing.id)) || null;
    const playingRef = db.doc(queuePath(appId) + '/' + playing.id);
    const nextRef = nextOne ? db.doc(queuePath(appId) + '/' + nextOne.id) : null;
    const activity = activityEvent({ id: eventId, type: 'track_skipped', at, item: playing, requester });
    const outcome = await db.runTransaction(async (tx) => {
      const reads = [tx.get(settingsRef), tx.get(playingRef), tx.get(activityRef)];
      if (nextRef) reads.push(tx.get(nextRef));
      const snapshots = await Promise.all(reads);
      const settingsSnap = snapshots[0];
      const playingSnap = snapshots[1];
      const priorEvent = snapshots[2];
      const nextSnap = nextRef ? snapshots[3] : null;
      if (priorEvent.exists) return 'duplicate';
      if (!playingSnap.exists) return 'changed';
      const settings = settingsSnap.exists ? settingsSnap.data() : {};
      tx.update(playingRef, {
        status: 'watched', watchedAt: new Date(at).toISOString(), playedAt: at, nextTrackOverrideId: null,
      });
      if (nextRef && nextSnap?.exists && nextSnap.data()?.status === 'queue') {
        tx.update(nextRef, { status: 'playing', playedAt: at + 1, pinned: false, nextTrackOverrideId: null });
      }
      tx.create(activityRef, activity);
      tx.set(settingsRef, versionUpdate(settings, at), { merge: true });
      return 'skipped';
    });
    await sendEventSubChatReply(event, outcome === 'skipped'
      ? '@' + requester + ' Skipped "' + String(playing.title || 'video').slice(0, 30) + '". ' +
        (nextOne ? 'Now playing "' + String(nextOne.title || 'next video').slice(0, 30) + '".' : 'The queue is empty.')
      : '@' + requester + ' The skip command was already processed or playback changed.');
    return { handled: true, reason: 'skip_' + outcome };
  }

  return { ignored: true, reason: 'unsupported_command' };
}

async function processChatMediaRequest({ db, appId, event, messageId, requester, rawText, extractedUrl }) {
  const isAssrCommand = /^!assr(?:\s|$)/i.test(rawText);
  const requestText = rawText.replace(/^!assr\s*/i, '').trim();
  const timestampRequest = stripMediaTimestampSuffix(requestText);
  const searchTitle = timestampRequest.text || requestText;
  if (!extractedUrl && (!isAssrCommand || searchTitle.length < 2)) return { ignored: true };

  const origin = getPublicOrigin();
  const settingsRef = db.doc(settingsPath(appId));
  const settingsSnapshot = await settingsRef.get();
  const settings = settingsSnapshot.exists && settingsSnapshot.data()?.streamSettings &&
    typeof settingsSnapshot.data().streamSettings === 'object' ? settingsSnapshot.data().streamSettings : {};
  if (settings.queueOpen === false) {
    await sendEventSubChatReply(event, '@' + requester + ' Requests are closed.');
    return { ignored: true, reason: 'queue_closed' };
  }

  let normalizedUrl = extractedUrl || requestText;
  let title = '';
  let searchThumbnail = '';
  if (!extractedUrl) {
    const searchUrl = new URL('/api/search-youtube?q=' + encodeURIComponent(searchTitle.slice(0, 180)), origin);
    let searchResponse;
    try {
      searchResponse = await fetch(searchUrl, { cache: 'no-store', signal: AbortSignal.timeout(5800) });
    } catch {
      throw new Error('YouTube title search timed out');
    }
    const searchResult = await searchResponse.json().catch(() => ({}));
    if (!searchResponse.ok || !Array.isArray(searchResult.results) || !searchResult.results.length) {
      await sendEventSubChatReply(event, '@' + requester + ' No YouTube match. Try a shorter title or direct URL.');
      return { ignored: true, reason: 'youtube_search_unavailable' };
    }
    normalizedUrl = String(searchResult.results[0].url || '');
    title = String(searchResult.results[0].title || '').slice(0, 180);
    searchThumbnail = String(searchResult.results[0].thumbnail || '');
  }

  let parsed = parseMediaUrl(normalizedUrl);
  if (!normalizedUrl.startsWith('https://') || !parsed.platform) throw new Error('Request URL is invalid');
  const tiktok = await resolveTiktokIfNeeded(normalizedUrl, parsed, origin, event, requester);
  if (!tiktok) return { ignored: true, reason: 'invalid_tiktok' };
  normalizedUrl = tiktok.url;
  parsed = tiktok.parsed;
  const metadataUrl = tiktok.metadataUrl;

  const allowedBySettings = parsed.platform === 'youtube'
    ? settings.allowYouTube !== false
    : parsed.platform === 'tiktok'
      ? settings.allowTikTok !== false
      : (parsed.platform === 'twitch' || parsed.platform === 'kick')
        ? settings.allowTwitch !== false
        : true;
  if (!allowedBySettings) {
    await sendEventSubChatReply(event, '@' + requester + ' Requests for this platform are disabled by the streamer.');
    return { ignored: true, reason: 'platform_disabled' };
  }

  const metadata = await getJson(
    new URL('/api/media-metadata?url=' + encodeURIComponent(metadataUrl || normalizedUrl), origin), 1600
  );
  if (!title && typeof metadata?.title === 'string') title = metadata.title.trim().slice(0, 180);
  const thumbnail = String(metadata?.thumbnailUrl || searchThumbnail || parsed.thumbnail || '');
  const candidateDuration = Number(metadata?.durationSec);
  const durationSec = Number.isFinite(candidateDuration) && candidateDuration > 0 && candidateDuration <= 86400
    ? Math.round(candidateDuration) : 0;
  const cleanTitle = title || (
    parsed.platform === 'youtube' ? 'YouTube Media (' + parsed.videoId + ')' :
    parsed.platform === 'twitch' ? 'Twitch Clip (' + parsed.videoId + ')' :
    parsed.platform === 'tiktok' ? 'TikTok Short Clip' :
    parsed.platform === 'kick' ? 'Kick Clip (' + parsed.videoId + ')' : 'Community Requested Media'
  );
  const note = 'Requested via Twitch chat';
  const detectedCategory = detectVideoCategory(normalizedUrl, cleanTitle, note, 'all');
  const mediaType = detectMusicType(normalizedUrl, cleanTitle, note, detectedCategory);
  const category = mediaType === 'Music' ? 'Music' : detectedCategory;
  const requestedAt = Date.now();
  const identityKey = getMediaIdentityKey(parsed.platform, parsed.videoId, normalizedUrl);
  const itemId = getStableMediaDocumentId(PRIVATE_CHANNEL + '|' + identityKey);
  const itemRef = db.doc(queuePath(appId) + '/' + itemId);
  const eventId = eventDocumentId(messageId);
  const eventRef = db.doc(eventsPath(appId) + '/' + eventId);
  const startSeconds = parsed.platform === 'youtube'
    ? (parseMediaStartSeconds(rawText) || parseMediaStartSeconds(normalizedUrl) || timestampRequest.startSeconds || 0) : 0;
  const item = {
    id: itemId, identityKey, channelRoom: PRIVATE_CHANNEL, title: cleanTitle, url: normalizedUrl,
    metadataUrl: metadataUrl || normalizedUrl, platform: parsed.platform, videoId: String(parsed.videoId || ''),
    category, categoryManuallySet: false, mediaType,
    duration: durationSec ? formatDuration(durationSec) : '',
    durationSource: durationSec ? 'metadata' : 'unknown',
    requestedBy: requester, userRole: 'viewer', status: 'queue', upvotes: 0, voters: [], pinned: false,
    addedAt: new Date(requestedAt).toISOString(), queueOrder: requestedAt * 1000, timestamp: requestedAt,
    startSeconds, note, thumbnail,
    isVertical: parsed.platform === 'tiktok' || normalizedUrl.toLowerCase().includes('youtube.com/shorts/'),
    createdAt: requestedAt,
  };
  if (durationSec) item.durationSec = durationSec;
  const activity = activityEvent({ id: eventId, type: 'request_added', at: requestedAt, item, requester });

  // A settings-document version is incremented in the same transaction as the queue
  // write; concurrent EventSub additions serialize rather than each trusting a stale snapshot.
  const outcome = await db.runTransaction(async (tx) => {
    const [settingsSnap, itemSnap, eventSnap] = await Promise.all([
      tx.get(settingsRef), tx.get(itemRef), tx.get(eventRef),
    ]);
    if (eventSnap.exists) return { result: 'duplicate_delivery' };
    const latestSettings = settingsSnap.exists ? settingsSnap.data() : {};
    const streamSettings = latestSettings.streamSettings && typeof latestSettings.streamSettings === 'object'
      ? latestSettings.streamSettings : {};
    if (streamSettings.queueOpen === false) return { result: 'queue_closed' };
    let remainingMs = 0;
    if (itemSnap.exists) {
      const previousItem = itemSnap.data() || {};
      if (!isMediaHistoryCooldownExpired(previousItem, requestedAt)) {
        remainingMs = previousItem.status === 'watched'
          ? getMediaHistoryCooldownRemainingMs(previousItem, requestedAt) : 0;
        return { result: 'duplicate', remainingMs };
      }
    }
    const oldHealth = latestSettings.chatIntakeHealth && typeof latestSettings.chatIntakeHealth === 'object'
      ? latestSettings.chatIntakeHealth : {};
    tx.set(itemRef, item, { merge: false });
    tx.create(eventRef, activity);
    tx.set(settingsRef, versionUpdate(latestSettings, requestedAt, {
      ...oldHealth,
      lastWriteAt: requestedAt,
      lastWriteStatus: 'ok',
      lastWrittenMediaId: itemId,
      lastProcessingError: null,
    }), { merge: true });
    return { result: 'queued', id: itemId, title: cleanTitle };
  });

  if (outcome.result === 'queue_closed') {
    await sendEventSubChatReply(event, '@' + requester + ' Requests are closed.');
    return { ignored: true, reason: 'queue_closed' };
  }
  if (outcome.result === 'duplicate') {
    if (outcome.remainingMs > 0) {
      const hours = Math.max(1, Math.ceil(outcome.remainingMs / 3600000));
      await sendEventSubChatReply(event, '@' + requester + ' That video is in History; try again in about ' + hours + 'h (16-hour cooldown).');
    } else {
      await sendEventSubChatReply(event, '@' + requester + ' That video is already queued or playing.');
    }
    return { ignored: true, reason: 'duplicate' };
  }
  return { queued: outcome.result === 'queued', id: outcome.id, title: outcome.title, reason: outcome.result };
}

export async function processEventSubChatMessage({ event, messageId }) {
  const broadcaster = normalizeLogin(event?.broadcaster_user_login);
  const requester = normalizeLogin(event?.chatter_user_login);
  const rawText = String(event?.message?.text || '').trim();
  if (broadcaster !== PRIVATE_CHANNEL || !requester || !rawText || KNOWN_CHAT_BOTS.has(requester)) {
    return { ignored: true };
  }
  const extractedUrl = extractSupportedMediaUrl(rawText);
  const isAssrCommand = /^!assr(?:\s|$)/i.test(rawText);
  if (extractedUrl || isAssrCommand) {
    return processChatMediaRequest({
      db: await getFirebaseAdminDb(),
      appId: getFirebaseNamespace(),
      event, messageId, requester, rawText, extractedUrl,
    });
  }
  return processCloudChatCommand({
    db: await getFirebaseAdminDb(),
    appId: getFirebaseNamespace(),
    event, messageId, requester, rawText,
  });
}
