import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAllSocialAnalytics, combinedAudience } from '../lib/sponsor-aggregate.mjs';
import { applyInstagramStudioCapture } from '../lib/instagram-studio.mjs';
import { instagramNativeFixture, instagramCollaborationFixture } from './fixtures/instagram-native.mjs';

const instagramCapture = instagramNativeFixture();

const range = (start, end) => ({ start, end, timezone: null });
const rows = (days, views) => Array.from({ length: days }, (_, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`,
  views: typeof views === 'function' ? views(index + 1) : views,
  likes: 2, comments: 1, shares: 0,
}));
const report = () => ({ sources: [
  { id: 'youtube-longform', status: 'snapshot', metrics: { views: 1000, followers: 50, videoCount: 10 },
    content: [{ likes: 10, comments: 0, shares: null }],
    performance: { dateRange: range('2026-10-01', '2026-10-14'), daily: rows(14, day => day) } },
  { id: 'youtube-shorts', status: 'snapshot', metrics: { views: 999, followers: 50, videoCount: 8 } },
  { id: 'instagram', status: 'needs-connection' },
  { id: 'tiktok', status: 'snapshot', metrics: { views: 2000, followers: 20, videoCount: 15,
    likes: 30, comments: 5, shares: 2 },
    studioSupplement: { performance: {
      dateRange: range('2026-10-01', '2026-10-16'),
      seriesRanges: { overview: range('2026-10-01', '2026-10-15') },
      daily: [...rows(15, 10), { date: '2026-10-16', views: null, viewers: 500 }],
    } } },
] });

test('combined totals count YouTube once, retain public counters and mark unconnected platforms', () => {
  const input = report();
  const before = structuredClone(input);
  const result = buildAllSocialAnalytics(input);
  assert.deepEqual(result.headlines, { views: 3000, followers: 70, uploads: 25, engagement: 47 });
  assert.deepEqual(result.coverage.included, ['YouTube', 'TikTok']);
  assert.deepEqual(result.coverage.missing, ['Instagram']);
  assert.equal(result.platforms.find(row => row.id === 'instagram').views, null);
  assert.equal(result.platforms.find(row => row.id === 'instagram').periodComplete, false);
  assert.equal(result.platforms.length, 3);
  assert.deepEqual(input, before);
});

test('7D aligns to the latest shared native overview end and compares the same calendar windows', () => {
  const result = buildAllSocialAnalytics(report(), '7d');
  assert.deepEqual(result.performance.dateRange, { start: '2026-10-08', end: '2026-10-14' });
  assert.equal(result.performance.daily.length, 7);
  assert.equal(result.performance.totals.views, 147);
  assert.equal(result.performance.totals.engagement, 42);
  const comparison = result.performance.comparison.views;
  assert.equal(comparison.previous.value, 98);
  assert.equal(comparison.current.value, 147);
  assert.equal(comparison.percent, 50);
  assert.equal(comparison.complete, true);
  assert.deepEqual(result.engagement, { likes: 28, comments: 14, shares: 0, total: 42 });
});

test('a missing native day remains null, preserves reported contributions and suppresses growth', () => {
  const input = report();
  input.sources[0].performance.daily = input.sources[0].performance.daily.filter(row => row.date !== '2026-10-10');
  const result = buildAllSocialAnalytics(input, '7d');
  const gap = result.performance.daily.find(row => row.date === '2026-10-10');
  assert.equal(gap.views, null);
  assert.equal(gap.byPlatform['youtube-longform'].views, null);
  assert.equal(gap.byPlatform.tiktok.views, 10);
  assert.equal(gap.reportedViews, 10);
  assert.equal(gap.completeViews, false);
  assert.equal(result.performance.partialDays, 1);
  assert.equal(result.performance.totals.views, 137);
  assert.equal(result.performance.comparison.views.percent, null);
  assert.equal(result.performance.comparison.views.change, null);
  assert.equal(result.performance.comparison.views.current.days, 6);
});

test('30D uses its full calendar without claiming a comparison when prior history is incomplete', () => {
  const result = buildAllSocialAnalytics(report(), '30d');
  assert.equal(result.performance.daily.length, 30);
  assert.equal(result.performance.dateRange.start, '2026-09-15');
  assert.equal(result.performance.totals.views, 245);
  assert.equal(result.performance.comparison.views.complete, false);
  assert.equal(result.performance.comparison.views.percent, null);
});

test('ALL retains both source end dates and sums native activity separately from lifetime counters', () => {
  const result = buildAllSocialAnalytics(report(), 'all');
  assert.deepEqual(result.performance.dateRange, { start: '2026-10-01', end: '2026-10-15' });
  assert.equal(result.performance.daily.length, 15);
  assert.equal(result.performance.totals.views, 255);
  assert.equal(result.headlines.views, 3000);
  assert.equal(result.performance.daily.at(-1).views, null);
  assert.equal(result.performance.daily.at(-1).reportedViews, 10);
  assert.equal(result.performance.partialDays, 1);
  assert.deepEqual(result.performance.comparison, { views: null, engagement: null });
});

test('known zeroes and signed native engagements survive; a zero growth baseline has no percent', () => {
  const input = report();
  for (const source of [input.sources[0].performance, input.sources[3].studioSupplement.performance]) {
    source.daily = rows(14, day => day <= 7 ? 0 : 10).map(row => ({ ...row, likes: -1, comments: 0, shares: 0 }));
  }
  const result = buildAllSocialAnalytics(input, '7d');
  assert.equal(result.performance.comparison.views.previous.value, 0);
  assert.equal(result.performance.comparison.views.change, 140);
  assert.equal(result.performance.comparison.views.percent, null);
  assert.equal(result.performance.totals.engagement, -14);
  assert.equal(result.engagement.likes, -14);
});

test('counters without daily history remain in totals without inventing a chart series', () => {
  const input = report();
  input.sources[2] = { id: 'instagram', status: 'snapshot', metrics: { views: 500, followers: 12, videoCount: 3 } };
  const result = buildAllSocialAnalytics(input, '7d');
  assert.equal(result.headlines.views, 3500);
  assert.deepEqual(result.coverage.noDaily, ['Instagram']);
  assert.deepEqual(result.coverage.chartSources, ['YouTube', 'TikTok']);
  assert.equal(result.performance.totals.views, 147);
});

test('unknown engagement fields stay missing even when views are available', () => {
  const input = report();
  input.sources[0].performance.daily[13].shares = null;
  const result = buildAllSocialAnalytics(input, '7d');
  assert.equal(result.performance.daily.at(-1).views, 24);
  assert.equal(result.performance.daily.at(-1).engagement, null);
  assert.equal(result.performance.comparison.engagement.complete, false);
  assert.equal(result.engagement.shares, 0); // other returned days genuinely report zero shares
  assert.equal(result.engagement.total, 39);
  assert.equal(result.engagement.total, result.performance.totals.engagement);
  assert.equal(result.engagement.likes, 26);
});

const audienceSources = () => [
  { id: 'youtube-longform', audience: {
    demographics: { report: { dateRange: range('2026-10-01', '2026-10-14'), rows: [
      ...[['age13-17', 30], ['age18-24', 10], ['age25-34', 20], ['age35-44', 20],
        ['age45-54', 10], ['age55-64', 5], ['age65-', 5]].map(([ageGroup, viewerPercentage]) =>
        ({ ageGroup, gender: 'male', viewerPercentage })),
    ] } },
    country: { report: { dateRange: range('2026-10-01', '2026-10-14'), rows: [
      { country: 'GB', views: 60 }, { country: 'US', views: 40 },
    ] } },
  } },
  { id: 'tiktok', studioSupplement: { audience: [
    { population: 'followers', age: [{ label: '18–24', percentage: 99 }],
      country: [{ label: 'FR', percentage: 100 }], gender: [{ label: 'Male', percentage: 99 }] },
    { population: 'viewers', dateRange: range('2025-10-01', '2026-10-01'),
      age: [['18–24', 10], ['25–34', 30], ['35–44', 30], ['45–54', 20], ['55+', 10]]
        .map(([label, percentage]) => ({ label, percentage })),
      gender: [{ label: 'Male', percentage: 50 }, { label: 'Female', percentage: 40 }, { label: 'Other', percentage: 10 }],
      country: [{ label: 'United Kingdom', percentage: 90 }, { label: 'Spain', percentage: null, lessThan: 1 }],
    },
  ] } },
];

test('adult channel profile coarsens 55+, excludes under-18s, then normalises each platform equally', () => {
  const result = combinedAudience(audienceSources());
  assert.deepEqual(result.age.contributors, ['YouTube', 'TikTok']);
  assert.ok(Math.abs(result.age.rows[0].percentage - ((10 / 70 * 100 + 10) / 2)) < 1e-9);
  assert.ok(Math.abs(result.age.rows.at(-1).percentage - ((10 / 70 * 100 + 10) / 2)) < 1e-9);
  assert.ok(Math.abs(result.age.rows.reduce((sum, row) => sum + row.percentage, 0) - 100) < 1e-9);
  assert.equal(result.age.rows.some(row => row.label === '13–17'), false);
  assert.match(result.age.note, /Under-18s are excluded/);
});

test('missing adult groups exclude the incomplete profile instead of supplying zero', () => {
  const input = audienceSources();
  input[1].studioSupplement.audience[1].age.pop();
  const result = combinedAudience(input);
  assert.deepEqual(result.age.contributors, ['YouTube']);
  assert.ok(Math.abs(result.age.rows[0].percentage - 10 / 70 * 100) < 1e-9);
});

test('viewer profiles never mix follower populations and retain censored country observations', () => {
  const result = combinedAudience(audienceSources());
  const uk = result.country.rows.find(row => row.label === 'United Kingdom');
  assert.deepEqual(uk.values.map(row => row.percentage), [60, 90]);
  assert.equal(result.country.rows.some(row => row.label === 'France'), false);
  const spain = result.country.rows.find(row => row.label === 'Spain').values[0];
  assert.equal(spain.percentage, null);
  assert.equal(spain.lessThan, 1);
  assert.notEqual(uk.values[0].unit, uk.values[1].unit);
  assert.equal(result.country.method, 'platform-comparison');
});

test('gender channel means use viewer populations and preserve original rounding', () => {
  const input = audienceSources();
  input[0].audience.demographics.report.rows = [
    { gender: 'male', viewerPercentage: 80 }, { gender: 'female', viewerPercentage: 19.9 },
    { gender: 'genderUserSpecified', viewerPercentage: 0 },
  ];
  const result = combinedAudience(input);
  assert.deepEqual(result.gender.rows.map(row => row.percentage), [65, 29.95, 5]);
  assert.deepEqual(result.gender.contributors, ['YouTube', 'TikTok']);
});

test('empty reports preserve missing totals and unsupported periods are rejected', () => {
  const result = buildAllSocialAnalytics({ sources: [] }, 'all');
  assert.deepEqual(result.headlines, { views: null, followers: null, uploads: null, engagement: null });
  assert.deepEqual(result.performance.daily, []);
  assert.equal(result.audience.age.rows.every(row => row.percentage === null), true);
  assert.throws(() => buildAllSocialAnalytics(report(), '90d'), /Unsupported/);
});

test('Instagram joins recorded history once using its widest native window, without changing lifetime counters', () => {
  const input = applyInstagramStudioCapture(report(), instagramCapture);
  const result = buildAllSocialAnalytics(input, 'all');
  assert.equal(result.reportedHistory.views, 255 + instagramCapture.windows[2].instagramViews);
  assert.equal(result.reportedHistory.engagement, 87 + instagramCapture.windows[2].interactions);
  assert.equal(result.reportedHistory.platforms.length, 3);
  assert.equal(result.reportedHistory.platforms.find(row => row.id === 'instagram').hasDaily, false);
  assert.equal(result.reportedHistory.includesMixedWindows, true);
  assert.equal(result.headlines.views, 3000);
  assert.equal(result.headlines.followers, 70 + instagramCapture.followers);
  assert.equal(result.headlines.uploads, 25, 'An inspected Reel sample does not establish an account upload inventory');
  assert.equal(result.performance.totals.views, 255, 'Period captures never become fabricated daily activity');
  assert.deepEqual(result.coverage.missing, []);
  assert.deepEqual(result.coverage.noDaily, ['Instagram']);
  assert.deepEqual(result.coverage.counterSources, ['YouTube', 'TikTok']);
  assert.equal(result.manualPeriods[0].periodDays, 90);
});

test('Instagram relative windows remain outside aligned 7D/30D graphs and retain differing native totals', () => {
  const input = applyInstagramStudioCapture(report(), instagramCapture);
  const seven = buildAllSocialAnalytics(input, '7d');
  assert.equal(seven.performance.totals.views, 147);
  assert.equal(seven.performance.comparison.views.percent, 50);
  assert.equal(seven.performance.daily.some(row => 'instagram' in row.byPlatform), false);
  assert.equal(seven.manualPeriods[0].views, instagramCapture.windows[0].instagramViews);
  assert.equal(seven.manualPeriods[0].nativeTotalViews, instagramCapture.windows[0].views);
  assert.deepEqual(seven.manualPeriods[0].dateRange, { start: null, end: null, timezone: null });
  assert.equal(seven.reportedHistory.views, 255 + instagramCapture.windows[2].instagramViews);
  const thirty = buildAllSocialAnalytics(input, '30d');
  assert.equal(thirty.manualPeriods[0].views, instagramCapture.windows[1].instagramViews);
  assert.equal(thirty.manualPeriods[0].interactions, instagramCapture.windows[1].interactions);
  assert.equal(thirty.reportedHistory.views, seven.reportedHistory.views);
  assert.equal(thirty.audience.contributors.includes('Instagram'), false);
});

test('a future native Instagram daily report replaces its period capture in combined history instead of double counting', () => {
  const input = applyInstagramStudioCapture(report(), instagramCapture);
  const instagram = input.sources.find(row => row.id === 'instagram');
  instagram.performance = { dateRange: range('2026-10-01', '2026-10-14'), daily: rows(14, 2) };
  const result = buildAllSocialAnalytics(input, 'all');
  assert.equal(result.reportedHistory.views, 255 + 28);
  assert.equal(result.reportedHistory.platforms.find(row => row.id === 'instagram').hasDaily, true);
  assert.equal(result.reportedHistory.platforms.filter(row => row.id === 'instagram').length, 1);
});

test('selected summary includes the matching Instagram native window once while daily chart and growth stay unchanged', () => {
  const input = applyInstagramStudioCapture(report(), instagramCapture);
  for (const [period, index, dailyViews, dailyEngagement] of [['7d', 0, 147, 42], ['30d', 1, 245, 84]]) {
    const result = buildAllSocialAnalytics(input, period);
    const baseline = buildAllSocialAnalytics(report(), period);
    assert.equal(result.summary.views, dailyViews + instagramCapture.windows[index].instagramViews);
    assert.equal(result.summary.engagement, dailyEngagement + instagramCapture.windows[index].interactions);
    assert.deepEqual(result.performance, baseline.performance);
    assert.equal(result.summary.platforms.length, 3);
    const instagram = result.summary.platforms.find(row => row.id === 'instagram');
    assert.equal(instagram.views, instagramCapture.windows[index].instagramViews);
    assert.equal(instagram.engagement, instagramCapture.windows[index].interactions);
    assert.equal(instagram.capturedAt, instagramCapture.capturedAt);
    assert.deepEqual(instagram.dateRange, { start: null, end: null, timezone: null });
    assert.equal(instagram.hasDaily, false);
    assert.equal(result.summary.includesMixedWindows, true);
    assert.match(result.summary.coverageNote, /nominal .*day selection/);
    assert.match(result.summary.coverageNote, /Reporting cutoffs and timezones can differ/);
    assert.equal(result.summary.percent, undefined);
    for (const source of result.summary.platforms.filter(row => row.hasDaily)) {
      assert.equal(source.dateRange.start, result.performance.dateRange.start);
      assert.equal(source.dateRange.end, result.performance.dateRange.end);
    }
  }
});

test('ALL summary uses available history once and never adds FootyScran collaboration or campaign counters', () => {
  const capture = instagramNativeFixture();
  capture.collaborations = instagramCollaborationFixture();
  capture.collaborations.posts[0].views = 999999;
  const result = buildAllSocialAnalytics(applyInstagramStudioCapture(report(), capture), 'all');
  assert.deepEqual(result.summary, result.reportedHistory);
  assert.equal(result.summary.views, 255 + capture.windows[2].instagramViews);
  assert.equal(result.summary.engagement, 87 + capture.windows[2].interactions);
  for (const period of ['7d', '30d', 'all']) {
    const withPosts = buildAllSocialAnalytics(applyInstagramStudioCapture(report(), capture), period);
    const withoutPosts = buildAllSocialAnalytics(applyInstagramStudioCapture(report(), instagramNativeFixture()), period);
    assert.deepEqual(withPosts.summary, withoutPosts.summary);
  }
});

test('selected summary prefers Instagram API daily reports over a retained manual capture', () => {
  const input = applyInstagramStudioCapture(report(), instagramCapture);
  input.sources.find(row => row.id === 'instagram').performance = {
    capturedAt: '2026-10-15T12:00:00Z', dateRange: range('2026-10-01', '2026-10-14'), daily: rows(14, 2),
  };
  const result = buildAllSocialAnalytics(input, '7d');
  assert.equal(result.summary.views, 161);
  assert.equal(result.summary.engagement, 63);
  const instagram = result.summary.platforms.filter(row => row.id === 'instagram');
  assert.equal(instagram.length, 1);
  assert.equal(instagram[0].hasDaily, true);
  assert.equal(instagram[0].views, 14);
  assert.equal(instagram[0].capturedAt, '2026-10-15T12:00:00Z');
  assert.equal(result.summary.includesMixedWindows, false);
});

test('summary keeps unsupported metrics null and never substitutes a different manual window', () => {
  const capture = instagramNativeFixture();
  capture.windows[0].instagramViews = null;
  capture.windows[0].interactions = null;
  let input = applyInstagramStudioCapture(report(), capture);
  let result = buildAllSocialAnalytics(input, '7d');
  const instagram = result.summary.platforms.find(row => row.id === 'instagram');
  assert.equal(instagram.views, null);
  assert.equal(instagram.engagement, null);
  assert.equal(result.summary.views, 147);
  assert.equal(result.summary.engagement, 42);
  assert.match(result.summary.coverageNote, /reported contributions only/);
  capture.windows = capture.windows.filter(row => row.periodDays !== 7);
  result = buildAllSocialAnalytics(applyInstagramStudioCapture(report(), capture), '7d');
  assert.equal(result.summary.platforms.some(row => row.id === 'instagram'), false);
  input = applyInstagramStudioCapture({ sources: [{ id: 'instagram', status: 'not-connected' }] }, instagramNativeFixture());
  result = buildAllSocialAnalytics(input, '7d');
  assert.equal(result.summary.views, instagramNativeFixture().windows[0].instagramViews);
  assert.deepEqual(result.performance.daily, []);
  assert.equal(result.performance.comparison.views, null);
  const empty = buildAllSocialAnalytics({ sources: [] }, '7d');
  assert.equal(empty.summary.views, null);
  assert.equal(empty.summary.engagement, null);
});
