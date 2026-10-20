import test from 'node:test';
import assert from 'node:assert/strict';
import { projectChannelPerformance, projectShortsPerformance } from '../lib/performance-projection.mjs';
import { loadPublicReport, readBundledInputs } from '../lib/cloud-report.mjs';
import { YOUTUBE_ANALYTICS_PROVENANCE } from '../lib/social-schema.mjs';
import { publicYouTubeFixture } from './fixtures/public-youtube.mjs';

const channel = () => {
  const aggregate = {
    views: 120, estimatedMinutesWatched: 630, averageViewDuration: 315,
    averageViewPercentage: 52.5, likes: -1, comments: 3, shares: 4,
    subscribersGained: 7, subscribersLost: 9,
  };
  return {
    capturedAt: '2026-10-19T12:00:00.000Z', channelId: 'UCAX4l1JUAymaMHVKiRFzK-A',
    dateRange: { start: '2026-10-01', end: '2026-10-17', timezone: 'America/Los_Angeles' },
    aggregate, daily: [
      { day: '2026-10-17', ...aggregate },
      { day: '2026-10-15', ...aggregate, views: 0, estimatedMinutesWatched: 0, likes: 0 },
    ],
    coverage: { startBasis: 'channel-created', endBasis: 'channel-daily-same-metrics' },
  };
};
const shorts = () => ({
  id: 'youtube-shorts', label: 'YouTube Shorts', accountLabel: 'Scran & Pints', status: 'snapshot',
  capturedAt: '2026-10-18T12:00:00.000Z',
  dateRange: { start: '2026-10-01', end: '2026-10-16', timezone: 'America/Los_Angeles' },
  scope: 'Shorts daily report.', provenance: { kind: 'official-api', label: YOUTUBE_ANALYTICS_PROVENANCE },
  metrics: { views: 80, engagedViews: 3141592, watchHours: 2.5, likes: -1, comments: 2, shares: 3,
    followers: null, subscribersNet: -2 },
  daily: [{ day: '2026-10-14', views: 0 }, { day: '2026-10-16', views: 80 }], content: [],
});
const metricKeys = ['views', 'watchHours', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost', 'subscribersNet'];
const bundled = await readBundledInputs();
function snapshotWithPerformance() {
  const snapshot = structuredClone(bundled.snapshot);
  snapshot.channelAnalytics = channel();
  snapshot.publicReport = publicYouTubeFixture();
  return snapshot;
}
async function publicReport(snapshot = snapshotWithPerformance(), shortsSource = shorts(), fallback = bundled) {
  return loadPublicReport({ bundled: fallback, storeFactory: () => ({
    loadSnapshot: async source => source === 'youtube' ? snapshot && { payload: snapshot }
      : source === 'youtube-shorts' ? shortsSource && { payload: shortsSource } : null,
    getStatuses: async () => [], loadPublicYouTubeHistory: async () => [],
  }) });
}

test('channel performance projects only selected fields, with exact native dates, gaps, zeros and signed changes', () => {
  const input = channel();
  const before = structuredClone(input);
  const performance = projectChannelPerformance(input);
  assert.deepEqual(Object.keys(performance), ['capturedAt', 'dateRange', 'daily', 'totals']);
  assert.deepEqual(Object.keys(performance.totals), metricKeys);
  assert.deepEqual(Object.keys(performance.daily[0]), ['date', ...metricKeys]);
  assert.deepEqual(performance.dateRange, { start: '2026-10-01', end: '2026-10-17', timeZone: 'America/Los_Angeles' });
  assert.deepEqual(performance.daily.map(row => row.date), ['2026-10-15', '2026-10-17']);
  assert.equal(performance.daily[0].views, 0);
  assert.equal(performance.daily[0].watchHours, 0);
  assert.equal(performance.totals.watchHours, 10.5);
  assert.equal(performance.totals.likes, -1);
  assert.equal(performance.totals.subscribersNet, -2);
  assert.doesNotMatch(JSON.stringify(performance), /averageView|estimatedMinutes|channelId|coverage|aggregate/);
  assert.deepEqual(input, before);
});

test('invalid channel dates, identities and native metrics cannot enter public performance', () => {
  for (const change of [
    source => { source.capturedAt = '2026-02-31T12:00:00Z'; },
    source => { source.capturedAt = '2026-10-17T01:00:00Z'; }, // Still October 16 Pacific.
    source => { source.dateRange.start = '2026-02-31'; },
    source => { source.dateRange.end = '2026-10-20'; },
    source => { source.dateRange.timezone = 'UTC'; },
    source => { source.channelId = 'OTHER_CHANNEL'; },
    source => { source.daily.push(structuredClone(source.daily[0])); },
    source => { source.daily[0].day = '2026-09-30'; },
    source => { source.daily = [source.daily[1]]; },
    source => { source.aggregate.views = null; },
    source => { source.aggregate.subscribersLost = -1; },
    source => { source.aggregate.likes = -1.5; },
    source => { source.aggregate.accessToken = 'PRIVATE'; },
    source => { source.notes = 'PRIVATE'; },
  ]) {
    const source = channel(); change(source);
    assert.throws(() => projectChannelPerformance(source), /Invalid performance source/);
  }
});

test('Shorts keeps stored period totals and publishes only available views in daily rows', () => {
  const performance = projectShortsPerformance(shorts());
  assert.deepEqual(Object.keys(performance.totals), metricKeys);
  assert.equal(performance.totals.watchHours, 2.5);
  assert.equal(performance.totals.likes, -1);
  assert.equal(performance.totals.subscribersNet, -2);
  assert.equal(performance.totals.subscribersGained, null);
  assert.equal(performance.totals.subscribersLost, null);
  assert.deepEqual(performance.daily.map(row => row.views), [0, 80]);
  for (const row of performance.daily) {
    for (const key of metricKeys.filter(key => key !== 'views')) assert.equal(row[key], null);
  }
  assert.doesNotMatch(JSON.stringify(performance), /engagedViews|3141592|content|scope|accountLabel/);
});

test('Shorts publication validates source provenance and dates beyond the storage schema', () => {
  for (const change of [
    source => { source.capturedAt = '2026-02-31T12:00:00Z'; },
    source => { source.dateRange.end = '2026-10-19'; },
    source => { source.dateRange.timezone = 'UTC'; },
    source => { source.provenance.label = 'Unverified provider'; },
    source => { source.provenance.kind = 'platform-export'; },
    source => { source.daily[0].day = '2026-09-30'; },
    source => { source.daily.push(structuredClone(source.daily[0])); },
  ]) {
    const source = shorts(); change(source);
    assert.throws(() => projectShortsPerformance(source));
  }
});

test('public endpoint retains independent counter/performance dates and excludes raw private objects', async () => {
  const snapshot = snapshotWithPerformance();
  snapshot.credentials = { refreshToken: 'PRIVATE_REFRESH_TOKEN' };
  snapshot.channelBreakdowns = { demographics: { viewerPercentage: 72.123456 } };
  snapshot.workshopNotes = 'PRIVATE_WORKSHOP_NOTE';
  snapshot.videos[0].metadata = { privacyStatus: 'private', title: 'NONPUBLIC_CONTENT_TITLE' };
  snapshot.history = { rows: ['PRIVATE_HISTORY_RECORD'] };
  const report = await publicReport(snapshot);
  const youtube = report.sources[0], short = report.sources[1];
  assert.equal(youtube.performance.capturedAt, channel().capturedAt);
  assert.equal(youtube.capturedAt, publicYouTubeFixture().capturedAt);
  assert.equal(youtube.metrics.views, publicYouTubeFixture().channel.views);
  assert.equal(youtube.performance.totals.views, 120);
  assert.equal(short.performance.capturedAt, shorts().capturedAt);
  assert.equal(short.metrics.views, 80);
  assert.equal(short.status, 'snapshot');
  assert.match(short.scope, /do not add/);
  assert.deepEqual(youtube.content.map(row => row.id), publicYouTubeFixture().content.map(row => row.id));
  assert.doesNotMatch(JSON.stringify(report),
    /PRIVATE_REFRESH_TOKEN|PRIVATE_WORKSHOP_NOTE|PRIVATE_HISTORY_RECORD|NONPUBLIC_CONTENT_TITLE|channelAnalytics|channelBreakdowns|viewerPercentage|72\.123456|3141592|refreshToken/);
});

test('invalid performance cannot replace valid counters or invalidate another source', async () => {
  const snapshot = snapshotWithPerformance();
  snapshot.channelAnalytics.daily[0].day = '2026-02-31';
  const report = await publicReport(snapshot);
  assert.equal(report.sources[0].performance, null);
  assert.equal(report.sources[0].metrics.views, publicYouTubeFixture().channel.views);
  assert.equal(report.sources[1].performance.totals.views, 80);
  const invalidShorts = shorts();
  invalidShorts.dateRange.end = '2026-10-19';
  const another = await publicReport(snapshotWithPerformance(), invalidShorts);
  assert.equal(another.sources[0].performance.totals.views, 120);
  assert.equal(another.sources[1].performance, null);
});

test('without public counters, verified channel performance uses its own dates and exposes no video metadata', async () => {
  const snapshot = snapshotWithPerformance();
  delete snapshot.publicReport;
  const youtube = (await publicReport(snapshot)).sources[0];
  assert.equal(youtube.snapshotOrigin, 'cloud');
  assert.equal(youtube.historical, undefined);
  assert.equal(youtube.format, 'All formats');
  assert.equal(youtube.capturedAt, channel().capturedAt);
  assert.equal(youtube.dateRange.end, channel().dateRange.end);
  assert.equal(youtube.metrics.views, 120);
  assert.deepEqual(youtube.content, []);
  assert.deepEqual(youtube.counterHistory, []);
});

test('bundled source objects do not authorize new channel or Shorts performance publication', async () => {
  const fallback = structuredClone(bundled);
  fallback.snapshot.channelAnalytics = channel();
  fallback.social = { schemaVersion: 1, sources: [shorts()] };
  const report = await publicReport(null, null, fallback);
  assert.equal(report.sources[0].performance, null);
  assert.equal(report.sources[1].performance, null);
  assert.equal(report.sources[0].historical, true);
});
