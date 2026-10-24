/** Keep the local fallback limited to the allowlisted moderator session. */
export function canHostLocalChatBridge(session) {
  const username = String(session?.username || '').trim().toLowerCase().replace(/^@/, '');
  return session?.authenticated === true &&
    session?.role === 'moderator' &&
    username === 'paim_beach_pete';
}


/**
 * EventSub being "enabled" only confirms that Twitch accepted the subscription.
 * Do not silence the live moderator IRC fallback until an actual chat request has
 * reached Firestore and been processed recently. Server transactions deduplicate
 * any brief overlap between the two intakes.
 */
export function hasVerifiedCloudChatIntake(status = {}, now = Date.now()) {
  const at = Number(status.lastWebhookAt) || 0;
  return status.active === true &&
    status.firestoreStatus === 'connected' &&
    status.lastWebhookStatus === 'persisted' &&
    status.lastProcessingStatus === 'ok' &&
    at > 0 && at <= now && (now - at) < 10 * 60 * 1000;
}
