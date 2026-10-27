import { sanitizeClassificationMetadata } from './categoryMemory.js';
import { isValidMediaDuration, videoNeedsDurationLookup } from './durationLookup.js';
import { getPlaybackGeneration } from './playerBridge.js';
import { formatMediaDuration } from './queueLogic.js';

export function isGenericMediaTitle(value) {
  const title = String(value || '').trim();
  return !title || /^(?:(?:youtube|tiktok|twitch|kick|external)\s+)?(?:media|video|short(?:\s+clip)?|clip|request|livestream|live stream)(?:\s*\([\w-]+\))?$/i.test(title) || /^https?:\/\//i.test(title);
}

export function videoNeedsTitleLookup(video) {
  return Boolean(video?.id && video?.url && ['youtube', 'tiktok', 'twitch', 'kick'].includes(video.platform) && isGenericMediaTitle(video.title));
}

export function videoNeedsClassificationLookup(video) {
  return Boolean(video?.id && video?.url && video.categoryManuallySet !== true && ['queue','playing'].includes(video.status) && ['youtube','tiktok','twitch','kick'].includes(video.platform) && video.classificationMetadata?.version !== 1);
}

export function videoNeedsMetadataLookup(video) {
  return videoNeedsTitleLookup(video) || videoNeedsDurationLookup(video);
}

export function getMetadataLookupKey(video) {
  return videoNeedsTitleLookup(video) ? 'title:' + getPlaybackGeneration(video) + ':' + video.url : videoNeedsClassificationLookup(video) ? 'classification:' + getPlaybackGeneration(video) : String(video.id);
}

// Only metadata fields may cross this boundary; late results cannot modify a replacement request.
export function buildMediaMetadataPatch(original, current, metadata) {
  if (!current || original.url !== current.url || getPlaybackGeneration(original) !== getPlaybackGeneration(current)) return {};
  const patch = {};
  const content = sanitizeClassificationMetadata(metadata?.classificationMetadata);
  if (content && JSON.stringify(content) !== JSON.stringify(current.classificationMetadata)) patch.classificationMetadata = content;
  if (videoNeedsTitleLookup(current) && typeof metadata?.title === 'string' && !isGenericMediaTitle(metadata.title)) patch.title = metadata.title.trim();
  if (typeof metadata?.thumbnailUrl === 'string' && /^https:\/\//i.test(metadata.thumbnailUrl) && metadata.thumbnailUrl !== current.thumbnail) patch.thumbnail = metadata.thumbnailUrl;
  if (isValidMediaDuration(metadata?.durationSec) && videoNeedsDurationLookup(current)) {
    patch.durationSec = Math.round(Number(metadata.durationSec));
    patch.duration = formatMediaDuration(patch.durationSec);
    patch.durationSource = 'metadata';
    patch.durationProvider = String(metadata.durationProvider || '');
  }
  return patch;
}
