import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildAllSocialAnalytics } from '../lib/sponsor-aggregate.mjs';
import { instagramNativeFixture, instagramCollaborationFixture } from './fixtures/instagram-native.mjs';

const script = await readFile(new URL('../sponsor.js', import.meta.url), 'utf8');
const code = script.slice(0, script.indexOf('try { report = await loadReport(); render(); }'))
  .replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '');
const formatDate = value => new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(new Date(value));

function ui(collaborations = instagramCollaborationFixture()) {
  const native = instagramNativeFixture();
  const fixture = { schemaVersion: 1, sources: [{ id: 'instagram', status: 'snapshot',
    capturedAt: native.capturedAt, metrics: { followers: native.followers, views: null }, daily: [], content: [],
    manualCapture: { ...native, ...(collaborations ? { collaborations } : {}) },
    provenance: { kind: 'manual-browser' }, dateRange: { start: null, end: null, timezone: null } }] };
  const workspace = { innerHTML: '' };
  const context = vm.createContext({ Intl, Date, buildAllSocialAnalytics,
    document: { documentElement: {}, querySelector: selector => selector === '#workspace' ? workspace : null,
      querySelectorAll: () => [] }, window: { innerWidth: 390 },
    getComputedStyle: () => ({ getPropertyValue: () => '0' }),
  });
  vm.runInContext(code, context); context.fixture = fixture;
  vm.runInContext("report=fixture;selectedSource='footyscran';render();", context);
  return { context, workspace, fixture };
}

test('FootyScran withholds the observed-post total when a captured post lacks views', () => {
  const capture = instagramCollaborationFixture();
  const { context, workspace } = ui(capture);
  const summary = context.collaborationSummary(capture);
  assert.equal(summary.totalViews, null);
  assert.equal(summary.complete, false);
  assert.equal(summary.countedPosts, 1);
  assert.equal(summary.missingPosts, 1);
  assert.match(workspace.innerHTML, /<strong>Incomplete<\/strong>/);
  assert.match(workspace.innerHTML, /1 of 2 observed posts have captured view counts/);
  assert.match(workspace.innerHTML, /Not captured/);
  assert.match(workspace.innerHTML, /≈1\.2K/i);
  assert.match(workspace.innerHTML, /Rounded profile views/);
  assert.ok(workspace.innerHTML.includes(capture.posts[0].url));
  assert.ok(workspace.innerHTML.includes(`List captured ${formatDate(capture.capturedAt)}`));
  for (const post of capture.posts) assert.ok(workspace.innerHTML.includes(`Captured ${formatDate(post.capturedAt)}`));
  assert.match(workspace.innerHTML, /Overlap with account reporting may exist/);
  assert.match(workspace.innerHTML, /stay separate from All socials/);
  assert.doesNotMatch(workspace.innerHTML, /NaN|undefined|incremental views|additional audience/i);
});

test('a complete post set totals exact and rounded values while retaining approximate precision', () => {
  const capture = instagramCollaborationFixture();
  capture.posts[1].views = capture.posts[0].views / 2;
  capture.posts[1].viewsPrecision = 'exact';
  const { context, workspace } = ui(capture);
  const result = context.collaborationSummary(capture);
  assert.equal(result.totalViews, capture.posts.reduce((sum, post) => sum + post.views, 0));
  assert.equal(result.complete, true);
  assert.equal(result.approximate, true);
  assert.equal(result.exactPosts, 1);
  assert.match(workspace.innerHTML, /Approximate total · includes rounded counts/);
  assert.match(workspace.innerHTML, /Exact captured views/);
  assert.doesNotMatch(workspace.innerHTML, /<dt>Shares<\/dt>/);
  capture.posts.forEach(post => { post.views = 0; post.viewsPrecision = 'exact'; });
  assert.equal(context.collaborationSummary(capture).totalViews, 0);
  assert.equal(context.collaborationSummary(capture).approximate, false);
});

test('campaign posts retain their relationship instead of being labelled collaborations', () => {
  const capture = instagramCollaborationFixture();
  capture.posts[1].relationship = 'campaign-post';
  const { workspace } = ui(capture);
  assert.match(workspace.innerHTML, />Collab post<\/span>/);
  assert.match(workspace.innerHTML, />FootyScran post<\/span>/);
  assert.match(workspace.innerHTML, /Public Reel counters · all time/);
  assert.match(workspace.innerHTML, /Instagram\/Facebook split was not supplied/);
  assert.match(workspace.innerHTML, /Observed posts/);
  assert.ok(workspace.innerHTML.includes('/assets/platforms/footyscran.jpg'));
  assert.doesNotMatch(workspace.innerHTML, /Verified collaboration posts|Shared Instagram posts|Shared-post views/);
});

test('collab and FootyScran-only subtotals remain separate and withhold missing group totals', () => {
  const capture = instagramCollaborationFixture();
  capture.posts[0].relationship = 'collaboration';
  capture.posts[1].relationship = 'campaign-post';
  const { context, workspace } = ui(capture);
  const partial = context.collaborationSummary(capture);
  assert.equal(partial.groups.collaboration.totalViews, capture.posts[0].views);
  assert.equal(partial.groups.collaboration.approximate, true);
  assert.equal(partial.groups['campaign-post'].totalViews, null);
  assert.match(workspace.innerHTML, /Views by post type/);
  assert.match(workspace.innerHTML, /Collab posts<small>1 post/);
  assert.match(workspace.innerHTML, /FootyScran-only posts<small>1 post/);
  capture.posts[1].views = capture.posts[0].views / 2;
  capture.posts[1].viewsPrecision = 'exact';
  const complete = context.collaborationSummary(capture);
  assert.equal(complete.groups['campaign-post'].totalViews, capture.posts[1].views);
  assert.equal(complete.groups['campaign-post'].approximate, false);
  assert.equal(complete.totalViews, complete.groups.collaboration.totalViews + complete.groups['campaign-post'].totalViews);
});

test('FootyScran is a separate tab and never contributes to ALL platform reporting', () => {
  const { context, workspace, fixture } = ui();
  assert.match(workspace.innerHTML, /data-yeet-source="footyscran" aria-pressed="true"/);
  assert.deepEqual(Array.from(context.sponsorSources(fixture), item => item.id), ['youtube-longform', 'instagram', 'tiktok']);
  const withCollabs = buildAllSocialAnalytics(fixture, 'all');
  const without = structuredClone(fixture);
  delete without.sources[0].manualCapture.collaborations;
  assert.deepEqual(withCollabs, buildAllSocialAnalytics(without, 'all'));
  vm.runInContext("selectedSource='all';render();", context);
  for (const platform of ['youtube', 'instagram', 'tiktok']) {
    assert.ok(workspace.innerHTML.includes(`/assets/platforms/${platform}.svg`));
  }
  assert.doesNotMatch(workspace.innerHTML, />IG<|>TK</);
});

test('reported platform history shows FootyScran as a single percentage bar using both totals', () => {
  const capture = instagramCollaborationFixture();
  capture.posts[1].views = capture.posts[0].views / 2;
  capture.posts[1].viewsPrecision = 'exact';
  const { context, workspace, fixture } = ui(capture);
  const before = buildAllSocialAnalytics(fixture, '7d').summary;
  vm.runInContext("selectedSource='all';allPeriod='7d';render();", context);
  const footy = context.footyHistoryRow(buildAllSocialAnalytics(fixture, 'all').reportedHistory);
  assert.match(footy, /assets\/platforms\/footyscran.jpg/);
  assert.match(footy, /<strong>≈20%<\/strong>/);
  assert.match(footy, /width:20%;background:/);
  assert.match(footy, /1\.8k FootyScran views ÷ 9k Instagram views/i);
  assert.match(footy, /Reporting windows differ/);
  assert.match(footy, /data-yeet-source="footyscran"/);
  assert.doesNotMatch(workspace.innerHTML, /yeet-footy-measured|Percentage not yet verified|Tracked post views|type="range"/);
  assert.ok(workspace.innerHTML.indexOf('yeet-footy-history-row') > workspace.innerHTML.indexOf('yeet-reported-history-bars'));
  assert.ok(workspace.innerHTML.indexOf('yeet-footy-history-row') < workspace.innerHTML.indexOf('yeet-all-performance'));
  assert.deepEqual(buildAllSocialAnalytics(fixture, '7d').summary, before);
});

test('FootyScran ratios above 100 retain the real percentage and mark bar overflow', () => {
  const capture = instagramCollaborationFixture();
  capture.posts.forEach(post => { post.views = 7500; post.viewsPrecision = 'exact'; });
  const { context } = ui(capture);
  const footy = context.footyHistoryRow({ platforms: [{ id: 'instagram', views: 10000 }] });
  assert.match(footy, /<strong>150%<\/strong>/);
  assert.match(footy, /yeet-footy-overflow/);
  assert.match(footy, /width:100%;/);
  assert.match(footy, /5k above the Instagram total/i);
  assert.doesNotMatch(footy, /Rest|width:150|additional views/);
});

test('missing or zero denominators and partial FootyScran totals do not create fake percentages', () => {
  const capture = instagramCollaborationFixture();
  const { context } = ui(capture);
  const history = views => ({ platforms: [{ id: 'instagram', views }] });
  for (const views of [9000, 0, null]) {
    assert.match(context.footyHistoryRow(history(views)), /<strong>Unavailable<\/strong>/);
  }
  capture.posts.forEach(post => { post.views = 0; post.viewsPrecision = 'exact'; });
  assert.match(context.footyHistoryRow(history(9000)), /<strong>0%<\/strong>/);
  assert.match(context.footyHistoryRow(history(0)), /<strong>Unavailable<\/strong>/);
  assert.match(context.footyHistoryRow({ platforms: [] }), /<strong>Unavailable<\/strong>/);
});

test('FootyScran gracefully handles an absent capture without reporting fake zero views', () => {
  const { context, workspace } = ui(null);
  assert.equal(context.collaborationSummary(null).totalViews, null);
  assert.match(workspace.innerHTML, /FootyScran reporting is being captured/);
  assert.doesNotMatch(workspace.innerHTML, /<strong>0<\/strong>|NaN|undefined/);
});
