// Server/build-only public Studio projection. Never forward a stored snapshot wholesale.
import { validatePublicYouTubeReport, publicYouTubeThumbnail } from './report-model.mjs';

const CHANNEL_ID = 'UCAX4l1JUAymaMHVKiRFzK-A';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ACTIVITY = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage',
  'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum = 1000) => typeof value === 'string' && value.length <= maximum ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
const timestamp = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)) && day(value.slice(0, 10)) ? value : null;
const captureDate = value => day(value) || timestamp(value);
// This flag is only read from the checked-in, reviewed history, never cloud input.
const reviewedPublicHistory = video => video?.publishedPublic === true && VIDEO_ID.test(video.videoId || '');
const strings = (values, maximum = 200) => Array.isArray(values)
  ? values.slice(0, maximum).map(value => text(value, 10000)).filter(value => value !== null) : [];
const numeric = (value, keys) => Object.fromEntries(keys.map(key => [key, number(value?.[key])]));
const activity = value => numeric(value, ACTIVITY);

/** Only cropped thumbnail assets explicitly paired with published historical videos. */
export function studioThumbnailAssets(bundled) {
  const videos = new Set((bundled?.videos || []).map(video => video.id).filter(id => VIDEO_ID.test(id)));
  const assets = new Set();
  for (const video of bundled?.videos || []) {
    if (typeof video.thumb === 'string' && /^assets\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/.test(video.thumb)) assets.add(video.thumb);
  }
  for (const video of bundled?.history?.videos || []) {
    if (!videos.has(video.videoId) && !reviewedPublicHistory(video)) continue;
    for (const variant of video.variants || []) {
      if (variant.status === 'draft') continue;
      const path = variant.webThumbnail;
      if (typeof path === 'string' &&
          new RegExp(`^assets/history-${video.videoId}-(?:p\\d+|studio-\\d+)\\.(?:jpe?g|png|webp)$`).test(path)) assets.add(path);
    }
  }
  return [...assets];
}

function image(value, assets, videoId) {
  if (assets.has(value)) return value;
  const url = publicYouTubeThumbnail(value);
  if (!url || !url.startsWith('https://')) return null;
  try {
    const parsed = new URL(url);
    // Remote public image URLs need no signature, token or other query parameters.
    return !parsed.search && new RegExp(`^/vi(?:_webp)?/${videoId}/`).test(parsed.pathname) ? parsed.href : null;
  } catch { return null; }
}

function reportSource(value) {
  if (!object(value)) return null;
  return { capturedAt: timestamp(value.capturedAt), start: day(value.start), end: day(value.end),
    timezone: value.timezone === 'America/Los_Angeles' ? value.timezone : null };
}
function studioCards(value) {
  if (!object(value) || !Object.keys(value).length) return null;
  return {
    capturedAt: captureDate(value.capturedAt), ctrPct: number(value.ctrPct),
    impressionsDisplay: text(value.impressionsDisplay, 100),
    engagement: { watchHoursDisplay: text(value.engagement?.watchHoursDisplay, 100),
      averageViewDuration: text(value.engagement?.averageViewDuration, 100) },
    retention: numeric(value.retention, ['averagePercentageViewed', 'intro30sPct']),
  };
}
function historyProjection(history, visibleIds, assets) {
  return { videos: (history?.videos || []).filter(video => visibleIds.has(video.videoId) || reviewedPublicHistory(video)).map(video => ({
    videoId: video.videoId, episode: text(video.episode), publishedAt: timestamp(video.publishedAt),
    currentTitle: text(video.currentTitle), missingHistory: strings(video.missingHistory),
    variants: (video.variants || []).filter(variant => variant.status !== 'draft').slice(0, 1000).map(variant => ({
      variantId: text(variant.variantId), title: text(variant.title),
      status: text(variant.status, 200), observedAt: captureDate(variant.observedAt),
      window: text(variant.window), testId: text(variant.testId, 200),
      thumbnailDescription: text(variant.thumbnailDescription),
      metrics: numeric(variant.metrics, ['watchTimeSharePct']), caveats: strings(variant.caveats),
      webThumbnail: image(variant.webThumbnail, assets, video.videoId),
      // Full screenshots, source paths and arbitrary source objects stay private.
    })),
    tests: (video.tests || []).slice(0, 1000).map(test => ({
      testId: text(test.testId || test.id, 200), status: text(test.status),
      type: ['title-only', 'title-and-thumbnail', 'thumbnail-only'].includes(test.type) ? test.type : null,
      window: text(test.window), observedAt: captureDate(test.observedAt), result: text(test.result),
    })),
  })) };
}

export function projectStudioSnapshot(snapshot, {
  historicalSnapshot = {}, channelAnalytics = null, channelBreakdowns = null, shortsAnalytics = null, uploadAnalytics = null,
  storageStatus = 'unavailable', snapshotOrigin = 'bundled',
} = {}) {
  const assets = new Set(studioThumbnailAssets(historicalSnapshot));
  const bundledIds = new Set((historicalSnapshot.videos || []).map(video => video.id));
  const publicIds = new Set(bundledIds);
  try {
    const report = validatePublicYouTubeReport(snapshot.publicReport);
    for (const video of report.content) publicIds.add(video.id);
  } catch { /* A malformed public inventory never authorizes another upload. */ }
  const videos = (snapshot.videos || []).filter(video => {
    if (!VIDEO_ID.test(video?.id || '')) return false;
    if (video.metadata) return video.metadata.privacyStatus === 'public' && video.metadata.channelId === CHANNEL_ID;
    return !video.discoveredAt && bundledIds.has(video.id);
  }).map(video => {
    publicIds.add(video.id);
    const metadata = video.metadata ? {
      title: text(video.metadata.title), description: text(video.metadata.description, 10000),
      tags: Array.isArray(video.metadata.tags) ? strings(video.metadata.tags) : null,
      tagsFieldReturned: video.metadata.tagsFieldReturned === true,
      capturedAt: timestamp(video.metadata.capturedAt), publishedAt: timestamp(video.metadata.publishedAt),
      thumbnail: { url: image(video.metadata.thumbnail?.url, assets, video.id) },
    } : null;
    return {
      id: video.id, title: text(video.title) || '', name: text(video.name) || text(video.title) || video.id,
      episode: number(video.episode), publishedAt: timestamp(video.publishedAt),
      durationSeconds: number(video.durationSeconds), reportingPublishedDate: day(video.reportingPublishedDate),
      discoveredAt: timestamp(video.discoveredAt), packagingCapturedAt: timestamp(video.packagingCapturedAt),
      thumb: image(video.thumb, assets, video.id), metadata, studio: studioCards(video.studio),
      apiAggregate: activity(video.apiAggregate), subscribersNet: number(video.subscribersNet),
      daily: (video.daily || []).filter(row => day(row.day)).slice(0, 20000).map(row => ({ day: row.day, ...activity(row) })),
      retention: (video.retention || []).slice(0, 1000).map(row =>
        numeric(row, ['elapsedVideoTimeRatio', 'audienceWatchRatio', 'relativeRetentionPerformance'])),
      retentionNear30Seconds: numeric(video.retentionNear30Seconds,
        ['elapsedVideoTimeRatio', 'audienceWatchRatio', 'relativeRetentionPerformance', 'sampledSeconds']),
      traffic: (video.traffic || []).slice(0, 1000).map(row => ({
        insightTrafficSourceType: text(row.insightTrafficSourceType, 150),
        ...numeric(row, ['views', 'estimatedMinutesWatched']),
      })),
      analyticsSource: reportSource(video.analyticsSource),
      trafficSource: reportSource(video.trafficSource), retentionSource: reportSource(video.retentionSource),
      refreshReports: Object.fromEntries(['retention', 'traffic'].map(key => [key,
        ['collected', 'no-rows-retained-previous', 'no-rows'].includes(video.refreshReports?.[key])
          ? video.refreshReports[key] : null])),
    };
  });
  let discovery = null;
  const savedDiscovery = snapshot.youtubeRefresh?.discovery;
  if (object(savedDiscovery)) {
    discovery = {
      status: ['complete', 'partial'].includes(savedDiscovery.status) ? savedDiscovery.status : 'partial',
      inventoryComplete: savedDiscovery.inventoryComplete === true, observedAt: timestamp(savedDiscovery.observedAt),
      ...numeric(savedDiscovery, ['publicUploadsCount', 'confirmedLongformCount', 'includedLongformCount',
        'excludedShortsCount', 'excludedLiveCount', 'excludedOtherCount', 'channelPublicVideoCount', 'nonPublicOrUnavailableCount']),
      ...Object.fromEntries(['unknownFormatIds', 'unreportedLongformIds', 'pendingPublicationIds']
        .map(key => [key, (savedDiscovery[key] || []).filter(id => publicIds.has(id))])),
    };
  }
  const { channelId: _channelId, ...channel } = channelAnalytics || {};
  const { channelId: _uploadChannelId, ...uploads } = uploadAnalytics || {};
  return {
    capturedAt: captureDate(snapshot.capturedAt), apiThrough: day(snapshot.apiThrough),
    studioCapturedAt: captureDate(snapshot.studioCapturedAt), videos,
    history: historyProjection(historicalSnapshot.history, new Set(videos.map(video => video.id)), assets),
    youtubeRefresh: discovery ? { discovery } : null,
    channelAnalytics: channelAnalytics ? channel : null, channelBreakdowns,
    uploadAnalytics: uploadAnalytics ? uploads : null,
    shortsAnalytics: shortsAnalytics ? {
      id: 'youtube-shorts', capturedAt: shortsAnalytics.capturedAt, dateRange: shortsAnalytics.dateRange,
      provenance: { kind: 'official-api', label: 'YouTube Analytics API' },
      scope: 'Shorts history from the earliest known channel date through the last returned reporting day.',
      metrics: numeric(shortsAnalytics.metrics, ['views', 'engagedViews', 'watchHours', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost', 'subscribersNet']),
      daily: shortsAnalytics.daily.map(row => ({ day: row.day,
        ...numeric(row, ['views', 'engagedViews', 'watchHours', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost', 'subscribersNet']) })),
    } : null,
    storageStatus: ['cloud', 'not-configured', 'unavailable'].includes(storageStatus) ? storageStatus : 'unavailable',
    snapshotOrigin: snapshotOrigin === 'cloud' ? 'cloud' : 'bundled',
  };
}
