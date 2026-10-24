// Cloud-synced personal dashboard choices. Never include local layout or
// player sound settings here; those are device-specific by design.
export const PERSONAL_FIELDS = Object.freeze([
  'activeTab', 'selectedCategory', 'mediaTypeFilter', 'sortBy', 'searchQuery',
  'isTheatreMode', 'statsExpanded', 'streamSettings',
]);

export function sanitizePersonalPreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  if (['queue', 'watch_later', 'watched'].includes(value.activeTab)) result.activeTab = value.activeTab;
  if (typeof value.selectedCategory === 'string' && value.selectedCategory.length < 60) result.selectedCategory = value.selectedCategory;
  if (['All', 'Music', 'Non-Music'].includes(value.mediaTypeFilter)) result.mediaTypeFilter = value.mediaTypeFilter;
  if (['priority', 'upvotes', 'newest'].includes(value.sortBy)) result.sortBy = value.sortBy;
  if (typeof value.searchQuery === 'string') result.searchQuery = value.searchQuery.slice(0, 200);
  if (typeof value.isTheatreMode === 'boolean') result.isTheatreMode = value.isTheatreMode;
  if (typeof value.statsExpanded === 'boolean') result.statsExpanded = value.statsExpanded;
  if (value.streamSettings && typeof value.streamSettings === 'object' && !Array.isArray(value.streamSettings)) {
    const original = value.streamSettings;
    const settings = {};
    for (const key of ['streamMode', 'autoPlayNext', 'subsOnly', 'allowYouTube', 'allowTwitch', 'allowTikTok']) {
      if (typeof original[key] === (key === 'streamMode' ? 'string' : 'boolean')) {
        settings[key] = original[key];
      }
    }
    if (Number.isFinite(original.maxDurationMinutes)) {
      settings.maxDurationMinutes = Math.max(1, Math.min(180, original.maxDurationMinutes));
    }
    result.streamSettings = settings;
  }
  return result;
}
