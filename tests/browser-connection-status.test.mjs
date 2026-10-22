import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudStore, publicSyncErrorCode } from '../lib/cloud-store.mjs';
import { createConnectionStatusHandler, publicConnectionStatuses } from '../api/connection-status.mjs';

const NOW = '2026-10-22T12:00:00.000Z';
const BEFORE = '2026-10-21T12:00:00.000Z';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_TEST_ONLY' };
function fixture({ state = 'ready', mode = 'browser-sweep', warnings = 2, completedAt = NOW,
  code = 'partial_refresh', runStatus = 'ready', browserExpiresAt = '2026-10-22T12:05:00.000Z' } = {}) {
  const calls = [];
  const store = createCloudStore({ env, fetcher: async (endpoint, init) => {
    const url = new URL(endpoint); calls.push({ url, init });
    let rows = [];
    if (init.method === 'POST') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('analytics_connections')) rows = [
      { platform: 'instagram', updated_at: NOW, reportingMode: mode, browserState: state, browserExpiresAt,
        credentials: { browser: { apiKey: 'PRIVATE_KEY', contextId: 'PRIVATE_CONTEXT', liveViewUrl: 'PRIVATE_URL' } } },
      { platform: 'tiktok', updated_at: BEFORE }, { platform: 'youtube', updated_at: BEFORE }
    ];
    if (url.pathname.endsWith('analytics_snapshots')) rows = [{ source: 'instagram', captured_at: BEFORE }];
    if (url.pathname.endsWith('analytics_sync_runs')) rows = [{ status: runStatus, error_code: code,
      completed_at: completedAt, warningCount: warnings, metadata: { private: 'PRIVATE_METADATA' }, message: 'PRIVATE_MESSAGE' }];
    return Response.json(rows);
  } });
  return { store, calls };
}
const instagram = rows => rows.find(row => row.id === 'instagram');
const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; },
  end(value) { this.body = JSON.parse(value); } });

test('browser mode is connected only after a verified ready state; legacy API grants keep their behavior', async () => {
  for (const state of ['configured', 'connecting', 'ready', 'login-required', 'failed', 'PRIVATE_STATE', null]) {
    const { store } = fixture({ state });
    const result = await store.getStatuses({ now: () => Date.parse(NOW) }), ig = instagram(result);
    assert.equal(ig.mode, 'browser-sweep');
    assert.equal(ig.connected, state === 'ready');
    assert.equal(ig.connectedAt, state === 'ready' ? NOW : null);
    assert.equal(ig.browserState, ['PRIVATE_STATE', null].includes(state) ? null : state);
    assert.ok(result.filter(row => row.id !== 'instagram').every(row => row.mode === 'official-api' && row.connected));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  }
  for (const mode of [null, 'official-api']) {
    const { store } = fixture({ mode, state: 'failed' });
    const ig = instagram(await store.getStatuses());
    assert.equal(ig.connected, true); assert.equal(ig.mode, 'official-api'); assert.equal(ig.browserState, null);
  }
  assert.equal(instagram(await fixture({ mode: 'PRIVATE_MODE' }).store.getStatuses()).connected, false);
});

test('status reads select only scalar metadata and collab-only success advances completion independently of capture', async () => {
  const { store, calls } = fixture();
  const ig = instagram(await store.getPublicSocialRefreshState({ now: () => Date.parse(NOW) }));
  assert.deepEqual(ig, { id: 'instagram', connected: true, mode: 'browser-sweep', browserState: 'ready',
    running: false, capturedAt: BEFORE, lastSyncStatus: 'ready', lastSyncAt: NOW,
    lastSyncErrorCode: 'partial_refresh', warningCount: 2 });
  const connectionSelect = calls.find(call => call.url.pathname.endsWith('analytics_connections')).url.searchParams.get('select');
  assert.equal(connectionSelect, 'platform,updated_at,reportingMode:credentials->>reportingMode,browserState:credentials->browser->>state,browserExpiresAt:credentials->browser->>setupExpiresAt');
  for (const { url } of calls.filter(call => call.url.pathname.endsWith('analytics_sync_runs'))) {
    assert.equal(url.searchParams.get('select'), 'status,error_code,completed_at,warningCount:metadata->warningCount');
  }
  assert.doesNotMatch(JSON.stringify(ig), /PRIVATE_|credentials|contextId|apiKey|liveViewUrl|metadata|message/);
});

test('public browser status expires stale connecting sessions and rejects missing or malformed expiry', async () => {
  for (const browserExpiresAt of [BEFORE, NOW, null, '', 'invalid', '2026-02-30T12:00:00Z', { secret: 'PRIVATE' }]) {
    const { store } = fixture({ state: 'connecting', browserExpiresAt });
    const ig = instagram(await store.getStatuses({ now: () => Date.parse(NOW) }));
    assert.equal(ig.browserState, 'login-required');
    assert.equal(ig.connected, false);
    const polling = instagram(await store.getPublicSocialRefreshState({ now: () => Date.parse(NOW) }));
    assert.equal(polling.browserState, 'login-required');
    assert.equal(polling.connected, false);
    assert.doesNotMatch(JSON.stringify(polling), /browserExpiresAt|setupExpiresAt|PRIVATE/);
  }
  const { store } = fixture({ state: 'connecting', browserExpiresAt: '2026-10-22T12:00:01Z' });
  assert.equal(instagram(await store.getStatuses({ now: () => Date.parse(NOW) })).browserState, 'connecting');
  const ready = fixture({ state: 'ready', browserExpiresAt: BEFORE }).store;
  assert.equal(instagram(await ready.getStatuses()).connected, true, 'Setup expiry does not revoke a verified persistent login');
});

test('public polling rejects arbitrary codes, warning values and future completion timestamps', async () => {
  for (const warnings of [-1, 1.5, '2', { secret: 'PRIVATE' }, Number.MAX_SAFE_INTEGER + 1]) {
    const { store } = fixture({ warnings, code: 'private_secret_disguised_as_code', completedAt: '2026-10-23T12:00:00.000Z' });
    const ig = instagram(await store.getPublicSocialRefreshState({ now: () => Date.parse(NOW) }));
    assert.equal(ig.warningCount, null); assert.equal(ig.lastSyncErrorCode, null); assert.equal(ig.lastSyncAt, null);
  }
  for (const code of ['provider-unavailable', 'quota', 'login-required']) assert.equal(publicSyncErrorCode(code), code);
  assert.equal(publicSyncErrorCode('private_secret'), null);
});

test('sync metadata persists a validated warning count without accepting unrelated browser fields', async () => {
  const { store, calls } = fixture();
  await store.recordSyncResult('instagram', { status: 'ready', completedAt: NOW, warningCount: 0,
    browser: { apiKey: 'PRIVATE_KEY' }, metadata: { contextId: 'PRIVATE_CONTEXT' } });
  const saved = JSON.parse(calls[0].init.body);
  assert.equal(saved.metadata.warningCount, 0);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_|contextId|apiKey|browser/);
  for (const warningCount of [-1, 1.5, '2']) await assert.rejects(
    store.recordSyncResult('instagram', { status: 'ready', warningCount }), error => error.code === 'invalid-input');
  assert.equal(calls.length, 1);
});

test('public Connections exposes browser capability, mode and safe state without granting setup actions', async () => {
  const { store } = fixture({ state: 'login-required', code: 'login-required' });
  const handler = createConnectionStatusHandler({ env: {}, oauthConfig: () => { throw Error(); }, storeFactory: () => store });
  const res = response(); await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.setup.instagramBrowser, true);
  assert.equal(res.body.setup.instagramOAuth, false);
  const ig = instagram(res.body.platforms);
  assert.equal(ig.connected, false); assert.equal(ig.browserState, 'login-required');
  assert.equal(ig.lastSync.errorCode, 'login-required'); assert.equal(ig.lastSync.warningCount, 2);
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_|contextId|apiKey|liveViewUrl|credentials/);
  assert.equal(instagram(publicConnectionStatuses([{ id: 'instagram', mode: 'browser-sweep',
    browserState: 'failed', connected: true }])).connected, false, 'Projection independently checks readiness');
});
