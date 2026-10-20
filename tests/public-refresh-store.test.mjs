import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCloudSource } from '../lib/cloud-sync.mjs';
import { createCloudStore } from '../lib/cloud-store.mjs';

const NOW = '2026-10-20T16:00:00.000Z';
const INTERVAL = 300000;
function syncStore({ last = null, busy = false, failReservation = false } = {}) {
  const calls = [];
  let latest = last;
  return {
    calls,
    acquireSyncLock: async () => { calls.push('acquire'); return !busy; },
    releaseSyncLock: async () => { calls.push('release'); },
    getLastSyncRun: async () => { calls.push('last'); return latest; },
    getConnection: async () => { calls.push('connection'); return null; },
    loadSnapshot: async () => { calls.push('snapshot'); return null; },
    recordSyncResult: async (_source, value) => {
      calls.push({ audit: value });
      if (failReservation && value.errorCode === 'public_refresh_started') throw Error('storage failure');
      latest = { status: value.status, errorCode: value.errorCode, completedAt: value.completedAt };
    },
  };
}
const run = store => syncCloudSource({
  source: 'youtube', store, now: () => NOW, minimumIntervalMs: INTERVAL, env: {},
  seedLoader: async () => ({ videos: [] }),
});

test('recent success or failure checks under lease and does not slide public cooldown', async () => {
  for (const status of ['ready', 'failed']) {
    const completedAt = '2026-10-20T15:59:00.000Z';
    const store = syncStore({ last: { status, errorCode: status === 'failed' ? 'network' : null, completedAt } });
    const result = await run(store);
    assert.equal(result.status, 'recent');
    assert.equal(result.completedAt, completedAt);
    assert.equal(result.lastSyncStatus, status);
    assert.equal(result.retryAt, '2026-10-20T16:04:00.000Z');
    assert.deepEqual(store.calls, ['acquire', 'last', 'release']);
    assert.equal(result.auditRecorded, false);
  }
});

test('busy public requests perform no audit write or provider access', async () => {
  const store = syncStore({ busy: true });
  const result = await run(store);
  assert.equal(result.status, 'busy');
  assert.equal(result.auditRecorded, false);
  assert.deepEqual(store.calls, ['acquire']);
});

test('public attempt is reserved under lease before provider work and final failure remains honest', async () => {
  const store = syncStore({ last: { status: 'ready', errorCode: null, completedAt: '2026-10-20T15:50:00.000Z' } });
  const result = await run(store);
  assert.equal(result.status, 'not-connected');
  assert.deepEqual(store.calls.slice(0, 2), ['acquire', 'last']);
  assert.equal(store.calls[2].audit.status, 'busy');
  assert.equal(store.calls[2].audit.errorCode, 'public_refresh_started');
  assert.equal(store.calls[2].audit.completedAt, NOW);
  assert.equal(store.calls[2].audit.trigger, 'manual');
  assert.equal(store.calls[3], 'connection');
  assert.equal(store.calls.at(-1).audit.status, 'not-connected');
  const repeated = await run(store);
  assert.equal(repeated.status, 'recent');
  assert.equal(repeated.lastSyncStatus, 'not-connected');
});

test('failed reservation prevents collection; ordinary team/cron requests keep existing path', async () => {
  const store = syncStore({ failReservation: true });
  assert.equal((await run(store)).status, 'failed');
  assert.ok(!store.calls.includes('connection'));
  const team = syncStore();
  await syncCloudSource({ source: 'youtube', store: team, now: () => NOW, env: {}, seedLoader: async () => ({ videos: [] }) });
  assert.ok(!team.calls.includes('last'));
  assert.equal(team.calls.filter(value => value.audit).length, 1);
  assert.ok(!team.calls.some(value => value.audit?.errorCode === 'public_refresh_started'));
});

test('completion audit race is covered by the prior reservation after lease release', async () => {
  const store = syncStore();
  let competing;
  const record = store.recordSyncResult;
  store.recordSyncResult = async (source, value) => {
    if (value.status !== 'busy' && !competing) {
      competing = run(store);
      await competing;
    }
    return record(source, value);
  };
  await run(store);
  assert.equal((await competing).status, 'recent');
  assert.equal((await competing).lastSyncStatus, 'busy');
  assert.equal(store.calls.filter(value => value === 'connection').length, 1);
});

const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_TEST_ONLY' };
const snapshotFields = () => ({
  publicSchema: 1, publicChannelId: 'UCAX4l1JUAymaMHVKiRFzK-A', publicCapturedAt: '2026-10-20T15:55:00.000Z',
  analyticsChannelId: 'UCAX4l1JUAymaMHVKiRFzK-A', analyticsCapturedAt: '2026-10-20T15:54:00.000Z',
  analyticsStart: '2026-08-28', analyticsThrough: '2026-10-19', analyticsTimezone: 'America/Los_Angeles',
  analyticsEndBasis: 'channel-daily-same-metrics',
});
function stateStore({ snapshot = snapshotFields(), lock = '2026-10-20T16:02:00.000Z', run = {
  status: 'failed', error_code: 'network', completed_at: '2026-10-20T15:56:00.000Z',
} } = {}) {
  const calls = [];
  const store = createCloudStore({ env, fetcher: async endpoint => {
    const url = new URL(endpoint); calls.push(url);
    const value = url.pathname.endsWith('analytics_sync_locks') ? lock ? [{ expires_at: lock, owner: 'PRIVATE_OWNER' }] : []
      : url.pathname.endsWith('analytics_snapshots') ? snapshot ? [{ ...snapshot, payload: 'PRIVATE_PAYLOAD' }] : []
        : run ? [{ ...run, message: 'PRIVATE_MESSAGE', metadata: { secret: 'PRIVATE_TOKEN' } }] : [];
    return new Response(JSON.stringify(value), { status: 200 });
  } });
  return { store, calls };
}

test('public refresh state selects only scalar scopes and dates, never raw snapshot or identifiers', async () => {
  const { store, calls } = stateStore();
  const result = await store.getPublicYouTubeRefreshState({ now: () => Date.parse(NOW) });
  assert.deepEqual(result, {
    running: true, capturedAt: '2026-10-20T15:55:00.000Z',
    analyticsCapturedAt: '2026-10-20T15:54:00.000Z', analyticsThrough: '2026-10-19',
    lastSync: { status: 'failed', errorCode: 'network', completedAt: '2026-10-20T15:56:00.000Z' },
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|channelId|jobId|credentials|payload|message|metadata/);
  const snapshotSelect = calls.find(url => url.pathname.endsWith('analytics_snapshots')).searchParams.get('select');
  assert.ok(snapshotSelect.includes('publicCapturedAt:payload->publicReport->>capturedAt'));
  assert.ok(snapshotSelect.includes('analyticsChannelId:payload->channelAnalytics->>channelId'));
  assert.ok(!snapshotSelect.split(',').includes('payload'));
  assert.ok(calls.every(url => !url.search.includes('*')));
});

test('public state rejects foreign scope or impossible reporting dates independently', async () => {
  for (const change of [
    value => { value.analyticsChannelId = 'other-channel'; },
    value => { value.analyticsThrough = '2026-02-30'; },
    value => { value.analyticsThrough = '2026-10-21'; },
    value => { value.analyticsTimezone = 'UTC'; },
  ]) {
    const snapshot = snapshotFields(); change(snapshot);
    const { store } = stateStore({ snapshot, lock: '2026-10-20T15:00:00.000Z' });
    const result = await store.getPublicYouTubeRefreshState({ now: () => Date.parse(NOW) });
    assert.equal(result.running, false);
    assert.equal(result.analyticsCapturedAt, null);
    assert.equal(result.analyticsThrough, null);
    assert.equal(result.capturedAt, snapshotFields().publicCapturedAt);
  }
  const { store } = stateStore({ snapshot: { ...snapshotFields(), publicChannelId: 'other-channel' }, lock: null, run: null });
  const result = await store.getPublicYouTubeRefreshState({ now: () => Date.parse(NOW) });
  assert.equal(result.capturedAt, null);
  assert.equal(result.lastSync, null);
  assert.equal(result.analyticsThrough, '2026-10-19');
});

test('last sync lookup rejects malformed run metadata rather than bypassing cooldown', async () => {
  for (const bad of [
    { status: 'ready', error_code: null, completed_at: '2026-02-30T12:00:00Z' },
    { status: 'unknown', error_code: null, completed_at: NOW },
    { status: 'failed', error_code: 'private provider text', completed_at: NOW },
  ]) {
    const { store } = stateStore({ run: bad });
    await assert.rejects(store.getLastSyncRun('youtube'), error => error.code === 'unavailable');
  }
});
