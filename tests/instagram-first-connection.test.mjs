import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCloudSource } from '../lib/cloud-sync.mjs';
import { instagramNativeFixture, instagramCollaborationFixture, instagramPostInsightsFixture } from './fixtures/instagram-native.mjs';

const NOW = '2026-01-16T12:00:00Z';
const ACCOUNT = '123456789';

function captureRow() {
  const manualCapture = instagramNativeFixture();
  const collaborations = instagramCollaborationFixture();
  const template = collaborations.posts[0];
  collaborations.posts = Array.from({ length: 12 }, (_, index) => {
    const shortcode = `Synthetic_collab_${index}`;
    return { ...structuredClone(template), shortcode,
      url: `https://www.instagram.com/reel/${shortcode}/`, mediaId: String(800000 + index),
      insights: { ...instagramPostInsightsFixture(), views: 1250 + index } };
  });
  manualCapture.collaborations = collaborations;
  return { capturedAt: manualCapture.capturedAt, status: 'ready', payload: {
    schemaVersion: 1, id: 'instagram', kind: 'instagram-native-capture',
    capturedAt: manualCapture.capturedAt, manualCapture,
  } };
}

function memoryStore(initial) {
  let row = structuredClone(initial), lease = null, saves = 0;
  return {
    get row() { return row; }, get lease() { return lease; }, get saves() { return saves; },
    async acquireSyncLock(id, { owner }) { assert.equal(id, 'instagram'); assert.equal(lease, null); lease = owner; return true; },
    async releaseSyncLock(id, owner) { assert.equal(id, 'instagram'); assert.equal(owner, lease); lease = null; },
    async getConnection() { return { accountId: ACCOUNT, credentials: {
      accessToken: 'PRIVATE_SYNTHETIC_TOKEN', expiresAt: '2026-03-01T00:00:00Z',
    } }; },
    async loadSnapshot(id) { assert.equal(id, 'instagram'); assert.ok(lease); return structuredClone(row); },
    async saveSnapshot(id, payload, metadata) {
      assert.equal(id, 'instagram'); assert.ok(lease); saves++;
      row = { payload, ...metadata }; return { saved: true };
    },
    async recordSyncResult() {},
  };
}

// Exercise the production collector through the production sync orchestrator.
// Only provider HTTP is mocked; no real grant or remote store is used.
function provider() {
  const calls = [];
  return { calls, fetchImpl: async (endpoint, options) => {
    const url = new URL(endpoint); calls.push(url);
    assert.equal(url.origin, 'https://graph.instagram.com');
    assert.equal(options.headers.Authorization, 'Bearer PRIVATE_SYNTHETIC_TOKEN');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(options.redirect, 'error');
    let payload;
    if (url.pathname === `/v24.0/${ACCOUNT}`) {
      payload = { id: ACCOUNT, username: 'scranpints', followers_count: 50, media_count: 1 };
    } else if (url.pathname === `/v24.0/${ACCOUNT}/media`) {
      payload = { data: [{ id: '555000', caption: 'Synthetic API post', media_type: 'VIDEO',
        media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/Synthetic_api/',
        timestamp: '2026-01-10T12:00:00+0000', like_count: 8, comments_count: 2 }] };
    } else if (url.pathname === '/v24.0/555000/insights') {
      payload = { data: [{ name: 'views', values: [{ value: 500 }] },
        { name: 'shares', values: [{ value: 3 }] }] };
    } else if (url.pathname === `/v24.0/${ACCOUNT}/insights`) {
      payload = { data: url.searchParams.get('metric') === 'views'
        ? [{ name: 'views', total_value: { value: 10 } }] : [] };
    } else throw Error(`Unexpected provider path: ${url.pathname}`);
    return { ok: true, status: 200, json: async () => payload };
  } };
}

test('first real Instagram API collection accepts a valid manual-only row and preserves all dated native observations', async () => {
  const initial = captureRow(), store = memoryStore(initial), mock = provider();
  const result = await syncCloudSource({ source: 'instagram', store, now: () => NOW, env: {}, fetchImpl: mock.fetchImpl });
  assert.equal(result.status, 'ready');
  assert.equal(store.saves, 1);
  assert.equal(store.lease, null);
  assert.equal(store.row.payload.provenance.kind, 'official-api');
  assert.equal(store.row.payload.capturedAt, NOW);
  assert.equal(store.row.payload.kind, undefined);
  assert.equal(store.row.payload.metrics.views, 500);
  assert.equal(store.row.payload.metrics.followers, 50);
  assert.equal(store.row.payload.daily.length, 90);
  assert.equal(store.row.payload.daily.at(-1).day, '2026-01-15');
  assert.deepEqual(store.row.payload.manualCapture, initial.payload.manualCapture);
  assert.equal(store.row.payload.manualCapture.collaborations.posts.length, 12);
  assert.equal(store.row.payload.manualCapture.collaborations.posts.filter(post => post.insights).length, 12);
  assert.ok(mock.calls.some(url => url.pathname.endsWith('/555000/insights')));
  assert.ok(mock.calls.every(url => !/\/8000\d+\//.test(url.pathname)));
  assert.doesNotMatch(JSON.stringify(store.row.payload), /PRIVATE_SYNTHETIC_TOKEN|accessToken/);

  // An API-backed row still reaches the collector as previous daily history.
  const later = provider();
  const again = await syncCloudSource({ source: 'instagram', store,
    now: () => '2026-01-17T12:00:00Z', env: {}, fetchImpl: later.fetchImpl });
  assert.equal(again.status, 'ready');
  assert.equal(later.calls.filter(url => url.searchParams.get('metric') === 'views').length, 8);
  assert.equal(store.row.payload.daily.length, 91);
  assert.deepEqual(store.row.payload.manualCapture, initial.payload.manualCapture);
});

test('malformed native wrappers cannot be discarded to bypass validation during first API collection', async () => {
  for (const mutate of [
    row => { row.payload.raw = 'PRIVATE_UNAPPROVED_FIELD'; },
    row => { row.payload.schemaVersion = 2; },
    row => { row.payload.id = 'tiktok'; },
    row => { row.payload.capturedAt = '2026-01-14T12:00:00Z'; },
    row => { row.capturedAt = '2026-01-14T12:00:00Z'; },
    row => { row.payload.manualCapture.raw = 'PRIVATE_UNAPPROVED_FIELD'; },
    row => { row.capturedAt = row.payload.capturedAt = row.payload.manualCapture.capturedAt = '2026-01-18T12:00:00Z'; },
  ]) {
    const initial = captureRow(); mutate(initial);
    const store = memoryStore(initial), mock = provider();
    const result = await syncCloudSource({ source: 'instagram', store, now: () => NOW, env: {}, fetchImpl: mock.fetchImpl });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'invalid-response');
    assert.equal(store.saves, 0);
    assert.equal(store.lease, null);
    assert.deepEqual(store.row, initial);
    assert.equal(mock.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_UNAPPROVED_FIELD|PRIVATE_SYNTHETIC_TOKEN/);
  }
});
