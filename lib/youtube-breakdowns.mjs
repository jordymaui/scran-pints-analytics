// Native channel reports supported by the existing yt-analytics.readonly grant.
// https://developers.google.com/youtube/analytics/channel_reports
const activity = dimensions => Object.freeze({
  dimensions, metrics: 'views,estimatedMinutesWatched', sort: dimensions,
});
const trafficDetail = source => Object.freeze({
  dimensions: 'insightTrafficSourceDetail', metrics: 'views,estimatedMinutesWatched',
  filters: `insightTrafficSourceType==${source}`, sort: '-views', maxResults: 25,
});
export const CHANNEL_BREAKDOWN_REPORTS = Object.freeze({
  traffic: activity('insightTrafficSourceType'),
  country: activity('country'),
  device: activity('deviceType'),
  subscribed: activity('subscribedStatus'),
  format: activity('creatorContentType'),
  demographics: Object.freeze({
    dimensions: 'ageGroup,gender', metrics: 'viewerPercentage', sort: 'ageGroup,gender',
  }),
  operatingSystem: activity('operatingSystem'),
  playbackLocation: activity('insightPlaybackLocationType'),
  youtubeProduct: activity('youtubeProduct'),
  liveOrOnDemand: activity('liveOrOnDemand'),
  sharing: Object.freeze({ dimensions: 'sharingService', metrics: 'shares', sort: 'sharingService' }),
  searchTerms: trafficDetail('YT_SEARCH'),
  externalSources: trafficDetail('EXT_URL'),
  suggestedVideos: trafficDetail('RELATED_VIDEO'),
  engagement: Object.freeze({
    dimensions: 'day', sort: 'day',
    metrics: 'engagedViews,dislikes,videosAddedToPlaylists,videosRemovedFromPlaylists,redViews,estimatedRedMinutesWatched',
  }),
  cards: Object.freeze({
    dimensions: 'day', sort: 'day',
    metrics: 'cardImpressions,cardClicks,cardClickRate,cardTeaserImpressions,cardTeaserClicks,cardTeaserClickRate',
  }),
});

export const UPLOAD_ACTIVITY_METRICS = Object.freeze([
  'views', 'engagedViews', 'estimatedMinutesWatched', 'averageViewDuration',
  'averageViewPercentage', 'likes', 'dislikes', 'comments', 'shares',
  'subscribersGained', 'subscribersLost', 'videosAddedToPlaylists', 'videosRemovedFromPlaylists',
]);
export const UPLOAD_REPORTS = Object.freeze({
  aggregate: Object.freeze({ metrics: UPLOAD_ACTIVITY_METRICS.join(',') }),
  daily: Object.freeze({ dimensions: 'day', metrics: UPLOAD_ACTIVITY_METRICS.join(','), sort: 'day' }),
  retention: Object.freeze({
    dimensions: 'elapsedVideoTimeRatio',
    metrics: 'audienceWatchRatio,relativeRetentionPerformance,startedWatching,stoppedWatching,totalSegmentImpressions',
  }),
  traffic: activity('insightTrafficSourceType'),
});
const TIMEZONE = 'America/Los_Angeles';
const END_STATUS = 'query-bound-no-daily-completeness-signal';
const STATUSES = ['collected', 'no-rows', 'failed', 'no-rows-retained', 'failed-retained'];
const COUNTERS = new Set(['views', 'engagedViews', 'redViews', 'likes', 'dislikes', 'comments', 'shares',
  'subscribersGained', 'subscribersLost', 'videosAddedToPlaylists', 'videosRemovedFromPlaylists',
  'cardImpressions', 'cardClicks', 'cardTeaserImpressions', 'cardTeaserClicks',
  'startedWatching', 'stoppedWatching', 'totalSegmentImpressions']);
const RATIOS = new Set(['relativeRetentionPerformance', 'cardClickRate', 'cardTeaserClickRate']);
const invalid = () => { throw new Error('Invalid saved channel breakdown.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key));
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)) && day(value.slice(0, 10));
const range = (value, capturedAt) => keys(value, ['start', 'end', 'timezone']) &&
  day(value.start) && day(value.end) && value.start <= value.end &&
  value.end <= capturedAt.slice(0, 10) && value.timezone === TIMEZONE;

function validateRows(rows, definition) {
  const dimensions = definition.dimensions ? definition.dimensions.split(',') : [];
  const limit = definition.maxResults || (dimensions.includes('day') ? 20000 : 1000);
  if (!Array.isArray(rows) || rows.length > limit || (!dimensions.length && rows.length > 1)) invalid();
  const metrics = definition.metrics.split(',');
  const seen = new Set();
  for (const row of rows) {
    if (!keys(row, [...dimensions, ...metrics]) ||
        dimensions.some(key => key === 'elapsedVideoTimeRatio'
          ? typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] <= 0 || row[key] > 1
          : typeof row[key] !== 'string' || !row[key].trim() ||
            row[key].length > (key === 'insightTrafficSourceDetail' ? 2048 : 150) ||
            /[\u0000-\u001f\u007f]/.test(row[key]) || (key === 'day' && !day(row[key]))) ||
        metrics.some(key => typeof row[key] !== 'number' || !Number.isFinite(row[key]) ||
          (key !== 'likes' && row[key] < 0) || (COUNTERS.has(key) && !Number.isSafeInteger(row[key])) ||
          (RATIOS.has(key) && row[key] > 1) ||
          (key === 'viewerPercentage' && row[key] > 100))) invalid();
    const identity = JSON.stringify(dimensions.map(key => row[key]));
    if (seen.has(identity)) invalid();
    seen.add(identity);
  }
}

function validateEntry(entry, definition) {
  if (!keys(entry, ['status', 'attemptedAt', 'attemptedRange', 'errorCode', 'report']) ||
      !STATUSES.includes(entry.status) || !timestamp(entry.attemptedAt) ||
      !range(entry.attemptedRange, entry.attemptedAt)) invalid();
  const failed = entry.status.startsWith('failed');
  if (failed ? !['report-unavailable', 'invalid-response', 'coverage-loss'].includes(entry.errorCode) : entry.errorCode !== null) invalid();
  const hasReport = entry.status === 'collected' || entry.status.endsWith('-retained');
  if (!hasReport) {
    if (entry.report !== null) invalid();
    return;
  }
  const report = entry.report;
  if (!keys(report, ['capturedAt', 'dateRange', 'endStatus', 'rows']) ||
      !timestamp(report.capturedAt) || !range(report.dateRange, report.capturedAt) ||
      Date.parse(report.capturedAt) > Date.parse(entry.attemptedAt) ||
      report.endStatus !== END_STATUS || !Array.isArray(report.rows) || !report.rows.length) invalid();
  if (entry.status === 'collected' && (report.capturedAt !== entry.attemptedAt ||
      report.dateRange.start !== entry.attemptedRange.start ||
      report.dateRange.end !== entry.attemptedRange.end)) invalid();
  validateRows(report.rows, definition);
  if (report.rows.some(row => row.day && (row.day < report.dateRange.start || row.day > report.dateRange.end))) invalid();
}

/** Strict private storage/API boundary. Unknown fields are never forwarded. */
export function validateChannelBreakdowns(value) {
  if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(CHANNEL_BREAKDOWN_REPORTS, key))) invalid();
  for (const [id, entry] of Object.entries(value)) validateEntry(entry, CHANNEL_BREAKDOWN_REPORTS[id]);
  return structuredClone(value);
}

/**
 * query({id, report, startDate, endDate}) supplies decoded native row objects.
 * It must paginate the report; this module never makes requests or reads tokens.
 * Each optional report fails independently, preserving a valid older report.
 */
export async function collectChannelBreakdowns({ query, previous = {}, capturedAt, start, end }) {
  const attemptedRange = { start, end, timezone: TIMEZONE };
  if (typeof query !== 'function' || !timestamp(capturedAt) || !range(attemptedRange, capturedAt)) {
    throw new Error('Invalid channel breakdown collection options.');
  }
  const entries = await mapLimited(Object.entries(CHANNEL_BREAKDOWN_REPORTS), async ([id, definition]) =>
    [id, await collectOptionalReport({ definition, previous: previous?.[id], capturedAt, start, end,
      query: () => query({ id, report: definition, startDate: start, endDate: end }) })]);
  return validateChannelBreakdowns(Object.fromEntries(entries));
}

async function mapLimited(values, action, concurrency = 6) {
  let cursor = 0;
  const result = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await action(values[index], index);
    }
  }));
  return result;
}

async function collectOptionalReport({ definition, previous, capturedAt, start, end, query }) {
  const attemptedRange = { start, end, timezone: TIMEZONE };
  let retained = null;
  try {
    validateEntry(previous, definition);
    if (previous.report && Date.parse(previous.report.capturedAt) <= Date.parse(capturedAt)) {
      retained = structuredClone(previous.report);
    }
  } catch { /* Malformed optional history cannot block the other reports. */ }
  const entry = { status: retained ? 'failed-retained' : 'failed', attemptedAt: capturedAt,
    attemptedRange, errorCode: 'report-unavailable', report: retained };
  let rows;
  try { rows = await query(); } catch { return entry; }
  try {
    validateRows(rows, definition);
    if (rows.some(row => row.day && (row.day < start || row.day > end))) invalid();
  } catch { entry.errorCode = 'invalid-response'; return entry; }
  if (rows.length && retained && definition.dimensions?.split(',').includes('day')) {
    const dates = new Set(rows.map(row => row.day));
    if (retained.rows.some(row => row.day >= start && row.day <= end && !dates.has(row.day))) {
      entry.errorCode = 'coverage-loss';
      return entry;
    }
  }
  entry.errorCode = null;
  entry.status = rows.length ? 'collected' : retained ? 'no-rows-retained' : 'no-rows';
  if (rows.length) entry.report = { capturedAt, dateRange: { ...attemptedRange },
    endStatus: END_STATUS, rows: structuredClone(rows) };
  return entry;
}

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
function publicThumbnail(value, id) {
  if (value === null) return true;
  try {
    const url = new URL(value);
    return typeof value === 'string' && url.protocol === 'https:' && url.hostname === 'i.ytimg.com' &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      new RegExp(`^/vi(?:_webp)?/${id}/[A-Za-z0-9_-]+\\.(?:jpg|webp|png)$`).test(url.pathname);
  } catch { return false; }
}
function validateUploadVideo(video) {
  if (!keys(video, ['id', 'title', 'description', 'tags', 'metadataCapturedAt', 'metadataHistory',
    'publishedAt', 'durationSeconds', 'thumbnail', 'creatorContentType',
    'aggregate', 'daily', 'retention', 'traffic']) ||
    !validId(video.id) || !timestamp(video.publishedAt) ||
    (video.durationSeconds !== null && (!Number.isFinite(video.durationSeconds) || video.durationSeconds <= 0)) ||
    !publicThumbnail(video.thumbnail, video.id) ||
    !['VIDEO_ON_DEMAND', 'SHORTS', 'LIVE_STREAM', 'STORY', 'UNSPECIFIED'].includes(video.creatorContentType)) invalid();
  validateObservedMetadata({ capturedAt: video.metadataCapturedAt, title: video.title,
    description: video.description, tags: video.tags, thumbnail: video.thumbnail }, video.id);
  if (!Array.isArray(video.metadataHistory) || video.metadataHistory.length > 20000) invalid();
  const seen = new Set();
  for (const observation of video.metadataHistory) {
    validateObservedMetadata(observation, video.id);
    const identity = JSON.stringify(observation);
    if (seen.has(identity) || Date.parse(observation.capturedAt) > Date.parse(video.metadataCapturedAt)) invalid();
    seen.add(identity);
  }
  for (const [id, definition] of Object.entries(UPLOAD_REPORTS)) validateEntry(video[id], definition);
}

function validateObservedMetadata(value, id) {
  if (!keys(value, ['capturedAt', 'title', 'description', 'tags', 'thumbnail']) ||
    !timestamp(value.capturedAt) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value.title) || typeof value.description !== 'string' ||
    value.description.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.description) ||
    !Array.isArray(value.tags) || value.tags.length > 100 ||
    value.tags.some(tag => typeof tag !== 'string' || tag.length > 500 || /[\u0000-\u001f\u007f]/.test(tag)) ||
    !publicThumbnail(value.thumbnail, id)) invalid();
}

/** Only verified public catalog metadata and explicitly selected report fields. */
export function validateUploadAnalytics(value) {
  if (!keys(value, ['capturedAt', 'channelId', 'dateRange', 'coverage', 'videos']) ||
    !timestamp(value.capturedAt) || !range(value.dateRange, value.capturedAt) ||
    typeof value.channelId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.channelId) ||
    !keys(value.coverage, ['scope', 'inventoryComplete', 'publicUploadsCount', 'channelPublicVideoCount']) ||
    value.coverage.scope !== 'verified-public-uploads' || typeof value.coverage.inventoryComplete !== 'boolean' ||
    !Number.isSafeInteger(value.coverage.publicUploadsCount) || value.coverage.publicUploadsCount < 0 ||
    (value.coverage.channelPublicVideoCount !== null &&
      (!Number.isSafeInteger(value.coverage.channelPublicVideoCount) || value.coverage.channelPublicVideoCount < 0)) ||
    (value.coverage.inventoryComplete && value.coverage.channelPublicVideoCount !== value.coverage.publicUploadsCount) ||
    !Array.isArray(value.videos) || value.videos.length > 5000 ||
    value.videos.length !== value.coverage.publicUploadsCount ||
    new Set(value.videos.map(video => video.id)).size !== value.videos.length) invalid();
  for (const video of value.videos) {
    validateUploadVideo(video);
    if (video.metadataCapturedAt !== value.capturedAt) invalid();
    for (const id of Object.keys(UPLOAD_REPORTS)) {
      if (video[id].attemptedAt !== value.capturedAt ||
        video[id].attemptedRange.start !== value.dateRange.start ||
        video[id].attemptedRange.end !== value.dateRange.end) invalid();
    }
  }
  return structuredClone(value);
}

/**
 * Each catalog item is already verified public by videos.list. Batchable
 * reports use an explicit video filter; retention always uses one video.
 * query({type,report,videoIds,startDate,endDate}) returns decoded native rows.
 */
export async function collectUploadAnalytics({ catalog, channelId, coverage, query,
  previous, capturedAt, start, end }) {
  if (!Array.isArray(catalog) || catalog.length > 5000 || !timestamp(capturedAt) ||
    !range({ start, end, timezone: TIMEZONE }, capturedAt) || typeof query !== 'function') invalid();
  let old = new Map();
  try {
    const valid = validateUploadAnalytics(previous);
    if (valid.channelId === channelId) old = new Map(valid.videos.map(video => [video.id, video]));
  } catch { /* An invalid previous optional catalog is never trusted. */ }
  const videos = catalog.map(video => {
    const prior = old.get(video.id);
    const observations = [...(video.metadataHistory || []), ...(prior?.metadataHistory || [])];
    if (prior) observations.push({ capturedAt: prior.metadataCapturedAt, title: prior.title,
      description: prior.description, tags: prior.tags, thumbnail: prior.thumbnail });
    const valid = new Map();
    for (const observation of observations) {
      try {
        validateObservedMetadata(observation, video.id);
        if (Date.parse(observation.capturedAt) <= Date.parse(capturedAt)) {
          valid.set(JSON.stringify(observation), structuredClone(observation));
        }
      } catch { /* Legacy observations must pass the same selected-field boundary. */ }
    }
    return { ...video, metadataCapturedAt: capturedAt,
      metadataHistory: [...valid.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)) };
  });
  const byId = new Map(videos.map(video => [video.id, video]));
  const publishedDay = video => new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(video.publishedAt));
  const eligible = videos.filter(video => publishedDay(video) <= end);
  for (const video of videos.filter(video => publishedDay(video) > end)) {
    for (const [type, definition] of Object.entries(UPLOAD_REPORTS)) {
      video[type] = await collectOptionalReport({ definition, previous: old.get(video.id)?.[type],
        capturedAt, start, end, query: async () => [] });
    }
  }
  const days = Math.floor((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  // Traffic reports reject queried-video-count × dates > 50,000. All three
  // batchable reports share this conservative bound; nothing is truncated.
  const size = Math.max(1, Math.min(50, Math.floor(50000 / days)));
  const batches = Array.from({ length: Math.ceil(eligible.length / size) },
    (_, index) => eligible.slice(index * size, (index + 1) * size));
  await mapLimited(batches.flatMap(batch => ['aggregate', 'daily', 'traffic'].map(type => ({ batch, type }))),
    async ({ batch, type }) => {
      const base = UPLOAD_REPORTS[type], ids = batch.map(video => video.id);
      const report = ids.length === 1 ? base : { ...base,
        dimensions: ['video', base.dimensions].filter(Boolean).join(','),
        sort: ['video', base.sort].filter(Boolean).join(',') };
      let result;
      try {
        const rows = await query({ type, report, videoIds: ids, startDate: start, endDate: end });
        if (!Array.isArray(rows) || rows.some(row => ids.length > 1 && !byId.has(row.video))) invalid();
        result = new Map(ids.map(id => [id, []]));
        for (const row of rows) {
          const id = ids.length === 1 ? ids[0] : row.video;
          if (!result.has(id)) invalid();
          const { video: ignored, ...values } = row;
          result.get(id).push(values);
        }
      } catch { result = null; }
      await Promise.all(batch.map(async video => {
        video[type] = await collectOptionalReport({ definition: base, previous: old.get(video.id)?.[type],
          capturedAt, start, end, query: async () => {
            if (result === null) throw Error('Report unavailable');
            return result.get(video.id);
          } });
      }));
    });
  await mapLimited(eligible, async video => {
    video.retention = await collectOptionalReport({ definition: UPLOAD_REPORTS.retention,
      previous: old.get(video.id)?.retention, capturedAt, start, end,
      query: () => query({ type: 'retention', report: UPLOAD_REPORTS.retention,
        videoIds: [video.id], startDate: start, endDate: end }) });
  });
  return validateUploadAnalytics({ capturedAt, channelId,
    dateRange: { start, end, timezone: TIMEZONE }, coverage: { ...coverage }, videos });
}
