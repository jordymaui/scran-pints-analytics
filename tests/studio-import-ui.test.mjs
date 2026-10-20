import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../connections.js', import.meta.url), 'utf8');
const publish = script.slice(script.indexOf('export async function publishStudioImport('), script.indexOf("$('#studio-import-form').addEventListener"))
  .replace(/^export /gm, '');
const context = vm.createContext({ TextEncoder, studioImportErrors: { payload_too_large: 'Report too large.' } });
vm.runInContext(publish, context);
const capture = script.slice(script.indexOf('export function studioCaptureTimestamp('), script.indexOf('export async function publishStudioImport('))
  .replace(/^export /gm, '');
vm.runInContext(capture, context);

test('Studio publishing sends a reviewed JSON report through the existing authenticated sync route', async () => {
  const calls = [];
  const report = { schemaVersion: 1, accountUsername: 'scranpints', performance: { totals: { views: 91451 } } };
  const result = await context.publishStudioImport(report, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ status: 'imported' }) };
  });
  assert.equal(result.result.status, 'imported');
  assert.equal(calls[0].url, '/api/sync?source=tiktok');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), { operation: 'studio-import', report });
});

test('Studio upload rejects a large prepared payload before making a request', async () => {
  let called = false;
  await assert.rejects(() => context.publishStudioImport({ invalid: 'x'.repeat(2_000_001) }, async () => { called = true; }), /too large/);
  assert.equal(called, false);
});

test('Studio publishing preserves auth and validation status instead of claiming success', async () => {
  for (const status of [401, 409, 400]) {
    const result = await context.publishStudioImport({}, async () => ({ ok: false, status,
      json: async () => ({ error: status === 401 ? 'unauthorized' : 'invalid_studio_report' }) }));
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.notEqual(result.result.status, 'imported');
  }
});

test('an older export retains its real capture date while today’s import time stays separate', () => {
  assert.equal(context.studioCaptureTimestamp('2026-09-15', '16:49:12', '2026-10-20T18:00:00Z'), '2026-09-15T16:49:12.000Z');
  assert.equal(context.studioCaptureTimestamp('2026-10-20', '17:59', '2026-10-20T18:00:00Z'), '2026-10-20T17:59:00.000Z');
  assert.throws(() => context.studioCaptureTimestamp('2026-10-21', '12:00', '2026-10-20T18:00:00Z'), /actual export download/);
});

test('TikTok Studio overview only offers graph metrics with reported daily values', async () => {
  const dashboard = await readFile(new URL('../dashboard.js', import.meta.url), 'utf8');
  const definitions = dashboard.slice(dashboard.indexOf('const metricDefinitions='), dashboard.indexOf('const params ='));
  const ui = vm.createContext({ selected: () => ({ id: 'tiktok', studioSupplement: {} }),
    performance: () => ({ daily: [{ views: 12, watchHours: null, likes: 1, comments: 0, shares: 0, subscribersNet: -1 }] }) });
  vm.runInContext(definitions, ui);
  const metrics = JSON.parse(JSON.stringify(ui.sourceMetricDefinitions()));
  assert.equal(metrics.some(([key]) => key === 'watchHours'), false);
  assert.equal(metrics.find(([key]) => key === 'subscribersNet')[1], 'Net followers');
  assert.deepEqual(metrics.map(([key]) => key), ['views', 'engagement', 'likes', 'comments', 'shares', 'subscribersNet']);
});
