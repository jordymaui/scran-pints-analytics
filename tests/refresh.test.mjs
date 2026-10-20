import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../refresh.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const connections = { configured: true, setup: { youtubePublic: true }, platforms: [
  { id: 'youtube', connected: true }, { id: 'youtube-shorts', connected: true },
  { id: 'instagram', connected: false }, { id: 'tiktok', connected: false },
] };
const ready = { status: 'ready', warningCount: 0, window: { start: '2020-01-01', end: '2026-10-18' } };

function harness(fetcher, stored = new Map()) {
  const elements = [];
  const element = () => {
    const node = {
      innerHTML: '', textContent: '', hidden: false, open: false, isConnected: true,
      children: [], events: {}, attributes: {}, queries: new Map(), classList: { toggle() {} },
      addEventListener(name, callback) { this.events[name] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector(selector) {
        if (!this.queries.has(selector)) this.queries.set(selector, element());
        return this.queries.get(selector);
      },
      appendChild(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
      showModal() { this.open = true; },
      close() { this.open = false; this.events.close?.(); },
      focus() {},
    };
    elements.push(node);
    return node;
  };
  const body = element();
  const context = vm.createContext({
    fetch: fetcher, URL, Intl, Date,
    sessionStorage: { getItem: key => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    location: { origin: 'https://analytics.example', pathname: '/', search: '', hash: '',
      replace(path) { context.redirect = path; } },
    document: { createElement: element, body, activeElement: body },
    window: { addEventListener() {}, SPSelect: { close() {} } },
  });
  vm.runInContext(source, context);
  const host = element();
  context.host = host;
  context.reloads = 0;
  vm.runInContext(`const control = createReportRefresh({
    getCoverage: () => [{label:'Saved Analytics',start:'2020-01-01',end:'2026-10-17',capturedAt:'2026-10-19T12:00:00Z'}],
    reloadReport: async () => { reloads++; },
  }); control.mount(host);`, context);
  const dialog = body.children[0];
  return { context, host, dialog, stored,
    click: () => host.children[0].events.click(),
    field: selector => dialog.querySelector(selector),
  };
}

test('Refresh waits for each source, skips disconnected accounts, and reloads once after saved results', async () => {
  const calls = [];
  let releaseYouTube;
  const youtubePending = new Promise(resolve => { releaseYouTube = resolve; });
  const ui = harness(async (url, options) => {
    calls.push({ url, method: options?.method });
    if (url === '/api/auth/session') return response({ authenticated: true });
    if (url === '/api/connection-status') return response(connections);
    if (url.endsWith('source=youtube')) return youtubePending;
    return response(ready);
  });
  const running = ui.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.url), ['/api/sync?source=youtube']);
  assert.match(ui.field('.report-refresh-message').textContent, /Collecting YouTube/);
  releaseYouTube(response(ready));
  await running;
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.url),
    ['/api/sync?source=youtube', '/api/sync?source=youtube-shorts']);
  assert.equal(ui.context.reloads, 1);
  assert.equal(ui.field('h2').textContent, 'Connected sources refreshed');
  assert.match(ui.field('.report-refresh-sources').innerHTML, /Not connected/);
  assert.match(ui.field('.report-refresh-coverage').innerHTML, /17 Oct 2026/);
  assert.match(ui.field('.report-refresh-coverage').innerHTML, /Collected 19 Oct/);
});

test('Refresh requires team sign-in without hiding reports or issuing provider requests', async () => {
  const calls = [];
  const ui = harness(async url => { calls.push(url); return response({ error: 'sign_in_required' }, 401); });
  await ui.click();
  assert.deepEqual(calls, ['/api/auth/session']);
  assert.equal(ui.field('h2').textContent, 'Sign in to refresh');
  assert.equal(ui.field('.report-refresh-sign-in').hidden, false);
  assert.equal(ui.context.reloads, 0);
  ui.field('.report-refresh-sign-in').events.click();
  assert.equal(JSON.parse(ui.stored.get('scran-pints-pending-refresh')).path, '/');
});

test('Interrupted YouTube responses do not immediately start another job on the shared Shorts lease', async () => {
  const calls = [];
  const ui = harness(async url => {
    calls.push(url);
    if (url === '/api/auth/session') return response({ authenticated: true });
    if (url === '/api/connection-status') return response(connections);
    throw Error('transport interrupted');
  });
  await ui.click();
  assert.equal(calls.includes('/api/sync?source=youtube-shorts'), false);
  assert.equal(ui.field('h2').textContent, 'Refresh finished with gaps');
  assert.match(ui.field('.report-refresh-sources').innerHTML, /server may still be collecting/);
  assert.match(ui.field('.report-refresh-sources').innerHTML, /Not started/);
  assert.equal(ui.context.reloads, 1);
});

test('Partial collection warnings and retained upload reports never become a full-success claim', async () => {
  const ui = harness(async url => {
    if (url === '/api/auth/session') return response({ authenticated: true });
    if (url === '/api/connection-status') return response(connections);
    if (url.endsWith('source=youtube-shorts')) return response(ready);
    return response({ ...ready, warningCount: 2, coverage: { status: 'complete', includedVideoCount: 7, confirmedLongformCount: 7 },
      uploadCoverage: { inventoryComplete: true, includedUploads: 184, publicUploadsCount: 184,
        reports: { aggregate: { collected: 183, noRows: 0, retained: 1, failed: 0 } } },
      components: { public: { status: 'ready', capturedAt: '2026-10-20T12:00:00Z' },
        analytics: { status: 'ready', capturedAt: '2026-10-20T12:00:00Z' } } });
  });
  await ui.click();
  assert.equal(ui.field('h2').textContent, 'Refresh finished with gaps');
  const details = ui.field('.report-refresh-sources').innerHTML;
  assert.match(details, /2 collection warnings/);
  assert.match(details, /184 of 184 public uploads/);
  assert.match(details, /1 older reports retained/);
  assert.match(details, /Channel Analytics: 1 Jan 2020 – 18 Oct 2026/);
  assert.match(details, /Public counters: collected · capture 20 Oct/);
});

test('Pending refresh continuations reject external, stale and non-app destinations', () => {
  const ui = harness(async () => { throw Error('No request expected'); });
  for (const intent of [
    { path: 'https://outside.example', createdAt: Date.now() },
    { path: '/api/sync?source=youtube', createdAt: Date.now() },
    { path: '/', createdAt: Date.now() - 31 * 60_000 },
  ]) {
    ui.stored.set('scran-pints-pending-refresh', JSON.stringify(intent));
    assert.equal(vm.runInContext('savedIntent()', ui.context), null);
  }
});
