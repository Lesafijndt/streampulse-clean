/** Keep the local fallback limited to the allowlisted moderator session. */
export function canHostLocalChatBridge(session) {
  const username = String(session?.username || '').trim().toLowerCase().replace(/^@/, '');
  return session?.authenticated === true &&
    session?.role === 'moderator' &&
    username === 'paim_beach_pete';
}
