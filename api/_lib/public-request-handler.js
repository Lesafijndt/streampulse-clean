import { randomUUID } from 'node:crypto';
import { extractSupportedMediaUrl } from '../../src/chatCommands.js';
import { classifyFirebaseHealthError } from './firebase-health-diagnostic.js';
import { processEventSubChatMessage } from './cloud-chat-requests.js';

const requestWindowMs = 60_000;
const maxRequestsPerWindow = 120;
const maxGuestRequestsPerWindow = 120;
const ALLOWED_STAFF = new Set(['2o3a', 'paim_beach_pete']);
const REMEMBERED_SESSION_MAX_AGE = 60 * 60 * 24 * 400;
const requestAttempts = new Map();

function sendJson(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(status).json(body);
}

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((value) => value.trim()).filter(Boolean).map((value) => {
    const index = value.indexOf('=');
    try { return [value.slice(0, index), decodeURIComponent(value.slice(index + 1))]; }
    catch { return [value.slice(0, index), '']; }
  }));
}

function appendCookie(res, value) {
  const previous = res.getHeader?.('Set-Cookie');
  const list = previous ? (Array.isArray(previous) ? previous : [previous]) : [];
  res.setHeader('Set-Cookie', [...list, value]);
}

function setStaffCookie(res, name, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

async function validateStaffRequest(req, res) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId) return null;
  const cookies = parseCookies(req.headers.cookie);
  let accessToken = cookies.yedi_twitch_access || '';
  let refreshToken = cookies.yedi_twitch_refresh || '';

  const validate = async (token) => {
    if (!token) return null;
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${token}` },
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    return response.ok ? response.json().catch(() => null) : null;
  };

  let identity = await validate(accessToken);
  if (!identity && refreshToken && clientSecret) {
    const refreshedResponse = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(6500),
      cache: 'no-store',
    });
    const refreshed = await refreshedResponse.json().catch(() => ({}));
    if (refreshedResponse.ok && refreshed.access_token) {
      accessToken = refreshed.access_token;
      if (refreshed.refresh_token) refreshToken = refreshed.refresh_token;
      identity = await validate(accessToken);
    }
  }

  const login = String(identity?.login || '').toLowerCase();
  if (!identity || identity.client_id !== clientId || !ALLOWED_STAFF.has(login)) return null;
  setStaffCookie(res, 'yedi_twitch_access', accessToken, Math.max(1, Math.min(Number(identity.expires_in) || 14400, 14400)));
  if (refreshToken) setStaffCookie(res, 'yedi_twitch_refresh', refreshToken, REMEMBERED_SESSION_MAX_AGE);
  return { login, userId: String(identity.user_id || '') };
}

function getRequester(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 25) || 'web_viewer';
}

function getClientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.socket?.remoteAddress || req.headers['x-real-ip'] || 'unknown');
}

function isSameOriginRequest(req) {
  const suppliedOrigin = String(req.headers.origin || '').trim();
  if (!suppliedOrigin) return true;
  try {
    const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!host) return false;
    return new URL(suppliedOrigin).origin === new URL(protocol + '://' + host).origin;
  } catch {
    return false;
  }
}

function checkRateLimit(key, now = Date.now(), maxAttempts = maxRequestsPerWindow) {
  const current = requestAttempts.get(key);
  if (!current || now - current.startedAt >= requestWindowMs) {
    requestAttempts.set(key, { startedAt: now, count: 1 });
    if (requestAttempts.size > 2000) {
      for (const [candidate, value] of requestAttempts) {
        if (now - value.startedAt >= requestWindowMs) requestAttempts.delete(candidate);
      }
    }
    return true;
  }
  if (current.count >= maxAttempts) return false;
  current.count += 1;
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: 'Use POST to submit a video request.' });
  }
  if (!isSameOriginRequest(req)) {
    return sendJson(res, 403, { ok: false, code: 'origin_not_allowed', message: 'Requests must be submitted from this site.' });
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};
  const rawUrl = String(body.url || '').trim().slice(0, 2048);
  const url = extractSupportedMediaUrl(rawUrl);
  if (!url) {
    return sendJson(res, 400, {
      ok: false,
      code: 'unsupported_media_url',
      message: 'Enter a supported YouTube, TikTok, Twitch Clip, or Kick Clip URL.',
    });
  }

  const suppliedRequester = getRequester(body.requestedBy);

  const title = String(body.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180);
  const note = String(body.note || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
  const category = ['Music', 'Gaming', 'Memes', 'Clips', 'IRL'].includes(body.category) ? body.category : 'Auto';
  const startValue = body.startSeconds;
  const startSeconds = startValue === null || startValue === undefined || startValue === ''
    ? null
    : Number(startValue);
  if (startSeconds !== null && (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 86400)) {
    return sendJson(res, 400, {
      ok: false,
      code: 'invalid_start_time',
      message: 'The start time must be between 0 and 24 hours.',
    });
  }

  let staff;
  try {
    staff = await validateStaffRequest(req, res);
  } catch (error) {
    console.error('Could not validate queue writer session:', String(error?.message || error).slice(0, 240));
  }
  // The dashboard is staff-only, but its request form is visible to viewers.
  // A visitor can add a video only through this narrow server-side endpoint:
  // never accept their claimed identity, elevated source or any Firebase credentials.
  // Unlike authenticated Twitch chat, a website guest is not verified by Twitch.
  if (!staff && (!req.headers.origin || !isSameOriginRequest(req))) {
    return sendJson(res, 403, {
      ok: false, code: 'guest_origin_required',
      message: 'Open the official dashboard URL to submit a viewer request.',
    });
  }
  const guest = !staff;
  const requester = staff ? suppliedRequester : 'web_viewer';
  // Twitch chat is already governed by Twitch's moderation and anti-spam rules.
  // Do not funnel hundreds of individual viewers into one moderator IP/session
  // throttle: two different chat requests a second apart must both proceed.
  const source = staff && String(body.source || '') === 'twitch-chat-bridge' ? 'twitch-chat-bridge' : 'website';
  if (source !== 'twitch-chat-bridge') {
    const rateKey = guest ? 'guest:' + getClientKey(req) : 'staff:' + staff.login;
    if (!checkRateLimit(rateKey, Date.now(), guest ? maxGuestRequestsPerWindow : maxRequestsPerWindow)) {
      res.setHeader('Retry-After', '60');
      return sendJson(res, 429, {
        ok: false,
        code: 'rate_limited',
        message: 'The website request endpoint is receiving unusually many submissions. Try again shortly.',
      });
    }
  }
  // Website guests still have no staff access. The bot/moderator bridge alone
  // can request an elevated source flag, after an approved Twitch staff login.

  try {
    const result = await processEventSubChatMessage({
      event: {
        broadcaster_user_login: '2o3a',
        chatter_user_login: requester,
        message: { text: url },
        source,
      },
      messageId: source + '-' + randomUUID(),
      requestOptions: { source, title, note, category, startSeconds },
    });

    if (result?.queued) {
      return sendJson(res, 201, {
        ok: true,
        id: result.id,
        title: result.title || title || 'Video request',
        requestedBy: requester,
        source,
      });
    }

    const reasons = {
      queue_closed: 'Requests are currently closed by the streamer.',
      duplicate: 'That video is already queued or playing.',
      platform_disabled: 'The streamer has disabled requests from this platform.',
      invalid_tiktok: 'Could not resolve that TikTok link. Try the full video URL.',
      youtube_search_unavailable: 'No YouTube match was found. Try a direct video URL.',
    };
    const reason = String(result?.reason || 'request_not_added');
    const status = reason === 'queue_closed' || reason === 'duplicate' ? 409 : 400;
    return sendJson(res, status, {
      ok: false,
      code: reason,
      message: reasons[reason] || 'This video could not be added. Check the URL and try again.',
    });
  } catch (error) {
    const health = classifyFirebaseHealthError(error);
    const phase = String(error?.queuePhase || 'processing').replace(/[^a-z0-9_]/g, '').slice(0, 40);
    const code = /Request URL is invalid|unsupported/i.test(String(error?.message || ''))
      ? 'unsupported_media_url'
      : health.code;
    const message = code === 'firestore_quota_exceeded'
      ? 'The shared queue database has reached a Firestore quota or rate limit. Requests cannot be confirmed until Firebase accepts writes again.'
      : code === 'firestore_permission_denied'
        ? 'The shared queue database denied the request. The server Firebase permissions need attention.'
        : code === 'unsupported_media_url'
          ? 'Enter a supported YouTube, TikTok, Twitch Clip, or Kick Clip URL.'
          : 'The shared queue could not save this request. Check the connection diagnostics and try again.';
    console.error('Public video request could not be queued:', {
      code: health.code,
      phase,
      grpcCode: String(error?.code ?? '').slice(0, 20),
      message: String(error?.message || error).slice(0, 240),
    });
    return sendJson(res, 503, { ok: false, code, phase,
      message: code === 'firestore_health_check_failed'
        ? 'Request failed during ' + phase + '. The server logs have the underlying error.' : message,
    });
  }
}
