import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateInstagramStudioCapture, applyInstagramStudioCapture } from '../lib/instagram-studio.mjs';
import { buildPublicReport } from '../lib/report-model.mjs';
import { instagramNativeFixture } from './fixtures/instagram-native.mjs';

const fixture = instagramNativeFixture;
const emptySource = () => ({ id: 'instagram', label: 'Instagram', status: 'not-connected', metrics: null, daily: [], content: [] });

test('synthetic Instagram capture preserves native relative totals and unknown boundaries', () => {
  const capture = validateInstagramStudioCapture(fixture());
  assert.equal(capture.capturedAt, '2026-01-15T12:00:00Z');
  assert.equal(capture.method, 'manual-browser-inspection');
  assert.equal(capture.followers, 42);
  assert.equal(capture.contentCount, null);
  assert.equal(capture.audience, null);
  assert.deepEqual(capture.windows.map(row => [row.periodDays, row.views, row.instagramViews,
    row.interactions, row.viewers, row.accountsEngaged]), [
    [7, 710, 700, 21, 70, 14],
    [30, 3010, 3000, 90, 300, 60],
    [90, 9010, 9000, 270, 900, 180],
  ]);
  for (const window of capture.windows) assert.deepEqual(window.dateRange, { start: null, end: null, timezone: null });
  assert.deepEqual(capture.windows.map(row => row.externalLinkTaps), [null, 2, 2]);
  assert.deepEqual(capture.windows.map(row => row.profileActivity), [9, 32, 92]);
  assert.deepEqual(capture.windows.map(row => row.profileVisits), [7, 30, 90]);
  assert.equal(capture.windows[0].views - capture.windows[0].instagramViews, 10);
  assert.equal(capture.windows[0].facebookViews, 0);
});

test('native percentages, Monday activity and the single inspected Reel remain observations', () => {
  const capture = validateInstagramStudioCapture(fixture());
  assert.deepEqual(capture.windows[0].viewAudience.map(row => row.percentage), [20, 80]);
  assert.deepEqual(capture.windows[1].viewContentTypes.map(row => row.percentage), [95, 5]);
  assert.deepEqual(capture.windows[2].interactionAudience.map(row => row.percentage), [30, 70]);
  assert.equal(capture.followerActivity.weekday, 'Monday');
  assert.equal(capture.followerActivity.timezone, null);
  assert.deepEqual(capture.followerActivity.hours, [2, 4, 6, 8, 7, 5, 3, 1].map((followers, i) => ({ hour: i * 3, followers })));
  assert.equal(capture.contentCoverage, 'sample');
  assert.equal(capture.content.length, 1);
  const reel = capture.content[0];
  assert.equal(reel.url, null);
  assert.equal(reel.reportingWindow, 'not-shown');
  assert.equal(reel.views, 100);
  assert.equal(reel.viewers, 80);
  assert.equal(reel.interactions, 12);
  assert.equal(reel.reelsInteractions, 0);
  assert.equal(reel.likes + reel.comments + reel.saves + reel.shares, 9);
});

test('projection makes manual Instagram reporting available without manufacturing lifetime or daily figures', () => {
  const report = buildPublicReport({}, { sources: [] }, { campaigns: [] }, { instagramCapture: fixture() });
  const source = report.sources.find(row => row.id === 'instagram');
  assert.equal(source.status, 'snapshot');
  assert.equal(source.provenance.kind, 'manual-browser');
  assert.equal(source.snapshotOrigin, 'manual-capture');
  assert.equal(source.counterScope, 'manual-current-followers');
  assert.equal(source.metrics.followers, 42);
  for (const [metric, value] of Object.entries(source.metrics)) if (metric !== 'followers') assert.equal(value, null, metric);
  assert.deepEqual(source.daily, []);
  assert.deepEqual(source.content, []);
  assert.equal(source.contentCount, null);
  assert.deepEqual(source.dateRange, { start: null, end: null, timezone: null });
  assert.equal(source.performance, undefined);
  assert.equal(source.manualCapture.content.length, 1);
  assert.doesNotMatch(JSON.stringify(report), /manual-browser-inspection[^]*\baccessToken\b/);
});

test('manual projection preserves separately collected API counters, series and source dates', () => {
  const source = { ...emptySource(), status: 'snapshot', capturedAt: '2026-10-22T12:00:00Z',
    provenance: { kind: 'official-api', label: 'Instagram API' }, counterScope: 'public-content-lifetime',
    metrics: { views: 500000, followers: 240 }, daily: [{ day: '2026-10-21', views: 4000 }],
    content: [{ id: 'real-api-inventory-item', views: 4000 }] };
  const original = structuredClone(source);
  const result = applyInstagramStudioCapture({ sources: [source] }, fixture()).sources[0];
  assert.deepEqual(source, original);
  assert.deepEqual(result.metrics, original.metrics);
  assert.deepEqual(result.daily, original.daily);
  assert.deepEqual(result.content, original.content);
  assert.equal(result.capturedAt, original.capturedAt);
  assert.equal(result.provenance.kind, 'official-api');
  assert.equal(result.manualCapture.capturedAt, fixture().capturedAt);
});

test('a retained newer manual capture cannot be replaced with an older bundled capture', () => {
  const fresh = fixture();
  fresh.capturedAt = '2026-10-22T10:00:00Z';
  fresh.followers = 240;
  const initial = applyInstagramStudioCapture({ sources: [emptySource()] }, fresh);
  const result = applyInstagramStudioCapture(initial, fixture()).sources[0];
  assert.equal(result.capturedAt, fresh.capturedAt);
  assert.equal(result.metrics.followers, 240);
});

test('historical YouTube build path also attaches the Instagram capture', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../data.json', import.meta.url), 'utf8'));
  const report = buildPublicReport(snapshot, { sources: [] }, { campaigns: [] }, {
    allowHistoricalYouTube: true, instagramCapture: fixture(),
  });
  assert.equal(report.sources.find(row => row.id === 'instagram').manualCapture.windows.length, 3);
  assert.equal(report.sources.find(row => row.id === 'youtube-longform').historical, true);
});

test('strict schema rejects private fields, invented windows, demographics, malformed counts and sample URLs', () => {
  const cases = [
    x => { x.ax = 'private-browser-dump'; },
    x => { x.accessToken = 'PRIVATE'; },
    x => { x.accountUsername = 'another-account'; },
    x => { x.method = 'official-api'; },
    x => { x.capturedAt = '2026-02-31T09:00:00Z'; },
    x => { x.windows[0].dateRange.start = '2026-10-14'; },
    x => { x.windows[0].dateRange.timezone = 'UTC'; },
    x => { x.windows[0].periodDays = 365; },
    x => { x.windows[0].views = -1; },
    x => { x.windows[0].interactions = 1.5; },
    x => { x.windows[0].viewAudience[0].percentage = 101; },
    x => { x.windows[0].viewAudience[0].label = 'access_token=PRIVATE'; },
    x => { x.windows[0].daily = [{ date: '2026-10-20', views: 100 }]; },
    x => { x.audience = { age: [] }; },
    x => { x.contentCoverage = 'complete'; },
    x => { x.content[0].url = 'https://www.instagram.com/insights/media/1000000000000000001/'; },
    x => { x.content[0].reportingWindow = 'lifetime'; },
    x => { x.content[0].capturedAt = '2026-10-22T09:00:00Z'; },
    x => { x.followerActivity.timezone = 'Europe/London'; },
    x => { x.followerActivity.hours.push(x.followerActivity.hours[0]); },
  ];
  for (const mutate of cases) {
    const value = fixture(); mutate(value);
    assert.throws(() => validateInstagramStudioCapture(value));
  }
  for (const mutate of cases.slice(0, 2)) {
    const value = fixture(); mutate(value);
    assert.throws(() => buildPublicReport({}, { sources: [] }, { campaigns: [] }, { instagramCapture: value }));
  }
});
