import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildAllSocialAnalytics } from '../lib/sponsor-aggregate.mjs';

const script = await readFile(new URL('../sponsor.js', import.meta.url), 'utf8');
const code = script.slice(0, script.indexOf('try { report = await loadReport(); render(); }')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '');
const sequence = (views, likes) => Array.from({ length: 14 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 9, 4 + index)).toISOString().slice(0, 10), views,
  likes, comments: 1, shares: 1,
}));
const range = { start: '2026-10-04', end: '2026-10-17' };
const fixture = { schemaVersion: 1, sources: [
  { id: 'youtube-longform', status: 'snapshot', capturedAt: '2026-10-20T12:00:00Z',
    metrics: { views: 1000, followers: 100, videoCount: 8 }, content: [{ likes: 3, comments: 1, shares: null }],
    performance: { dateRange: range, daily: sequence(10, 2) } },
  { id: 'youtube-shorts', status: 'snapshot', metrics: { views: 800 } },
  { id: 'instagram', status: 'not-connected', metrics: null, content: [] },
  { id: 'tiktok', status: 'snapshot', capturedAt: '2026-10-20T12:00:00Z',
    metrics: { views: 500, followers: 10, likes: 4, comments: 1, shares: 2 }, content: [{}, {}],
    studioSupplement: { performance: { dateRange: range, seriesRanges: { overview: range }, daily: sequence(5, 1) }, audience: [] } },
] };

function ui() {
  const workspace = { innerHTML: '' };
  const context = vm.createContext({ Intl, Date, buildAllSocialAnalytics,
    document: { documentElement: {}, querySelector: selector => selector === '#workspace' ? workspace : null,
      querySelectorAll: () => [] }, window: { innerWidth: 1280 },
    getComputedStyle: () => ({ getPropertyValue: () => '200' }),
  });
  vm.runInContext(code, context);
  context.fixture = fixture;
  vm.runInContext('report = fixture;', context);
  return { context, workspace };
}

test('YEET opens with a compiled all-social view and retains individual platform tabs', () => {
  const { context, workspace } = ui();
  vm.runInContext('render();', context);
  assert.match(workspace.innerHTML, /data-yeet-source="all" aria-pressed="true"/);
  assert.match(workspace.innerHTML, /data-yeet-source="youtube-longform"/);
  assert.match(workspace.innerHTML, /data-yeet-source="tiktok"/);
  assert.match(workspace.innerHTML, /Reported history/);
  assert.match(workspace.innerHTML, /title="210"/);
  assert.match(workspace.innerHTML, /Account followers/);
  assert.match(workspace.innerHTML, /Instagram awaiting data/);
  assert.match(workspace.innerHTML, /data-all-period="30d"/);
  assert.match(workspace.innerHTML, /data-all-metric="engagement"/);
  assert.match(workspace.innerHTML, /Views by platform/);
  assert.match(workspace.innerHTML, /How people engaged/);
});

test('ALL TIME sums only reported native activity while missing platform points remain gaps', () => {
  const { context } = ui();
  const platforms = [{ id: 'youtube-longform' }, { id: 'tiktok' }];
  const performance = { daily: [
    { date: '2026-10-01', views: null, reportedViews: 5, byPlatform: { tiktok: { views: 5 } } },
    { date: '2026-10-02', views: 5, reportedViews: 5, byPlatform: { tiktok: { views: 2 }, 'youtube-longform': { views: 3 } } },
  ] };
  const cumulative = JSON.parse(JSON.stringify(context.allSocialChartRows(performance, platforms, 'views', true)));
  assert.deepEqual(cumulative, [
    { date: '2026-10-01', total: 5, values: { 'youtube-longform': null, tiktok: 5 } },
    { date: '2026-10-02', total: 10, values: { 'youtube-longform': 3, tiktok: 7 } },
  ]);
  const daily = context.allSocialChartRows(performance, platforms, 'views', false);
  assert.equal(daily[0].total, null);
  assert.equal(daily[1].total, 5);
});

test('ALL TIME renders cumulative reported lines without changing the lifetime headline scope', () => {
  const { context, workspace } = ui();
  vm.runInContext("allPeriod = 'all'; allMetric = 'engagement'; render();", context);
  assert.match(workspace.innerHTML, /Cumulative reported engagement over available history/);
  assert.match(workspace.innerHTML, /stroke-dasharray="6 4"/);
  assert.match(workspace.innerHTML, /title="210"/);
  assert.match(workspace.innerHTML, /data-all-period="all" aria-pressed="true"/);
});
