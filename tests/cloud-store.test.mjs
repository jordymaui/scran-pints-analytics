import { publicYouTubeFixture } from './fixtures/public-youtube.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudConfig, createCloudStore, CloudStoreError } from '../lib/cloud-store.mjs';
import { loadPublicReport, readBundledInputs } from '../lib/cloud-report.mjs';
import { createNotebookHandler } from '../api/workshop-notebook.mjs';

const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_TEST_ONLY' };
const owner = '29faf025-988d-447b-9285-a771ef8cb44e';
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200 });
function fakeStore(responses) {
  const calls = [];
  const store = createCloudStore({ env, fetcher: async (url, init) => {
    calls.push({ url, ...init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const next = responses.shift();
    return next instanceof Response ? next : jsonResponse(next);
  } });
  return { store, calls };
}

test('cloud configuration fails closed and never accepts a public key or unsafe origin', () => {
  assert.deepEqual(cloudConfig(env), { url: env.SUPABASE_URL, key: env.SUPABASE_SECRET_KEY });
  for (const bad of [{}, { ...env, SUPABASE_SECRET_KEY: 'sb_publishable_no' },
    { ...env, SUPABASE_URL: 'http://localhost' }, { ...env, SUPABASE_URL: 'https://user:password@example.test' },
    { ...env, SUPABASE_URL: 'https://example.test/?secret=x' }]) {
    assert.throws(() => createCloudStore({ env: bad }), error => error.code === 'not-configured');
  }
});

test('connections stay server-side with scoped rows and no browser authorization forwarded', async () => {
  const { store, calls } = fakeStore([new Response(null, { status: 204 }), [{
    credentials: { refreshToken: 'private-token' }, account_id: 'channel', scopes: ['scope'], updated_at: '2026-10-20T12:00:00Z',
  }]]);
  await store.setConnection('youtube', { refreshToken: 'private-token' }, { accountId: 'channel', scopes: ['scope'] });
  const result = await store.getConnection('youtube');
  assert.equal(result.credentials.refreshToken, 'private-token');
  assert.equal(calls[0].headers.apikey, env.SUPABASE_SECRET_KEY);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].body.platform, 'youtube');
  assert.match(calls[1].url, /platform=eq.youtube&select=credentials/);
  await assert.rejects(store.getConnection('youtube&select=*'), error => error.code === 'invalid-input');
  assert.equal(calls.length, 2);
});

test('storage errors never disclose provider response bodies or credentials', async () => {
  const { store } = fakeStore([new Response('refresh_token=VERY_PRIVATE', { status: 500 })]);
  await assert.rejects(store.getConnection('youtube'), error =>
    error.code === 'unavailable' && !error.message.includes('VERY_PRIVATE'));
});

test('snapshot updates use the atomic database guard and report rejected stale writes', async () => {
  const { store, calls } = fakeStore([true, false]);
  const capturedAt = '2026-10-04T14:11:35.510850+00:00';
  assert.deepEqual(await store.saveSnapshot('youtube', { capturedAt }, { capturedAt }), { saved: true });
  assert.deepEqual(await store.saveSnapshot('youtube', { capturedAt }, { capturedAt }), { saved: false });
  assert.match(calls[0].url, /\/rpc\/analytics_save_snapshot$/);
  assert.equal(calls[0].body.p_captured_at, '2026-10-04T14:11:35.510Z');
  await assert.rejects(store.saveSnapshot('youtube', {}, { capturedAt: '2026-02-31T00:00:00Z' }));
});

test('lease acquisition and release preserve owner identity and bound expiration', async () => {
  const { store, calls } = fakeStore([true, false, true]);
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  assert.equal(await store.acquireSyncLock('youtube', { owner, expiresAt }), true);
  assert.equal(await store.acquireSyncLock('youtube', { owner, expiresAt }), false);
  assert.equal(await store.releaseSyncLock('youtube', owner), true);
  assert.equal(calls[0].body.p_owner, owner);
  await assert.rejects(store.acquireSyncLock('youtube', { owner, expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
});

test('connection statuses expose only safe dates and sync outcomes, including the shared YouTube grant', async () => {
  const time = '2026-10-20T12:00:00.123456+00:00';
  const { store, calls } = fakeStore([
    [{ platform: 'youtube', updated_at: time, credentials: { secret: 'NEVER_RETURN' }, account_id: 'private-account' }],
    [{ source: 'youtube', captured_at: time, payload: { private: true } }],
    [{ status: 'failed', error_code: 'authorization', completed_at: time, message: 'private provider response' }],
    [], [], [],
  ]);
  const result = await store.getStatuses();
  assert.equal(result[0].connected, true);
  assert.equal(result[1].connected, true);
  assert.equal(result[2].connected, false);
  assert.equal(result[0].hasSnapshot, true);
  assert.deepEqual(result[0].lastSync, { status: 'failed', errorCode: 'authorization', completedAt: '2026-10-20T12:00:00.123Z', warningCount: null });
  assert.doesNotMatch(JSON.stringify(result), /NEVER_RETURN|private-account|provider response|credentials|payload/);
  assert.ok(calls.every(call => !call.url.includes('select=*')));
});

test('sync run storage allowlists metadata and rejects arbitrary error text as a public code', async () => {
  const { store, calls } = fakeStore([new Response(null, { status: 204 })]);
  await store.recordSyncResult('youtube', {
    status: 'failed', errorCode: 'network', message: 'Platform unavailable.', completedAt: '2026-10-20T12:00:00Z',
    runId: owner, startedAt: '2026-10-20T11:59:00Z', trigger: 'cron',
    requestedWindow: { start: '2026-09-20', end: '2026-10-17' }, credentials: 'excluded',
  });
  assert.deepEqual(calls[0].body.metadata.requestedWindow, { start: '2026-09-20', end: '2026-10-17' });
  assert.equal(calls[0].body.credentials, undefined);
  await assert.rejects(store.recordSyncResult('youtube', { status: 'failed', errorCode: 'bearer secret value' }));
});

test('notebook updates detect a concurrent edit without overwriting the newer version', async () => {
  const { store, calls } = fakeStore([[], { version: 1, drafts: [], updatedAt: '2026-10-20T12:00:00Z' }, null]);
  assert.deepEqual(await store.getNotebook(), { version: 0, drafts: [], updatedAt: null });
  assert.equal((await store.saveNotebook({ drafts: [], expectedVersion: 0, updatedBy: owner })).version, 1);
  await assert.rejects(store.saveNotebook({ drafts: [], expectedVersion: 0, updatedBy: owner }),
    error => error.code === 'version-conflict');
  assert.equal(calls[2].body.p_expected_version, 0);
});

test('public reports use last-good cloud snapshots without exposing raw archive or credentials', async () => {
  const bundled = await readBundledInputs();
  const saved = structuredClone(bundled.snapshot);
  saved.videos[0].apiAggregate.views += 17;
  saved.publicReport = publicYouTubeFixture();
  saved.privateCredentials = { refreshToken: 'NEVER_PUBLIC' };
  const result = await loadPublicReport({ bundled, storeFactory: () => ({
    loadSnapshot: async source => source === 'youtube' ? { payload: saved } : null,
    getStatuses: async () => [{ id: 'youtube', lastSync: { status: 'failed', errorCode: 'network', completedAt: '2026-10-20T12:00:00Z' } }],
  }) });
  assert.equal(result.storageStatus, 'cloud');
  assert.equal(result.sources[0].snapshotOrigin, 'cloud');
  assert.equal(result.sources[0].metrics.views, saved.publicReport.channel.views);
  assert.equal(result.sources[0].syncStatus, null, 'Combined public/private run status is not a public freshness claim');
  assert.doesNotMatch(JSON.stringify(result), /NEVER_PUBLIC|privateCredentials|refreshToken|thumbnailPath|watchTimeSharePct/);
});

test('unconfigured, unavailable, or malformed cloud data retains truthful bundled coverage', async () => {
  const bundled = await readBundledInputs();
  for (const [factory, status] of [
    [() => { throw new CloudStoreError('not-configured'); }, 'not-configured'],
    [() => ({ loadSnapshot: async () => { throw Error('provider secret'); }, getStatuses: async () => [] }), 'unavailable'],
    [() => ({ loadSnapshot: async source => source === 'youtube' ? { payload: { videos: [{}] } } : null, getStatuses: async () => [] }), 'unavailable'],
  ]) {
    const result = await loadPublicReport({ bundled, storeFactory: factory });
    assert.equal(result.storageStatus, status);
    assert.equal(result.sources[0].snapshotOrigin, 'bundled');
    assert.equal(result.sources[0].capturedAt, bundled.snapshot.capturedAt);
    assert.equal(result.sources[0].dateRange.end, bundled.snapshot.apiThrough);
    assert.doesNotMatch(JSON.stringify(result), /provider secret/);
  }
  const missing = structuredClone(bundled.snapshot);
  delete missing.videos[0].apiAggregate.views;
  const result = await loadPublicReport({ bundled, storeFactory: () => ({
    loadSnapshot: async source => source === 'youtube' ? { payload: missing } : null, getStatuses: async () => [],
  }) });
  assert.equal(result.sources[0].snapshotOrigin, 'bundled', 'Missing views must not become an artificial zero');
});

test('one failed platform read preserves successful fresh snapshots from other platforms', async () => {
  const bundled = await readBundledInputs();
  const saved = structuredClone(bundled.snapshot);
  saved.videos[0].apiAggregate.views += 123;
  saved.publicReport = publicYouTubeFixture();
  const result = await loadPublicReport({ bundled, storeFactory: () => ({
    loadSnapshot: async source => {
      if (source === 'instagram') throw Error('Unavailable source');
      return source === 'youtube' ? { payload: saved } : null;
    },
    getStatuses: async () => [],
  }) });
  assert.equal(result.storageStatus, 'unavailable');
  assert.equal(result.sources[0].snapshotOrigin, 'cloud');
  assert.equal(result.sources[0].metrics.views, saved.publicReport.channel.views);
  assert.equal(result.sources.find(row => row.id === 'instagram').snapshotOrigin, 'bundled');
});

test('verified sponsor evidence survives a fresh Shorts report without individual content metadata', async () => {
  const bundled = await readBundledInputs();
  const short = {
    id: 'youtube-shorts', label: 'YouTube Shorts', accountLabel: 'Scran & Pints',
    status: 'snapshot', capturedAt: '2026-10-04T12:00:00Z',
    dateRange: { start: '2026-10-01', end: '2026-10-01', timezone: 'America/Los_Angeles' },
    scope: 'Owned Shorts daily reporting', provenance: { kind: 'official-api', label: 'YouTube Analytics' },
    metrics: { views: 25, engagedViews: null, watchHours: 0.1, likes: null, comments: null, shares: null, followers: null, subscribersNet: null },
    daily: [{ day: '2026-10-01', views: 25 }],
    content: [{ id: 'aBcDeFgHi12', title: 'Reviewed sponsor Short',
      url: 'https://www.youtube.com/shorts/aBcDeFgHi12', publishedAt: '2026-10-01T10:00:00Z',
      thumbnail: null, views: 25, likes: null, comments: null, shares: null }],
  };
  bundled.social = { schemaVersion: 1, sources: [short] };
  bundled.campaigns = { schemaVersion: 1, campaigns: [{
    id: 'yeet', name: 'YEET', description: 'Confirmed placement evidence.',
    placements: [{ platform: 'youtube-shorts', contentId: 'aBcDeFgHi12', placement: 'Sponsor mention',
      confirmedAt: '2026-10-04T12:00:00Z', evidenceUrl: short.content[0].url }],
  }] };
  const current = { ...short, capturedAt: '2026-10-20T12:00:00Z', content: [] };
  const options = { bundled, storeFactory: () => ({
    loadSnapshot: async source => source === 'youtube-shorts' ? { payload: current } : null,
    getStatuses: async () => [],
  }) };
  const result = await loadPublicReport(options);
  assert.equal(result.storageStatus, 'cloud');
  const source = result.sources.find(row => row.id === 'youtube-shorts');
  assert.equal(source.snapshotOrigin, 'unavailable');
  assert.equal(source.metrics, null);
  assert.deepEqual(source.content, [], 'Do not relabel old per-content counters as current');
  assert.equal(result.campaigns[0].placements[0].evidenceUrl, short.content[0].url);
  bundled.campaigns.campaigns[0].placements[0].evidenceUrl = 'https://youtube.com.evil.example/shorts/aBcDeFgHi12';
  await assert.rejects(loadPublicReport(options), /official platform/);
});

function responseRecorder() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = JSON.parse(body); } };
}
const baseReq = {
  method: 'POST', headers: { origin: 'https://analytics.example.test', 'content-type': 'application/json' },
  body: { drafts: [], expectedVersion: 0 },
};
function notebookHandler(saveNotebook) {
  return createNotebookHandler({
    authorize: async () => ({ id: owner }), getAuthConfig: () => ({ origin: 'https://analytics.example.test' }),
    storeFactory: () => ({ saveNotebook, getNotebook: async () => ({ version: 0, drafts: [], updatedAt: null }) }),
  });
}

test('notebook endpoint requires same-origin JSON and returns useful version conflicts', async () => {
  const handler = notebookHandler(async () => { throw new CloudStoreError('version-conflict'); });
  let response = responseRecorder();
  await handler(baseReq, response);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, 'notebook_version_conflict');
  assert.match(response.headers['Cache-Control'], /no-store/);
  response = responseRecorder();
  await handler({ ...baseReq, headers: { ...baseReq.headers, origin: 'https://other.example' } }, response);
  assert.equal(response.statusCode, 403);
  response = responseRecorder();
  await handler({ ...baseReq, headers: { ...baseReq.headers, 'content-length': '2000001' } }, response);
  assert.equal(response.statusCode, 413);
});

test('notebook endpoint strips unknown experiment fields and assigns the verified editor server-side', async () => {
  let saved;
  const handler = notebookHandler(async input => { saved = input; return { drafts: input.drafts, version: 2, updatedAt: '2026-10-20T12:00:00Z' }; });
  const draft = Object.fromEntries(['id', 'videoId', 'hypothesis', 'change', 'control', 'candidate', 'thumbnail', 'metric', 'decision', 'result', 'updatedAt'].map(key => [key, key]));
  Object.assign(draft, { status: 'draft', privateUnknown: 'ignored' });
  const response = responseRecorder();
  await handler({ ...baseReq, body: { drafts: [draft], expectedVersion: 1 } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(saved.updatedBy, owner);
  assert.equal(saved.drafts[0].privateUnknown, undefined);
});
