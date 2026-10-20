import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncHandler } from '../api/sync.mjs';
import { StudioImportError } from '../lib/cloud-sync.mjs';

const ORIGIN = 'https://analytics.example';
function response() {
  return {
    headers: {}, statusCode: null, body: '',
    setHeader(name, value) { this.headers[name] = value; },
    getHeader(name) { return this.headers[name]; },
    end(value = '') { this.body = value; },
  };
}
function request(body = { operation: 'studio-import', report: { test: 'report' } }, overrides = {}) {
  return {
    method: 'POST', url: '/api/sync?source=tiktok',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body, ...overrides,
  };
}
function handlerWith(options = {}) {
  return createSyncHandler({
    env: {}, getAuthConfig: () => ({ origin: ORIGIN }),
    authorize: async () => ({ id: 'team-user' }),
    storeFactory: () => ({ privateStorage: true }),
    synchronize: async () => { throw Error('must not collect'); },
    ...options,
  });
}

test('Studio import requires same-origin verified team before reading or writing data', async () => {
  let authorized = 0, stored = 0;
  const handler = handlerWith({
    authorize: async (_req, res) => { authorized++; res.statusCode = 401; res.end('{}'); return null; },
    storeFactory: () => { stored++; return {}; },
  });
  const crossSite = response();
  await handler(request(undefined, { headers: { origin: 'https://evil.example', 'content-type': 'application/json' } }), crossSite);
  assert.equal(crossSite.statusCode, 403);
  assert.equal(authorized, 0);
  const anonymous = response();
  await handler(request(), anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(authorized, 1);
  assert.equal(stored, 0);
});

test('team import dispatches only curated report to TikTok storage without provider collection', async () => {
  const calls = [];
  const handler = handlerWith({
    importStudio: async input => {
      calls.push(input);
      return { source: 'tiktok', status: 'imported', capturedAt: '2026-10-20T12:00:00Z', displayCapturedAt: '2026-10-19T12:00:00Z' };
    },
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [{ store: { privateStorage: true }, report: { test: 'report' } }]);
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.equal(JSON.parse(res.body).displayCapturedAt, '2026-10-19T12:00:00Z');
});

test('imports reject source, operation, query and extra-body injection', async () => {
  let touched = false;
  const handler = handlerWith({
    importStudio: async () => { touched = true; },
    storeFactory: () => { touched = true; },
  });
  for (const req of [
    request(undefined, { url: '/api/sync?source=instagram' }),
    request(undefined, { url: '/api/sync?source=tiktok&source=instagram' }),
    request(undefined, { url: '/api/sync?source=tiktok&accountId=other' }),
    request({ operation: 'import-anything', report: {} }),
    request({ operation: 'studio-import', report: {}, accountId: 'other' }),
    request({ operation: 'studio-import', report: {}, credentials: 'private' }),
    request('not json'),
    request([]),
  ]) {
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(touched, false);
});

test('body size and media type limits hold for parsed bodies and streaming input', async () => {
  const handler = handlerWith({ storeFactory: () => { throw Error('must not access'); } });
  const cases = [
    [request({}, { headers: { origin: ORIGIN, 'content-type': 'text/plain' } }), 415],
    [request({}, { headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': '2000001' } }), 413],
    [request({ operation: 'studio-import', report: { value: 'x'.repeat(2_000_001) } }), 413],
    [{
      ...request(), body: undefined,
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      async *[Symbol.asyncIterator]() { yield 'x'.repeat(1_000_001); yield 'x'.repeat(1_000_001); },
    }, 413],
  ];
  for (const [req, status] of cases) {
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, status);
  }
});

test('busy, missing snapshot and storage failures have safe distinct responses', async () => {
  for (const [run, status, expected] of [
    [async () => ({ source: 'tiktok', status: 'busy', errorCode: 'sync_in_progress' }), 409, 'sync_in_progress'],
    [async () => { throw new StudioImportError(409, 'tiktok_snapshot_required'); }, 409, 'tiktok_snapshot_required'],
    [async () => { throw new StudioImportError(400, 'invalid_studio_report'); }, 400, 'invalid_studio_report'],
    [async () => { throw Error('private-token database-password'); }, 503, 'sync_unavailable'],
  ]) {
    const res = response();
    await handlerWith({ importStudio: run })(request(), res);
    assert.equal(res.statusCode, status);
    assert.match(res.body, new RegExp(expected));
    assert.doesNotMatch(res.body, /private-token|database-password/);
  }
});

test('cron cannot dispatch an import operation', async () => {
  let imported = false, collected = false;
  const handler = handlerWith({
    env: { CRON_SECRET: 'a-private-cron-test-secret' },
    synchronize: async () => { collected = true; return { status: 'ready' }; },
    importStudio: async () => { imported = true; },
  });
  const res = response();
  await handler(request(undefined, {
    method: 'GET', headers: { authorization: 'Bearer a-private-cron-test-secret', 'content-type': 'application/json' },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(collected, true);
  assert.equal(imported, false);
});
