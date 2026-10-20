import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCloudSource, scheduledWindow, shortsHistoryStart } from '../lib/cloud-sync.mjs';
import { CollectionError } from '../lib/collectors.mjs';
import { createSyncHandler, validCronAuthorization, requestedSource } from '../api/sync.mjs';

const NOW = '2026-10-20T12:00:00.000Z';
const now = () => NOW;
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200 });
const sourceSnapshot = (id = 'youtube-shorts') => ({
  id, label: id, accountLabel: 'Scran test', status: 'snapshot', capturedAt: NOW,
  dateRange: { start: '2026-09-20', end: '2026-10-17', timezone: 'America/Los_Angeles' },
  scope: 'A test report.', provenance: { kind: 'official-api', label: 'Test fixture' },
  metrics: { views: 1, engagedViews: null, watchHours: null, likes: null, comments: null, shares: null, followers: null, subscribersNet: null },
  daily: [], content: [],
});

function fakeStore({ connection = null, snapshot = null, busy = false, rejectOld = false } = {}) {
  const calls = [];
  const store = {
    calls,
    async acquireSyncLock(source, options) { calls.push(['acquire', source, options]); return !busy; },
    async releaseSyncLock(source, owner) { calls.push(['release', source, owner]); return true; },
    async getConnection(platform) { calls.push(['connection', platform]); return connection; },
    async setConnection(platform, credentials, metadata) { calls.push(['setConnection', platform, credentials, metadata]); },
    async loadSnapshot(source) { calls.push(['load', source]); return snapshot; },
    async saveSnapshot(source, payload, metadata) { calls.push(['save', source, payload, metadata]); return { saved: !rejectOld }; },
    async recordSyncResult(source, run) { calls.push(['run', source, run]); },
  };
  return store;
}

test('scheduled YouTube requests reach today in Pacific time without an artificial lag', () => {
  assert.deepEqual(scheduledWindow(NOW), { start: '2026-09-23', end: '2026-10-20' });
  assert.deepEqual(scheduledWindow('2026-10-20T01:00:00.000Z'), { start: '2026-09-22', end: '2026-10-19' });
});

test('Shorts backfill starts at the earliest channel or retained reporting evidence', () => {
  assert.equal(shortsHistoryStart({
    channelAnalytics: { dateRange: { start: '2026-08-28' } },
    videos: [{ publishedAt: '2026-09-01T01:00:00Z' }],
  }, sourceSnapshot()), '2026-08-28');
  assert.equal(shortsHistoryStart({
    publicReport: { content: [{ publishedAt: '2026-08-01T01:00:00Z' }] },
  }, sourceSnapshot()), '2026-07-31');
  assert.throws(() => shortsHistoryStart({}, null), /channel inventory/);
});

test('missing connection records a safe not-connected run without replacing data', async () => {
  const store = fakeStore();
  const result = await syncCloudSource({ source: 'tiktok', store, now, fetchImpl: () => { throw Error('unexpected network'); } });
  assert.equal(result.status, 'not-connected');
  assert.equal(result.auditRecorded, true);
  assert.equal(store.calls.some(call => call[0] === 'save'), false);
  assert.deepEqual(store.calls.map(call => call[0]), ['acquire', 'connection', 'release', 'run']);
  assert.equal(store.calls.at(-1)[2].trigger, 'manual');
});

test('Shorts maps saved credentials without mutating process state and shares the YouTube lease', async () => {
  const env = Object.freeze({ YOUTUBE_CLIENT_ID: 'test-client', YOUTUBE_CLIENT_SECRET: 'test-client-secret' });
  const connection = { credentials: { refreshToken: 'private-refresh', channelId: 'UCabcdefghijklmnopqrstuv' }, scopes: ['scope'] };
  const store = fakeStore({ connection });
  let received;
  const result = await syncCloudSource({
    source: 'youtube-shorts', store, now, env, trigger: 'cron',
    seedLoader: async () => ({ channelAnalytics: { dateRange: { start: '2026-08-28' } } }),
    collectors: { 'youtube-shorts': async options => { received = options; return sourceSnapshot(); } },
  });
  assert.equal(result.status, 'ready');
  assert.equal(received.env.YOUTUBE_REFRESH_TOKEN, 'private-refresh');
  assert.equal(received.env.YOUTUBE_CHANNEL_ID, 'UCabcdefghijklmnopqrstuv');
  assert.equal(received.start, '2026-08-28');
  assert.equal(received.end, '2026-10-20');
  assert.equal(store.calls[0][1], 'youtube');
  assert.equal(store.calls.find(call => call[0] === 'connection')[1], 'youtube');
  assert.equal(store.calls.find(call => call[0] === 'save')[1], 'youtube-shorts');
  assert.equal(Object.hasOwn(env, 'YOUTUBE_REFRESH_TOKEN'), false);
  assert.doesNotMatch(JSON.stringify(result), /private-refresh|test-client-secret/);
});

test('episode sync uses cloud data, preserves packaging chronology and never writes local files', async () => {
  const original = { capturedAt: '2026-10-01T12:00:00Z', videos: [{ id: 'a4uUoOby5G0', publishedAt: '2026-07-01T12:00:00Z' }] };
  const store = fakeStore({ connection: { credentials: { accessToken: 'private-access' } }, snapshot: { payload: original } });
  let received;
  const result = await syncCloudSource({
    source: 'youtube', store, now, env: {},
    seedLoader: () => { throw Error('should use cloud snapshot'); },
    collectors: { youtube: async options => {
      received = options;
      return { snapshot: { ...options.snapshot, capturedAt: NOW, apiThrough: '2026-10-16' }, warnings: [] };
    } },
  });
  assert.equal(result.status, 'ready');
  assert.equal(received.snapshot.videos[0].packagingCapturedAt, original.capturedAt);
  assert.equal(original.videos[0].packagingCapturedAt, undefined);
  assert.equal(result.window.start, '2026-07-01');
  assert.equal(result.window.end, '2026-10-16');
});

test('provider errors are sanitized, successful old data stays and leases release', async () => {
  const store = fakeStore({ connection: { credentials: { accessToken: 'private-token' } } });
  const result = await syncCloudSource({
    source: 'tiktok', store, now, env: {},
    collectors: { tiktok: async () => { throw new CollectionError('authorization', 'private-token raw provider text'); } },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'authorization');
  assert.equal(store.calls.some(call => call[0] === 'save'), false);
  assert.ok(store.calls.some(call => call[0] === 'release'));
  assert.doesNotMatch(JSON.stringify(result), /private-token|raw provider/);
  assert.doesNotMatch(JSON.stringify(store.calls.filter(call => call[0] === 'run')), /private-token|raw provider/);
});

test('publishing validates the source boundary and rejects unknown fields or mismatched platforms', async () => {
  for (const payload of [
    { ...sourceSnapshot(), accessToken: 'private-token' },
    sourceSnapshot('instagram'),
    { ...sourceSnapshot(), metrics: { ...sourceSnapshot().metrics, views: -1 } },
  ]) {
    const store = fakeStore({ connection: { credentials: { accessToken: 'private-token' } } });
    const result = await syncCloudSource({
      source: 'youtube-shorts', store, now, env: {},
      collectors: { 'youtube-shorts': async () => payload },
    });
    assert.equal(result.errorCode, 'invalid-response');
    assert.equal(store.calls.some(call => call[0] === 'save'), false);
    assert.doesNotMatch(JSON.stringify(result), /private-token/);
  }
});

test('an existing lease prevents any platform request and older results cannot become latest', async () => {
  const busyStore = fakeStore({ busy: true });
  const busy = await syncCloudSource({ source: 'youtube', store: busyStore, now });
  assert.equal(busy.status, 'busy');
  assert.deepEqual(busyStore.calls.map(call => call[0]), ['acquire', 'run']);
  const store = fakeStore({ connection: { credentials: { accessToken: 'test' } }, rejectOld: true });
  const older = await syncCloudSource({
    source: 'youtube-shorts', store, now, env: {},
    collectors: { 'youtube-shorts': async () => sourceSnapshot() },
  });
  assert.equal(older.status, 'blocked');
  assert.equal(older.errorCode, 'newer_snapshot_exists');
});

test('TikTok rotates and saves refresh credentials before collecting, with no token in results', async () => {
  const store = fakeStore({
    connection: {
      accountId: 'owner-id', scopes: ['video.list'],
      credentials: { refreshToken: 'old-refresh', accessToken: 'expired-access', expiresAt: '2026-10-19T00:00:00Z' },
    },
  });
  let receivedEnv;
  const result = await syncCloudSource({
    source: 'tiktok', store, now,
    env: { TIKTOK_CLIENT_KEY: 'client-key', TIKTOK_CLIENT_SECRET: 'client-secret' },
    fetchImpl: async (endpoint, options) => {
      assert.equal(endpoint, 'https://open.tiktokapis.com/v2/oauth/token/');
      assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'old-refresh');
      return jsonResponse({
        access_token: 'new-access', refresh_token: 'new-refresh', open_id: 'owner-id',
        expires_in: 86400, refresh_expires_in: 31536000, scope: 'video.list,user.info.basic,user.info.stats',
      });
    },
    collectors: { tiktok: async ({ env }) => {
      receivedEnv = env;
      assert.ok(store.calls.some(call => call[0] === 'setConnection'));
      return { ...sourceSnapshot('tiktok'), dateRange: { start: '2026-10-20', end: '2026-10-20', timezone: 'UTC' } };
    } },
  });
  assert.equal(result.status, 'ready');
  assert.equal(receivedEnv.TIKTOK_ACCESS_TOKEN, 'new-access');
  assert.equal(receivedEnv.TIKTOK_OPEN_ID, 'owner-id');
  const saved = store.calls.find(call => call[0] === 'setConnection');
  assert.equal(saved[2].refreshToken, 'new-refresh');
  assert.equal(saved[3].accountId, 'owner-id');
  assert.doesNotMatch(JSON.stringify(result), /old-refresh|new-refresh|new-access|client-secret/);
});

test('a TikTok token for a different account is rejected before it can be saved', async () => {
  const store = fakeStore({ connection: { accountId: 'expected-owner', credentials: { refreshToken: 'private-token' } } });
  const result = await syncCloudSource({
    source: 'tiktok', store, now,
    env: { TIKTOK_CLIENT_KEY: 'client', TIKTOK_CLIENT_SECRET: 'secret' },
    fetchImpl: async () => jsonResponse({ access_token: 'wrong-token', refresh_token: 'new-token', open_id: 'wrong-owner', expires_in: 86400 }),
  });
  assert.equal(result.errorCode, 'authorization');
  assert.equal(store.calls.some(call => ['save', 'setConnection'].includes(call[0])), false);
});

function response() {
  const headers = {};
  return {
    statusCode: null, headers, body: '',
    setHeader(name, value) { headers[name] = value; },
    getHeader(name) { return headers[name]; },
    end(value = '') { this.body = value; },
  };
}

test('cron bearer verification is exact and source query accepts only one known source', () => {
  assert.equal(validCronAuthorization('Bearer a-secure-cron-secret-123', 'a-secure-cron-secret-123'), true);
  for (const value of [undefined, 'a-secure-cron-secret-123', 'Bearer wrong', 'bearer a-secure-cron-secret-123']) {
    assert.equal(validCronAuthorization(value, 'a-secure-cron-secret-123'), false);
  }
  assert.equal(validCronAuthorization('Bearer undefined', undefined), false);
  assert.equal(requestedSource('/api/sync?source=youtube-shorts'), 'youtube-shorts');
  for (const url of ['/api/sync', '/api/sync?source=all', '/api/sync?source=tiktok&source=youtube', '/api/sync?source=tiktok&token=private']) {
    assert.throws(() => requestedSource(url), /invalid_source/);
  }
});

test('GET sync requires the cron secret before any data store or collector is touched', async () => {
  let calls = 0;
  const handler = createSyncHandler({
    env: { CRON_SECRET: 'a-secure-cron-secret-123' },
    storeFactory: () => { calls++; return {}; },
    synchronize: async options => { calls++; return { source: options.source, status: 'ready' }; },
  });
  const denied = response();
  await handler({ method: 'GET', url: '/api/sync?source=tiktok', headers: {} }, denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(calls, 0);
  const accepted = response();
  await handler({ method: 'GET', url: '/api/sync?source=tiktok', headers: { authorization: 'Bearer a-secure-cron-secret-123' } }, accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(calls, 2);
  assert.match(accepted.headers['Cache-Control'], /no-store/);
});

test('manual sync requires same-origin POST and an authorized team session', async () => {
  let authorized = 0;
  let synchronized = 0;
  const handler = createSyncHandler({
    env: {}, getAuthConfig: () => ({ origin: 'https://analytics.example' }),
    authorize: async () => { authorized++; return { id: 'team-member' }; },
    storeFactory: () => ({}),
    synchronize: async options => { synchronized++; assert.equal(options.trigger, 'manual'); return { source: options.source, status: 'ready' }; },
  });
  const crossSite = response();
  await handler({
    method: 'POST', url: '/api/sync?source=youtube',
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  }, crossSite);
  assert.equal(crossSite.statusCode, 403);
  assert.equal(authorized, 0);
  const allowed = response();
  await handler({
    method: 'POST', url: '/api/sync?source=youtube',
    headers: { origin: 'https://analytics.example', 'sec-fetch-site': 'same-origin' },
  }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(authorized, 1);
  assert.equal(synchronized, 1);
  const unsigned = createSyncHandler({
    env: {}, getAuthConfig: () => ({ origin: 'https://analytics.example' }),
    authorize: async (_req, res) => { res.statusCode = 401; res.end('{}'); return null; },
    storeFactory: () => { throw Error('must not access'); },
  });
  const denied = response();
  await unsigned({ method: 'POST', url: '/api/sync?source=youtube', headers: { origin: 'https://analytics.example' } }, denied);
  assert.equal(denied.statusCode, 401);
});

test('handler never serializes storage errors or credentials', async () => {
  const handler = createSyncHandler({
    env: { CRON_SECRET: 'a-secure-cron-secret-123' },
    storeFactory: () => { throw Error('private-database-password'); },
  });
  const res = response();
  await handler({ method: 'GET', url: '/api/sync?source=instagram', headers: { authorization: 'Bearer a-secure-cron-secret-123' } }, res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(res.body, /private-database-password/);
});
