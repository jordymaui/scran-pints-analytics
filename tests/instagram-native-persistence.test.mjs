import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCloudSource } from '../lib/cloud-sync.mjs';
import { validateSocialImport } from '../lib/social-schema.mjs';
import { instagramNativeFixture } from './fixtures/instagram-native.mjs';
import { CollectionError } from '../lib/collectors.mjs';

const NOW = '2026-01-16T12:00:00Z';
function apiSource(capturedAt = NOW) {
  return { id: 'instagram', label: 'Instagram', accountLabel: 'Scran & Pints', status: 'snapshot', capturedAt,
    dateRange: { start: '2026-01-15', end: '2026-01-15', timezone: 'UTC' },
    scope: 'Returned public media lifetime counters.', provenance: { kind: 'official-api', label: 'Instagram API' },
    metrics: { views: 10000, engagedViews: null, watchHours: null, likes: 50, comments: 5,
      shares: null, followers: 45, subscribersNet: null }, daily: [], content: [] };
}
function storeFor(payload) {
  let row = { payload: structuredClone(payload), capturedAt: payload.capturedAt, status: 'ready' }, lease = null;
  const events = [];
  return { events, get row() { return row; }, get lease() { return lease; },
    async acquireSyncLock(id, { owner }) { events.push(['acquire', id]); if (lease) return false; lease = owner; return true; },
    async releaseSyncLock(id, owner) { assert.equal(owner, lease); lease = null; events.push(['release', id]); },
    async getConnection() { return { accountId: '123456789', credentials: {
      accessToken: 'PRIVATE_SYNTHETIC_TOKEN', expiresAt: '2026-03-01T00:00:00Z' } }; },
    async loadSnapshot(id) { assert.ok(lease); assert.equal(id, 'instagram'); return structuredClone(row); },
    async saveSnapshot(id, payload, metadata) { assert.ok(lease); events.push(['save', id]); row = { payload, ...metadata }; return { saved: true }; },
    async recordSyncResult() {},
  };
}
function wrapper() {
  const manualCapture = instagramNativeFixture();
  return { schemaVersion: 1, id: 'instagram', kind: 'instagram-native-capture',
    capturedAt: manualCapture.capturedAt, manualCapture };
}

test('Instagram capture survives first API connection and subsequent refresh with independent dates', async () => {
  for (const initial of [wrapper(), { ...apiSource(), manualCapture: instagramNativeFixture() }]) {
    const store = storeFor(initial);
    const result = await syncCloudSource({ source: 'instagram', store, now: () => NOW, env: {},
      collectors: { instagram: async ({ capturedAt }) => apiSource(capturedAt) } });
    assert.equal(result.status, 'ready');
    assert.deepEqual(store.row.payload.manualCapture, instagramNativeFixture());
    assert.equal(store.row.payload.capturedAt, NOW);
    assert.equal(store.row.payload.metrics.views, 10000);
    assert.equal(store.row.payload.metrics.followers, 45);
    assert.equal(store.row.payload.manualCapture.followers, 42);
    assert.equal(store.row.payload.manualCapture.capturedAt, '2026-01-15T12:00:00Z');
    assert.equal(store.row.payload.kind, undefined);
    assert.equal(store.lease, null);
    assert.doesNotMatch(JSON.stringify(store.row.payload), /PRIVATE_SYNTHETIC_TOKEN|accessToken/);
  }
});

test('provider failure and invalid retained capture never overwrite the last saved capture', async () => {
  for (const badCapture of [false, true]) {
    const initial = wrapper();
    if (badCapture) initial.manualCapture.privatePath = '/private/source.csv';
    const store = storeFor(initial), before = structuredClone(store.row);
    const result = await syncCloudSource({ source: 'instagram', store, now: () => NOW, env: {},
      collectors: { instagram: async () => {
        if (!badCapture) throw new CollectionError('network', 'private provider response');
        return apiSource();
      } } });
    assert.equal(result.status, 'failed');
    assert.deepEqual(store.row, before);
    assert.equal(store.events.some(([event]) => event === 'save'), false);
    assert.equal(store.lease, null);
    assert.doesNotMatch(JSON.stringify(result), /private provider response|privatePath/);
  }
});

test('manual capture uses the strict Instagram-only schema without weakening API source validation', () => {
  const source = { ...apiSource(), manualCapture: instagramNativeFixture() };
  assert.deepEqual(validateSocialImport({ schemaVersion: 1, sources: [source] }).sources[0].manualCapture, instagramNativeFixture());
  for (const id of ['tiktok', 'youtube-shorts']) {
    assert.throws(() => validateSocialImport({ schemaVersion: 1, sources: [{ ...source, id }] }), /Instagram/);
  }
  source.manualCapture.accessToken = 'PRIVATE_SYNTHETIC_TOKEN';
  assert.throws(() => validateSocialImport({ schemaVersion: 1, sources: [source] }));
});
