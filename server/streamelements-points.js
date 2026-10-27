// No retries for PUT: StreamElements does not document an idempotency key.
const BASE = 'https://api.streamelements.com/kappa/v2';
const failure = (code, uncertain = false) => Object.assign(Error(code), {code, uncertain});
export function createPointsClient({request = fetch, token = process.env.STREAMELEMENTS_JWT} = {}) {
  let channel;
  async function call(path, method = 'GET') {
    if (!token) throw failure('streamelements_not_configured');
    let response;
    try { response = await request(BASE + path, {method, headers:{Authorization:'Bearer ' + token, Accept:'application/json'}, redirect:'error', signal:AbortSignal.timeout(8000)}); }
    catch { throw failure('streamelements_unavailable', method === 'PUT'); }
    if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? 'streamelements_authorization_required' : 'streamelements_request_failed', method === 'PUT' && response.status >= 500);
    // A successful write can return an empty/plain-text response. HTTP success is the acknowledgement.
    if (method === 'PUT') return;
    try {return await response.json();} catch {throw failure('streamelements_invalid_response');}
  }
  async function channelId() {
    if (channel) return channel;
    const row = await call('/channels/me');
    if (!/^[a-f0-9]{24}$/i.test(row?._id || '') || String(row.username || '').toLowerCase() !== '2o3a' || row.provider !== 'twitch') throw failure('streamelements_wrong_channel');
    return channel = row._id;
  }
  return {
    async verify() {await channelId();return {channel:'2o3a',provider:'twitch'};},
    async balance(login) {
      if (!/^[a-z0-9_]{1,25}$/.test(login)) throw failure('invalid_points_user');
      const row = await call('/points/' + await channelId() + '/' + login);
      if (!Number.isSafeInteger(row?.points) || row.points < 0) throw failure('streamelements_invalid_balance');
      return row.points;
    },
    async adjust(login, amount) {
      if (!/^[a-z0-9_]{1,25}$/.test(login) || !Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 2147483647) throw failure('invalid_points_adjustment');
      await call('/points/' + await channelId() + '/' + login + '/' + amount, 'PUT');
    }
  };
}
