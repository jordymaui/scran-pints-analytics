import test from 'node:test';
import assert from 'node:assert/strict';
import { instagramEnvironment, syncCloudSource } from '../lib/cloud-sync.mjs';

const NOW = '2026-10-20T16:00:00.000Z';
const connection = (overrides = {}) => ({ accountId: '17841400000000000',
  scopes: ['instagram_business_basic', 'instagram_business_manage_insights'],
  credentials: { accessToken: 'PRIVATE_OLD_ACCESS', expiresAt: '2026-10-23T16:00:00Z',
    tokenIssuedAt: '2026-08-25T16:00:00Z', accountUsername: 'scranpints', ...overrides } });
const snapshot = id => ({
  id, label: id, accountLabel: 'Scran & Pints', status: 'snapshot', capturedAt: NOW,
  dateRange: { start: '2026-10-20', end: '2026-10-20', timezone: 'UTC' },
  scope: 'Current observed public counters.', provenance: { kind: 'official-api', label: 'Official API fixture' },
  metrics: { views: 20, engagedViews: null, watchHours: null, likes: 2, comments: 1,
    shares: 1, followers: 10, subscribersNet: null }, daily: [], content: [],
});
function storeWith({ instagram = connection(), last = {}, busy = new Set() } = {}) {
  const calls = [], latest = new Map(Object.entries(last));
  return { calls,
    acquireSyncLock: async source => { calls.push(['acquire', source]); return !busy.has(source); },
    releaseSyncLock: async source => { calls.push(['release', source]); },
    getLastSyncRun: async source => { calls.push(['last', source]); return latest.get(source) || null; },
    getConnection: async source => source === 'instagram' ? instagram : {
      accountId: 'owner-id', credentials: { accessToken: 'PRIVATE_TIKTOK_ACCESS', expiresAt: '2026-10-21T16:00:00Z' },
    },
    setConnection: async (...args) => { calls.push(['connection-saved', ...args]); },
    loadSnapshot: async () => null,
    saveSnapshot: async (source, value) => { calls.push(['snapshot', source, value]); return { saved: true }; },
    recordSyncResult: async (source, value) => {
      calls.push(['audit', source, value]); latest.set(source, value);
    },
  };
}
const refreshed = () => new Response(JSON.stringify({ access_token: 'PRIVATE_NEW_ACCESS', expires_in: 60 * 86400 }));

test('Instagram refresh persists the renewed credential before any collector request', async () => {
  const store = storeWith(), order = [];
  const result = await syncCloudSource({ source: 'instagram', store, now: () => NOW,
    env: { INSTAGRAM_API_VERSION: 'v24.0' },
    fetchImpl: async endpoint => {
      const url = new URL(endpoint);
      assert.equal(url.origin + url.pathname, 'https://graph.instagram.com/refresh_access_token');
      assert.equal(url.searchParams.get('grant_type'), 'ig_refresh_token');
      assert.equal(url.searchParams.get('access_token'), 'PRIVATE_OLD_ACCESS');
      order.push('refresh'); return refreshed();
    },
    collectors: { instagram: async options => {
      const saved = store.calls.find(call => call[0] === 'connection-saved');
      assert.ok(saved);
      assert.equal(saved[1], 'instagram');
      assert.equal(saved[2].accessToken, 'PRIVATE_NEW_ACCESS');
      assert.equal(saved[2].tokenIssuedAt, NOW);
      assert.equal(saved[2].expiresAt, '2026-12-19T16:00:00.000Z');
      assert.equal(saved[3].accountId, connection().accountId);
      assert.deepEqual(saved[3].scopes, connection().scopes);
      assert.equal(options.env.INSTAGRAM_ACCESS_TOKEN, 'PRIVATE_NEW_ACCESS');
      assert.equal(options.env.INSTAGRAM_ACCOUNT_ID, connection().accountId);
      order.push('collect'); return snapshot('instagram');
    } } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(order, ['refresh', 'collect']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|178414/);
});

test('expired, undated or unrefreshable Instagram tokens never reach collection', async () => {
  for (const overrides of [
    { expiresAt: '2026-10-19T16:00:00Z' },
    { expiresAt: NOW },
    { expiresAt: 'invalid' },
    { tokenIssuedAt: '2026-10-20T12:00:00Z' },
  ]) {
    const store = storeWith({ instagram: connection(overrides) });
    const result = await syncCloudSource({ source: 'instagram', store, now: () => NOW, env: {},
      fetchImpl: () => { throw Error('Provider must not be called'); },
      collectors: { instagram: () => { throw Error('Collector must not be called'); } } });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'authorization');
    assert.ok(!store.calls.some(call => ['snapshot', 'connection-saved'].includes(call[0])));
  }
});

test('a healthy Instagram token is reused and a failed persistence prevents collection', async () => {
  const store = storeWith();
  const mapped = await instagramEnvironment(connection({ expiresAt: '2026-12-01T00:00:00Z' }),
    {}, store, () => { throw Error('Unexpected network'); }, NOW);
  assert.equal(mapped.INSTAGRAM_ACCESS_TOKEN, 'PRIVATE_OLD_ACCESS');
  assert.equal(store.calls.length, 0);
  store.setConnection = async () => { throw Error('PRIVATE_DATABASE_ERROR'); };
  let collected = false;
  const result = await syncCloudSource({ source: 'instagram', store, now: () => NOW, env: {},
    fetchImpl: async () => refreshed(),
    collectors: { instagram: async () => { collected = true; return snapshot('instagram'); } } });
  assert.equal(collected, false);
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('invalid Instagram refresh responses do not overwrite a saved credential', async () => {
  for (const value of [
    { access_token: 'invalid token', expires_in: 60 * 86400 },
    { access_token: 'PRIVATE_NEW_ACCESS', expires_in: -1 },
    { access_token: 'PRIVATE_NEW_ACCESS', expires_in: 100 * 86400 },
    { access_token: 'PRIVATE_NEW_ACCESS', expires_in: 86400.5 },
  ]) {
    const store = storeWith();
    await assert.rejects(instagramEnvironment(connection(), {}, store,
      async () => new Response(JSON.stringify(value)), NOW), error => error.code === 'authorization');
    assert.equal(store.calls.length, 0);
  }
});

test('social cooldowns and busy leases are independent per provider and do not slide timestamps', async () => {
  const completedAt = '2026-10-20T15:59:00.000Z';
  const store = storeWith({ last: { instagram: { status: 'failed', errorCode: 'network', completedAt } } });
  const collectors = { tiktok: async () => snapshot('tiktok'), instagram: () => { throw Error('Must remain in cooldown'); } };
  const options = { store, now: () => NOW, env: {}, collectors, minimumIntervalMs: 300000 };
  const [instagram, tiktok] = await Promise.all([
    syncCloudSource({ ...options, source: 'instagram' }),
    syncCloudSource({ ...options, source: 'tiktok' }),
  ]);
  assert.equal(instagram.status, 'recent');
  assert.equal(instagram.lastSyncStatus, 'failed');
  assert.equal(instagram.retryAt, '2026-10-20T16:04:00.000Z');
  assert.equal(tiktok.status, 'ready');
  assert.ok(!store.calls.some(call => call[0] === 'audit' && call[1] === 'instagram'));
  assert.deepEqual(store.calls.filter(call => call[0] === 'acquire').map(call => call[1]).sort(), ['instagram', 'tiktok']);
  const busyStore = storeWith({ busy: new Set(['instagram']) });
  const busy = await syncCloudSource({ ...options, store: busyStore, source: 'instagram' });
  assert.equal(busy.status, 'busy');
  assert.deepEqual(busyStore.calls, [['acquire', 'instagram']]);
});
