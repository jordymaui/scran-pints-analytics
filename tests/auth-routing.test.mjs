import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import auth from '../api/auth/[action].mjs';
import { AUTH_ACTIONS, createAuthDispatcher } from '../lib/auth-routes.mjs';

const ORIGIN = 'https://analytics.example.test';
const env = {
  APP_ORIGIN: ORIGIN, SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  WORKSHOP_ALLOWED_EMAILS: 'approved@example.test', NODE_ENV: 'test',
};
let saved;
before(() => {
  saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
});
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const response = () => ({ headers: {}, body: '',
  setHeader(name, value) { this.headers[name] = value; },
  getHeader(name) { return this.headers[name]; },
  end(value = '') { this.body = value; },
});

test('consolidated auth dispatch preserves all four paths and the complete callback query', async () => {
  const calls = [];
  const dispatcher = createAuthDispatcher(Object.fromEntries(AUTH_ACTIONS.map(action => [
    action, async (req, res) => { calls.push({ action, req }); res.end(action); },
  ])));
  for (const action of AUTH_ACTIONS) {
    const req = { method: 'GET', url: `/api/auth/${action}?code=one-use&flow_state=state&action=logout`,
      query: { action: 'logout', code: 'one-use' } };
    const res = response();
    await dispatcher(req, res);
    assert.equal(res.body, action);
    assert.equal(calls.at(-1).action, action);
    assert.equal(calls.at(-1).req, req);
  }
});

test('unknown, encoded and traversal auth actions cannot reach any handler', async () => {
  let called = false;
  const dispatcher = createAuthDispatcher(Object.fromEntries(AUTH_ACTIONS.map(action => [
    action, () => { called = true; },
  ])));
  for (const url of ['/api/auth', '/api/auth/[action]?action=login', '/api/auth/unknown',
    '/api/auth/session/../login', '/api/auth/%6cogin', '/api/auth/login/extra',
    '/api/auth/session.mjs', '/api/auth/__proto__', '/api/auth/login\\session']) {
    const res = response();
    await dispatcher({ method: 'POST', url, query: { action: 'login' } }, res);
    assert.equal(res.statusCode, 404, url);
    assert.match(res.headers['Cache-Control'], /no-store/);
  }
  assert.equal(called, false);
});

test('real consolidated handlers preserve method, origin and anonymous session checks', async () => {
  for (const [method, action, headers, expected] of [
    ['GET', 'login', {}, 405], ['GET', 'logout', {}, 405],
    ['POST', 'session', {}, 405], ['GET', 'session', {}, 401],
    ['POST', 'login', { origin: 'https://evil.example' }, 403],
    ['POST', 'logout', { origin: 'https://evil.example' }, 403],
  ]) {
    const res = response();
    await auth({ method, url: `/api/auth/${action}`, headers }, res);
    assert.equal(res.statusCode, expected, `${method} ${action}`);
    assert.match(res.headers['Cache-Control'], /no-store/);
  }
  const callback = response();
  await auth({ method: 'GET', url: '/api/auth/callback?code=unused', headers: {} }, callback);
  assert.equal(callback.statusCode, 303);
  assert.equal(callback.headers.Location, '/login.html?error=login_expired');
});

test('Google login keeps the exact configured callback URL and secure flow cookies', async () => {
  const res = response();
  await auth({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN } }, res);
  assert.equal(res.statusCode, 303);
  const provider = new URL(res.headers.Location);
  const callback = new URL(provider.searchParams.get('redirect_to'));
  assert.equal(callback.origin + callback.pathname, `${ORIGIN}/api/auth/callback`);
  assert.ok(res.headers['Set-Cookie'].every(cookie => cookie.includes('HttpOnly; Secure; SameSite=Lax')));
});

test('deployment stays within the twelve-function Hobby limit and traces auth outside the API directory', async () => {
  const root = new URL('../', import.meta.url);
  const entries = (await readdir(new URL('api/', root), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(?:m?js|ts)$/.test(entry.name));
  assert.equal(entries.length, 12);
  const authEntries = await readdir(new URL('api/auth/', root));
  assert.deepEqual(authEntries, ['[action].mjs']);
  const config = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'));
  assert.equal(config.functions['api/auth/*.mjs'].maxDuration, 30);
  const server = await readFile(new URL('scripts/serve.mjs', root), 'utf8');
  assert.ok(server.includes("import auth from '../api/auth/[action].mjs'"));
  assert.doesNotMatch(server, /api\/auth\/(?:login|callback|logout|session)\.mjs/);
  const { PUBLIC_FILES } = await import('../scripts/build.mjs');
  assert.ok(!PUBLIC_FILES.includes('lib/auth-routes.mjs'));
});
