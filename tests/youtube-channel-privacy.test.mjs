import test from 'node:test';
import assert from 'node:assert/strict';
import { readBundledInputs, loadPublicReport } from '../lib/cloud-report.mjs';
import { createWorkshopDataHandler } from '../api/workshop-data.mjs';
import { validateChannelBreakdowns } from '../lib/youtube-breakdowns.mjs';
import { publicYouTubeFixture } from './fixtures/public-youtube.mjs';
import { YOUTUBE_ANALYTICS_PROVENANCE } from '../lib/social-schema.mjs';

const PRIVATE_CAPTURE = '2026-10-21T12:00:00.000Z';
const SHORTS_CAPTURE = '2026-10-19T12:00:00.000Z';
const BREAKDOWNS_CAPTURE = '2026-10-20T07:00:00.000Z';
function channelBreakdowns() {
  const dateRange = { start: '2026-01-01', end: '2026-10-17', timezone: 'America/Los_Angeles' };
  const entry = rows => ({
    status: 'collected', attemptedAt: BREAKDOWNS_CAPTURE, attemptedRange: { ...dateRange }, errorCode: null,
    report: { capturedAt: BREAKDOWNS_CAPTURE, dateRange: { ...dateRange },
      endStatus: 'query-bound-no-daily-completeness-signal', rows },
  });
  return validateChannelBreakdowns({
    country: entry([{ country: 'GB', views: 730000221, estimatedMinutesWatched: 730000222 }]),
    demographics: entry([{ ageGroup: '18-24', gender: 'female', viewerPercentage: 37.123456 }]),
  });
}
function channelAnalytics() {
  const aggregate = { views: 730000001, estimatedMinutesWatched: 730000002,
    averageViewDuration: 73, averageViewPercentage: 37, likes: 730000003,
    comments: 730000004, shares: 730000005, subscribersGained: 730000006, subscribersLost: 3 };
  return { capturedAt: PRIVATE_CAPTURE, channelId: 'UCAX4l1JUAymaMHVKiRFzK-A',
    dateRange: { start: '2026-01-01', end: '2026-10-18', timezone: 'America/Los_Angeles' },
    aggregate, daily: [{ day: '2026-10-18', ...aggregate }],
    coverage: { startBasis: 'channel-created', endBasis: 'channel-daily-same-metrics' } };
}
function shortsAnalytics() {
  return {
    id: 'youtube-shorts', label: 'YouTube Shorts', accountLabel: 'Scran & Pints',
    status: 'snapshot', capturedAt: SHORTS_CAPTURE,
    dateRange: { start: '2026-09-19', end: '2026-10-16', timezone: 'America/Los_Angeles' },
    scope: 'Shorts daily source.', provenance: { kind: 'official-api', label: YOUTUBE_ANALYTICS_PROVENANCE },
    metrics: { views: 730000111, engagedViews: 730000112, watchHours: 730000113,
      likes: 7, comments: 8, shares: 9, followers: null, subscribersNet: 10 },
    daily: [{ day: '2026-10-16', views: 730000111 }], content: [],
  };
}
const privatePattern = /channelAnalytics|shortsAnalytics|channelBreakdowns|viewerPercentage|730000112|73000022[12]|37\.123456|PRIVATE_EVIDENCE/;

test('only selected channel and Shorts performance enters public output; raw reports and audiences stay excluded', async () => {
  for (const mode of ['current', 'missing-public', 'invalid-public']) {
    const bundled = await readBundledInputs();
    const snapshot = structuredClone(bundled.snapshot);
    snapshot.channelAnalytics = channelAnalytics();
    snapshot.channelBreakdowns = channelBreakdowns();
    snapshot.capturedAt = PRIVATE_CAPTURE;
    snapshot.privateEvidence = 'PRIVATE_EVIDENCE';
    if (mode !== 'missing-public') snapshot.publicReport = publicYouTubeFixture();
    if (mode === 'invalid-public') snapshot.publicReport.channel.views = -1;
    const options = { bundled, storeFactory: () => ({
      loadSnapshot: async source => source === 'youtube' ? { payload: snapshot }
        : source === 'youtube-shorts' ? { payload: shortsAnalytics() } : null,
      getStatuses: async () => [],
      loadPublicYouTubeHistory: async () => [{
        channelAnalytics: channelAnalytics(), channelBreakdowns: channelBreakdowns(),
      }],
    }) };
    const report = await loadPublicReport(options);
    assert.doesNotMatch(JSON.stringify(report), privatePattern, mode);
    assert.equal(report.sources[0].performance.totals.views, 730000001);
    assert.equal(report.sources[0].performance.capturedAt, PRIVATE_CAPTURE);
    assert.equal(report.sources[1].performance.totals.views, 730000111);
    assert.equal(report.sources[1].performance.capturedAt, SHORTS_CAPTURE);
    assert.equal(report.sources[1].performance.daily[0].watchHours, null);
    assert.equal(report.sources[1].metrics.engagedViews, null);
    assert.equal(report.sources[0].capturedAt, mode === 'current' ? publicYouTubeFixture().capturedAt : PRIVATE_CAPTURE);
    assert.equal(report.sources[0].snapshotOrigin, 'cloud');
    assert.equal(report.sources[0].metrics.views, mode === 'current' ? 987654 : 730000001);
  }
});

function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(body) { this.body = JSON.parse(body); } };
}

test('workshop authorization precedes any read of channel or Shorts Analytics', async () => {
  let reads = 0;
  const handler = createWorkshopDataHandler({
    authorize: async (_req, res) => { res.statusCode = 401; res.end('{"error":"authentication_required"}'); return false; },
    loadInputs: async () => { reads++; throw Error('Private reports must not be read'); },
  });
  const res = response();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(reads, 0);
  assert.doesNotMatch(JSON.stringify(res.body), privatePattern);
});

test('authorized workshop retains native channel and Shorts values with their independent source dates', async () => {
  const handler = createWorkshopDataHandler({
    authorize: async () => ({ id: 'approved-test-user' }),
    loadInputs: async () => ({
      snapshot: { capturedAt: PRIVATE_CAPTURE, channelAnalytics: channelAnalytics(),
        channelBreakdowns: channelBreakdowns() },
      social: { schemaVersion: 1, sources: [shortsAnalytics()] },
      storageStatus: 'cloud', origins: { youtube: 'cloud', 'youtube-shorts': 'cloud' },
    }),
  });
  const res = response();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.channelAnalytics.aggregate.views, 730000001);
  assert.equal(res.body.channelAnalytics.dateRange.end, '2026-10-18');
  assert.equal(res.body.channelAnalytics.capturedAt, PRIVATE_CAPTURE);
  assert.equal(res.body.shortsAnalytics.metrics.views, 730000111);
  assert.equal(res.body.shortsAnalytics.dateRange.end, '2026-10-16');
  assert.equal(res.body.shortsAnalytics.capturedAt, SHORTS_CAPTURE);
  assert.equal(res.body.channelBreakdowns.country.report.rows[0].views, 730000221);
  assert.equal(res.body.channelBreakdowns.demographics.report.rows[0].viewerPercentage, 37.123456);
  assert.equal(res.body.channelBreakdowns.country.report.dateRange.end, '2026-10-17');
  assert.equal(res.body.channelBreakdowns.country.report.capturedAt, BREAKDOWNS_CAPTURE);
  assert.match(res.headers['cache-control'], /no-store/);
});
