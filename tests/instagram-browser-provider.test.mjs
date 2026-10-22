import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramCloudBrowser, CloudBrowserError } from '../lib/instagram-browser-provider.mjs';

const SECRET = 'never-print-provider-key';
function fixture({ session = {}, debug = {}, fail, connectError, closeError } = {}) {
  const calls = [], events = [];
  const page = {
    url: () => 'about:blank',
    setDefaultTimeout: value => events.push(['pageTimeout', value]),
    setDefaultNavigationTimeout: value => events.push(['navigationTimeout', value]),
    goto: async value => events.push(['goto', value])
  };
  const browser = {
    contexts: () => [{ pages: () => [page] }],
    close: async () => { events.push(['close']); if (closeError) throw new Error(SECRET); }
  };
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, path, options, body });
    const failed = fail?.({ path, body });
    if (failed === 'throw') throw new Error(`${SECRET} https://evil.example/?token=secret`);
    if (failed) return new Response(SECRET, { status: failed });
    const result = path === '/v1/contexts' ? { id: 'context-1' } :
      path.endsWith('/debug') ? { debuggerFullscreenUrl: 'https://www.browserbase.com/devtools/inspector.html?token=private', ...debug } :
      body?.status === 'REQUEST_RELEASE' ? { status: 'COMPLETED' } : {
        id: 'session-1', contextId: 'context-1', status: 'RUNNING',
        expiresAt: new Date(Date.now() + 240000).toISOString(),
        connectUrl: `wss://connect.browserbase.com?apiKey=${SECRET}&sessionId=session-1`, ...session
      };
    return Response.json(result);
  };
  const connectImpl = async (url, options) => {
    events.push(['connect', url, options]);
    if (connectError) throw new Error(`${SECRET} ${url}`);
    return browser;
  };
  return { options: { apiKey: SECRET, fetchImpl, connectImpl }, page, calls, events };
}

async function rejectsSafe(promise, code = 'provider-unavailable') {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof CloudBrowserError);
    assert.equal(error.code, code);
    assert.ok(!String(error.stack).includes(SECRET));
    assert.ok(!JSON.stringify(error).includes('token=') && !error.cause);
    return true;
  });
}

test('creates an encrypted persistent-context session with all optional capture/bypass settings disabled', async () => {
  const f = fixture();
  const result = await createInstagramCloudBrowser({ ...f.options, projectId: 'project-1' });
  assert.equal(result.page, f.page);
  assert.equal(result.contextId, 'context-1');
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.liveViewUrl, 'https://www.browserbase.com/devtools/inspector.html?token=private');
  assert.deepEqual(f.calls[0].body, { projectId: 'project-1' });
  assert.deepEqual(f.calls[1].body, {
    projectId: 'project-1', timeout: 240, keepAlive: false, proxies: false,
    browserSettings: { context: { id: 'context-1', persist: true }, solveCaptchas: false,
      recordSession: false, logSession: false, advancedStealth: false, ignoreCertificateErrors: false }
  });
  assert.deepEqual(f.events[0][2], { timeout: 15000 });
  for (const call of f.calls) {
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers['X-BB-API-Key'], SECRET);
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(new URL(call.url).origin, 'https://api.browserbase.com');
  }
  assert.ok(!Object.hasOwn(result, 'connectUrl') && !Object.hasOwn(result, 'apiKey'));
  await Promise.all([result.close(), result.close()]);
  assert.equal(f.calls.filter(call => call.body?.status === 'REQUEST_RELEASE').length, 1);
  assert.equal(f.events.filter(event => event[0] === 'close').length, 1);
});

test('reuses supplied context without creating or replacing it, and infers project from key', async () => {
  const f = fixture();
  const result = await createInstagramCloudBrowser({ ...f.options, contextId: 'context-1' });
  assert.equal(f.calls[0].path, '/v1/sessions');
  assert.ok(!Object.hasOwn(f.calls[0].body, 'projectId'));
  await result.close();
});

test('invalid configuration cannot trigger a provider call', async () => {
  for (const invalid of [{ apiKey: '' }, { apiKey: 'bad\nkey' }, { contextId: '../escape' },
    { projectId: 'bad/project' }, { contextId: 123 }, { projectId: {} },
    { timeoutSeconds: 59 }, { timeoutSeconds: 241 }, { timeoutSeconds: 120.5 }]) {
    const f = fixture();
    await rejectsSafe(createInstagramCloudBrowser({ ...f.options, ...invalid }), 'not-configured');
    assert.equal(f.calls.length, 0);
  }
});

test('provider quota/auth/network errors never expose response bodies or URLs', async () => {
  for (const [status, code] of [[402, 'quota'], [429, 'quota'], [401, 'not-configured'],
    [403, 'not-configured'], [500, 'provider-unavailable'], ['throw', 'provider-unavailable']]) {
    const f = fixture({ fail: () => status });
    await rejectsSafe(createInstagramCloudBrowser(f.options), code);
    assert.equal(f.events.length, 0);
  }
});

test('untrusted connection URLs are rejected before CDP and the created session is released', async () => {
  for (const connectUrl of ['ws://connect.browserbase.com', 'https://browserbase.com.evil.example',
    'https://evilbrowserbase.com', 'wss://secret@connect.browserbase.com',
    'wss://connect.browserbase.com:8443', 'https://127.0.0.1', 'wss://connect.browserbase.com/#secret',
    ' wss://connect.browserbase.com']) {
    const f = fixture({ session: { connectUrl } });
    await rejectsSafe(createInstagramCloudBrowser(f.options));
    assert.equal(f.events.length, 0);
    assert.equal(f.calls.at(-1).body.status, 'REQUEST_RELEASE');
  }
});

test('invalid live URL, context mismatch and unusable expiry fail closed and clean up', async () => {
  for (const args of [{ debug: { debuggerFullscreenUrl: 'https://evil.example/?token=secret' } },
    { debug: { debuggerFullscreenUrl: 'wss://connect.browserbase.com' } },
    { session: { contextId: 'other-context' } }, { session: { status: 'COMPLETED' } },
    { session: { expiresAt: 'invalid' } }, { session: { expiresAt: '2020-01-01T00:00:00Z' } },
    { session: { expiresAt: new Date(Date.now() + 86400000).toISOString() } }]) {
    const f = fixture(args);
    await rejectsSafe(createInstagramCloudBrowser(f.options));
    assert.equal(f.calls.at(-1).body.status, 'REQUEST_RELEASE');
    if (args.debug) assert.equal(f.events.at(-1)[0], 'close');
  }
});

test('CDP failures release sessions without leaking connection secrets', async () => {
  const f = fixture({ connectError: true });
  await rejectsSafe(createInstagramCloudBrowser(f.options));
  assert.equal(f.calls.at(-1).body.status, 'REQUEST_RELEASE');
});

test('release failure still closes CDP and close remains idempotent', async () => {
  const f = fixture({ fail: ({ body }) => body?.status === 'REQUEST_RELEASE' ? 500 : null });
  const result = await createInstagramCloudBrowser(f.options);
  await rejectsSafe(result.close());
  await rejectsSafe(result.close());
  assert.equal(f.events.filter(event => event[0] === 'close').length, 1);
  assert.equal(f.calls.filter(call => call.body?.status === 'REQUEST_RELEASE').length, 1);
});

test('already-terminated provider session is safe to close; CDP errors are sanitized', async () => {
  const f = fixture({ fail: ({ body }) => body?.status === 'REQUEST_RELEASE' ? 404 : null });
  await (await createInstagramCloudBrowser(f.options)).close();
  const broken = fixture({ closeError: true });
  await rejectsSafe((await createInstagramCloudBrowser(broken.options)).close());
});
