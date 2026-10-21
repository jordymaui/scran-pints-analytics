import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildAllSocialAnalytics } from '../lib/sponsor-aggregate.mjs';
import { instagramNativeFixture } from './fixtures/instagram-native.mjs';

const capture = instagramNativeFixture();
const displayNumber = value => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value);
const captureDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(capture.capturedAt));
const script = await readFile(new URL('../sponsor.js', import.meta.url), 'utf8');
const code = script.slice(0, script.indexOf('try { report = await loadReport(); render(); }')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '');
const report = { schemaVersion: 1, sources: [{ id: 'instagram', label: 'Instagram', status: 'snapshot',
  capturedAt: capture.capturedAt, metrics: { followers: capture.followers, views: null }, daily: [], content: [], manualCapture: capture,
  provenance: { kind: 'manual-browser', label: 'Captured Instagram Insights' },
  dateRange: { start: null, end: null, timezone: null } }] };

function ui(fixture = report) {
  const workspace = { innerHTML: '' }, select = { addEventListener() {} };
  const context = vm.createContext({ Intl, Date, buildAllSocialAnalytics,
    document: { documentElement: {}, querySelector: selector => selector === '#workspace' ? workspace
      : selector === '#yeet-instagram-period' ? select : null, querySelectorAll: () => [] },
    window: { innerWidth: 1280, SPSelect: { refresh() {} } },
    getComputedStyle: () => ({ getPropertyValue: () => '200' }),
  });
  vm.runInContext(code, context); context.fixture = fixture;
  vm.runInContext("report = fixture; selectedSource = 'instagram';", context);
  return { context, workspace };
}

test('Instagram 7/30/90 captured Insights retain native totals and unknown reporting boundaries', () => {
  const { context, workspace } = ui();
  for (const period of capture.windows) {
    context.days = period.periodDays; vm.runInContext('instagramDays=days;render();', context);
    assert.ok(workspace.innerHTML.includes(`title="${displayNumber(period.views)}"`));
    assert.match(workspace.innerHTML, /exact reporting dates and timezone were not shown/);
    assert.match(workspace.innerHTML, /No daily values or growth percentages have been inferred/);
    assert.doesNotMatch(workspace.innerHTML, /All-time performance|Lifetime views|id="yeet-history-chart"/);
  }
  vm.runInContext('instagramDays=7;render();', context);
  const seven = capture.windows.find(period => period.periodDays === 7);
  assert.ok(workspace.innerHTML.includes(`${displayNumber(seven.instagramViews)} Instagram views`));
  assert.ok(workspace.innerHTML.includes(`${displayNumber(seven.facebookViews)} Facebook views`));
});

test('Instagram native distributions, profile activity and sampled Reel counters appear without inferred demographics', () => {
  const { context, workspace } = ui();
  vm.runInContext('instagramDays=30;render();', context);
  const thirty = capture.windows.find(period => period.periodDays === 30);
  assert.ok(workspace.innerHTML.includes(`${displayNumber(thirty.viewAudience[0].percentage)}%`));
  assert.ok(workspace.innerHTML.includes(`${displayNumber(thirty.viewContentTypes[0].percentage)}%`));
  assert.ok(workspace.innerHTML.includes(`title="${displayNumber(thirty.profileVisits)}"`));
  assert.ok(workspace.innerHTML.includes(`title="${displayNumber(thirty.externalLinkTaps)}"`));
  assert.match(workspace.innerHTML, /Captured Reel/);
  assert.ok(workspace.innerHTML.includes(`<span>Saves</span><strong>${displayNumber(capture.content[0].saves)}</strong>`));
  assert.ok(workspace.innerHTML.includes(`<span>Shares</span><strong>${displayNumber(capture.content[0].shares)}</strong>`));
  assert.match(workspace.innerHTML, /Age, gender and country were not supplied/);
  assert.ok(workspace.innerHTML.includes(capture.followerActivity.weekday));
  assert.match(workspace.innerHTML, /timezone not shown/);
});

test('ALL includes Instagram captured history prominently without inventing a daily line or lifetime total', () => {
  const { context, workspace } = ui();
  vm.runInContext("selectedSource='all';allPeriod='7d';render();", context);
  assert.match(workspace.innerHTML, /Reported history/);
  const widest = [...capture.windows].sort((a, b) => b.periodDays - a.periodDays)[0];
  assert.ok(workspace.innerHTML.includes(`title="${displayNumber(widest.instagramViews)}"`));
  assert.match(workspace.innerHTML, /data-primary-platform="instagram"/);
  assert.doesNotMatch(workspace.innerHTML, /yeet-instagram-compact|View all Instagram Insights →/);
  const model = buildAllSocialAnalytics(report, '7d');
  assert.equal(model.headlines.views, null);
  assert.equal(model.headlines.uploads, null);
  assert.equal(model.reportedHistory.views, widest.instagramViews);
  assert.deepEqual(model.performance.daily, []);
  assert.equal(model.headlines.followers, capture.followers);
});

test('selected ALL-social reports include Instagram once while daily activity remains separately scoped', () => {
  const range = { start: '2026-01-01', end: '2026-01-14', timezone: null };
  const sequence = views => Array.from({ length: 14 }, (_, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    views, likes: 1, comments: 1, shares: 0,
  }));
  const mixed = structuredClone(report);
  mixed.sources.push({ id: 'youtube-longform', label: 'YouTube', status: 'snapshot',
    capturedAt: capture.capturedAt, metrics: { views: 300, followers: 10, videoCount: 2 }, content: [],
    performance: { dateRange: range, daily: sequence(10) } },
  { id: 'tiktok', label: 'TikTok', status: 'snapshot', capturedAt: capture.capturedAt,
    metrics: { views: 200, followers: 5, videoCount: 1 }, content: [],
    studioSupplement: { performance: { dateRange: range, seriesRanges: { overview: range }, daily: sequence(5) } } });
  const { context, workspace } = ui(mixed);
  for (const period of ['7d', '30d', 'all']) {
    context.period = period;
    vm.runInContext("selectedSource='all';allPeriod=period;render();", context);
    const model = buildAllSocialAnalytics(mixed, period);
    const html = workspace.innerHTML;
    assert.ok(html.includes(`<div data-selected-views><span>Reported views</span><strong title="${displayNumber(model.summary.views)}"`));
    assert.ok(html.includes(`<div data-selected-actions><span>Recorded actions</span><strong title="${displayNumber(model.summary.engagement)}"`));
    const selected = html.split('class="yeet-selected-summary"')[1].split('class="yeet-all-daily-report"')[0];
    assert.match(selected, /YouTube \+ Instagram \+ TikTok/);
    assert.doesNotMatch(selected, /vs previous period|yeet-change/);
    assert.match(selected, /class="yeet-primary-platform-chart"/);
    assert.match(html, /<details class="yeet-all-daily-details"><summary>/);
    assert.match(html, /Daily trend · YouTube \+ TikTok/);
    for (const platform of model.summary.platforms) {
      const row = selected.split(`data-primary-platform="${platform.id}"`)[1];
      assert.ok(row, `${platform.label} appears in the primary chart for ${period}`);
      assert.ok(row.split('class="yeet-primary-platform-row"')[0].includes(`title="${displayNumber(platform.views)}"`));
    }
    assert.ok(html.indexOf('data-primary-platform="instagram"') < html.indexOf('<details class="yeet-all-daily-details"'));
    assert.match(html, /Instagram interactions/);
    assert.match(html, /including saves and other actions/);
    assert.match(html, /Daily activity · YouTube \+ TikTok/);
    assert.match(html, /daily-report views/);
    const daily = html.split('class="yeet-all-daily-report"')[1].split('</section>')[0];
    assert.doesNotMatch(daily, /assets\/platforms\/instagram/);
    assert.doesNotMatch(html, /yeet-instagram-compact|View all Instagram Insights →/);
    const instagram = model.summary.platforms.find(platform => platform.id === 'instagram');
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    assert.equal(instagram.views, capture.windows.find(window => window.periodDays === days).instagramViews);
    assert.ok(html.includes(`title="${displayNumber(model.summary.views)}"`));
  }
  vm.runInContext("allPeriod='7d';allMetric='engagement';render();", context);
  const actions = workspace.innerHTML.split('class="yeet-primary-platform-chart"')[1].split('<details')[0];
  const model = buildAllSocialAnalytics(mixed, '7d');
  for (const platform of model.summary.platforms) {
    assert.ok(actions.split(`data-primary-platform="${platform.id}"`)[1].includes(`title="${displayNumber(platform.engagement)}"`));
  }
  assert.match(actions, /Recorded actions by platform/);
});

test('a retained manual capture does not add a duplicate Instagram card to the combined view', () => {
  const mixed = structuredClone(report);
  mixed.sources[0].performance = { dateRange: { start: '2026-01-01', end: '2026-01-14', timezone: null },
    daily: Array.from({ length: 14 }, (_, index) => ({ date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      views: 10, likes: 1, comments: 0, shares: 0 })) };
  const { context, workspace } = ui(mixed);
  vm.runInContext("selectedSource='all';allPeriod='7d';render();", context);
  assert.doesNotMatch(workspace.innerHTML, /yeet-instagram-compact|Instagram views · separate capture|Instagram views · included above/);
  assert.equal(buildAllSocialAnalytics(mixed, '7d').summary.views, 70);
});
