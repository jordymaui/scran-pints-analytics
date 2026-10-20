import test from 'node:test';
import assert from 'node:assert/strict';
import { importTikTokStudioSupplement, syncCloudSource } from '../lib/cloud-sync.mjs';
import { validateSocialImport } from '../lib/social-schema.mjs';
import { validateTikTokStudioReport } from '../lib/tiktok-studio.mjs';
import { loadPublicReport, readBundledInputs } from '../lib/cloud-report.mjs';
import { tiktokStudioFixture } from './fixtures/tiktok-studio.mjs';
import { CollectionError } from '../lib/collectors.mjs';

const DISPLAY_CAPTURE = '2026-10-19T12:00:00Z';
const NOW = '2026-10-20T16:00:00Z';
function displaySnapshot(capturedAt = DISPLAY_CAPTURE) {
  return {
    id: 'tiktok', label: 'TikTok', accountLabel: 'Scran & Pints', status: 'snapshot', capturedAt,
    dateRange: { start: capturedAt.slice(0, 10), end: capturedAt.slice(0, 10), timezone: 'UTC' },
    scope: 'Lifetime counters for currently public videos.', provenance: { kind: 'official-api', label: 'TikTok Display API' },
    metrics: { views: 9000, engagedViews: null, watchHours: null, likes: 100, comments: 20, shares: 10, followers: 170, subscribersNet: null },
    daily: [], content: [],
  };
}
function memoryStore(initial = { payload: displaySnapshot(), capturedAt: DISPLAY_CAPTURE, status: 'partial' }) {
  let row = initial ? structuredClone(initial) : null, lease = null;
  const calls = [];
  return {
    calls, get row() { return row; }, get lease() { return lease; },
    async acquireSyncLock(source, options) {
      calls.push(['acquire', source, options.owner]);
      if (lease) return false;
      lease = options.owner;
      return true;
    },
    async releaseSyncLock(source, owner) {
      calls.push(['release', source, owner]);
      if (lease !== owner) return false;
      lease = null;
      return true;
    },
    async loadSnapshot(source) { calls.push(['load', source]); return source === 'tiktok' ? structuredClone(row) : null; },
    async saveSnapshot(source, payload, metadata) {
      calls.push(['save', source, structuredClone(payload), metadata]);
      if (row && Date.parse(row.capturedAt) > Date.parse(metadata.capturedAt)) return { saved: false };
      row = { payload: structuredClone(payload), ...metadata };
      return { saved: true };
    },
    async getConnection() { return { credentials: { accessToken: 'private-provider-token' } }; },
    async recordSyncResult(source, result) { calls.push(['audit', source, result]); },
    async getStatuses() { return []; },
  };
}

test('import preserves Display capture, counters, status and cooldown while storing only validated reporting fields', async () => {
  const store = memoryStore();
  const original = structuredClone(store.row);
  const report = tiktokStudioFixture();
  const result = await importTikTokStudioSupplement({ store, report, now: () => NOW });
  assert.equal(result.status, 'imported');
  assert.equal(result.capturedAt, report.performance.capturedAt);
  assert.equal(result.displayCapturedAt, DISPLAY_CAPTURE);
  assert.equal(store.row.capturedAt, DISPLAY_CAPTURE);
  assert.equal(store.row.payload.capturedAt, DISPLAY_CAPTURE);
  assert.deepEqual(store.row.payload.metrics, original.payload.metrics);
  assert.deepEqual(store.row.payload.daily, []);
  assert.equal(store.row.status, 'partial');
  assert.deepEqual(store.row.payload.studioSupplement, validateTikTokStudioReport(report));
  assert.equal(store.calls.some(call => call[0] === 'audit'), false);
  assert.equal(store.lease, null);
});

test('regular TikTok refresh carries the imported report with its original periods and capture', async () => {
  const store = memoryStore();
  await importTikTokStudioSupplement({ store, report: tiktokStudioFixture(), now: () => NOW });
  const supplement = structuredClone(store.row.payload.studioSupplement);
  const result = await syncCloudSource({
    source: 'tiktok', store, now: () => NOW, env: {},
    collectors: { tiktok: async ({ capturedAt }) => ({ ...displaySnapshot(capturedAt), metrics: { ...displaySnapshot().metrics, views: 10000 } }) },
  });
  assert.equal(result.status, 'ready');
  assert.equal(store.row.capturedAt, NOW);
  assert.equal(store.row.payload.metrics.views, 10000);
  assert.deepEqual(store.row.payload.studioSupplement, supplement);
  assert.equal(store.row.payload.studioSupplement.performance.totals.views, 100);
});

test('future-dated imports cannot poison the stale guard; at most five minutes of clock skew is accepted', async () => {
  const store = memoryStore();
  const future = tiktokStudioFixture();
  future.importedAt = '2026-10-20T16:05:00.001Z';
  future.performance.capturedAt = future.importedAt;
  await assert.rejects(importTikTokStudioSupplement({ store, report: future, now: () => NOW }),
    error => error.status === 400 && error.code === 'invalid_studio_report');
  assert.deepEqual(store.calls, []);
  assert.equal(store.row.payload.studioSupplement, undefined);
  const bounded = tiktokStudioFixture();
  bounded.importedAt = '2026-10-20T16:05:00.000Z';
  bounded.performance.capturedAt = bounded.importedAt;
  const result = await importTikTokStudioSupplement({ store, report: bounded, now: () => NOW });
  assert.equal(result.status, 'imported');
  assert.equal(store.row.payload.studioSupplement.performance.capturedAt, bounded.importedAt);
});

test('failed provider refresh leaves both counters and the imported Studio report intact', async () => {
  const store = memoryStore();
  await importTikTokStudioSupplement({ store, report: tiktokStudioFixture(), now: () => NOW });
  const previous = structuredClone(store.row);
  const result = await syncCloudSource({
    source: 'tiktok', store, now: () => NOW,
    collectors: { tiktok: async () => { throw new CollectionError('network', 'private raw response'); } },
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(store.row, previous);
  assert.equal(store.lease, null);
});

test('import and collection share the same provider lease instead of overwriting concurrent data', async () => {
  const store = memoryStore();
  let releaseRead, announceRead;
  const reading = new Promise(resolve => { announceRead = resolve; });
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const load = store.loadSnapshot;
  store.loadSnapshot = async source => { announceRead(); await readGate; return load(source); };
  const importing = importTikTokStudioSupplement({ store, report: tiktokStudioFixture(), now: () => NOW });
  await reading;
  let collected = false;
  const competing = await syncCloudSource({
    source: 'tiktok', store, now: () => NOW,
    collectors: { tiktok: async () => { collected = true; return displaySnapshot(NOW); } },
  });
  assert.equal(competing.status, 'busy');
  assert.equal(collected, false);
  releaseRead();
  assert.equal((await importing).status, 'imported');
  assert.equal(store.row.payload.studioSupplement.performance.totals.views, 100);
  assert.equal(store.lease, null);
});

test('missing snapshot, older Studio report and failed save release the lease without changing stored data', async () => {
  const absent = memoryStore(null);
  await assert.rejects(importTikTokStudioSupplement({ store: absent, report: tiktokStudioFixture(), now: () => NOW }),
    error => error.status === 409 && error.code === 'tiktok_snapshot_required');
  assert.equal(absent.lease, null);
  const store = memoryStore();
  await importTikTokStudioSupplement({ store, report: tiktokStudioFixture(), now: () => NOW });
  const before = structuredClone(store.row);
  const old = tiktokStudioFixture();
  old.performance.capturedAt = '2026-10-20T13:00:00Z';
  await assert.rejects(importTikTokStudioSupplement({ store, report: old, now: () => NOW }),
    error => error.code === 'studio_import_stale');
  assert.deepEqual(store.row, before);
  store.saveSnapshot = async () => ({ saved: false });
  await assert.rejects(importTikTokStudioSupplement({ store, report: tiktokStudioFixture(), now: () => NOW }),
    error => error.code === 'newer_snapshot_exists');
  assert.equal(store.lease, null);
});

test('later follower CSV reports preserve the independently dated viewer population', async () => {
  const store = memoryStore();
  const first = tiktokStudioFixture();
  first.audience.push({ ...structuredClone(first.audience[0]), population: 'viewers', provenance: 'studio-screen' });
  await importTikTokStudioSupplement({ store, report: first, now: () => NOW });
  const next = tiktokStudioFixture();
  next.importedAt = NOW;
  next.performance.capturedAt = '2026-10-20T15:00:00Z';
  next.audience[0].capturedAt = '2026-10-20T15:00:00Z';
  next.audience[0].age = [];
  await importTikTokStudioSupplement({ store, report: next, now: () => NOW });
  const audience = store.row.payload.studioSupplement.audience;
  assert.equal(audience.find(row => row.population === 'viewers').capturedAt, '2026-10-20T14:00:00Z');
  assert.equal(audience.find(row => row.population === 'followers').capturedAt, '2026-10-20T15:00:00Z');
});

test('public report keeps period performance independent of Display lifetime counters and drops unsafe imports', async () => {
  const bundled = await readBundledInputs();
  const store = memoryStore();
  await importTikTokStudioSupplement({ store, report: tiktokStudioFixture(), now: () => NOW });
  const result = await loadPublicReport({ bundled, storeFactory: () => store });
  const source = result.sources.find(row => row.id === 'tiktok');
  assert.equal(source.metrics.views, 9000);
  assert.equal(source.capturedAt, DISPLAY_CAPTURE);
  assert.equal(source.counterScope, 'public-content-lifetime');
  assert.equal(source.studioSupplement.performance.totals.views, 100);
  assert.equal(source.studioSupplement.performance.dateRange.end, '2026-10-18');
  assert.equal(source.studioSupplement.performance.dateRange.timezone, null);
  assert.equal(source.performance, undefined);
  assert.deepEqual(source.studioSupplement, store.row.payload.studioSupplement);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-token|accessToken|rawCsv|localPath/);

  for (const field of ['credentials', 'rawCsv', 'localPath']) {
    const malicious = { ...tiktokStudioFixture(), [field]: 'PRIVATE_SENTINEL' };
    await assert.rejects(importTikTokStudioSupplement({ store, report: malicious, now: () => NOW }),
      error => error.status === 400 && error.code === 'invalid_studio_report');
    const poisoned = { ...displaySnapshot(), studioSupplement: malicious };
    const publicResult = await loadPublicReport({
      bundled,
      storeFactory: () => ({ loadSnapshot: async id => id === 'tiktok' ? { payload: poisoned } : null, getStatuses: async () => [] }),
    });
    assert.doesNotMatch(JSON.stringify(publicResult), /PRIVATE_SENTINEL/);
  }
});

test('Studio supplement is accepted only on TikTok and malformed dates never enter the public source', () => {
  const fixture = tiktokStudioFixture();
  const valid = { ...displaySnapshot(), studioSupplement: fixture };
  assert.ok(validateSocialImport({ schemaVersion: 1, sources: [valid] }).sources[0].studioSupplement);
  for (const id of ['instagram', 'youtube-shorts']) {
    assert.throws(() => validateSocialImport({ schemaVersion: 1, sources: [{ ...valid, id }] }), /TikTok/);
  }
  fixture.performance.daily[0].date = '2026-02-31';
  assert.throws(() => validateSocialImport({ schemaVersion: 1, sources: [{ ...valid, studioSupplement: fixture }] }));
});
