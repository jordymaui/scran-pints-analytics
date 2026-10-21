import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInstagramStudioCapture, validateInstagramCollaborations,
  mergeInstagramStudioCaptures } from '../lib/instagram-studio.mjs';
import { instagramNativeFixture, instagramCollaborationFixture } from './fixtures/instagram-native.mjs';
import { loadPublicReport, readBundledInputs } from '../lib/cloud-report.mjs';

const fixture = () => ({ ...instagramNativeFixture(), collaborations: instagramCollaborationFixture() });

test('collaboration observations preserve independent dates, rounded views and unavailable metrics', () => {
  const original = fixture(), capture = validateInstagramStudioCapture(original);
  assert.deepEqual(capture, original);
  assert.ok(Date.parse(capture.collaborations.capturedAt) > Date.parse(capture.capturedAt));
  assert.equal(capture.collaborations.posts[0].viewsPrecision, 'rounded');
  assert.equal(capture.collaborations.posts[0].views, 1200);
  assert.equal(capture.collaborations.posts[0].publishedAt, '2026-01-10');
  assert.equal(capture.collaborations.posts[1].views, null);
  assert.equal(capture.collaborations.posts[1].publishedAt, null);
  assert.equal(capture.collaborations.posts[0].relationship, 'collaboration');
  assert.equal(capture.collaborations.posts[1].relationship, 'campaign-post');
  assert.equal(validateInstagramStudioCapture(instagramNativeFixture()).collaborations, undefined);
});

test('older verified collaboration records default relationship without relabeling campaign posts', () => {
  const value = instagramCollaborationFixture();
  delete value.posts[0].relationship;
  const result = validateInstagramCollaborations(value);
  assert.equal(result.posts[0].relationship, 'collaboration');
  assert.equal(result.posts[1].relationship, 'campaign-post');
  assert.equal(value.posts[0].relationship, undefined);
});

test('capture merge retains newer account windows and independently dated collaboration post observations', () => {
  const previous = fixture();
  previous.capturedAt = '2026-01-18T12:00:00Z';
  previous.followers = 48;
  const incoming = fixture();
  incoming.collaborations.capturedAt = '2026-01-19T10:00:00Z';
  incoming.collaborations.posts = [incoming.collaborations.posts[0]];
  incoming.collaborations.posts[0].capturedAt = '2026-01-19T09:00:00Z';
  incoming.collaborations.posts[0].views = 1500;
  const merged = mergeInstagramStudioCaptures(previous, incoming);
  assert.equal(merged.capturedAt, previous.capturedAt);
  assert.equal(merged.followers, 48);
  assert.equal(merged.collaborations.capturedAt, incoming.collaborations.capturedAt);
  assert.equal(merged.collaborations.posts.length, 2);
  assert.equal(merged.collaborations.posts[0].views, 1500);
  assert.deepEqual(merged.collaborations.posts[1], previous.collaborations.posts[1]);
  const laterAccountOnly = { ...instagramNativeFixture(), capturedAt: '2026-01-20T12:00:00Z' };
  const retained = mergeInstagramStudioCaptures(merged, laterAccountOnly);
  assert.equal(retained.capturedAt, laterAccountOnly.capturedAt);
  assert.deepEqual(retained.collaborations, merged.collaborations);
  assert.deepEqual(mergeInstagramStudioCaptures(retained, previous).collaborations, merged.collaborations);
});

test('strict collaboration allowlist rejects private fields, incorrect URLs, false precision and impossible dates', () => {
  const cases = [
    x => { x.accessToken = 'PRIVATE_SENTINEL'; },
    x => { x.accountUsername = 'another-account'; },
    x => { x.coverage = 'complete-inventory'; },
    x => { x.posts[0].raw = 'PRIVATE_SENTINEL'; },
    x => { x.posts[0].url = 'https://example.com/reel/Synthetic_A/'; },
    x => { x.posts[0].url = 'https://www.instagram.com/reel/Different/'; },
    x => { x.posts[0].url += '?access_token=PRIVATE_SENTINEL'; },
    x => { x.posts[0].url = 'https://user:password@www.instagram.com/reel/Synthetic_A/'; },
    x => { x.posts[0].shortcode = '../private'; },
    x => { x.posts[0].mediaId = 'private-account-id'; },
    x => { x.posts[0].title = 'accessToken=PRIVATE_SENTINEL'; },
    x => { x.posts[0].publishedAt = '2026-02-31'; },
    x => { x.posts[0].publishedAt = '2026-01-17'; },
    x => { x.posts[0].capturedAt = '2026-01-17T00:00:00Z'; },
    x => { x.posts[0].views = -1; },
    x => { x.posts[0].likes = 1.5; },
    x => { x.posts[0].viewsPrecision = 'unavailable'; },
    x => { x.posts[1].viewsPrecision = 'exact'; },
    x => { x.posts[0].metricScope = 'channel-total'; },
    x => { x.posts[0].relationship = 'unverified-mention'; },
    x => { x.posts[0].relationship = null; },
    x => { x.posts.push(structuredClone(x.posts[0])); },
    x => { x.posts[1].mediaId = x.posts[0].mediaId; },
  ];
  for (const mutate of cases) {
    const value = instagramCollaborationFixture(); mutate(value);
    assert.throws(() => validateInstagramCollaborations(value));
  }
});

test('cloud public projection exposes collaboration observations separately from account totals', async () => {
  const bundled = await readBundledInputs(), capture = fixture();
  const payload = { schemaVersion: 1, id: 'instagram', kind: 'instagram-native-capture',
    capturedAt: capture.capturedAt, manualCapture: capture };
  const options = { bundled, storeFactory: () => ({
    loadSnapshot: async id => id === 'instagram' ? { capturedAt: capture.capturedAt, payload } : null,
    getStatuses: async () => [],
  }) };
  const report = await loadPublicReport(options);
  const instagram = report.sources.find(source => source.id === 'instagram');
  assert.deepEqual(instagram.manualCapture.collaborations, capture.collaborations);
  assert.equal(instagram.capturedAt, capture.capturedAt);
  assert.equal(instagram.metrics.views, null);
  assert.equal(instagram.metrics.followers, capture.followers);
  assert.deepEqual(instagram.content, []);
  assert.equal(report.sources.some(source => source.id === 'footyscran'), false);
  payload.manualCapture.collaborations.posts[0].credentials = 'PRIVATE_SENTINEL';
  const rejected = await loadPublicReport(options);
  assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_SENTINEL/);
  assert.equal(rejected.sources.find(source => source.id === 'instagram').manualCapture, undefined);
});
