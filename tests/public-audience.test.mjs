import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicReport, readBundledInputs } from '../lib/cloud-report.mjs';
import { publicYouTubeFixture } from './fixtures/public-youtube.mjs';

const CAPTURE = '2026-10-20T12:00:00.000Z';
const OLD_CAPTURE = '2026-10-18T12:00:00.000Z';
const range = (end = '2026-10-19') => ({ start: '2026-08-28', end, timezone: 'America/Los_Angeles' });
const activity = { views: 100, estimatedMinutesWatched: 90, averageViewDuration: 54,
  averageViewPercentage: 30, likes: 5, comments: 2, shares: 1, subscribersGained: 3, subscribersLost: 1 };
const channelAnalytics = () => ({
  capturedAt: CAPTURE, channelId: 'UCAX4l1JUAymaMHVKiRFzK-A', dateRange: range(),
  aggregate: { ...activity }, daily: [{ day: '2026-10-19', ...activity }],
  coverage: { startBasis: 'channel-created', endBasis: 'channel-daily-same-metrics' },
});
const entry = (rows, overrides = {}) => ({
  status: 'collected', attemptedAt: CAPTURE, attemptedRange: range(), errorCode: null,
  report: { capturedAt: CAPTURE, dateRange: range(), endStatus: 'query-bound-no-daily-completeness-signal', rows },
  ...overrides,
});
const breakdowns = () => ({
  country: entry([{ country: 'GB', views: 80, estimatedMinutesWatched: 72 },
    { country: 'ZZ', views: 20, estimatedMinutesWatched: 18 }]),
  demographics: entry([{ ageGroup: 'age25-34', gender: 'female', viewerPercentage: 27.5 },
    { ageGroup: 'age25-34', gender: 'male', viewerPercentage: 35.25 }]),
  searchTerms: entry([{ insightTrafficSourceDetail: 'PRIVATE_SEARCH_SENTINEL', views: 9, estimatedMinutesWatched: 5 }]),
});

async function fixture(change = () => {}) {
  const bundled = await readBundledInputs();
  const snapshot = structuredClone(bundled.snapshot);
  Object.assign(snapshot, {
    capturedAt: CAPTURE, publicReport: publicYouTubeFixture(), channelAnalytics: channelAnalytics(),
    channelBreakdowns: breakdowns(), refreshToken: 'PRIVATE_TOKEN_SENTINEL',
    notebook: 'PRIVATE_NOTEBOOK_SENTINEL', finance: 'PRIVATE_FINANCE_SENTINEL',
  });
  change(snapshot, bundled);
  const report = await loadPublicReport({
    bundled, storeFactory: () => ({
      loadSnapshot: async source => source === 'youtube' ? { payload: snapshot } : null,
      getStatuses: async () => [], loadPublicYouTubeHistory: async () => [],
    }),
  });
  return report;
}

test('public audience is compact and contains only selected native country and demographic fields', async () => {
  const report = await fixture();
  const audience = report.sources.find(source => source.id === 'youtube-longform').audience;
  assert.deepEqual(Object.keys(audience), ['country', 'demographics']);
  assert.deepEqual(audience.country.report.rows, breakdowns().country.report.rows);
  assert.deepEqual(audience.demographics.report.rows, breakdowns().demographics.report.rows);
  assert.deepEqual(Object.keys(audience.country.report), ['capturedAt', 'dateRange', 'rows']);
  assert.equal(audience.country.attemptedAt, CAPTURE);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_[A-Z_]+_SENTINEL|refreshToken|notebook|finance|channelBreakdowns|endStatus/);
  assert.ok(report.sources.filter(source => source.id !== 'youtube-longform').every(source => !Object.hasOwn(source, 'audience')));
});

test('retained audience keeps old source dates separate from latest failed attempt', async () => {
  const report = await fixture(snapshot => {
    const country = snapshot.channelBreakdowns.country;
    country.status = 'failed-retained';
    country.errorCode = 'network';
    country.report.capturedAt = OLD_CAPTURE;
    country.report.dateRange = range('2026-10-17');
  });
  const country = report.sources[0].audience.country;
  assert.equal(country.status, 'failed-retained');
  assert.equal(country.attemptedAt, CAPTURE);
  assert.equal(country.attemptedRange.end, '2026-10-19');
  assert.equal(country.report.capturedAt, OLD_CAPTURE);
  assert.equal(country.report.dateRange.end, '2026-10-17');
});

test('unavailable audience stays explicit and does not invent zero rows', async () => {
  const report = await fixture(snapshot => {
    snapshot.channelBreakdowns.country = entry(null, { status: 'no-rows', report: null });
    snapshot.channelBreakdowns.demographics = entry(null, { status: 'failed', errorCode: 'report-unavailable', report: null });
  });
  assert.equal(report.sources[0].audience.country.report, null);
  assert.equal(report.sources[0].audience.demographics.report, null);
  assert.equal(report.sources[0].audience.country.status, 'no-rows');
});

test('invalid optional audience cannot erase independent valid country data', async () => {
  for (const change of [
    value => { value.report.rows[0].viewerPercentage = 101; },
    value => { value.report.dateRange.end = '2026-02-30'; },
    value => { value.report.rows[0].rawProviderSecret = 'PRIVATE_TOKEN_SENTINEL'; },
    value => { value.attemptedAt = value.report.capturedAt = '2026-10-21T12:00:00.000Z'; },
  ]) {
    const report = await fixture(snapshot => change(snapshot.channelBreakdowns.demographics));
    assert.equal(report.sources[0].audience.demographics, null);
    assert.equal(report.sources[0].audience.country.report.rows[0].views, 80);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TOKEN_SENTINEL|rawProviderSecret/);
  }
});

test('audience requires trusted cloud origin and matching validated channel Analytics', async () => {
  for (const change of [
    snapshot => { delete snapshot.channelAnalytics; },
    snapshot => { snapshot.channelAnalytics.channelId = 'UCXXXXXXXXXXXXXXXXXXXXXX'; },
    snapshot => { snapshot.channelAnalytics.daily[0].views = -1; },
    snapshot => { snapshot.videos = []; },
  ]) {
    const report = await fixture(change);
    assert.equal(report.sources[0].audience, null);
  }
  const bundled = await readBundledInputs();
  bundled.snapshot.channelAnalytics = channelAnalytics();
  bundled.snapshot.channelBreakdowns = breakdowns();
  const report = await loadPublicReport({ bundled, storeFactory: () => { throw Object.assign(Error(), { code: 'not-configured' }); } });
  assert.equal(report.sources[0].audience, null);
});
