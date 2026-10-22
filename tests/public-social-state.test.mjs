import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudStore } from '../lib/cloud-store.mjs';

const NOW = '2026-10-20T16:00:00.000Z';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_TEST_ONLY' };
function setup({ locks = [], snapshots = [
  { source: 'instagram', captured_at: '2026-10-20T15:30:00Z' },
  { source: 'tiktok', captured_at: '2026-10-20T15:40:00Z' },
], connections = [{ platform: 'instagram' }, { platform: 'tiktok' }] } = {}) {
  const calls = [];
  const store = createCloudStore({ env, fetcher: async endpoint => {
    const url = new URL(endpoint); calls.push(url);
    let value;
    if (url.pathname.endsWith('analytics_connections')) value = connections;
    else if (url.pathname.endsWith('analytics_snapshots')) value = snapshots;
    else if (url.pathname.endsWith('analytics_sync_locks')) value = locks;
    else if (url.pathname.endsWith('analytics_sync_runs')) {
      value = [{ status: url.searchParams.get('source') === 'eq.instagram' ? 'failed' : 'ready',
        error_code: 'PRIVATE_CODE', completed_at: NOW, metadata: 'PRIVATE_METADATA' }];
    } else throw Error('Unexpected request');
    return new Response(JSON.stringify(value.map(row => ({ ...row,
      credentials: 'PRIVATE_TOKEN', account_id: 'PRIVATE_ACCOUNT', payload: 'PRIVATE_PAYLOAD' }))));
  } });
  return { store, calls };
}

test('social state returns independent leases, dated capture and status without selecting private fields', async () => {
  const { store, calls } = setup({ locks: [
    { source: 'instagram', expires_at: '2026-10-20T16:03:00Z', owner: 'PRIVATE_OWNER' },
    { source: 'tiktok', expires_at: '2026-10-20T15:59:00Z', owner: 'PRIVATE_OWNER' },
  ] });
  const result = await store.getPublicSocialRefreshState({ now: () => Date.parse(NOW) });
  assert.deepEqual(result, [
    { id: 'instagram', connected: true, mode: 'official-api', browserState: null, running: true,
      capturedAt: '2026-10-20T15:30:00.000Z', lastSyncStatus: 'failed', lastSyncAt: NOW, lastSyncErrorCode: null, warningCount: null },
    { id: 'tiktok', connected: true, mode: 'official-api', browserState: null, running: false,
      capturedAt: '2026-10-20T15:40:00.000Z', lastSyncStatus: 'ready', lastSyncAt: NOW, lastSyncErrorCode: null, warningCount: null },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|account|credentials|payload|owner|metadata/);
  for (const url of calls) {
    for (const column of url.searchParams.get('select').split(',')) {
      if (['reportingMode:credentials->>reportingMode', 'browserState:credentials->browser->>state',
        'warningCount:metadata->warningCount'].includes(column)) continue;
      assert.doesNotMatch(column, /\*|credentials|account_id|payload|owner|metadata|message/);
    }
  }
  const query = calls.find(url => url.pathname.endsWith('analytics_sync_locks'));
  assert.equal(query.searchParams.get('source'), 'in.(instagram,tiktok)');
});

test('social state keeps absent accounts disconnected and rejects impossible or future capture dates', async () => {
  const { store } = setup({ connections: [], snapshots: [
    { source: 'instagram', captured_at: '2026-02-30T15:30:00Z' },
    { source: 'tiktok', captured_at: '2026-10-21T15:40:00Z' },
  ] });
  const result = await store.getPublicSocialRefreshState({ now: () => Date.parse(NOW) });
  assert.ok(result.every(row => !row.connected && !row.running && row.capturedAt === null));
});

test('a malformed lease fails closed instead of reporting an idle provider', async () => {
  const { store } = setup({ locks: [{ source: 'instagram', expires_at: 'not-a-date' }] });
  await assert.rejects(store.getPublicSocialRefreshState({ now: () => Date.parse(NOW) }),
    error => error.code === 'unavailable');
});
