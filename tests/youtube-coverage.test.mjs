import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPublicReport, publicYouTubeThumbnail, youtubeCoverage } from '../lib/report-model.mjs';
import { loadPublicReport, loadReportingInputs } from '../lib/cloud-report.mjs';
import { syncCloudSource } from '../lib/cloud-sync.mjs';

import { publicYouTubeFixture } from './fixtures/public-youtube.mjs';

const baseline = JSON.parse(await readFile(new URL('../data.json', import.meta.url), 'utf8'));
const CAPTURED = '2026-10-20T12:00:00.000Z';
function discoveredSnapshot() {
  const result = structuredClone(baseline);
  for (const video of result.videos) video.packagingCapturedAt = baseline.capturedAt;
  result.capturedAt = CAPTURED;
  const original = result.videos[0];
  result.videos.push({
    id: 'NewVideo123', name: 'A newly discovered video', title: 'A newly discovered video',
    publishedAt: original.publishedAt, durationSeconds: original.durationSeconds,
    thumb: 'https://i.ytimg.com/vi/NewVideo123/hqdefault.jpg',
    discoveredAt: CAPTURED, packagingCapturedAt: CAPTURED,
    subscribersNet: original.subscribersNet, apiAggregate: structuredClone(original.apiAggregate),
    daily: structuredClone(original.daily), windows: structuredClone(original.windows),
  });
  result.youtubeRefresh = { discovery: {
    status: 'complete', inventoryComplete: true, publicUploadsCount: result.videos.length + 4,
    confirmedLongformCount: result.videos.length, includedLongformCount: result.videos.length,
    excludedShortsCount: 3, excludedLiveCount: 1, excludedOtherCount: 0,
    nonPublicOrUnavailableCount: 2, unknownFormatIds: [], unreportedLongformIds: [],
    pendingPublicationIds: [], observedAt: CAPTURED,
  } };
  return result;
}
const bundled = () => ({ snapshot: baseline, social: { schemaVersion: 1, sources: [] }, campaigns: { schemaVersion: 1, campaigns: [] } });
function cloudOptions(snapshot) { return { bundled: bundled(), storeFactory: () => ({
  loadSnapshot: async source => source === 'youtube' ? { payload: snapshot } : null,
  getStatuses: async () => [],
}) }; }
async function publicFromCloud(snapshot) { return loadPublicReport(cloudOptions(snapshot)); }

test('complete discovery expands private coverage without authorizing public Analytics disclosure', async () => {
  const snapshot = discoveredSnapshot();
  const input = await loadReportingInputs(cloudOptions(snapshot));
  assert.equal(input.origins.youtube, 'cloud');
  assert.equal(input.snapshot.videos.length, baseline.videos.length + 1);
  assert.equal(youtubeCoverage(input.snapshot).status, 'complete');
  assert.equal(buildPublicReport(snapshot).sources[0].metrics, null);
  const source = (await publicFromCloud(snapshot)).sources[0];
  assert.equal(source.snapshotOrigin, 'bundled');
  assert.equal(source.capturedAt, baseline.capturedAt);
  assert.equal(source.content.length, baseline.videos.length);
});

test('partial private coverage remains explicit without leaking discovery identifiers', async () => {
  const snapshot = discoveredSnapshot();
  Object.assign(snapshot.youtubeRefresh.discovery, {
    status: 'partial', publicUploadsCount: snapshot.videos.length + 7,
    confirmedLongformCount: snapshot.videos.length + 1,
    unknownFormatIds: ['UnknownId12'], unreportedLongformIds: ['NoReport123'], pendingPublicationIds: ['NewUpload12'],
  });
  const input = await loadReportingInputs(cloudOptions(snapshot));
  const coverage = youtubeCoverage(input.snapshot);
  assert.equal(coverage.status, 'partial');
  assert.equal(coverage.unknownFormatCount, 1);
  assert.equal(coverage.unreportedLongformCount, 1);
  assert.equal(coverage.pendingPublicationCount, 1);
  assert.doesNotMatch(JSON.stringify(await publicFromCloud(snapshot)), /UnknownId12|NoReport123|NewUpload12|nonPublicOrUnavailableCount/);
});

test('a complete claim with missing reports or inconsistent inventory counts cannot replace baseline reporting', async () => {
  for (const change of [
    { unreportedLongformIds: ['NoReport123'] },
    { confirmedLongformCount: 7 },
    { includedLongformCount: 4 },
    { publicUploadsCount: 999 },
    { inventoryComplete: false },
  ]) {
    const snapshot = discoveredSnapshot();
    Object.assign(snapshot.youtubeRefresh.discovery, change);
    const report = await publicFromCloud(snapshot);
    assert.equal(report.storageStatus, 'unavailable');
    assert.equal(report.sources[0].snapshotOrigin, 'bundled');
    assert.equal(report.sources[0].content.length, baseline.videos.length);
  }
});

test('a counted inventory gap remains a readable partial private report', async () => {
  const snapshot = discoveredSnapshot();
  Object.assign(snapshot.youtubeRefresh.discovery, {
    status: 'partial', inventoryComplete: false,
    channelPublicVideoCount: snapshot.youtubeRefresh.discovery.publicUploadsCount + 6,
    supplementalPublicIdsCount: 0,
  });
  const input = await loadReportingInputs(cloudOptions(snapshot));
  assert.equal(input.origins.youtube, 'cloud');
  assert.equal(input.storageStatus, 'cloud');
  assert.equal(youtubeCoverage(input.snapshot).status, 'partial');
  assert.equal(input.snapshot.videos.length, snapshot.videos.length);
  snapshot.youtubeRefresh.discovery.inventoryComplete = true;
  assert.equal((await loadReportingInputs(cloudOptions(snapshot))).origins.youtube, 'bundled');
});

test('discovered videos may lack a thumbnail without fabricating one, but unsafe thumbnail URLs fail closed', async () => {
  const snapshot = discoveredSnapshot();
  snapshot.videos.at(-1).thumb = null;
  assert.equal((await loadReportingInputs(cloudOptions(snapshot))).snapshot.videos.at(-1).thumb, null);
  for (const value of [
    'https://i.ytimg.com.evil.example/vi/NewVideo123/hqdefault.jpg',
    'https://user:secret@i.ytimg.com/vi/NewVideo123/hqdefault.jpg',
    'javascript:alert(1)', 'https://i.ytimg.com/private/secret',
  ]) {
    assert.equal(publicYouTubeThumbnail(value), null);
    snapshot.videos.at(-1).thumb = value;
    assert.equal((await loadReportingInputs(cloudOptions(snapshot))).origins.youtube, 'bundled');
  }
});

test('the historical baseline keeps its selected inventory scope until discovery really succeeds', () => {
  const source = buildPublicReport(baseline, undefined, undefined, { allowHistoricalYouTube: true }).sources[0];
  assert.equal(source.coverage.status, 'selected');
  assert.equal(source.coverage.publicUploadsCount, null);
  assert.match(source.scope, /selected content, not channel totals/);
  assert.equal(source.content[0].thumbnailSource, 'saved-image');
});

test('cloud sync records partial inventory as partial without losing available reports', async () => {
  const snapshot = discoveredSnapshot();
  Object.assign(snapshot.youtubeRefresh.discovery, {
    status: 'partial', publicUploadsCount: snapshot.videos.length + 5, unknownFormatIds: ['UnknownId12'],
  });
  let saved;
  const store = {
    acquireSyncLock: async () => true, releaseSyncLock: async () => true,
    getConnection: async () => ({ credentials: { accessToken: 'test-only-access' } }),
    loadSnapshot: async () => ({ payload: baseline }),
    saveSnapshot: async (_source, payload, metadata) => { saved = { payload, metadata }; return { saved: true }; },
    recordSyncResult: async () => {},
  };
  const result = await syncCloudSource({
    source: 'youtube', store, env: {}, now: () => CAPTURED,
    collectors: { youtube: async () => ({ snapshot, warnings: ['A new upload has no format report yet.'] }) },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.window.scope, 'partial-public-longform-since-publication');
  assert.equal(saved.metadata.status, 'partial');
  assert.equal(saved.payload.videos.length, baseline.videos.length + 1);
  assert.doesNotMatch(JSON.stringify(result), /test-only-access|UnknownId12/);
});


test('public counters remain independent of raw per-video Analytics and private evidence', async () => {
  const snapshot = discoveredSnapshot();
  snapshot.publicReport = publicYouTubeFixture();
  snapshot.videos[0].apiAggregate.views = 777777777;
  snapshot.videos[0].apiAggregate.estimatedMinutesWatched = 666666666;
  snapshot.privateSecret = 'NEVER_PUBLIC';
  const report = await publicFromCloud(snapshot);
  const source = report.sources[0];
  assert.equal(source.snapshotOrigin, 'cloud');
  assert.equal(source.counterScope, 'public-channel');
  assert.equal(source.metrics.views, 987654);
  assert.equal(source.metrics.followers, 12300);
  assert.equal(source.metrics.videoCount, 1);
  for (const key of ['watchHours', 'engagedViews', 'shares', 'subscribersNet']) assert.equal(source.metrics[key], null);
  assert.deepEqual(source.daily, []);
  assert.equal(source.content[0].platform, 'youtube');
  assert.equal(source.content[0].views, 12345);
  assert.equal(source.content[0].watchHours, null);
  assert.equal(source.content[0].packagingCapturedAt, CAPTURED);
  assert.match(source.scope, /including Shorts and live streams/);
  assert.doesNotMatch(JSON.stringify(report), /777777777|666666666|NEVER_PUBLIC|NewVideo123|creatorContentType|estimatedMinutesWatched/);
  assert.equal(report.sources[1].status, 'included-in-channel');
  assert.equal(report.sources[1].metrics, null);
});

test('public counters stay available independently of private payload validation', async () => {
  const report = await publicFromCloud({ capturedAt: 'invalid', videos: [], publicReport: publicYouTubeFixture() });
  assert.equal(report.sources[0].snapshotOrigin, 'cloud');
  assert.equal(report.sources[0].metrics.views, 987654);
  assert.equal(report.sources[0].capturedAt, CAPTURED);
});

test('invalid public projections fail closed to the published baseline, never newer private counters', async () => {
  for (const change of [report => { report.secret = 'no'; }, report => { report.content[0].watchHours = 55; },
    report => { report.content[0].thumbnail = 'https://evil.example/image.jpg'; }, report => { report.channel.views = -1; }]) {
    const snapshot = discoveredSnapshot();
    snapshot.publicReport = publicYouTubeFixture();
    change(snapshot.publicReport);
    const source = (await publicFromCloud(snapshot)).sources[0];
    assert.equal(source.snapshotOrigin, 'bundled');
    assert.equal(source.capturedAt, baseline.capturedAt);
    assert.equal(source.content.length, baseline.videos.length);
  }
});

test('historical fallback does not claim Shorts are included in the selected episode totals', async () => {
  const report = await publicFromCloud(discoveredSnapshot());
  assert.equal(report.sources[0].historical, true);
  assert.equal(report.sources[1].status, 'not-connected');
  assert.match(report.sources[1].scope, /excludes Shorts/);
  assert.doesNotMatch(report.sources[1].scope, /Included in channel counters/);
});
