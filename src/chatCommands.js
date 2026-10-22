const MEDIA_LINK_PATTERN = /(?<![\\w.-])(?:https?:\\/\\/)?(?:(?:www|m)\\.)?(?:music\\.youtube\\.com|youtube\\.com|youtu\\.be|vm\\.tiktok\\.com|vt\\.tiktok\\.com|tiktok\\.com|clips\\.twitch\\.tv|twitch\\.tv|clip\\.kick\\.com|kick\\.com)\\/[^\\s<>"'`]+/gi;
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
export function extractSupportedMediaUrl(rawText = '') {
  const text = String(rawText || '');
  const matches = text.matchAll(new RegExp(MEDIA_LINK_PATTERN.source, 'gi'));
  for (const match of matches) {
    // Strip sentence punctuation and closing wrappers commonly added after pasted links.
    const candidate = String(match[0] || '').replace(/[.,!?;:)\]}>\u0027"]+$/g, '');
    if (!candidate) continue;
    try {
      const normalized = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
      const parsed = new URL(normalized);
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (!['http:', 'https:'].includes(parsed.protocol) || !ALLOWED_MEDIA_HOSTS.has(hostname)) continue;
      return parsed.href;
    } catch {
      // Keep scanning in case a message contains an unrelated or malformed candidate first.
    }
  }
  return '';
}

export function isSupportedMediaUrlMessage(rawText = '') {
  return Boolean(extractSupportedMediaUrl(rawText));
}
