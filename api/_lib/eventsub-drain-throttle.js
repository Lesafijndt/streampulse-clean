export const EVENTSUB_STATUS_DRAIN_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Status polling is a safety-net retry trigger, not the main EventSub processor.
 * Limit each warm function instance to one retry drain every two minutes.
 */
export function shouldScheduleEventSubDrain(now = Date.now(), lastScheduledAt = 0) {
  const current = Number(now);
  const previous = Number(lastScheduledAt);
  if (!Number.isFinite(current) || current <= 0) return false;
  if (!Number.isFinite(previous) || previous < 0) return true;
  return current - previous >= EVENTSUB_STATUS_DRAIN_INTERVAL_MS;
}
