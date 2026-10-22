import test from 'node:test';
import assert from 'node:assert/strict';
import { instagramNativeFixture } from './fixtures/instagram-native.mjs';
import { instagramBrowserStatus, configureInstagramBrowser, startInstagramBrowserLogin, syncInstagramBrowser } from '../lib/instagram-browser-sync.mjs';
import { syncCloudSource } from '../lib/cloud-sync.mjs';
import { CloudBrowserError } from '../lib/instagram-browser-provider.mjs';

const NOW = '2026-02-01T12:00:00.000Z';
function fixture() {
  let connection = { credentials: { reportingMode: 'browser-sweep', browser: { provider: 'browserbase', apiKey: 'private-test-key', contextId: 'context-test', state: 'ready' } }, accountId: null, scopes: [] };
  const capture = instagramNativeFixture();
  let snapshot = { capturedAt: capture.capturedAt, payload: { schemaVersion: 1, id: 'instagram', kind: 'instagram-native-capture', capturedAt: capture.capturedAt, manualCapture: capture } };
  const calls = [];
  return { calls, async getConnection() { return structuredClone(connection); },
    async setConnection(id, credentials, metadata) { connection = { credentials, ...metadata }; calls.push(['connection', connection]); },
    async acquireSyncLock() { calls.push(['acquire']); return true; }, async releaseSyncLock() { calls.push(['release']); },
    async loadSnapshot() { return structuredClone(snapshot); },
    async saveSnapshot(id, payload, metadata) { snapshot = { payload, ...metadata }; calls.push(['snapshot', snapshot]); return { saved: true }; },
    async recordSyncResult(id, result) { calls.push(['run', result]); }
  };
}

test('browser management status contains no key, Context, session or private login link', async () => {
  const store = fixture(), connection = await store.getConnection();
  connection.credentials.browser.liveViewUrl = 'https://www.browserbase.com/private-test';
  const status = instagramBrowserStatus(connection);
  assert.equal(status.connected, true);
  assert.doesNotMatch(JSON.stringify(status), /private-test|context-test|apiKey|liveView/);
  connection.credentials.browser.state = 'connecting'; connection.credentials.browser.setupExpiresAt = NOW;
  assert.equal(instagramBrowserStatus(connection, Date.parse(NOW) + 1).state, 'login-required');
});

test('configure stays unconnected until the owner is verified, under the account lease', async () => {
  const store = fixture();
  assert.equal((await configureInstagramBrowser({ store, apiKey: 'replacement-test-key' })).connected, false);
  const saved = (await store.getConnection()).credentials.browser;
  assert.equal(saved.state, 'configured'); assert.equal(saved.contextId, undefined);
  assert.deepEqual(store.calls.map(x => x[0]), ['acquire', 'connection', 'release']);
  await assert.rejects(configureInstagramBrowser({ store, apiKey: 'bad key' }));
});

test('hosted sign-in verifies the own profile before saving a persistent ready connection', async () => {
  const store = fixture(); let task, closed = false;
  const browser = { contextId: 'context-test', expiresAt: '2026-02-01T12:04:00Z', liveViewUrl: 'https://www.browserbase.com/live-test',
    page: { goto: async () => {}, evaluate: async () => true }, close: async () => { closed = true; } };
  const result = await startInstagramBrowserLogin({ store, background: promise => { task = promise; },
    createBrowser: async () => browser, verifyAccount: async () => {}, now: () => Date.parse(NOW), pause: async () => {} });
  assert.equal(result.state, 'connecting'); await task;
  const saved = (await store.getConnection()).credentials.browser;
  assert.equal(saved.state, 'ready'); assert.equal(saved.liveViewUrl, undefined);
  assert.equal(saved.verifiedAt, NOW); assert.equal(closed, true); assert.equal(store.calls.at(-1)[0], 'release');
});

test('wrong identity or expired login never becomes a ready connection', async () => {
  const store = fixture(); let task;
  await startInstagramBrowserLogin({ store, background: promise => { task = promise; },
    createBrowser: async () => ({ contextId: 'context-test', expiresAt: '2026-02-01T12:04:00Z', liveViewUrl: 'https://www.browserbase.com/live-test',
      page: { goto: async () => {}, evaluate: async () => true }, close: async () => {} }),
    verifyAccount: async () => { throw Error('private-browser-detail'); }, now: () => Date.parse(NOW), pause: async () => {} });
  await task;
  assert.equal((await store.getConnection()).credentials.browser.state, 'login-required');
});

test('normal login redirects can interrupt a DOM check without aborting setup', async () => {
  const store = fixture(); let task, reads = 0, verified = false;
  await startInstagramBrowserLogin({ store, background: promise => { task = promise; },
    createBrowser: async () => ({ contextId: 'context-test', expiresAt: '2026-02-01T12:04:00Z', liveViewUrl: 'https://www.browserbase.com/live-test',
      page: { goto: async () => {}, evaluate: async () => { if (++reads === 1) throw Error('navigation replaced document'); return true; } }, close: async () => {} }),
    verifyAccount: async () => { verified = true; }, now: () => Date.parse(NOW), pause: async () => {} });
  await task;
  assert.equal(verified, true); assert.equal((await store.getConnection()).credentials.browser.state, 'ready');
});

test('setup rereads configuration after acquiring the account lease', async () => {
  const store = fixture(), originalGet = store.getConnection; let reads = 0, usedKey, task;
  store.getConnection = async () => { const value = await originalGet(); if (++reads === 1) value.credentials.browser.apiKey = 'obsolete-key'; return value; };
  await startInstagramBrowserLogin({ store, background: promise => { task = promise; },
    createBrowser: async settings => { usedKey = settings.apiKey; return { contextId: 'context-test', expiresAt: '2026-02-01T12:04:00Z', liveViewUrl: 'https://www.browserbase.com/live-test',
      page: { goto: async () => {}, evaluate: async () => true }, close: async () => {} }; },
    verifyAccount: async () => {}, now: () => Date.parse(NOW), pause: async () => {} });
  await task; assert.equal(usedKey, 'private-test-key');
});

test('collab-only scan saves its results without changing the retained account capture date', async () => {
  const store = fixture(), connection = await store.getConnection();
  let closed = false;
  const result = await syncInstagramBrowser({ store, connection, startedAt: NOW, now: () => NOW,
    createBrowser: async () => ({ page: {}, expiresAt: new Date(Date.now() + 240000).toISOString(), close: async () => { closed = true; } }),
    collect: async ({ previous }) => ({ capture: previous, accountStatus: 'retained', posts: { collected: 1, retained: 1, total: 2 }, errors: ['parse-failed'] }) });
  assert.equal(result.capturedAt, instagramNativeFixture().capturedAt);
  assert.ok(result.warningCount); assert.equal(result.components.collabs.collected, 1); assert.equal(closed, true);
  assert.equal(store.calls.find(x => x[0] === 'snapshot')[1].capturedAt, instagramNativeFixture().capturedAt);
});

test('login challenge keeps reports unchanged and requires owner reconnection', async () => {
  const store = fixture(), connection = await store.getConnection();
  await assert.rejects(syncInstagramBrowser({ store, connection, startedAt: NOW,
    createBrowser: async () => ({ page: {}, expiresAt: new Date(Date.now() + 240000).toISOString(), close: async () => {} }),
    collect: async () => { throw Object.assign(Error('private challenge text'), { code: 'instagram-challenge-required' }); }
  }), error => error.code === 'login-required' && !error.message.includes('private'));
  assert.equal(store.calls.some(x => x[0] === 'snapshot'), false);
  assert.equal((await store.getConnection()).credentials.browser.state, 'login-required');
});

test('cloud sync dispatches browser mode once, audits partial results and always releases lease', async () => {
  const store = fixture();
  const result = await syncCloudSource({ source: 'instagram', store, now: () => NOW,
    browserSynchronize: async () => ({ capturedAt: instagramNativeFixture().capturedAt, warningCount: 1, components: { collabs: { collected: 1 } } }) });
  assert.equal(result.status, 'ready'); assert.equal(result.errorCode, 'partial_refresh');
  assert.equal(store.calls.find(x => x[0] === 'run')[1].warningCount, 1);
  assert.equal(store.calls.some(x => x[0] === 'release'), true);
});

test('provider quota errors are sanitized and leave snapshots untouched', async () => {
  const store = fixture();
  const result = await syncCloudSource({ source: 'instagram', store, now: () => NOW,
    browserSynchronize: async () => { throw new CloudBrowserError('quota'); } });
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'quota');
  assert.equal(store.calls.some(x => x[0] === 'snapshot'), false);
});
