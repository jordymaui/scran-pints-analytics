// Documented values plus the exact aliases observed in owner Analytics reports.
// Unknown or differently spelled values remain unclassified; never guess from
// video duration, title, URL or case folding.
// https://developers.google.com/youtube/analytics/dimensions#creatorContentType
const CONTENT_TYPES = new Map([
  ['SHORTS', 'SHORTS'],
  ['VIDEO_ON_DEMAND', 'VIDEO_ON_DEMAND'],
  ['LIVE_STREAM', 'LIVE_STREAM'],
  ['STORY', 'STORY'],
  ['UNSPECIFIED', 'UNSPECIFIED'],
  ['shorts', 'SHORTS'],
  ['videoOnDemand', 'VIDEO_ON_DEMAND'],
  ['creatorContentTypeUnspecified', 'UNSPECIFIED'],
]);

export function normalizeYouTubeContentType(value) {
  return typeof value === 'string' ? CONTENT_TYPES.get(value) || null : null;
}
