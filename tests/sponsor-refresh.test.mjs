import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../sponsor.js', import.meta.url), 'utf8');
const refreshCode = script.slice(script.indexOf('let report = null'), script.indexOf('function growthContent('));
const setup = fetch => {
  const context = vm.createContext({ fetch, render() {}, document: { querySelector() { return null; } } });
  vm.runInContext(refreshCode, context);
  return context;
};

test('anonymous sponsor refresh reads the public report without login or provider-management requests', async () => {
  const calls = [];
  const context = setup(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ schemaVersion: 1, sources: [{ id: 'youtube-longform' }] }) };
  });
  await context.refreshReport();
  assert.deepEqual(calls.map(call => call.url), ['/api/report']);
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(vm.runInContext('report.sources[0].id', context), 'youtube-longform');
  assert.equal(vm.runInContext('refreshing', context), false);
});

test('failed sponsor refresh preserves the visible report and clears the busy state', async () => {
  const context = setup(async () => ({ ok: false, status: 503 }));
  vm.runInContext('report = { schemaVersion: 1, sources: [{ id: "previous-report" }] }', context);
  await context.refreshReport();
  assert.equal(vm.runInContext('report.sources[0].id', context), 'previous-report');
  assert.equal(vm.runInContext('refreshing', context), false);
  assert.match(vm.runInContext('refreshMessage', context), /previous report is still shown/);
});
