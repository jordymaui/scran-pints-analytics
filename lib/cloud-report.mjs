import { readFile } from 'node:fs/promises';
import { createCloudStore, CLOUD_SOURCES } from './cloud-store.mjs';
import { buildPublicReport, publicYouTubeThumbnail, validatePublicYouTubeReport } from './report-model.mjs';
import { validateSocialImport } from './social-schema.mjs';
import { validateCampaigns } from './campaign-schema.mjs';
import { projectChannelPerformance, projectShortsPerformance } from './performance-projection.mjs';

export async function readBundledInputs() {
  const [snapshot, social, campaigns] = await Promise.all([
    readFile(new URL('../data.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../integrations/social.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../integrations/campaigns.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  return { snapshot, social, campaigns };
}

function youtubeSnapshot(value) {
  const fail = () => { throw new Error('Invalid saved YouTube snapshot.'); };
  const day = text => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text) &&
    Number.isFinite(Date.parse(text)) && new Date(text).toISOString().slice(0, 10) === text;
  const number = amount => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
  if (!value || !Array.isArray(value.videos) || !value.videos.length || value.videos.length > 1000 ||
      !Number.isFinite(Date.parse(value.capturedAt)) || !day(value.apiThrough) ||
      value.apiThrough > value.capturedAt.slice(0, 10)) fail();
  const ids = new Set();
  for (const video of value.videos) {
    if (!video || !/^[A-Za-z0-9_-]{11}$/.test(video.id || '') || ids.has(video.id) ||
        ![video.name, video.title].every(text => typeof text === 'string' && text.length <= 1000) ||
        (video.thumb != null && !publicYouTubeThumbnail(video.thumb)) ||
        (video.thumb == null && !video.discoveredAt) ||
        !Number.isFinite(Date.parse(video.publishedAt)) || !number(video.durationSeconds) ||
        !Number.isFinite(video.subscribersNet) || !video.apiAggregate ||
        !['views', 'estimatedMinutesWatched', 'comments', 'shares'].every(key => number(video.apiAggregate[key])) ||
        !Number.isSafeInteger(video.apiAggregate.likes) ||
        !Array.isArray(video.daily) || video.daily.length > 3660) fail();
    ids.add(video.id);
    const publication = Date.parse(video.publishedAt);
    if (Date.parse(value.apiThrough) - publication > 3660 * 86_400_000) fail();
    const days = new Set();
    for (const row of video.daily) {
      if (!day(row.day) || row.day > value.apiThrough || days.has(row.day) || !number(row.views)) fail();
      days.add(row.day);
    }
    for (const window of ['3', '7']) {
      const row = video.windows?.[window];
      if (!row || typeof row.complete !== 'boolean' || (row.complete && (!number(row.views) || !number(row.watchHours)))) fail();
    }
  }
  const discovery = value.youtubeRefresh?.discovery;
  if (discovery !== undefined) {
    const validDate = text => typeof text === 'string' && Number.isFinite(Date.parse(text));
    const countKeys = ['publicUploadsCount', 'confirmedLongformCount', 'includedLongformCount',
      'excludedShortsCount', 'excludedLiveCount', 'excludedOtherCount', 'nonPublicOrUnavailableCount'];
    const listKeys = ['unknownFormatIds', 'unreportedLongformIds', 'pendingPublicationIds'];
    if (!discovery || !['complete', 'partial'].includes(discovery.status) ||
        typeof discovery.inventoryComplete !== 'boolean' || !validDate(discovery.observedAt) ||
        Date.parse(discovery.observedAt) !== Date.parse(value.capturedAt) ||
        countKeys.some(key => !Number.isSafeInteger(discovery[key]) || discovery[key] < 0) ||
        discovery.includedLongformCount !== value.videos.length ||
        discovery.confirmedLongformCount < discovery.includedLongformCount ||
        discovery.publicUploadsCount < discovery.confirmedLongformCount ||
        listKeys.some(key => !Array.isArray(discovery[key]) || discovery[key].length > 10000 ||
          discovery[key].some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id)) ||
          new Set(discovery[key]).size !== discovery[key].length)) fail();
    if (discovery.channelPublicVideoCount !== undefined &&
        (discovery.channelPublicVideoCount !== null &&
          (!Number.isSafeInteger(discovery.channelPublicVideoCount) || discovery.channelPublicVideoCount < 0) ||
          discovery.inventoryComplete && discovery.channelPublicVideoCount !== discovery.publicUploadsCount)) fail();
    if (discovery.supplementalPublicIdsCount !== undefined &&
        (!Number.isSafeInteger(discovery.supplementalPublicIdsCount) || discovery.supplementalPublicIdsCount < 0)) fail();
    if (discovery.status === 'complete' && (
      discovery.inventoryComplete !== true ||
      discovery.confirmedLongformCount !== value.videos.length ||
      listKeys.some(key => discovery[key].length) ||
      discovery.publicUploadsCount !== discovery.confirmedLongformCount + discovery.excludedShortsCount +
        discovery.excludedLiveCount + discovery.excludedOtherCount
    )) fail();
  }
  // The independent public-counter payload is validated separately. Its
  // failure must not invalidate otherwise sound channel Analytics.
  return value;
}

function publicCounterHistory(current, history) {
  if (!current) return [];
  const observations = new Map();
  const cutoff = Date.parse(current.capturedAt);
  for (const candidate of [...(Array.isArray(history) ? history : []), current]) {
    try {
      const report = validatePublicYouTubeReport(candidate);
      const { capturedAt, channel } = report;
      if (channel.id !== current.channel.id || Date.parse(capturedAt) > cutoff ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(capturedAt) ||
          new Date(`${capturedAt.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== capturedAt.slice(0, 10)) continue;
      // Use the report capture, not the enclosing private refresh/archive time.
      // The current row wins when archived refreshes repeat the same observation.
      if (observations.has(capturedAt) && candidate !== current) continue;
      observations.set(capturedAt, {
        capturedAt, views: channel.views, subscribers: channel.subscribers, videoCount: channel.videoCount,
      });
    } catch { /* Ignore legacy bundles, private rows and malformed projections. */ }
  }
  return [...observations.values()]
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || a.capturedAt.localeCompare(b.capturedAt));
}

export async function loadReportingInputs({ storeFactory = createCloudStore, bundled, includePublicHistory = false } = {}) {
  const fallback = bundled || await readBundledInputs();
  let snapshot = fallback.snapshot;
  let publicYouTube = null;
  let publicYouTubeHistory = [];
  const social = validateSocialImport(fallback.social);
  // Campaigns are reviewed, checked-in evidence validated against the retained
  // bundled catalog at build time. A refreshed counter report can omit content
  // (Shorts does), without invalidating a previously confirmed placement.
  const campaigns = validateCampaigns(fallback.campaigns, fallback.snapshot, social);
  const origins = Object.fromEntries(CLOUD_SOURCES.map(id => [id, 'bundled']));
  let storageStatus = 'cloud';
  let statuses = [];
  try {
    const store = storeFactory();
    const [saved, statusResult, history] = await Promise.all([
      Promise.allSettled(CLOUD_SOURCES.map(id => store.loadSnapshot(id))),
      store.getStatuses().then(value => ({ value })).catch(() => ({ failed: true })),
      // A missing history read must not remove the last good current counters.
      Promise.resolve().then(() => includePublicHistory ? store.loadPublicYouTubeHistory?.() : [])
        .catch(() => []),
    ]);
    publicYouTubeHistory = history;
    for (let index = 0; index < saved.length; index++) {
      if (saved[index].status === 'rejected') {
        storageStatus = 'unavailable';
        continue;
      }
      const row = saved[index].value;
      if (!row) continue;
      const id = CLOUD_SOURCES[index];
      if (id === 'youtube' && row.payload?.publicReport) {
        try { publicYouTube = validatePublicYouTubeReport(row.payload.publicReport); }
        catch { storageStatus = 'unavailable'; }
      }
      try {
        if (id === 'youtube') snapshot = youtubeSnapshot(row.payload);
        else {
          const validated = validateSocialImport({ schemaVersion: 1, sources: [row.payload] }).sources[0];
          if (validated.id !== id) throw Error();
          social.sources = social.sources.filter(source => source.id !== id);
          social.sources.push(validated);
        }
        origins[id] = 'cloud';
      } catch { storageStatus = 'unavailable'; }
    }
    if (statusResult.failed) storageStatus = 'unavailable';
    else statuses = statusResult.value;
  } catch (error) {
    storageStatus = error.code === 'not-configured' ? 'not-configured' : 'unavailable';
  }
  return { snapshot, social, campaigns, storageStatus, origins, statuses,
    publicYouTube, counterHistory: publicCounterHistory(publicYouTube, publicYouTubeHistory),
    historicalSnapshot: fallback.snapshot };
}

export async function loadPublicReport(options) {
  const input = await loadReportingInputs({ ...options, includePublicHistory: true });
  let channelPerformance = null, shortsPerformance = null;
  // Publish only the selected aggregate/daily fields. An invalid optional
  // performance report must not hide independently validated public counters.
  try {
    if (input.origins.youtube === 'cloud' && input.snapshot.channelAnalytics) {
      channelPerformance = projectChannelPerformance(input.snapshot.channelAnalytics);
    }
  } catch { /* Unavailable performance is not replaced with inferred values. */ }
  try {
    if (input.origins['youtube-shorts'] === 'cloud') {
      const shorts = input.social.sources.find(source => source.id === 'youtube-shorts');
      if (shorts) shortsPerformance = projectShortsPerformance(shorts);
    }
  } catch { /* Malformed or unsupported Shorts sources stay unavailable. */ }
  const publicSnapshot = input.publicYouTube ? { publicReport: input.publicYouTube }
    : channelPerformance ? {} : input.historicalSnapshot;
  const report = buildPublicReport(publicSnapshot, input.social, input.campaigns, {
    allowHistoricalYouTube: !input.publicYouTube && !channelPerformance,
  });
  report.storageStatus = input.storageStatus;
  report.storageNote = {
    cloud: 'Using saved snapshots from online storage where available. Each platform shows its own coverage and collection date.',
    'not-configured': 'Online storage is not configured. Showing the bundled historical snapshots.',
    unavailable: 'Online storage could not be fully read. Bundled historical snapshots are used where online snapshots are unavailable.',
  }[input.storageStatus];
  for (const source of report.sources) {
    const id = source.id === 'youtube-longform' ? 'youtube' : source.id;
    if (id === 'youtube') {
      source.counterHistory = input.counterHistory;
      source.performance = channelPerformance;
      if (channelPerformance) {
        source.format = 'All formats';
        source.scope = 'YouTube channel performance across all formats, including Shorts and live streams. Period Analytics and public lifetime counters have separate reporting dates.';
        if (!input.publicYouTube) {
          source.status = 'snapshot';
          source.accountLabel = 'Scran & Pints';
          source.capturedAt = channelPerformance.capturedAt;
          source.dateRange = { ...channelPerformance.dateRange, timezone: channelPerformance.dateRange.timeZone };
          delete source.dateRange.timeZone;
          source.provenance = { kind: 'official-api', label: 'YouTube Analytics API · channel performance' };
          source.metrics = { ...channelPerformance.totals, followers: null, videoCount: null, engagedViews: null };
        }
      }
    }
    if (id === 'youtube-shorts') {
      source.performance = shortsPerformance;
      if (shortsPerformance) {
        source.status = 'snapshot';
        source.accountLabel = 'Scran & Pints';
        source.capturedAt = shortsPerformance.capturedAt;
        source.dateRange = { start: shortsPerformance.dateRange.start, end: shortsPerformance.dateRange.end,
          timezone: shortsPerformance.dateRange.timeZone };
        source.scope = 'YouTube Shorts performance for the stated reporting window. Shorts are included in all-format channel performance; do not add them to the channel totals.';
        source.provenance = { kind: 'official-api', label: 'YouTube Analytics API · Shorts performance' };
        source.metrics = { ...shortsPerformance.totals, followers: null };
        source.daily = shortsPerformance.daily.map(row => ({
          day: row.date, ...Object.fromEntries(['views', 'engagedViews', 'watchHours', 'likes', 'comments', 'shares',
            'subscribersGained', 'subscribersLost', 'subscribersNet'].map(key => [key, row[key] ?? null])),
          complete: row.views !== null, missing: row.views === null ? ['daily record'] : [],
        }));
      }
    }
    source.snapshotOrigin = id === 'youtube' ? input.publicYouTube || channelPerformance ? 'cloud' : 'bundled'
      : id === 'youtube-shorts' ? shortsPerformance ? 'cloud' : 'unavailable' : input.origins[id];
    // The YouTube job has independent public/private branches. Its combined
    // completion time does not establish a successful public counter refresh.
    if (id === 'youtube' || id === 'youtube-shorts') { source.syncStatus = null; continue; }
    const status = input.statuses.find(row => row.id === id)?.lastSync;
    source.syncStatus = status ? {
      status: status.status, errorCode: status.errorCode, completedAt: status.completedAt,
    } : null;
  }
  return report;
}
