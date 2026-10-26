// Minimal, pure Twitch EventSub message decoder. Never trust a chat message's
// claimed moderator role; derive it only from Twitch's signed-in event badges.
export function parseChatNotification(frame) {
  if (frame?.metadata?.message_type !== 'notification') return null;
  if (frame?.payload?.subscription?.type !== 'channel.chat.message') return null;
  const event = frame.payload.event || {};
  if (String(event.broadcaster_user_login || '').toLowerCase() !== '2o3a') return null;
  const login = String(event.chatter_user_login || '').toLowerCase().trim();
  if (!/^[a-z0-9_]{1,25}$/.test(login) || login === 'gachibot69') return null;
  const plainText = String(event.message?.text || '').trim();
  const fragments = Array.isArray(event.message?.fragments)
    ? event.message.fragments.map(part => String(part?.text || '')).join('').trim() : '';
  const text = plainText || fragments;
  if (!text) return null;
  const badges = Array.isArray(event.badges) ? event.badges.map(b => String(b?.set_id || '')) : [];
  const role = badges.includes('broadcaster') ? 'streamer' :
    badges.includes('moderator') || event.chatter_is_moderator === true ? 'moderator' :
    badges.includes('vip') ? 'vip' :
    badges.includes('subscriber') ? 'subscriber' : 'viewer';
  return {
    id: String(event.message_id || frame.metadata?.message_id || ''),
    login, role, text,
  };
}

export function requestLikeChatMessage(text = '') {
  const content = String(text).trim();
  return /^!assr(?:\s|$)/i.test(content) ||
    /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|m\.youtube\.com|music\.youtube\.com|youtu\.be|tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|twitch\.tv|clips\.twitch\.tv|kick\.com|clip\.kick\.com)\//i.test(content);
}

// Call only with identity decoded from Twitch, never a role claimed in chat text.
export function maySkipCurrentRequest(identity, video) {
  const login = String(identity?.login || '').trim().toLowerCase();
  if (!login || login === 'gachibot69') return false;
  if (login === '2o3a' || ['streamer','moderator'].includes(identity?.role)) return true;
  return video?.channelRoom === '2o3a' && video?.status === 'playing' &&
    String(video.requestedBy || '').trim().replace(/^@/, '').toLowerCase() === login;
}
