import { randomUUID } from 'node:crypto';
import { extractSupportedMediaUrl } from '../../src/chatCommands.js';
import { classifyFirebaseHealthError } from './firebase-health-diagnostic.js';
import { processEventSubChatMessage } from './cloud-chat-requests.js';

const requestWindowMs = 60_000;
const maxRequestsPerWindow = 5;
const requestAttempts = new Map();

function sendJson(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(status).json(body);
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

function checkRateLimit(key, now = Date.now()) {
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
  if (current.count >= maxRequestsPerWindow) return false;
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

  const requester = getRequester(body.requestedBy);
  if (!checkRateLimit(getClientKey(req))) {
    return sendJson(res, 429, {
      ok: false,
      code: 'rate_limited',
      message: 'Too many requests from this connection. Wait a minute and try again.',
    });
  }

  const title = String(body.title || '').replace(/[\\u0000-\\u001f\\u007f]/g, ' ').trim().slice(0, 180);
  const note = String(body.note || '').replace(/[\\u0000-\\u001f\\u007f]/g, ' ').trim().slice(0, 300);
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

  try {
    const result = await processEventSubChatMessage({
      event: {
        broadcaster_user_login: '2o3a',
        chatter_user_login: requester,
        message: { text: url },
        source: 'website',
      },
      messageId: 'website-' + randomUUID(),
      requestOptions: { source: 'website', title, note, category, startSeconds },
    });

    if (result?.queued) {
      return sendJson(res, 201, {
        ok: true,
        id: result.id,
        title: result.title || title || 'Video request',
        requestedBy: requester,
      });
    }

    const reasons = {
      queue_closed: 'Requests are currently closed by the streamer.',
      duplicate: 'That video is already queued or playing, or is still in its history cooldown.',
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
      message: String(error?.message || error).slice(0, 240),
    });
    return sendJson(res, 503, { ok: false, code, message });
  }
}
