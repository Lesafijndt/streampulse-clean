import { extractSupportedMediaUrl } from '../../src/chatCommands.js';
import {
  detectMusicType,
  detectVideoCategory,
  getMediaIdentityKey,
  getStableMediaDocumentId,
  parseMediaUrl,
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

async function resolveTiktokIfNeeded(url, parsed, origin) {
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
    await sendEventSubChatReply({ broadcaster_user_id: PRIVATE_CHANNEL }, 'TikTok link failed; try the full /video/ URL.');
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

export async function processEventSubChatMessage({ event, messageId }) {
  const broadcaster = normalizeLogin(event?.broadcaster_user_login);
  const requester = normalizeLogin(event?.chatter_user_login);
  const rawText = String(event?.message?.text || '').trim();
  if (broadcaster !== PRIVATE_CHANNEL || !requester || !rawText) return { ignored: true };
  if (KNOWN_CHAT_BOTS.has(requester)) return { ignored: true };

  const extractedUrl = extractSupportedMediaUrl(rawText);
  const isAssrCommand = /^!assr(?:\\s|$)/i.test(rawText);
  if (!extractedUrl && !isAssrCommand) return { ignored: true };

  const requestText = rawText.replace(/^!assr\\s*/i, '').trim();
  if (!extractedUrl && requestText.length < 2) return { ignored: true };

  const db = await getFirebaseAdminDb();
  const appId = getFirebaseNamespace();
  const origin = getPublicOrigin();

  const settingsRef = db.doc(`artifacts/${appId}/public/data/room_settings/${PRIVATE_CHANNEL}`);
  const settingsSnapshot = await settingsRef.get();
  const streamSettings = settingsSnapshot.exists && settingsSnapshot.data()?.streamSettings &&
    typeof settingsSnapshot.data().streamSettings === 'object'
    ? settingsSnapshot.data().streamSettings
    : {};

  if (streamSettings.queueOpen === false) {
    await sendEventSubChatReply(event, `@${requester} Requests are closed.`);
    return { ignored: true, reason: 'queue_closed' };
  }

  let normalizedUrl = extractedUrl || requestText;
  let title = '';
  let searchThumbnail = '';
  if (!extractedUrl) {
    const searchUrl = new URL('/api/search-youtube?q=' + encodeURIComponent(requestText.slice(0, 180)), origin);
    let searchResponse;
    try {
      searchResponse = await fetch(searchUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5800),
      });
    } catch {
      throw new Error('YouTube title search timed out');
    }
    const searchResult = await searchResponse.json().catch(() => ({}));
    if (!searchResponse.ok || !Array.isArray(searchResult.results) || !searchResult.results.length) {
      // Mirror the old bridge's user feedback rather than asking EventSub to redeliver
      // the same unsearchable title repeatedly. A direct URL remains the reliable option.
      await sendEventSubChatReply(event, `@${requester} Search unavailable; try a direct URL.`);
      return { ignored: true, reason: 'youtube_search_unavailable' };
    }
    normalizedUrl = String(searchResult.results[0].url || '');
    title = String(searchResult.results[0].title || '').slice(0, 180);
    searchThumbnail = String(searchResult.results[0].thumbnail || '');
  }

  let parsed = parseMediaUrl(normalizedUrl);
  if (!normalizedUrl.startsWith('https://') || !parsed.platform) {
    throw new Error('Request URL is invalid');
  }
  const tiktok = await resolveTiktokIfNeeded(normalizedUrl, parsed, origin);
  if (!tiktok) return { ignored: true, reason: 'invalid_tiktok' };
  normalizedUrl = tiktok.url;
  parsed = tiktok.parsed;
  const metadataUrl = tiktok.metadataUrl;

  const allowedBySettings = parsed.platform === 'youtube'
    ? streamSettings.allowYouTube !== false
    : parsed.platform === 'tiktok'
      ? streamSettings.allowTikTok !== false
      : (parsed.platform === 'twitch' || parsed.platform === 'kick')
        ? streamSettings.allowTwitch !== false
        : true;
  if (!allowedBySettings) {
    await sendEventSubChatReply(event, `@${requester} Requests for this platform are disabled by the streamer.`);
    return { ignored: true, reason: 'platform_disabled' };
  }

  // Metadata enriches the queue item when it is quick, but a slow provider must not
  // prevent Twitch EventSub from receiving an acknowledgement in time.
  const metadataUrlForLookup = new URL('/api/media-metadata?url=' + encodeURIComponent(metadataUrl || normalizedUrl), origin);
  const metadata = await getJson(metadataUrlForLookup, 1600);
  if (!title && typeof metadata?.title === 'string') title = metadata.title.trim().slice(0, 180);
  const thumbnail = String(metadata?.thumbnailUrl || searchThumbnail || parsed.thumbnail || '');
  const candidateDuration = Number(metadata?.durationSec);
  const durationSec = Number.isFinite(candidateDuration) && candidateDuration > 0 && candidateDuration <= 86400
    ? Math.round(candidateDuration)
    : 0;

  const cleanTitle = title || (
    parsed.platform === 'youtube' ? `YouTube Media (${parsed.videoId})` :
    parsed.platform === 'twitch' ? `Twitch Clip (${parsed.videoId})` :
    parsed.platform === 'tiktok' ? 'TikTok Short Clip' :
    parsed.platform === 'kick' ? `Kick Clip (${parsed.videoId})` :
    'Community Requested Media'
  );
  const note = 'Requested via Twitch chat';
  const detectedCategory = detectVideoCategory(normalizedUrl, cleanTitle, note, 'all');
  const mediaType = detectMusicType(normalizedUrl, cleanTitle, note, detectedCategory);
  const category = mediaType === 'Music' ? 'Music' : detectedCategory;
  const requestedAt = Date.now();
  const identityKey = getMediaIdentityKey(parsed.platform, parsed.videoId, normalizedUrl);
  const itemId = getStableMediaDocumentId(`${PRIVATE_CHANNEL}|${identityKey}`);
  const itemRef = db.doc(`artifacts/${appId}/public/data/queue_videos/${itemId}`);
  const eventId = `eventsub-${String(messageId || itemId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 105)}`;
  const eventRef = db.doc(`artifacts/${appId}/public/data/queue_events/${eventId}`);

  const item = {
    id: itemId,
    channelRoom: PRIVATE_CHANNEL,
    title: cleanTitle,
    url: normalizedUrl,
    metadataUrl: metadataUrl || normalizedUrl,
    platform: parsed.platform,
    videoId: String(parsed.videoId || ''),
    category,
    categoryManuallySet: false,
    mediaType,
    duration: durationSec ? formatDuration(durationSec) : '',
    durationSource: durationSec ? 'metadata' : 'unknown',
    requestedBy: requester,
    userRole: 'viewer',
    status: 'queue',
    upvotes: 0,
    voters: [],
    pinned: false,
    addedAt: new Date(requestedAt).toISOString(),
    // Keep server-ingested items at the tail of the numeric queue order. Client-side
    // additions then append using getNextQueueOrder() without jumping ahead of webhook items.
    queueOrder: requestedAt * 1000,
    timestamp: requestedAt,
    note,
    thumbnail,
    isVertical: parsed.platform === 'tiktok' || normalizedUrl.toLowerCase().includes('youtube.com/shorts/'),
    createdAt: requestedAt,
  };
  if (durationSec) item.durationSec = durationSec;

  const activity = {
    id: eventId,
    type: 'request_added',
    room: PRIVATE_CHANNEL,
    at: requestedAt,
    sessionId: 'twitch-eventsub',
    mediaId: itemId,
    title: cleanTitle.slice(0, 180),
    requester: requester.slice(0, 64),
    actor: requester.slice(0, 64),
    platform: String(parsed.platform || 'external').slice(0, 32),
    category: String(category || 'General').slice(0, 64),
    source: 'twitch-chat',
  };

  // Queue item + stats event are committed atomically. Stable media IDs mean a
  // duplicate delivery or a simultaneous browser request cannot make two queue rows.
  const batch = db.batch();
  batch.create(itemRef, item);
  batch.create(eventRef, activity);
  try {
    await batch.commit();
    return { queued: true, id: itemId, title: cleanTitle };
  } catch (error) {
    if (isAlreadyExists(error)) {
      // A repeated webhook delivery for the same Twitch message ID is silent; a distinct
      // chat message for an already-requested video gets the same feedback as the old bridge.
      const priorEvent = await eventRef.get().catch(() => null);
      if (priorEvent?.exists) return { ignored: true, reason: 'duplicate_delivery' };
      await sendEventSubChatReply(event, `@${requester} That video has already been requested.`);
      return { ignored: true, reason: 'duplicate' };
    }
    console.error('Twitch EventSub queue write failed:', {
      code: String(error?.code || 'unknown'),
      message: String(error?.message || error).slice(0, 500),
    });
    throw error;
  }
}
