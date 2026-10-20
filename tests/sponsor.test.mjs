import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../sponsor.js', import.meta.url), 'utf8'))
  .split('const icons =')[0].replace(/^import .*\n/gm, '').replace(/^export /gm, '');
const context = vm.createContext({ Intl, Date });
vm.runInContext(source, context);
const plain = value => JSON.parse(JSON.stringify(value));
const sequence = Array.from({ length: 28 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 9, index + 1)).toISOString().slice(0, 10),
  views: index < 14 ? 10 : 20, watchHours: 2, subscribersNet: index < 14 ? -1 : 1,
}));
const performance = { dateRange: { start: '2026-10-01', end: '2026-10-28' }, daily: sequence };

test('YEET growth compares equal adjacent periods ending at the actual processed date', () => {
  const result = context.comparePeriods(performance, 14, 'views');
  assert.equal(result.start, '2026-10-15');
  assert.equal(result.end, '2026-10-28');
  assert.equal(result.previousStart, '2026-10-01');
  assert.equal(result.previousEnd, '2026-10-14');
  assert.equal(result.current.value, 280);
  assert.equal(result.previous.value, 140);
  assert.equal(result.percent, 100);
});

test('missing daily rows preserve reported values and suppress growth claims', () => {
  const result = context.comparePeriods({ ...performance, daily: sequence.filter(row => row.date !== '2026-10-21') }, 14, 'views');
  assert.equal(result.current.value, 260);
  assert.equal(result.current.days, 13);
  assert.equal(result.complete, false);
  assert.equal(result.change, null);
  assert.equal(result.percent, null);
});

test('zero baselines never generate Infinity and subscriber changes retain signs', () => {
  const zero = context.comparePeriods({ ...performance, daily: sequence.map((row, index) => ({ ...row, views: index < 14 ? 0 : 20 })) }, 14, 'views');
  assert.equal(zero.complete, true);
  assert.equal(zero.percent, null);
  assert.equal(zero.change, 280);
  const subscribers = context.comparePeriods(performance, 14, 'subscribersNet');
  assert.equal(subscribers.previous.value, -14);
  assert.equal(subscribers.current.value, 14);
  assert.equal(subscribers.change, 28);
});

test('cumulative views keep later valid points after a missing native value', () => {
  assert.deepEqual(plain(context.cumulativeViews({ daily: [
    { date: '2026-10-01', views: 5 }, { date: '2026-10-02', views: null }, { date: '2026-10-03', views: 7 },
  ] })), [{ date: '2026-10-01', value: 5 }, { date: '2026-10-02', value: null }, { date: '2026-10-03', value: 12 }]);
});

test('audience groups add native percentages without normalising withheld groups', () => {
  const rows = [
    { ageGroup: 'age18-24', gender: 'male', viewerPercentage: 20 },
    { ageGroup: 'age18-24', gender: 'female', viewerPercentage: 10 },
    { ageGroup: 'age25-34', gender: 'male', viewerPercentage: 40 },
  ];
  assert.deepEqual(plain(context.audienceGroups(rows, 'ageGroup')), [{ key: 'age18-24', value: 30 }, { key: 'age25-34', value: 40 }]);
  assert.deepEqual(plain(context.audienceGroups(rows, 'gender')), [{ key: 'male', value: 60 }, { key: 'female', value: 10 }]);
});

test('sponsor platform summaries include each social account once and exclude the Shorts subset', () => {
  const sources = context.sponsorSources({ sources: [
    { id: 'youtube-longform', metrics: { views: 100 } }, { id: 'youtube-shorts', metrics: { views: 80 } },
    { id: 'instagram', metrics: { views: 40 } }, { id: 'tiktok', metrics: { views: 30 } },
  ] });
  assert.deepEqual(plain(sources.map(item => item.id)), ['youtube-longform', 'instagram', 'tiktok']);
  assert.equal(sources.reduce((sum, item) => sum + item.source.metrics.views, 0), 170);
});

test('social daily account activity stays separate from lifetime media totals', () => {
  const result = context.sourcePerformance({ id: 'instagram', status: 'snapshot', metrics: { views: 9000 },
    dateRange: { start: '2026-10-01', end: '2026-10-03', timezone: 'UTC' },
    daily: [{ day: '2026-10-01', views: 5 }, { day: '2026-10-03', views: 7 }] });
  assert.deepEqual(plain(result.totals), {});
  assert.deepEqual(plain(result.daily.map(row => row.views)), [5, 7]);
  assert.equal(result.daily[0].watchHours, null);
  assert.equal(result.daily.some(row => row.date === '2026-10-02'), false);
  assert.equal(context.sourcePerformance({ id: 'tiktok', metrics: { views: 9000 }, daily: [] }), null);
});

test('Instagram audience percentages use their own returned follower-count denominator', () => {
  const shares = context.audienceShares([{ label: 'GB', count: 60 }, { label: 'US', count: 20 }]);
  assert.deepEqual(plain(shares), [{ label: 'GB', count: 60, share: 75 }, { label: 'US', count: 20, share: 25 }]);
  assert.deepEqual(plain(context.audienceShares([{ label: 'GB', count: 0 }])), []);
});

test('TikTok Studio daily history uses each metric family’s exact export window', () => {
  const overview = { start: '2026-10-17', end: '2026-10-18', timezone: null };
  const viewers = { start: '2026-10-18', end: '2026-10-19', timezone: null };
  const source = { id: 'tiktok', metrics: { views: 90000, followers: 171 }, studioSupplement: { performance: {
    capturedAt: '2026-10-20T12:00:00Z', dateRange: { start: overview.start, end: viewers.end, timezone: null },
    seriesRanges: { overview, followers: overview, viewers }, totals: { views: 30, totalViewers: null }, daily: [
      { date: '2026-10-17', views: 10, netFollowers: -2, totalViewers: null },
      { date: '2026-10-18', views: 20, netFollowers: 3, totalViewers: 12 },
      { date: '2026-10-19', views: null, netFollowers: null, totalViewers: 15 },
    ],
  } } };
  const performance = context.sourcePerformance(source);
  assert.equal(performance.studio, true);
  assert.equal(performance.daily[0].subscribersNet, -2);
  assert.equal(source.metrics.views, 90000);
  const views = context.metricPerformance(performance, 'views');
  assert.equal(views.dateRange.end, '2026-10-18');
  assert.deepEqual(plain(context.trendPoints(views, 'views', 90)), [
    { date: '2026-10-17', value: 10 }, { date: '2026-10-18', value: 20 },
  ]);
  assert.equal(context.metricPerformance(performance, 'totalViewers').dateRange.end, '2026-10-19');
  assert.equal(performance.totals.totalViewers, null);
});

test('TikTok 365-day graphs retain missing values and signed follower changes', () => {
  const performance = { dateRange: { start: '2025-10-19', end: '2026-10-18' }, daily: [
    { date: '2025-10-19', netFollowers: -1 }, { date: '2026-10-17', netFollowers: null }, { date: '2026-10-18', netFollowers: 2 },
  ] };
  assert.deepEqual(plain(context.trendPoints(performance, 'netFollowers', 365)), [
    { date: '2025-10-19', value: -1 }, { date: '2026-10-17', value: null }, { date: '2026-10-18', value: 2 },
  ]);
  const compared = context.comparePeriods(performance, 365, 'netFollowers');
  assert.equal(compared.current.value, 1);
  assert.equal(compared.percent, null);
  assert.equal(compared.complete, false);
});

test('TikTok audience keeps native less-than thresholds and separates viewers from followers', async () => {
  const script = await readFile(new URL('../sponsor.js', import.meta.url), 'utf8');
  const renderer = script.slice(script.indexOf('function studioAudienceContent('), script.indexOf('function studioTrafficContent('));
  vm.runInContext("let audiencePopulation = 'viewers';", context);
  vm.runInContext(renderer, context);
  context.countryName = value => value;
  const entry = (population, percentage) => ({ population, capturedAt: '2026-10-20T12:00:00Z',
    dateRange: { start: '2025-10-20', end: '2026-10-19' }, country: [{ label: 'GB', percentage, lessThan: null },
      { label: 'FR', percentage: null, lessThan: 1 }], age: [], gender: [] });
  const rendered = context.studioAudienceContent({ audience: [entry('viewers', 76), entry('followers', 95)] });
  assert.match(rendered, /76%/);
  assert.doesNotMatch(rendered, />95%/);
  assert.match(rendered, /&lt;1%/);
  assert.doesNotMatch(rendered, /&lt;—%|NaN/);
  assert.match(rendered, /value="viewers" selected/);
  assert.match(rendered, /People who watched/);
});

test('TikTok censored percentages use the numeric native threshold as an upper bound', () => {
  assert.deepEqual(plain(context.studioPercentage({ percentage: null, lessThan: 1 })), { label: '<1%', width: 1, threshold: true });
  assert.deepEqual(plain(context.studioPercentage({ percentage: 0, lessThan: null })), { label: '0%', width: 0, threshold: false });
  assert.deepEqual(plain(context.studioPercentage({ percentage: 36.2, lessThan: null })), { label: '36.2%', width: 36.2, threshold: false });
});
