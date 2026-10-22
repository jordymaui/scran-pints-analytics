import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicSocialRefreshHandler } from '../api/public-social-refresh.mjs';
import { PUBLIC_REFRESH_INTERVAL_MS } from '../api/public-refresh.mjs';

const ORIGIN = 'https://scran-pints-analytics.vercel.app';
const NOW = '2026-10-20T16:00:00.000Z';
const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; },
  end(value) { this.body = JSON.parse(value); } });
const request = (overrides = {}) => ({ method: 'POST', url: '/api/public-social-refresh',
  headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }, ...overrides });
const states = () => ['instagram', 'tiktok'].map(id => ({
  id, connected: true, running: false, capturedAt: NOW, lastSyncStatus: 'ready',
  accountId: 'PRIVATE_ACCOUNT', credentials: { accessToken: 'PRIVATE_TOKEN' },
}));
function setup({ rows = states(), results = {}, failStore = false } = {}) {
  const calls = [];
  const handler = createPublicSocialRefreshHandler({ env: { APP_ORIGIN: ORIGIN },
    storeFactory: () => {
      if (failStore) throw Error('PRIVATE_TOKEN database details');
      return { getPublicSocialRefreshState: async () => rows };
    },
    synchronize: async options => {
      calls.push(options);
      const value = results[options.source];
      if (value instanceof Error) throw value;
      return value || { status: 'ready', credentials: 'PRIVATE_TOKEN' };
    } });
  return { handler, calls };
}

test('anonymous social refresh selects only the two configured providers with five-minute cooldown', async () => {
  const { handler, calls } = setup(), res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map(call => call.source).sort(), ['instagram', 'tiktok']);
  assert.equal(PUBLIC_REFRESH_INTERVAL_MS, 300000);
  for (const call of calls) {
    assert.equal(call.minimumIntervalMs, PUBLIC_REFRESH_INTERVAL_MS);
    assert.equal(call.trigger, 'manual');
  }
  assert.deepEqual(res.body.sources.map(row => [row.id, row.status]), [
    ['instagram', 'refreshed'], ['tiktok', 'refreshed'],
  ]);
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_|accountId|credentials/);
  assert.match(res.headers['Cache-Control'], /no-store/);
});

test('anonymous social GET reads status without collecting and ignores unrelated sources', async () => {
  const rows = [...states(), { id: 'youtube', connected: true, credentials: 'PRIVATE_TOKEN' }];
  rows[0].running = true;
  rows[1].connected = false;
  const { handler, calls } = setup({ rows }), res = response();
  await handler(request({ method: 'GET', headers: {} }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0);
  assert.deepEqual(res.body.sources.map(row => [row.id, row.status]), [
    ['instagram', 'busy'], ['tiktok', 'not-connected'],
  ]);
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_|youtube/);
});

test('social refresh rejects source, account, token and date injection before storage or provider work', async () => {
  for (const [req, expected] of [
    [request({ url: '/api/public-social-refresh?source=youtube' }), 400],
    [request({ url: '/api/public-social-refresh?account=another' }), 400],
    [request({ method: 'GET', url: '/api/public-social-refresh?source=tiktok' }), 400],
    [request({ body: { source: 'youtube' } }), 400],
    [request({ body: { accessToken: 'PRIVATE_TOKEN', start: '2020-01-01' } }), 400],
    [request({ body: '{"source":"youtube"}' }), 400],
    [request({ body: [] }), 400],
    [request({ headers: {} }), 403],
    [request({ headers: { origin: 'https://other.example' } }), 403],
    [request({ headers: { origin: ORIGIN, 'sec-fetch-site': 'cross-site' } }), 403],
    [request({ method: 'PUT' }), 405],
  ]) {
    let stored = false;
    const handler = createPublicSocialRefreshHandler({ env: { APP_ORIGIN: ORIGIN },
      storeFactory: () => { stored = true; throw Error('must not access'); } });
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, expected);
    assert.equal(stored, false);
  }
});

test('provider failure is isolated and busy or recent failure is not labelled refreshed', async () => {
  for (const [instagram, tiktok, expected] of [
    [Error('PRIVATE_TOKEN raw provider response'), { status: 'ready' }, ['failed', 'refreshed']],
    [{ status: 'busy' }, { status: 'recent', lastSyncStatus: 'failed', retryAt: NOW }, ['busy', 'recent']],
    [{ status: 'blocked' }, { status: 'not-connected' }, ['failed', 'not-connected']],
  ]) {
    const { handler } = setup({ results: { instagram, tiktok } }), res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.sources.map(row => row.status), expected);
    if (tiktok.status === 'recent') {
      assert.equal(res.body.sources[1].lastSyncStatus, 'failed');
      assert.equal(res.body.sources[1].retryAt, NOW);
    }
    assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_|provider response/);
  }
});

test('unconnected social accounts are skipped and storage errors have only static public text', async () => {
  const rows = states(); rows[0].connected = false;
  const { handler, calls } = setup({ rows }), res = response();
  await handler(request(), res);
  assert.deepEqual(calls.map(call => call.source), ['tiktok']);
  assert.equal(res.body.sources[0].status, 'not-connected');
  const failed = setup({ failStore: true }), unavailable = response();
  await failed.handler(request(), unavailable);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.error, 'refresh_unavailable');
  assert.doesNotMatch(JSON.stringify(unavailable.body), /PRIVATE_|database details/);
});

test('public status exposes only safe completion metadata and partial browser outcomes', async () => {
  const rows = states();
  Object.assign(rows[0], { lastSyncAt: NOW, lastSyncErrorCode: 'partial_refresh', warningCount: 2,
    mode: 'browser-sweep', browserState: 'ready' });
  Object.assign(rows[1], { lastSyncAt: 'PRIVATE_TIMESTAMP', lastSyncErrorCode: 'PRIVATE_TOKEN', warningCount: -1,
    mode: 'PRIVATE_MODE', browserState: { sessionUrl: 'PRIVATE_URL' } });
  const { handler } = setup({ rows }), res = response();
  await handler(request({ method: 'GET', headers: {} }), res);
  assert.equal(res.body.sources[0].status, 'partial');
  assert.equal(res.body.sources[0].lastSyncAt, NOW);
  assert.equal(res.body.sources[0].lastSyncErrorCode, 'partial_refresh');
  assert.equal(res.body.sources[0].warningCount, 2);
  assert.equal(res.body.sources[0].mode, 'browser-sweep');
  assert.equal(res.body.sources[0].browserState, 'ready');
  for (const key of ['lastSyncAt', 'lastSyncErrorCode', 'warningCount', 'mode', 'browserState']) assert.equal(res.body.sources[1][key], null);
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_|sessionUrl|credentials/);
});

test('ready collections with retained reports return partial and preserve safe run completion time', async () => {
  const completedAt = '2026-10-20T16:03:00.000Z';
  const { handler } = setup({ results: { instagram: { status: 'ready', errorCode: 'partial_refresh',
    warningCount: 1, completedAt, rawError: 'PRIVATE_ERROR' } } }), res = response();
  await handler(request(), res);
  assert.equal(res.body.sources[0].status, 'partial');
  assert.equal(res.body.sources[0].lastSyncStatus, 'ready');
  assert.equal(res.body.sources[0].lastSyncAt, completedAt);
  assert.equal(res.body.sources[0].capturedAt, NOW);
  assert.equal(res.body.sources[0].lastSyncErrorCode, 'partial_refresh');
  assert.equal(res.body.sources[0].warningCount, 1);
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_|rawError/);
});

test('recent collection metadata is sanitized rather than copied from provider results', async () => {
  const { handler } = setup({ results: { instagram: { status: 'recent', retryAt: 'PRIVATE_URL',
    lastSyncStatus: 'PRIVATE_STATUS', lastSyncErrorCode: 'PRIVATE_ERROR' },
  tiktok: { status: 'recent', retryAt: NOW, lastSyncStatus: 'ready', lastSyncErrorCode: 'partial_refresh' } } }), res = response();
  await handler(request(), res);
  assert.equal(res.body.sources[0].retryAt, null);
  assert.equal(res.body.sources[0].lastSyncStatus, null);
  assert.equal(res.body.sources[0].lastSyncErrorCode, null);
  assert.equal(res.body.sources[1].status, 'recent');
  assert.equal(res.body.sources[1].lastSyncErrorCode, 'partial_refresh');
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_/);
});
