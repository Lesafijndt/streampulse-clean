import { createSign, createHmac, randomUUID } from 'node:crypto';
import { decodeServiceAccount, getQueueNamespace } from '../server/firebase-guard.js';

// Run only through Vercel env run. Never print tokens, credentials, or chat text.
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error('Remote diagnostic failed'), {
    status: response.status, code: body.error?.status || body.code || 'remote_request_failed',
  });
  return body;
}
try {
  const token = await json('https://id.twitch.tv/oauth2/token', {
    method: 'POST', body: new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const headers = { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token.access_token };
  const users = await json('https://api.twitch.tv/helix/users?login=2o3a&login=paim_beach_pete&login=palm_beach_pete&login=gachibot69', { headers });
  console.log(JSON.stringify({ check: 'twitch_identities', users: users.data.map(x => ({ id: x.id, login: x.login, displayName: x.display_name })) }));
  const subscriptions = [];
  let cursor = '';
  do {
    const page = await json('https://api.twitch.tv/helix/eventsub/subscriptions?type=channel.chat.message' + (cursor ? '&after=' + encodeURIComponent(cursor) : ''), { headers });
    subscriptions.push(...(page.data || [])); cursor = page.pagination?.cursor || '';
  } while (cursor && subscriptions.length < 1000);
  console.log(JSON.stringify({ check: 'subscriptions', subscriptions: subscriptions.map(x => ({ id: x.id, status: x.status,
    condition: x.condition, method: x.transport?.method, callback: x.transport?.callback })) }));
  if (process.argv.includes('--repair-webhook')) {
    const broadcaster = users.data.find(x => x.login === '2o3a');
    const moderator = users.data.find(x => x.login === 'paim_beach_pete');
    const callback = 'https://streampulse-clean.vercel.app/api/twitch/bot-session?action=webhook';
    const secret = process.env.TWITCH_EVENTSUB_SECRET || '';
    if (!broadcaster || !moderator || secret.length < 10 || secret.length > 100) throw Error('Invalid repair configuration');
    const matching = subscriptions.filter(x => x.transport?.method === 'webhook' && x.transport.callback === callback &&
      x.condition?.broadcaster_user_id === broadcaster.id && x.condition?.user_id === moderator.id);
    if (matching.length > 1) throw Error('Ambiguous subscriptions require review');
    if (matching.length) {
      await json('https://api.twitch.tv/helix/eventsub/subscriptions?id=' + encodeURIComponent(matching[0].id), {
        method: 'DELETE', headers,
      });
    }
    const created = await json('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({
        type: 'channel.chat.message', version: '1',
        condition: { broadcaster_user_id: broadcaster.id, user_id: moderator.id },
        transport: { method: 'webhook', callback, secret },
      }),
    });
    const id = created.data?.[0]?.id;
    let status = created.data?.[0]?.status;
    for (let attempt = 0; attempt < 15 && status === 'webhook_callback_verification_pending'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const result = await json('https://api.twitch.tv/helix/eventsub/subscriptions?type=channel.chat.message', { headers });
      status = result.data?.find(x => x.id === id)?.status || 'missing';
    }
    console.log(JSON.stringify({ check: 'webhook_signing_repair', id, status, oauthActionNeeded: status !== 'enabled' }));
    if (status !== 'enabled') throw Error('Webhook verification did not complete');
    // Retire only this project's obsolete bot callback after its replacement is
    // enabled. It otherwise produces rejected duplicate deliveries on every chat.
    const bot = users.data.find(x => x.login === 'gachibot69');
    for (const old of subscriptions.filter(x => x.transport?.callback === 'https://streampulse-clean.vercel.app/api/twitch/eventsub' &&
      x.condition?.broadcaster_user_id === broadcaster.id && x.condition?.user_id === bot?.id)) {
      await json('https://api.twitch.tv/helix/eventsub/subscriptions?id=' + encodeURIComponent(old.id), { method: 'DELETE', headers });
      console.log(JSON.stringify({ check: 'retired_obsolete_callback', id: old.id }));
    }
  }
} catch (error) { console.log(JSON.stringify({ check: 'twitch', ok: false, status: error.status, code: error.code })); }
try {
  const key = decodeServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
  const token = await json('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + signature }) });
  const headers = { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json' };
  const root = 'https://firestore.googleapis.com/v1/projects/' + key.project_id + '/databases/(default)/documents';
  const parent = root + '/artifacts/' + getQueueNamespace() + '/public/data';
  const room = await fetch(parent + '/room_settings/2o3a', { headers, signal: AbortSignal.timeout(15000) });
  const roomData = await room.json();
  console.log(JSON.stringify({ check: 'firestore_room', project: key.project_id, namespace: getQueueNamespace(), status: room.status,
    code: roomData.error?.status, queueOpen: roomData.fields?.streamSettings?.mapValue?.fields?.queueOpen?.booleanValue }));
  const receipts = await json(parent + ':runQuery', { method: 'POST', headers, body: JSON.stringify({ structuredQuery: {
    from: [{ collectionId: 'twitch_eventsub_receipts' }], orderBy: [{ field: { fieldPath: 'receivedAt' }, direction: 'DESCENDING' }], limit: 10 } }) });
  console.log(JSON.stringify({ check: 'recent_receipts', receipts: receipts.filter(x => x.document).map(x => {
    const f = x.document.fields; return { sender: f.sender?.stringValue, status: f.status?.stringValue,
      queued: f.queued?.integerValue, receivedAt: f.receivedAt?.integerValue }; }) }));
} catch (error) { console.log(JSON.stringify({ check: 'firestore', ok: false, status: error.status, code: error.code || 'credential_error' })); }

if (process.argv.includes('--probe')) {
  const target = process.argv[process.argv.indexOf('--probe') + 1];
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' ||
      url.search || !/^(streampulse-clean\.vercel\.app|streampulse-clean-[a-z0-9]+-lesafijndt\.vercel\.app)$/.test(url.hostname)) throw Error('Invalid probe target');
  const id = 'probe-' + randomUUID(); const timestamp = new Date().toISOString(); const raw = '{}';
  const signature = 'sha256=' + createHmac('sha256', process.env.TWITCH_EVENTSUB_SECRET)
    .update(id).update(timestamp).update(raw).digest('hex');
  const response = await fetch(url.origin + '/api/twitch/bot-session?action=webhook', {
    method: 'POST', body: raw, redirect: 'manual', signal: AbortSignal.timeout(20000), headers: {
      'Content-Type': 'application/json', 'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-timestamp': timestamp, 'twitch-eventsub-message-signature': signature,
      'twitch-eventsub-message-type': 'streampulse_transport_probe',
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}),
    },
  });
  console.log(JSON.stringify({ check: 'durable_transport_probe', target: url.hostname, probeId: id, status: response.status,
    body: await response.json().catch(() => ({ code: 'non_json_response' })) }));
}
