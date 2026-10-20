import { readFile } from 'node:fs/promises';
import { createCloudStore, CLOUD_SOURCES } from './cloud-store.mjs';
import { buildPublicReport, publicYouTubeThumbnail, validatePublicYouTubeReport } from './report-model.mjs';
import { validateSocialImport } from './social-schema.mjs';
import { validateCampaigns } from './campaign-schema.mjs';

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
        !['views', 'estimatedMinutesWatched', 'likes', 'comments', 'shares'].every(key => number(video.apiAggregate[key])) ||
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
        discovery.inventoryComplete !== true || !validDate(discovery.observedAt) ||
        Date.parse(discovery.observedAt) !== Date.parse(value.capturedAt) ||
        countKeys.some(key => !Number.isSafeInteger(discovery[key]) || discovery[key] < 0) ||
        discovery.includedLongformCount !== value.videos.length ||
        discovery.confirmedLongformCount < discovery.includedLongformCount ||
        discovery.publicUploadsCount < discovery.confirmedLongformCount ||
        listKeys.some(key => !Array.isArray(discovery[key]) || discovery[key].length > 10000 ||
          discovery[key].some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id)) ||
          new Set(discovery[key]).size !== discovery[key].length)) fail();
    if (discovery.status === 'complete' && (
      discovery.confirmedLongformCount !== value.videos.length ||
      listKeys.some(key => discovery[key].length) ||
      discovery.publicUploadsCount !== discovery.confirmedLongformCount + discovery.excludedShortsCount +
        discovery.excludedLiveCount + discovery.excludedOtherCount
    )) fail();
  }
  // Keep projection compatibility inside the fallback boundary.
  buildPublicReport(value);
  return value;
}

export async function loadReportingInputs({ storeFactory = createCloudStore, bundled } = {}) {
  const fallback = bundled || await readBundledInputs();
  let snapshot = fallback.snapshot;
  let publicYouTube = null;
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
    const [saved, statusResult] = await Promise.all([
      Promise.allSettled(CLOUD_SOURCES.map(id => store.loadSnapshot(id))),
      store.getStatuses().then(value => ({ value })).catch(() => ({ failed: true })),
    ]);
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
    publicYouTube, historicalSnapshot: fallback.snapshot };
}

export async function loadPublicReport(options) {
  const input = await loadReportingInputs(options);
  // A cloud Analytics refresh is private even when its original seed was
  // published. Only the independent API-key projection may replace that seed.
  const publicSnapshot = input.publicYouTube ? { publicReport: input.publicYouTube } : input.historicalSnapshot;
  const report = buildPublicReport(publicSnapshot, input.social, input.campaigns, {
    allowHistoricalYouTube: !input.publicYouTube,
  });
  report.storageStatus = input.storageStatus;
  report.storageNote = {
    cloud: 'Using saved snapshots from online storage where available. Each platform shows its own coverage and collection date.',
    'not-configured': 'Online storage is not configured. Showing the bundled historical snapshots.',
    unavailable: 'Online storage could not be fully read. Bundled historical snapshots are used where online snapshots are unavailable.',
  }[input.storageStatus];
  for (const source of report.sources) {
    const id = source.id === 'youtube-longform' ? 'youtube' : source.id;
    source.snapshotOrigin = id === 'youtube' ? input.publicYouTube ? 'cloud' : 'bundled'
      : id === 'youtube-shorts' ? 'unavailable' : input.origins[id];
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
