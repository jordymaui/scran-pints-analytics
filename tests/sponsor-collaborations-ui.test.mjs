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

test('FootyScran gracefully handles an absent capture without reporting fake zero views', () => {
  const { context, workspace } = ui(null);
  assert.equal(context.collaborationSummary(null).totalViews, null);
  assert.match(workspace.innerHTML, /FootyScran reporting is being captured/);
  assert.doesNotMatch(workspace.innerHTML, /<strong>0<\/strong>|NaN|undefined/);
});
