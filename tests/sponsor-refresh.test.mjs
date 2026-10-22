import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../sponsor.js', import.meta.url), 'utf8');
const refreshCode = script.slice(script.indexOf('export async function syncPublicYouTube'), script.indexOf('function growthContent('))
  .replace(/^export /gm, '');
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const report = { schemaVersion: 1, sources: [{ id: 'youtube-longform' }] };
const completed = { status: 'ready', errorCode: null, completedAt: '2026-10-20T15:30:00Z' };
const setup = fetch => {
  const publicFetch = (url, options) => url === '/api/public-social-refresh' ? Promise.resolve(reply({ sources: [
    { id: 'instagram', connected: false, running: false, capturedAt: null, status: 'not-connected' },
    { id: 'tiktok', connected: false, running: false, capturedAt: null, status: 'not-connected' },
  ] })) : fetch(url, options);
  const context = vm.createContext({ fetch: publicFetch, Intl, Date, AbortController, setTimeout, clearTimeout,
    render() {}, document: { querySelector() { return null; } } });
  vm.runInContext(refreshCode, context);
  return context;
};

test('anonymous sponsor refresh starts a real provider sync before reloading the public report', async () => {
  const calls = [];
  const context = setup(async (url, options) => {
    calls.push({ url, options });
    return reply(url === '/api/public-refresh' ? { status: 'refreshed', lastSync: completed } : report);
  });
  await context.refreshReport();
  assert.deepEqual(calls.map(call => [call.url, call.options.method || 'GET']), [
    ['/api/public-refresh', 'POST'], ['/api/report', 'GET'],
  ]);
  assert.ok(calls.every(call => call.options.credentials === 'omit' && call.options.cache === 'no-store'));
  assert.equal(vm.runInContext('report.sources[0].id', context), 'youtube-longform');
  assert.match(vm.runInContext('refreshMessage', context), /YouTube data updated at/);
  assert.equal(vm.runInContext('refreshing', context), false);
});

test('social sync polls busy providers until their own snapshot capture advances', async () => {
  const context = setup(async () => { throw Error('unexpected request'); });
  let reads = 0, clock = Date.parse('2026-10-20T15:20:00Z');
  const calls = [];
  const entries = capturedAt => [
    { id: 'instagram', connected: true, running: false, capturedAt, status: 'refreshed' },
    { id: 'tiktok', connected: false, running: false, capturedAt: null, status: 'not-connected' },
  ];
  const results = await context.syncPublicSocial({
    now: () => clock, wait: async milliseconds => { clock += milliseconds; },
    request: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'POST') return reply({ sources: [{ ...entries('2026-10-20T15:00:00Z')[0], status: 'busy', running: true }, entries(null)[1]] });
      return reply({ sources: entries(++reads === 1 ? '2026-10-20T15:00:00Z' : '2026-10-20T15:25:00Z') });
    },
  });
  assert.equal(results[0].status, 'refreshed');
  assert.equal(results[0].capturedAt, '2026-10-20T15:25:00Z');
  assert.equal(results[1].status, 'not-connected');
  assert.equal(reads, 2);
  assert.ok(calls.every(call => call.url === '/api/public-social-refresh' && call.options.credentials === 'omit'));
});

test('social busy refresh reports failed completion even when saved capture did not advance', async () => {
  const context = setup(async () => { throw Error('unexpected request'); });
  let clock = Date.parse('2026-10-20T15:20:00Z');
  const results = await context.syncPublicSocial({
    now: () => clock, wait: async milliseconds => { clock += milliseconds; },
    request: async (url, options) => reply({ sources: [{ id: 'tiktok', connected: true,
      running: options.method === 'POST', status: options.method === 'POST' ? 'busy' : 'failed',
      lastSyncStatus: 'failed', capturedAt: '2026-10-20T15:00:00Z' }] }),
  });
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].capturedAt, '2026-10-20T15:00:00Z');
});

test('busy sponsor refresh waits for a newer completed run rather than an idle old report', async () => {
  const calls = [];
  const previous = { ...completed, completedAt: '2026-10-20T15:00:00Z' };
  let reads = 0, clock = Date.parse('2026-10-20T15:20:00Z');
  const context = setup(async () => { throw Error('unexpected default request'); });
  const result = await context.syncPublicYouTube({
    now: () => clock, wait: async milliseconds => { clock += milliseconds; },
    request: async (url, options) => {
      calls.push([url, options.method]);
      if (options.method === 'POST') return reply({ status: 'busy', lastSync: previous }, 202);
      reads++;
      if (reads === 1) return reply({ running: true, lastSync: previous });
      if (reads === 2) return reply({ running: false, lastSync: previous });
      return reply({ running: false, lastSync: completed });
    },
  });
  assert.equal(result.status, 'refreshed');
  assert.equal(reads, 3);
  assert.deepEqual(calls.map(call => call[1]), ['POST', 'GET', 'GET', 'POST', 'GET']);
});

test('busy refresh polling is bounded and never claims an unchanged completion as success', async () => {
  let clock = Date.parse('2026-10-20T15:20:00Z'), calls = 0;
  const context = setup(async () => { throw Error('unexpected default request'); });
  await assert.rejects(() => context.syncPublicYouTube({
    timeout: 9_000, now: () => clock, wait: async milliseconds => { clock += milliseconds; },
    request: async (url, options) => {
      calls++;
      return reply(options.method === 'POST' ? { status: 'busy', lastSync: completed }
        : { running: false, lastSync: completed });
    },
  }), /timed out/);
  assert.ok(calls <= 5);
});

test('a completed Shorts lease triggers one channel sync when no YouTube completion advanced', async () => {
  let posts = 0, clock = Date.parse('2026-10-20T15:20:00Z');
  const calls = [], context = setup(async () => { throw Error('unexpected default request'); });
  const result = await context.syncPublicYouTube({
    now: () => clock, wait: async milliseconds => { clock += milliseconds; },
    request: async (url, options) => {
      calls.push(options.method);
      if (options.method === 'GET') return reply({ running: false, lastSync: completed });
      posts++;
      return reply(posts === 1 ? { status: 'busy', lastSync: completed }
        : { status: 'refreshed', lastSync: { ...completed, completedAt: '2026-10-20T15:35:00Z' } });
    },
  });
  assert.equal(result.status, 'refreshed');
  assert.deepEqual(calls, ['POST', 'GET', 'POST']);
});

test('recent failed collection reloads available saved data without claiming freshness', async () => {
  const calls = [];
  const context = setup(async (url, options) => {
    calls.push(url);
    return reply(url === '/api/public-refresh' ? { status: 'recent', lastSyncStatus: 'failed',
      lastSync: { ...completed, status: 'failed' }, retryAt: '2026-10-20T15:35:00Z' } : report);
  });
  await context.refreshReport();
  assert.deepEqual(calls, ['/api/public-refresh', '/api/report']);
  assert.match(vm.runInContext('refreshMessage', context), /last YouTube refresh failed/);
  assert.match(vm.runInContext('refreshMessage', context), /Try again after/);
  assert.doesNotMatch(vm.runInContext('refreshMessage', context), /Latest data|data updated/);
});

test('failed sync and report reload preserve the visible report and growth selection', async () => {
  const context = setup(async url => url === '/api/public-refresh'
    ? reply({ status: 'failed' }, 502) : reply({}, 503));
  vm.runInContext('report = { schemaVersion: 1, sources: [{ id: "previous-report" }] }; growthDays = 14;', context);
  await context.refreshReport();
  assert.equal(vm.runInContext('report.sources[0].id', context), 'previous-report');
  assert.equal(vm.runInContext('growthDays', context), 14);
  assert.equal(vm.runInContext('refreshing', context), false);
  assert.match(vm.runInContext('refreshMessage', context), /previous report is still shown/);
});

test('overlapping clicks share one pending provider request', async () => {
  let release, providerCalls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const context = setup(async url => {
    if (url === '/api/public-refresh') { providerCalls++; return pending; }
    return reply(report);
  });
  const first = context.refreshReport();
  await context.refreshReport();
  assert.equal(providerCalls, 1);
  release(reply({ status: 'partial', lastSync: completed }));
  await first;
  assert.match(vm.runInContext('refreshMessage', context), /Available YouTube data updated/);
  assert.equal(vm.runInContext('refreshing', context), false);
});

const manualReport = () => ({ sources: [{ id: 'instagram', capturedAt: '2026-10-20T12:00:00Z',
  provenance: { kind: 'manual-browser' }, manualCapture: { capturedAt: '2026-10-20T12:00:00Z',
    collaborations: { capturedAt: '2026-10-20T13:00:00Z', posts: [1, 2].map(id => ({
      shortcode: `synthetic_${id}`, relationship: 'collaboration', views: 10, viewsPrecision: 'exact',
      capturedAt: '2026-10-20T12:00:00Z', insights: { views: 12, capturedAt: '2026-10-20T13:00:00Z' },
    })) } } }] });
const instagramResult = (status, extra = {}) => [{ id: 'instagram', status, connected: status !== 'not-connected', ...extra }];

test('disconnected Instagram explicitly retains both dated account and FootyScran captures', () => {
  const context = setup(async () => { throw Error('unexpected fetch'); });
  const before = manualReport(), after = structuredClone(before);
  const message = context.socialRefreshMessages(instagramResult('not-connected'), before, after).join(' ');
  assert.match(message, /Instagram \+ FootyScran/);
  assert.match(message, /20 Oct/);
  assert.match(message, /not refreshed/);
  assert.doesNotMatch(message, /Instagram.*updated|latest/i);
  assert.deepEqual(after, before);
});

test('a fresh official account report cannot make retained collaboration captures look refreshed', () => {
  const context = setup(async () => { throw Error('unexpected fetch'); });
  const before = manualReport(), after = structuredClone(before);
  Object.assign(after.sources[0], { capturedAt: '2026-10-21T14:00:00Z', provenance: { kind: 'official-api' } });
  const message = context.socialRefreshMessages(instagramResult('refreshed'), before, after).join(' ');
  assert.match(message, /Instagram.*updated|Instagram.*refreshed/i);
  assert.match(message, /FootyScran.*not refreshed/i);
  assert.match(message, /20 Oct/);
});

test('one newer collab and campaign-only capture dates cannot imply a fully refreshed FootyScran set', () => {
  const context = setup(async () => { throw Error('unexpected fetch'); });
  const before = manualReport(), after = structuredClone(before);
  const collabs = after.sources[0].manualCapture.collaborations;
  collabs.capturedAt = '2026-10-21T14:00:00Z';
  collabs.posts.push({ shortcode: 'own_post', relationship: 'campaign-post', views: 90000,
    capturedAt: '2026-10-21T14:00:00Z' });
  let message = context.socialRefreshMessages(instagramResult('refreshed'), before, after).join(' ');
  assert.match(message, /not refreshed/);
  collabs.posts[0].insights.capturedAt = '2026-10-21T14:00:00Z';
  message = context.socialRefreshMessages(instagramResult('refreshed'), before, after).join(' ');
  assert.match(message, /1\/2|1 of 2/);
  assert.doesNotMatch(message, /FootyScran.*fully refreshed/i);
});

test('all collab post captures must advance before a fully newer saved set is reported', () => {
  const context = setup(async () => { throw Error('unexpected fetch'); });
  const before = manualReport(), after = structuredClone(before);
  for (const post of after.sources[0].manualCapture.collaborations.posts) post.insights.capturedAt = '2026-10-21T14:00:00Z';
  const message = context.socialRefreshMessages(instagramResult('refreshed'), before, after).join(' ');
  assert.match(message, /FootyScran.*(?:updated|newer).*captures loaded/i);
  assert.doesNotMatch(message, /FootyScran.*not refreshed/i);
});

test('recent or failed API outcomes cannot label unchanged Instagram captures updated', () => {
  const context = setup(async () => { throw Error('unexpected fetch'); });
  const before = manualReport();
  before.sources[0].provenance.kind = 'official-api';
  for (const result of [instagramResult('recent', { lastSyncStatus: 'ready' }), instagramResult('failed')]) {
    const message = context.socialRefreshMessages(result, before, structuredClone(before)).join(' ');
    assert.doesNotMatch(message, /Instagram data updated|FootyScran.*updated/i);
    assert.match(message, /saved|recent|kept|not refreshed/i);
  }
});
