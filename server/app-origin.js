// Explicit production hosts only: never trust an arbitrary forwarded host.
export const APP_ORIGIN = 'https://203a.vercel.app';
export const LEGACY_ORIGIN = 'https://streampulse-clean.vercel.app';
export function requestAppOrigin(req) {
  const host = String(req.headers?.host || '').toLowerCase();
  if (host === '203a.vercel.app' || host === 'streampulse-clean.vercel.app') return 'https://' + host;
  return new URL(process.env.TWITCH_APP_URL || 'https://' + host).origin;
}
export function requestRedirectUri(req) {
  const origin = requestAppOrigin(req);
  if ([APP_ORIGIN, LEGACY_ORIGIN].includes(origin)) return origin + '/api/twitch/callback';
  return process.env.TWITCH_REDIRECT_URI || origin + '/api/twitch/callback';
}
