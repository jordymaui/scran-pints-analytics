import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInstagramStudioCapture, validateInstagramPostInsights,
  mergeInstagramStudioCaptures } from '../lib/instagram-studio.mjs';
import { instagramNativeFixture, instagramCollaborationFixture,
  instagramPostInsightsFixture } from './fixtures/instagram-native.mjs';
import { loadPublicReport, readBundledInputs } from '../lib/cloud-report.mjs';

function capture() {
  const value = { ...instagramNativeFixture(), collaborations: instagramCollaborationFixture() };
  value.collaborations.posts[0].insights = instagramPostInsightsFixture();
  return value;
}

test('native observations retain exact counts and independent dates without replacing public counters or account windows', () => {
  const value = capture(), actual = validateInstagramStudioCapture(value);
  assert.deepEqual(actual, value);
  assert.equal(actual.collaborations.posts[0].views, 1200);
  assert.equal(actual.collaborations.posts[0].viewsPrecision, 'rounded');
  assert.equal(actual.collaborations.posts[0].insights.views, 1250);
  assert.equal(actual.collaborations.posts[0].capturedAt, '2026-01-16T09:00:00Z');
  assert.equal(actual.collaborations.posts[0].insights.capturedAt, '2026-01-16T09:45:00Z');
  assert.equal(actual.capturedAt, instagramNativeFixture().capturedAt);
  assert.deepEqual(actual.windows, instagramNativeFixture().windows);
  assert.equal(actual.collaborations.posts[1].insights, undefined);
});

test('native count fields preserve null and zero and never infer Facebook splits or reporting dates', () => {
  const value = instagramPostInsightsFixture(); value.views = null; value.saves = null;
  const actual = validateInstagramPostInsights(value);
  assert.equal(actual.views, null);
  assert.equal(actual.saves, null);
  assert.equal(actual.shares, 0);
  assert.equal(actual.platformScope, 'unspecified');
  assert.equal(actual.reportingWindow, 'not-shown');
  assert.equal(actual.facebook, undefined);
  assert.equal(actual.daily, undefined);
});

test('native observations merge by their own timestamp across tied and later public-only captures', () => {
  const original = capture();
  const incoming = capture(); incoming.collaborations.posts[0].insights.views = 1260;
  incoming.collaborations.posts[0].insights.capturedAt = '2026-01-16T09:50:00Z';
  const tied = mergeInstagramStudioCaptures(original, incoming);
  assert.equal(tied.collaborations.posts[0].insights.views, 1260);
  const later = { ...instagramNativeFixture(), collaborations: instagramCollaborationFixture() };
  later.collaborations.capturedAt = '2026-01-17T12:00:00Z';
  later.collaborations.posts[0].capturedAt = '2026-01-17T10:00:00Z';
  later.collaborations.posts[0].views = 1400;
  later.collaborations.posts[0].mediaId = null;
  const merged = mergeInstagramStudioCaptures(tied, later);
  assert.equal(merged.collaborations.posts[0].views, 1400);
  assert.deepEqual(merged.collaborations.posts[0].insights, incoming.collaborations.posts[0].insights);
  assert.equal(merged.collaborations.posts[0].mediaId, original.collaborations.posts[0].mediaId);
  assert.equal(mergeInstagramStudioCaptures(merged, original).collaborations.posts[0].insights.views, 1260);
  const newer = capture();
  newer.collaborations.capturedAt = '2026-01-18T12:00:00Z';
  newer.collaborations.posts[0].insights.capturedAt = '2026-01-18T10:00:00Z';
  newer.collaborations.posts[0].insights.views = 1500;
  const updated = mergeInstagramStudioCaptures(merged, newer);
  assert.equal(updated.collaborations.posts[0].views, 1400);
  assert.equal(updated.collaborations.posts[0].insights.views, 1500);
});

test('strict native schema rejects private fields, manufactured scope and invalid values or capture bounds', () => {
  for (const mutate of [
    v => { v.insights.accessToken = 'PRIVATE_SENTINEL'; },
    v => { v.insights.facebook = { views: 100 }; },
    v => { v.insights.reportingWindow = 'lifetime'; },
    v => { v.insights.platformScope = 'instagram-only'; },
    v => { v.insights.method = 'official-api'; },
    v => { v.insights.likes = -1; },
    v => { v.insights.views = 1.5; },
    v => { v.insights.capturedAt = '2026-02-31T00:00:00Z'; },
    v => { v.insights.capturedAt = '2026-01-16T10:00:00.001Z'; },
    v => { v.insights.capturedAt = '2026-01-09T00:00:00Z'; },
    v => { v.insights.viewAudience[0].percentage = 101; },
    v => { v.insights.interactionAudience.push(v.insights.interactionAudience[0]); },
  ]) {
    const value = capture(); mutate(value.collaborations.posts[0]);
    assert.throws(() => validateInstagramStudioCapture(value));
  }
  const value = capture(); delete value.collaborations.posts[0].relationship;
  assert.equal(validateInstagramStudioCapture(value).collaborations.posts[0].relationship, 'collaboration');
  const conflicting = capture(); conflicting.collaborations.posts[0].mediaId = '1000000000000000901';
  assert.throws(() => mergeInstagramStudioCaptures(capture(), conflicting), /conflicting media IDs/);
});

test('cloud projection exposes only validated native observations and retains the account report date', async () => {
  const bundled = await readBundledInputs(), manualCapture = capture();
  const payload = { schemaVersion: 1, id: 'instagram', kind: 'instagram-native-capture',
    capturedAt: manualCapture.capturedAt, manualCapture };
  const options = { bundled, storeFactory: () => ({ loadSnapshot: async id => id === 'instagram'
    ? { capturedAt: manualCapture.capturedAt, payload } : null, getStatuses: async () => [] }) };
  const report = await loadPublicReport(options);
  const source = report.sources.find(row => row.id === 'instagram');
  assert.deepEqual(source.manualCapture.collaborations.posts[0].insights, instagramPostInsightsFixture());
  assert.equal(source.capturedAt, manualCapture.capturedAt);
  assert.equal(source.metrics.views, null);
  payload.manualCapture.collaborations.posts[0].insights.raw = 'PRIVATE_SENTINEL';
  assert.doesNotMatch(JSON.stringify(await loadPublicReport(options)), /PRIVATE_SENTINEL/);
});
