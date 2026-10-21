import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildAllSocialAnalytics } from '../lib/sponsor-aggregate.mjs';
import { instagramNativeFixture, instagramCollaborationFixture, instagramPostInsightsFixture } from './fixtures/instagram-native.mjs';

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

test('FootyScran summary and tab exclude campaign posts and unverified relationships', () => {
  const capture = instagramCollaborationFixture();
  capture.posts[1].views = 900000;
  capture.posts[1].viewsPrecision = 'exact';
  capture.posts.push({ ...capture.posts[0], shortcode: 'Unknown', relationship: undefined, views: 800000 });
  const { context, workspace } = ui(capture);
  const summary = context.footyCollaborationSummary(capture);
  assert.equal(summary.totalViews, 1200);
  assert.equal(summary.observedPosts, 1);
  assert.match(workspace.innerHTML, /FootyScran collabs/);
  assert.match(workspace.innerHTML, /Collab views/);
  assert.ok(workspace.innerHTML.includes(capture.posts[0].url));
  assert.ok(!workspace.innerHTML.includes(capture.posts[1].url));
  assert.doesNotMatch(workspace.innerHTML, /900k|800k|FootyScran-only posts|Views by post type/i);
});

test('missing campaign counts do not make collab counts incomplete', () => {
  const capture = instagramCollaborationFixture();
  const { context } = ui(capture);
  assert.equal(context.footyCollaborationSummary(capture).complete, true);
  assert.equal(context.footyCollaborationSummary(capture).totalViews, 1200);
  capture.posts[1].relationship = 'collaboration';
  const summary = context.footyCollaborationSummary(capture);
  assert.equal(summary.complete, false);
  assert.equal(summary.totalViews, null);
  assert.equal(summary.missingPosts, 1);
});

test('native collab Insights supply exact views and actions without discarding original public counters', () => {
  const capture = instagramCollaborationFixture();
  capture.posts[0].insights = instagramPostInsightsFixture();
  const { context, workspace } = ui(capture);
  const summary = context.footyCollaborationSummary(capture);
  assert.equal(summary.totalViews, 1250);
  assert.equal(summary.approximate, false);
  assert.equal(summary.nativePosts, 1);
  assert.equal(summary.metrics.likes.value, 20);
  assert.equal(summary.metrics.comments.value, 3);
  assert.equal(summary.metrics.saves.value, 4);
  assert.equal(summary.metrics.shares.value, 0);
  assert.equal(capture.posts[0].views, 1200);
  assert.match(workspace.innerHTML, /title="1,250 views"/);
  assert.match(workspace.innerHTML, /native Insights/i);
  assert.match(workspace.innerHTML, /Saves/);
  assert.ok(workspace.innerHTML.includes('Captured '+formatDate(capture.posts[0].insights.capturedAt)));
  assert.doesNotMatch(workspace.innerHTML, /Rounded profile views/);
});

test('missing native action values remain unavailable and explicit zero shares survive', () => {
  const capture = instagramCollaborationFixture();
  capture.posts[0].insights = { ...instagramPostInsightsFixture(), saves: null };
  const { context } = ui(capture);
  const summary = context.footyCollaborationSummary(capture);
  assert.equal(summary.metrics.saves.value, null);
  assert.equal(summary.metrics.shares.value, 0);
  assert.equal(context.collaborationPostMetrics(capture.posts[0]).saves, null);
});

test('the requested 50/50 split uses collabs only and sits inside the Instagram platform row', () => {
  const capture = instagramCollaborationFixture();
  capture.posts[0].views = 4500;
  capture.posts[0].viewsPrecision = 'exact';
  capture.posts[1].views = 900000;
  capture.posts[1].viewsPrecision = 'exact';
  const { context, workspace, fixture } = ui(capture);
  const before = buildAllSocialAnalytics(fixture, '7d').summary;
  vm.runInContext("selectedSource='all';allPeriod='7d';render();", context);
  const split = context.footyInstagramSplit(9000);
  assert.match(split, /FootyScran collabs/);
  assert.match(split, /Other Instagram views/);
  assert.equal((split.match(/<strong>50%<\/strong>/g) || []).length, 2);
  assert.equal((split.match(/width:50%;background:/g) || []).length, 2);
  assert.match(split, /4\.5k views/i);
  assert.ok(workspace.innerHTML.includes('/assets/platforms/footyscran.jpg'));
  assert.match(workspace.innerHTML, /yeet-instagram-split-track/);
  assert.doesNotMatch(workspace.innerHTML, /yeet-footy-history-row|yeet-footy-measured|yeet-instagram-compact|Percentage not yet verified|type="range"/);
  assert.deepEqual(buildAllSocialAnalytics(fixture, '7d').summary, before);
});

test('native collab counts drive the split while rounded fallback retains approximate labels', () => {
  const capture = instagramCollaborationFixture();
  const { context } = ui(capture);
  assert.match(context.footyInstagramSplit(9000), /<strong>≈13\.3%<\/strong>/);
  capture.posts[0].insights = { ...instagramPostInsightsFixture(), views: 1800 };
  const split = context.footyInstagramSplit(9000);
  assert.match(split, /<strong>20%<\/strong>/);
  assert.match(split, /<strong>80%<\/strong>/);
  assert.doesNotMatch(split, /≈/);
});

test('a collab total above the report does not invent a positive remainder or a filled share', () => {
  const capture = instagramCollaborationFixture();
  capture.posts[0].views = 15000;
  capture.posts[0].viewsPrecision = 'exact';
  const { context } = ui(capture);
  const split = context.footyInstagramSplit(10000);
  assert.match(split, /150%/);
  assert.match(split, /Remainder unavailable/);
  assert.match(split, /is-unavailable/);
  assert.doesNotMatch(split, /width:150%;|Other Instagram views<\/span><strong>0%/);
});

test('partial, absent and zero totals do not become fake percentages', () => {
  const capture = instagramCollaborationFixture();
  capture.posts[0].views = null;
  capture.posts[0].viewsPrecision = 'unavailable';
  const { context } = ui(capture);
  assert.match(context.footyInstagramSplit(9000), /Unavailable/);
  capture.posts[0].views = 0;
  capture.posts[0].viewsPrecision = 'exact';
  assert.match(context.footyInstagramSplit(9000), /<strong>0%<\/strong>/);
  assert.match(context.footyInstagramSplit(9000), /<strong>100%<\/strong>/);
  assert.match(context.footyInstagramSplit(0), /Unavailable/);
  assert.match(context.footyInstagramSplit(null), /Unavailable/);
  assert.equal(ui(null).context.footyInstagramSplit(9000), '');
});

test('FootyScran remains a non-additive collab view and combined totals are unchanged', () => {
  const { context, workspace, fixture } = ui();
  assert.match(workspace.innerHTML, /data-yeet-source="footyscran" aria-pressed="true"/);
  assert.deepEqual(Array.from(context.sponsorSources(fixture), item => item.id), ['youtube-longform', 'instagram', 'tiktok']);
  const without = structuredClone(fixture);
  delete without.sources[0].manualCapture.collaborations;
  assert.deepEqual(buildAllSocialAnalytics(fixture, 'all'), buildAllSocialAnalytics(without, 'all'));
  vm.runInContext("selectedSource='all';render();", context);
  assert.doesNotMatch(workspace.innerHTML, /yeet-instagram-compact|View all Instagram Insights →/);
});

test('an empty collab inventory is not presented as zero delivered views', () => {
  const { context, workspace } = ui(null);
  assert.equal(context.footyCollaborationSummary(null).totalViews, null);
  assert.match(workspace.innerHTML, /FootyScran collabs are being captured/);
  assert.doesNotMatch(workspace.innerHTML, /<strong>0<\/strong>|NaN|undefined/);
});
