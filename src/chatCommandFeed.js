// Queue mutations already happened on the server; apply only browser audio and fallback replies.
async function applyFeed(feed, context) {
  const { login, connected, authenticated, loaded, seen, storage, claim, audio, reply, error, now = Date.now() } = context;
  if (!authenticated || !loaded || !Array.isArray(feed)) return;
  for (const packet of feed) {
    if (!packet || typeof packet.id !== 'string' || !packet.id || !Number.isFinite(packet.at) || now - packet.at > 120000 || packet.at > now + 5000) continue;
    const kind = login === '2o3a' && packet.volumeCommand ? 'audio'
      : login === 'paim_beach_pete' && connected && typeof packet.reply === 'string' && packet.reply.trim() ? 'reply' : '';
    if (!kind) continue;
    const key = ['whale-cum:chat-command:v1', login, kind, packet.id].join(':');
    if (seen.has(key)) continue;
    try { if (storage.getItem(key)) { seen.add(key); continue; } } catch { /* Durable claim still prevents duplicate tabs. */ }
    seen.add(key);
    try {
      const claimed = await claim(packet.id, kind);
      if (claimed) {
        if (kind === 'audio') audio(packet.volumeCommand);
        else reply(packet.reply);
      }
      try { storage.setItem(key, '1'); } catch { /* Memory and durable claim remain authoritative. */ }
    } catch (failure) {
      seen.delete(key);
      error(failure);
    }
  }
}

const queues = new WeakMap();
export function consumeChatCommandFeed(feed, context) {
  const previous = queues.get(context.seen) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => applyFeed(feed, context));
  queues.set(context.seen, pending);
  return pending;
}
