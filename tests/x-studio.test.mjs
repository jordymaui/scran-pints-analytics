import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeXExports, validateXAnalytics, xPerformance } from '../lib/x-studio.mjs';
import { validateSocialImport } from '../lib/social-schema.mjs';
import { buildAllSocialAnalytics } from '../lib/sponsor-aggregate.mjs';
import { loadPublicReport, readBundledInputs } from '../lib/cloud-report.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const overview = 'Date,Impressions,Likes,Engagements,Bookmarks,Shares,New follows,Unfollows,Replies,Reposts,Profile visits,Create Post,Video views,Media views\n"Sun, Nov 8, 2026",500,5,20,1,1,2,0,2,3,4,1,20,30\n"Sat, Nov 7, 2026",600,6,25,2,2,3,1,3,4,5,2,30,40\n';
const video = 'Video overview,,,,,\nDate,Views,Watch Time (ms),Completion Rate,Average Watch Time (ms),Estimated Revenue\n"Sun, Nov 8, 2026",20,3600000,0.1,1000,99999\n"Sat, Nov 7, 2026",30,7200000,0.2,2000,99999\nYour videos,,,,,,,,,\nUploaded on:,Video ID,Video title,Views,Duration,Video Link,Monetized,Estimated Revenue,Published date,Post Link\n"Nov 7, 2026",13_123456789,Untitled,999,0:36,https://studio.x.com/private-edit,No,99999,,\n';
export const xFixture = () => normalizeXExports({ overviewCsv: overview, videoCsv: video, followers: 96, capturedAt: '2026-11-08T21:00:00.000Z' });
test('X publishes exact native video views separately from post impressions and library counters', () => {
  const source = validateSocialImport({ schemaVersion: 1, sources: [xFixture()] }).sources[0];
  assert.equal(source.metrics.views, 50); assert.equal(source.xAnalytics.totals.impressions, 1100);
  assert.equal(source.xAnalytics.totals.engagements, 45); assert.equal(source.metrics.watchHours, 3);
  assert.equal(source.xAnalytics.videos[0].views, 999);
  assert.doesNotMatch(JSON.stringify(source), /99999|studio\.x\.com|private-edit|Estimated Revenue/);
  assert.equal(xPerformance(source.xAnalytics).daily[1].shares, 4);
});
test('X refuses duplicates, inconsistent totals, unknown fields and private-looking titles', () => {
  for (const mutate of [x => x.daily.push(x.daily[0]), x => x.totals.views++, x => x.credentials = 'PRIVATE', x => x.videos[0].title = 'access_token=PRIVATE']) {
    const x = xFixture().xAnalytics; mutate(x); assert.throws(() => validateXAnalytics(x));
  }
  assert.throws(() => normalizeXExports({ overviewCsv: overview + overview.split('\n')[1], videoCsv: video, followers: 96, capturedAt: '2026-11-08T21:00:00.000Z' }));
});
test('X adds native video plays and engagements once to ALL, without adding impressions or library totals', () => {
  const source = xFixture(); source.performance = xPerformance(source.xAnalytics);
  const result = buildAllSocialAnalytics({ sources: [source] }, 'all');
  assert.equal(result.reportedHistory.views, 50); assert.equal(result.reportedHistory.engagement, 45);
  assert.equal(result.headlines.followers, 96); assert.equal(result.headlines.views, null);
  assert.equal(result.headlines.uploads, null);
});
test('the production projection loads the private X snapshot and publishes only its validated reports', async () => {
  const source = xFixture(); const bundled = await readBundledInputs();
  const report = await loadPublicReport({ bundled, storeFactory: () => ({ loadSnapshot: async id => id === 'x' ? { payload: source } : null, getStatuses: async () => [], loadPublicYouTubeHistory: async () => [] }) });
  const x = report.sources.find(s => s.id === 'x');
  assert.equal(x.performance.totals.views, 50); assert.equal(x.snapshotOrigin, 'cloud');
  assert.equal(x.xAnalytics.totals.impressions, 1100); assert.equal(x.metrics.followers, 96);
});
test('X tab renders native history controls, separate impressions and its safe video library', async () => {
  const script = await readFile(new URL('../sponsor.js', import.meta.url), 'utf8');
  const code = script.slice(0, script.indexOf('try { report = await loadReport(); render(); }')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '');
  const workspace = { innerHTML: '' };
  const context = vm.createContext({ Intl, Date, buildAllSocialAnalytics,
    document: { documentElement: {}, querySelector: s => s === '#workspace' ? workspace : null, querySelectorAll: () => [] }, window: { innerWidth: 1280 }, getComputedStyle: () => ({ getPropertyValue: () => '200' }) });
  vm.runInContext(code, context); context.fixture = { sources: [xFixture()] };
  vm.runInContext("report=fixture; selectedSource='x'; render();", context);
  assert.match(workspace.innerHTML, /assets\/platforms\/x\.svg/);
  assert.match(workspace.innerHTML, /data-x-period="7d"/); assert.match(workspace.innerHTML, /data-x-period="30d"/);
  assert.match(workspace.innerHTML, /Post impressions/); assert.match(workspace.innerHTML, /Video library/);
  assert.match(workspace.innerHTML, /never added to video views/); assert.doesNotMatch(workspace.innerHTML, /studio\.x\.com|private-edit|99999/);
  vm.runInContext("xPeriod='30d'; xMetric='impressions'; render();", context);
  assert.match(workspace.innerHTML, /Post impressions over time/);
});
