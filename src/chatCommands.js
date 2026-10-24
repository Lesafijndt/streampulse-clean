const MEDIA_LINK_PATTERN = /(?<![\w.-])(?:https?:\/\/)?(?:(?:www|m)\.)?(?:music\.youtube\.com|youtube\.com|youtu\.be|vm\.tiktok\.com|vt\.tiktok\.com|tiktok\.com|clips\.twitch\.tv|twitch\.tv|clip\.kick\.com|kick\.com)\/[^\s<>"']+/gi;
const ALLOWED_MEDIA_HOSTS = new Set([
  'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
  'twitch.tv', 'clips.twitch.tv', 'kick.com', 'clip.kick.com',
]);

function decodeIrcTagValue(value = '') {
  return String(value)
    .replace(/\\s/g, ' ')
    .replace(/\\:/g, ';')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
}

/**
 * Twitch may batch multiple IRC commands (including PING and several PRIVMSGs)
 * into one WebSocket message. Always process the individual CRLF-delimited lines.
 */
export function splitTwitchIrcFrame(frame = '') {
  return String(frame || '')
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Parse one Twitch IRC PRIVMSG line without losing chat text after its first colon. */
export function parseTwitchPrivmsgLine(line = '') {
  const raw = String(line || '').trim();
  let rest = raw;
  let tags = {};

  if (rest.startsWith('@')) {
    const separator = rest.indexOf(' ');
    if (separator < 0) return null;
    const encodedTags = rest.slice(1, separator);
    tags = Object.fromEntries(encodedTags.split(';').filter(Boolean).map((entry) => {
      const equalsAt = entry.indexOf('=');
      const key = equalsAt >= 0 ? entry.slice(0, equalsAt) : entry;
      const value = equalsAt >= 0 ? entry.slice(equalsAt + 1) : '';
      return [key, decodeIrcTagValue(value)];
    }));
    rest = rest.slice(separator + 1);
  }

  if (!rest.startsWith(':')) return null;
  const commandStart = rest.indexOf(' PRIVMSG #');
  if (commandStart < 0) return null;
  const login = rest.slice(1, commandStart).split('!')[0].trim();
  if (!login) return null;

  const payload = rest.slice(commandStart + ' PRIVMSG #'.length);
  const bodyStart = payload.indexOf(' :');
  if (bodyStart < 0) return null;
  const channel = payload.slice(0, bodyStart).trim();
  if (!channel) return null;

  return {
    tags,
    login,
    channel,
    text: payload.slice(bodyStart + 2),
  };
}

/**
 * Find supported media links anywhere in a chat message, including a sentence
 * around the URL, and normalize naked host/path links to an https URL.
 */
/** Collect distinct video links in the order Twitch delivered them.
 * A single chatter may paste several URLs in one message; do not silently
 * discard all but the first. Limit per-message parsing for safety. */
export function extractSupportedMediaUrls(rawText = '', maxLinks = 8) {
  const text = String(rawText || '').replace(/[\u200b-\u200d\ufeff]/g, '');
  const matches = text.matchAll(new RegExp(MEDIA_LINK_PATTERN.source, 'gi'));
  const urls = [];
  const seen = new Set();
  for (const match of matches) {
    const candidate = String(match[0] || '').replace(/[.,!?;:)\]}>']+$/g, '');
    if (!candidate) continue;
    try {
      const normalized = /^https?:\/\//i.test(candidate) ? candidate : 'https://' + candidate;
      const parsed = new URL(normalized);
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (!['http:', 'https:'].includes(parsed.protocol) || !ALLOWED_MEDIA_HOSTS.has(hostname)) continue;
      if (seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      urls.push(parsed.href);
      if (urls.length >= Math.max(1, Math.min(8, Number(maxLinks) || 8))) break;
    } catch {
      // Keep scanning for valid media URLs after malformed links.
    }
  }
  return urls;
}

export function extractSupportedMediaUrl(rawText = '') {
  return extractSupportedMediaUrls(rawText, 1)[0] || '';
}

export function isSupportedMediaUrlMessage(rawText = '') {
  return Boolean(extractSupportedMediaUrl(rawText));
}


/** Twitch Block Hyperlinks may hold a viewer's URLs before EventSub sees them.
 * A !assr command with an 11-character YouTube ID provides a link-free fallback.
 * The command must still be delivered by Twitch moderation.
 */
export function linkFreeYouTubeRequestUrl(rawText = '') {
  const match = String(rawText || '').trim().match(/^!assr\s+(?:(?:yt|youtube)\s+)?([A-Za-z0-9_-]{11})\s*$/i);
  return match ? 'https://www.youtube.com/watch?v=' + match[1] : '';
}

/** Twitch may put the actual link in message.fragments even if message.text
 * was normalized. Select the representation containing the media link. */
export function getTwitchMessageText(message = {}) {
  const raw = String(message?.text || '').trim();
  const fragments = Array.isArray(message?.fragments)
    ? message.fragments.map((part) => String(part?.text || '')).join('').trim()
    : '';
  if (fragments && !extractSupportedMediaUrl(raw) && extractSupportedMediaUrl(fragments)) return fragments;
  return raw || fragments;
}
