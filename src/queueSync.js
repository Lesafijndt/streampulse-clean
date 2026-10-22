/**
 * Keep local-only queue additions visible when the newest cloud snapshot does not
 * contain them yet. Confirmed remote deletes are still respected because only
 * items explicitly tracked as pending additions are merged back in.
 */
/**
 * Suppress the retired browser-only queue warning. Actual sync health remains visible
 * in Connection details, without telling chat requesters that a local save is shared.
 */
export function shouldSuppressLocalOnlySyncToast(message = '') {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('your request was saved in the dashboard browser') ||
    normalized.includes('the streamer may not see it until sync recovers');
}

export function mergePendingQueueAdds(cloudItems = [], pendingItems = []) {
  const merged = Array.isArray(cloudItems) ? [...cloudItems] : [];
  const ids = new Set(merged.filter(Boolean).map((item) => String(item.id)));
  for (const item of Array.isArray(pendingItems) ? pendingItems : []) {
    if (!item || item.id === undefined || item.id === null) continue;
    const id = String(item.id);
    if (ids.has(id)) continue;
    ids.add(id);
    merged.push(item);
  }
  return merged;
}
