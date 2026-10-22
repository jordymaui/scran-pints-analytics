import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../connections.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../connections.html', import.meta.url), 'utf8');
const browserCode = script.slice(script.indexOf('function browserMessage('), script.indexOf('function message(')).replace(/^export /gm, '');
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

function ui() {
  const nodes = new Map(), timers = new Map(), requests = [], opened = [];
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', hidden: true, disabled: false, textContent: '', innerHTML: '',
      classList: { toggle() {} }, reportValidity: () => true, removeAttribute(name) { delete this[name]; } });
    return nodes.get(selector);
  };
  let publicReads = 0, timerId = 0;
  const context = vm.createContext({ Intl, Date, URL, $: node, formatDate: value => value,
    escapeHTML: value => String(value ?? '').replace(/</g, '&lt;'),
    document: { querySelectorAll: () => [node('#instagram-browser-key'), node('#instagram-browser-project'), node('#instagram-browser-save')] },
    window: { open: (...args) => opened.push(args) },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    loadStatus: async () => { publicReads++; }, setTeamAccess: value => vm.runInContext(`teamAccess=${value === true}`, context),
    fetch: async (url, options) => { requests.push([url, options]); return reply({ configured: true, connected: false, state: 'login-required' }); },
  });
  vm.runInContext('let teamAccess=false, instagramBrowser=null, browserPending=false, browserPollTimer=null, browserPollDeadline=0;', context);
  vm.runInContext(browserCode, context);
  return { context, node, requests, opened, timers, publicReads: () => publicReads };
}

test('browser controls are hidden for public visitors and cannot start or configure without team access', async () => {
  assert.match(html, /class="instagram-browser" data-team-control hidden/);
  assert.match(html, /id="instagram-browser-key" type="password" autocomplete="off"/);
  assert.match(html, /id="instagram-browser-live"[^>]* hidden/);
  const { context, requests, opened } = ui();
  await context.saveInstagramBrowser({ preventDefault() {} });
  await context.startInstagramBrowser();
  await context.loadInstagramBrowser();
  assert.equal(requests.length, 0);
  assert.equal(opened.length, 0);
});

test('configuration sends the key only to the authenticated route and clears the input before the request', async () => {
  const { context, node, requests } = ui();
  vm.runInContext('teamAccess=true;', context);
  node('#instagram-browser-key').value = 'synthetic-test-key';
  node('#instagram-browser-project').value = 'synthetic-project';
  context.fetch = async (url, options) => {
    assert.equal(node('#instagram-browser-key').value, '');
    requests.push([url, options]);
    return reply({ configured: true, connected: false, state: 'login-required' });
  };
  await context.saveInstagramBrowser({ preventDefault() {} });
  assert.equal(requests[0][0], '/api/connections/instagram-browser');
  assert.equal(requests[0][1].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(requests[0][1].body), { action: 'configure', apiKey: 'synthetic-test-key', projectId: 'synthetic-project' });
  assert.equal(node('#instagram-browser-key').value, '');
  assert.doesNotMatch(node('#instagram-browser-details').innerHTML, /synthetic-test-key/);
  assert.doesNotMatch(node('#instagram-browser-message').textContent, /synthetic-test-key/);
});

test('cloud login opens only a validated private provider URL and verifies status before enabling reporting', async () => {
  const { context, node, opened, timers, publicReads } = ui();
  vm.runInContext("teamAccess=true;instagramBrowser={configured:true,state:'login-required'};", context);
  const liveViewUrl = 'https://www.browserbase.com/devtools-internal-embed?sessionId=synthetic';
  context.fetch = async (url, options) => reply(options.method === 'POST'
    ? { state: 'connecting', liveViewUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    : { configured: true, connected: true, state: 'ready', verifiedAt: '2026-01-15T12:00:00Z', lastScanAt: null });
  await context.startInstagramBrowser();
  assert.deepEqual(opened[0], [liveViewUrl, '_blank', 'noopener,noreferrer']);
  assert.equal(node('#instagram-browser-live').href, liveViewUrl);
  assert.equal(publicReads(), 0);
  assert.equal(timers.size, 1);
  await context.loadInstagramBrowser();
  assert.equal(node('#instagram-browser-state').textContent, 'Login verified');
  assert.equal(node('#instagram-browser-live').hidden, true);
  assert.equal(publicReads(), 1);
  assert.equal(timers.size, 0);
  for (const invalid of ['javascript:alert(1)', 'http://browserbase.com/session', 'https://browserbase.com.evil.test/', 'https://user:password@browserbase.com/']) {
    assert.equal(context.instagramBrowserLiveUrl(invalid), null);
  }
});

test('cloud sweep captures remain dated native reports rather than pretending to be API collections', () => {
  const captureCode = script.slice(script.indexOf('function instagramCapturedReport('), script.indexOf('function renderStatus('));
  const context = vm.createContext({}); vm.runInContext(captureCode, context);
  const source = { id: 'instagram', provenance: { kind: 'manual-browser' },
    manualCapture: { method: 'browser-sweep', capturedAt: '2026-01-15T12:00:00Z', windows: [{ periodDays: 90, instagramViews: 100 }] } };
  const report = context.instagramCapturedReport(source);
  assert.equal(report.browserSweep, true);
  assert.equal(report.manualOnly, true);
  assert.equal(report.capture.capturedAt, source.manualCapture.capturedAt);
});
