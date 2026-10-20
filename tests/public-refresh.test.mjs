import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicRefreshHandler, PUBLIC_REFRESH_INTERVAL_MS } from '../api/public-refresh.mjs';

const ORIGIN = 'https://scran-pints-analytics.vercel.app';
const state = { running: false, capturedAt: '2026-10-20T15:00:00.000Z',
  analyticsCapturedAt: '2026-10-20T15:00:00.000Z', analyticsThrough: '2026-10-17',
  lastSync: { status: 'ready', errorCode: null, completedAt: '2026-10-20T15:01:00.000Z' } };
const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; },
  end(value) { this.body = JSON.parse(value); } });
const request = (overrides = {}) => ({ method: 'POST', url: '/api/public-refresh',
  headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }, ...overrides });
function setup(result = { status: 'ready', components: { public: { status: 'ready' }, analytics: { status: 'ready' } } }) {
  const calls = [];
  const handler = createPublicRefreshHandler({ env: { APP_ORIGIN: ORIGIN },
    storeFactory: () => ({ getPublicYouTubeRefreshState: async () => ({ ...state, credentials: 'PRIVATE_SECRET' }) }),
    synchronize: async options => { calls.push(options); return result; } });
  return { handler, calls };
}

test('anonymous same-origin POST runs the fixed YouTube collector with a persistent cooldown', async () => {
  const { handler, calls } = setup(), res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'refreshed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, 'youtube');
  assert.equal(calls[0].minimumIntervalMs, PUBLIC_REFRESH_INTERVAL_MS);
  assert.equal(calls[0].trigger, 'manual');
  assert.equal(res.body.analyticsThrough, '2026-10-17');
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_SECRET|credentials/);
});

test('public GET reads progress without starting provider work', async () => {
  const { handler, calls } = setup(), res = response();
  await handler(request({ method: 'GET', headers: {} }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, state);
  assert.equal(calls.length, 0);
});

test('cross-site writes, caller-selected sources and unsupported methods cannot start a sync', async () => {
  for (const [req, status] of [
    [request({ headers: { origin: 'https://elsewhere.example' } }), 403],
    [request({ url: '/api/public-refresh?source=tiktok' }), 400],
    [request({ body: { source: 'instagram' } }), 400],
    [request({ method: 'DELETE' }), 405],
  ]) {
    const { handler, calls } = setup(), res = response();
    await handler(req, res);
    assert.equal(res.statusCode, status);
    assert.equal(calls.length, 0);
  }
});

test('busy, recent and partial collections keep explicit outcomes', async () => {
  for (const [result, status, httpStatus] of [
    [{ status: 'busy' }, 'busy', 202],
    [{ status: 'recent', lastSyncStatus: 'failed', retryAt: '2026-10-20T16:00:00.000Z' }, 'recent', 200],
    [{ status: 'ready', components: { public: { status: 'ready' }, analytics: { status: 'failed' } } }, 'partial', 200],
    [{ status: 'failed' }, 'failed', 502],
  ]) {
    const { handler } = setup(result), res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, httpStatus);
    assert.equal(res.body.status, status);
  }
});

test('unexpected provider/storage errors expose a static failure without secrets', async () => {
  const handler = createPublicRefreshHandler({ env: { APP_ORIGIN: ORIGIN },
    storeFactory: () => { throw Error('PRIVATE_SECRET provider details'); } });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'failed');
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_SECRET|provider details/);
});
