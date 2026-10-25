import { createHash, randomUUID } from 'node:crypto';
import { parseChatNotification } from '../src/twitchChatEvents.js';
import { buildNextTrackTransition, getDurationEstimate } from '../src/queueLogic.js';
import { getQueueNamespace } from './firebase-guard.js';
import { sendCommandReply } from './command-reply.js';
import { createActivityEvent } from '../src/activityLog.js';

export function parseServerCommand(event) {
  const incoming = parseChatNotification({ metadata: { message_type: 'notification' },
    payload: { subscription: { type: 'channel.chat.message' }, event } });
  if (!incoming) return null;
  const text = incoming.text.toLowerCase().trim();
  const volume = text.match(/^!(?:volume|vol)\s+(up|down|mute|unmute|\d{1,3})$/);
  let volumeCommand;
  if (volume) volumeCommand = /^\d+$/.test(volume[1]) ? { action: 'set', value: Math.min(100, Number(volume[1])) } : { action: volume[1] };
  else if (['!volup', '!volumeup', '!vol+'].includes(text)) volumeCommand = { action: 'up' };
  else if (['!voldown', '!volumedown', '!vol-'].includes(text)) volumeCommand = { action: 'down' };
  else if (['!mute', '!unmute'].includes(text)) volumeCommand = { action: text.slice(1) };
  const staff = ['streamer', 'moderator'].includes(incoming.role) || incoming.login === '2o3a';
  if (volumeCommand) return { ...incoming, type: 'volume', volumeCommand, permitted: staff };
  if (text === '!skip') return { ...incoming, type: 'skip', permitted: staff };
  if (['!remove', '!unrequest'].includes(text)) return { ...incoming, type: 'remove', permitted: true };
  if (['!queue', '!help', '!commands'].includes(text)) return { ...incoming, type: text === '!queue' ? 'queue' : 'help', permitted: true };
  if (['!when', '!position', '!myqueue', '!queueposition'].includes(text)) return { ...incoming, type: 'position', permitted: true };
  const vote = text.match(/^!(?:bigcock|vote)(?:\s+(\d{1,4}))?$/);
  return vote ? { ...incoming, type: 'vote', position: Math.max(1, Number(vote[1] || 1)), permitted: true } : null;
}
const order = (a, b) => Number(a.queueOrder ?? a.timestamp ?? 0) - Number(b.queueOrder ?? b.timestamp ?? 0) || Number(a.timestamp || 0) - Number(b.timestamp || 0) || String(a.id).localeCompare(String(b.id));
const title = video => String(video?.title || 'Untitled').replace(/\s+/g, ' ').slice(0, 35);
export async function persistChatCommand(db, { event, messageId }, dependencies = {}) {
  const command = parseServerCommand(event);
  if (!command) return { status: 'ignored_command', queued: 0 };
  const prefix = `artifacts/${getQueueNamespace()}/public/data/`;
  const id = 'chat-' + createHash('sha256').update('2o3a:' + String(messageId)).digest('hex');
  const receipt = db.doc(prefix + 'twitch_eventsub_receipts/' + id);
  const room = db.doc(prefix + 'room_settings/2o3a');
  const collection = db.collection(prefix + 'queue_videos');
  const now = Date.now();
  const result = await db.runTransaction(async tx => {
    const saved = await tx.get(receipt);
    if (saved.exists) return { ...saved.data(), duplicate: true };
    if (!command.permitted) {
      const denied = { status: 'command_denied', command: command.type, sender: command.login, receivedAt: now, queued: 0 };
      tx.create(receipt, denied);return denied;
    }
    const settings = (await tx.get(room)).data() || { channelRoom: '2o3a' };
    const snapshot = ['volume', 'help'].includes(command.type) ? { docs: [] } : await tx.get(collection);
    const videos = snapshot.docs.map(row => ({ ...row.data(), id: row.id })).filter(row => row.channelRoom === '2o3a');
    const queue = videos.filter(row => row.status === 'queue').sort(order);
    const playing = videos.find(row => row.status === 'playing');
    let reply = '', changed = false;
    const activity = (type, video) => tx.create(db.doc(prefix + 'queue_events/' + id + '-' + type), createActivityEvent({
      id: id + '-' + type, type, room: '2o3a', at: now, video, actor: command.login, source: 'twitch-chat-command' }));
    if (command.type === 'volume') {
      const feed = Array.isArray(settings.chatCommandFeed) ? settings.chatCommandFeed : [];
      tx.set(room, { ...settings, chatCommandFeed: [...feed.filter(entry => entry.at > now - 120000),
        { id, at: now, volumeCommand: command.volumeCommand }].slice(-30), updatedAt: now });
    } else if (command.type === 'skip' && (playing || queue[0])) {
      const transition = buildNextTrackTransition(videos, playing || queue[0], order, now);
      for (const [key, patch] of transition.updatesById) tx.set(db.doc(prefix + 'queue_videos/' + key), patch, { merge: true });
      activity('track_skipped', playing || queue[0]);
      if (transition.nextOne) activity('play_started', transition.nextOne);
      changed = true;
    } else if (command.type === 'remove') {
      const own = queue.filter(row => row.requestedBy?.toLowerCase() === command.login).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0];
      if (own) { tx.delete(db.doc(prefix + 'queue_videos/' + own.id));activity('request_removed', own);changed = true; }
      reply = `@${command.login} ${own ? 'Removed your latest waiting request.' : 'No waiting request to remove.'}`;
    } else if (command.type === 'vote') {
      const target = queue[command.position - 1];
      const voters = Array.isArray(target?.voters) ? target.voters : [];
      if (!target) reply = `@${command.login} No waiting video at #${command.position}.`;
      else if (target.requestedBy?.toLowerCase() === command.login) reply = `@${command.login} You cannot vote for your own request.`;
      else if (voters.some(voter => String(voter).toLowerCase() === command.login)) reply = `@${command.login} You already voted for that video.`;
      else {
        const votes = voters.length + 1;
        const reordered = queue.map(row => row.id === target.id ? { ...row, upvotes: votes } : row)
          .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Number(b.upvotes || 0) - Number(a.upvotes || 0) || Number(a.timestamp || 0) - Number(b.timestamp || 0));
        reordered.forEach((row, index) => tx.update(db.doc(prefix + 'queue_videos/' + row.id), {
          queueOrder: (index + 1) * 1000, ...(row.id === target.id ? { voters: [...voters, command.login], upvotes: votes } : {}) }));
        activity('vote_cast', target);
        changed = true;reply = `@${command.login} +1 vote: ${title(target)}.`;
      }
    } else if (command.type === 'queue') {
      reply = `@${command.login} ${playing ? 'Now: ' + title(playing) : 'Nothing playing'} | ${queue.length} waiting. Next: ${queue.slice(0, 3).map((row, index) => '#' + (index + 1) + ' ' + title(row)).join(', ') || 'empty'}.`;
    } else if (command.type === 'position') {
      let seconds = playing ? getDurationEstimate(playing).seconds : 0;
      const entries = [];
      if (playing?.requestedBy?.toLowerCase() === command.login) entries.push('Playing now: ' + title(playing));
      queue.forEach((row, index) => { if (row.requestedBy?.toLowerCase() === command.login) entries.push('#' + (index + 1) + ' ' + title(row) + ' (~' + Math.ceil(seconds / 60) + 'm)');seconds += getDurationEstimate(row).seconds; });
      reply = `@${command.login} ${entries.slice(0, 3).join('; ') || 'No upcoming requests.'}`;
    } else if (command.type === 'help') reply = '!assr <URL/title> or paste a URL (silent). !queue, !when, !remove, !bigcock [#] / !vote [#]. Mods: !skip, !volume 0-100/up/down, !mute, !unmute.';
    const outcome = { status: 'command_processed', command: command.type, sender: command.login, receivedAt: now, queued: 0, changed, reply };
    tx.create(receipt, outcome);return outcome;
  });
  if (!result.reply || result.replyDelivery) return result;
  const lease = randomUUID();
  const claimed = await db.runTransaction(async tx => {
    const current = (await tx.get(receipt)).data();
    if (current.replyDelivery === 'sent' || current.replyDelivery === 'dashboard' || Number(current.replyLeaseUntil || 0) > Date.now()) return false;
    tx.update(receipt, { replyLease: lease, replyLeaseUntil: Date.now() + 30000 });return true;
  });
  if (!claimed) return result;
  const delivery = await (dependencies.sendReply || sendCommandReply)(result.reply);
  await db.runTransaction(async tx => {
    const current = (await tx.get(receipt)).data();
    const settings = (await tx.get(room)).data() || { channelRoom: '2o3a' };
    if (current.replyLease !== lease) return;
    tx.update(receipt, { replyDelivery: delivery.sent ? 'sent' : 'dashboard', replyLeaseUntil: 0 });
    if (!delivery.sent) {
      const feed = Array.isArray(settings.chatCommandFeed) ? settings.chatCommandFeed : [];
      tx.set(room, { ...settings, chatCommandFeed: [...feed.filter(entry => entry.at > now - 120000), { id, at: now, reply: result.reply }].slice(-30),
        chatReplyDiagnostic: { code: delivery.code || 'chat_reply_failed', at: now }, updatedAt: now });
    } else if (settings.chatReplyDiagnostic?.code && settings.chatReplyDiagnostic.code !== 'ok') {
      tx.set(room, { ...settings, chatReplyDiagnostic: { code: 'ok', at: now }, updatedAt: now });
    }
  });
  return { ...result, replyDelivery: delivery.sent ? 'sent' : 'dashboard' };
}
