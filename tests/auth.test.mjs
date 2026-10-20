import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  authConfig, allowlistedGoogleUser, authorizeRequest, startGoogleLogin,
  finishGoogleLogin, logout, cookies, cookieName, SESSION_COOKIE, STATE_COOKIE, VERIFIER_COOKIE,
} from '../lib/auth.mjs';
import { resolvePrivateFile } from '../lib/private-files.mjs';
import privateHandler from '../api/private.mjs';

const env = {
  APP_ORIGIN: 'https://analytics.example.test',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  WORKSHOP_ALLOWED_EMAILS: 'approved@example.test, Second@example.test',
  NODE_ENV: 'production',
};
const config = authConfig(env);
const user = {
  id: 'user-123', email: 'approved@example.test', email_confirmed_at: '2026-01-01T00:00:00Z',
  identities: [{ provider: 'google', identity_data: { email: 'approved@example.test', email_verified: true } }],
};
function response() {
  return {
    headers: {}, statusCode: 200, body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    end(body) { this.body = body; this.ended = true; },
  };
}
function mockJSON(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}
function req(cookie, extra = {}) {
  return { method: 'GET', url: '/api/workshop-data', headers: { cookie }, ...extra };
}
function cookieHeader(res) {
  return res.getHeader('Set-Cookie').map(value => value.split(';')[0]).join('; ');
}
function startedFlow() {
  const res = response();
  startGoogleLogin({ method: 'POST', headers: { origin: config.origin } }, res, config);
  const authorize = new URL(res.getHeader('Location'));
  const callback = new URL(authorize.searchParams.get('redirect_to'));
  callback.searchParams.set('code', 'single-use-code');
  return { res, authorize, callback, cookie: cookieHeader(res) };
}

test('configuration fails closed for missing values, empty allowlist, privileged keys and production HTTP', () => {
  for (const bad of [
    {}, { ...env, WORKSHOP_ALLOWED_EMAILS: '' },
    { ...env, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_do_not_use' },
    { ...env, APP_ORIGIN: 'http://analytics.example.test' },
    { ...env, APP_ORIGIN: 'http://localhost:8000' },
    { ...env, APP_ORIGIN: 'https://analytics.example.test/extra' },
    { ...env, SUPABASE_URL: 'http://project.supabase.co' },
    { ...env, SUPABASE_URL: 'https://credentials@project.supabase.co' },
  ]) assert.throws(() => authConfig(bad), error => error.status === 503);
  assert.deepEqual([...config.emails], ['approved@example.test', 'second@example.test']);
});

test('authorization needs a confirmed matching Google identity and exact approved email', () => {
  assert.equal(allowlistedGoogleUser(user, config), true);
  for (const altered of [
    { ...user, email: 'unapproved@example.test' },
    { ...user, email: 'approved+alias@example.test' },
    { ...user, is_anonymous: true },
    { ...user, email_confirmed_at: null },
    { ...user, identities: [] },
    { ...user, identities: [{ provider: 'email', identity_data: user.identities[0].identity_data }] },
    { ...user, identities: [{ provider: 'google', identity_data: { email: user.email, email_verified: false } }] },
    { ...user, identities: [{ provider: 'google', identity_data: { email: 'someone-else@example.test', email_verified: true } }] },
    { ...user, identities: [], user_metadata: { email: user.email, provider: 'google', email_verified: true } },
  ]) assert.equal(allowlistedGoogleUser(altered, config), false);
});

test('unauthenticated access returns 401 without requesting private data or contacting Supabase', async () => {
  const res = response();
  let called = false;
  const result = await authorizeRequest(req(''), res, { config, fetcher: () => { called = true; } });
  assert.equal(result, null);
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
  assert.equal(JSON.parse(res.body).error, 'sign_in_required');
  assert.match(res.getHeader('Cache-Control'), /no-store/);
  assert.equal(res.getHeader('Vercel-CDN-Cache-Control'), 'no-store');
});

test('private HTML redirects to sign in and does not disclose a source page', async () => {
  const res = response();
  await authorizeRequest(req(''), res, { config, redirect: true });
  assert.equal(res.statusCode, 303);
  assert.equal(res.getHeader('Location'), '/login.html?error=sign_in_required');
  assert.equal(res.body, undefined);
});

test('every authenticated request verifies the token with Supabase and returns only identity', async () => {
  const res = response();
  const requests = [];
  const result = await authorizeRequest(req(`${SESSION_COOKIE}=token`), res, {
    config,
    fetcher: async (url, options) => { requests.push({ url, options }); return mockJSON(user); },
  });
  assert.deepEqual(result, { id: user.id, email: user.email });
  assert.equal(requests[0].url, `${config.supabase}/auth/v1/user`);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer token');
  assert.equal(requests[0].options.headers.apikey, config.key);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(res.ended, undefined);
});

test('invalid sessions, denied users and unavailable authentication all fail closed', async () => {
  for (const [result, expected] of [
    [mockJSON({}, 401), 401],
    [mockJSON({ ...user, email: 'stranger@example.test' }), 403],
    [mockJSON({}, 500), 503],
    [mockJSON({}, 429), 503],
  ]) {
    const res = response();
    assert.equal(await authorizeRequest(req(`${SESSION_COOKIE}=token`), res, { config, fetcher: async () => result }), null);
    assert.equal(res.statusCode, expected);
  }
  const res = response();
  await authorizeRequest(req(`${SESSION_COOKIE}=token`), res, { config, fetcher: async () => { throw Error('offline'); } });
  assert.equal(res.statusCode, 503);
});

test('Google login accepts only a same-origin POST', () => {
  for (const request of [
    { method: 'GET', headers: { origin: config.origin } },
    { method: 'POST', headers: {} },
    { method: 'POST', headers: { origin: 'https://evil.example.test' } },
    { method: 'POST', headers: { origin: config.origin, 'sec-fetch-site': 'cross-site' } },
  ]) assert.throws(() => startGoogleLogin(request, response(), config), error => [403, 405].includes(error.status));
});

test('Google login uses S256 PKCE, a random callback state and secure host-only cookies', () => {
  const { res, authorize, callback, cookie } = startedFlow();
  const jar = cookies(req(cookie));
  assert.equal(authorize.origin, config.supabase);
  assert.equal(authorize.pathname, '/auth/v1/authorize');
  assert.equal(authorize.searchParams.get('provider'), 'google');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 's256');
  assert.equal(authorize.searchParams.get('code_challenge'), createHash('sha256').update(jar[VERIFIER_COOKIE]).digest('base64url'));
  assert.equal(callback.origin, config.origin);
  assert.equal(callback.searchParams.get('flow_state'), jar[STATE_COOKIE]);
  assert.equal(authorize.href.includes(jar[VERIFIER_COOKIE]), false);
  for (const value of res.getHeader('Set-Cookie')) {
    assert.match(value, /HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
    assert.match(value, /Path=\//);
    assert.doesNotMatch(value, /Domain=/);
  }
  assert.notEqual(startedFlow().cookie, cookie);
});

test('HTTP loopback uses separate development cookies and never bypasses authorization', async () => {
  const development = authConfig({ ...env, NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:5186' });
  const res = response();
  startGoogleLogin({ method: 'POST', headers: { origin: development.origin } }, res, development);
  for (const value of res.getHeader('Set-Cookie')) {
    assert.match(value, /^dev-sp-/);
    assert.match(value, /HttpOnly; SameSite=Lax/);
    assert.doesNotMatch(value, /Secure|__Host-/);
  }
  const denied = response();
  await authorizeRequest(req(''), denied, { config: development });
  assert.equal(denied.statusCode, 401);
  const authorized = response();
  const verified = await authorizeRequest(req(`${cookieName(SESSION_COOKIE, development)}=token`), authorized, {
    config: development, fetcher: async () => mockJSON(user),
  });
  assert.equal(verified.email, user.email);
  assert.throws(() => authConfig({ ...env, NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:5186', VERCEL: '1' }), error => error.status === 503);
  assert.throws(() => authConfig({ ...env, NODE_ENV: 'production', APP_ORIGIN: 'http://localhost:5186' }), error => error.status === 503);
});

test('PKCE callback rejects mismatched state before any code exchange', async () => {
  const flow = startedFlow();
  flow.callback.searchParams.set('flow_state', 'a'.repeat(43));
  const res = response();
  let fetched = false;
  await assert.rejects(() => finishGoogleLogin(
    req(flow.cookie, { url: flow.callback.href }), res, config,
    async () => { fetched = true; },
  ), error => error.code === 'login_expired');
  assert.equal(fetched, false);
  assert.equal(res.getHeader('Set-Cookie').length, 2);
  assert.ok(res.getHeader('Set-Cookie').every(value => value.endsWith('Max-Age=0')));
});

test('valid callback exchanges the code, verifies the user, and keeps only a bounded access cookie', async () => {
  const flow = startedFlow();
  const requests = [];
  const res = response();
  await finishGoogleLogin(req(flow.cookie, { url: flow.callback.href }), res, config, async (url, options) => {
    requests.push({ url, options });
    return url.includes('/token?') ?
      mockJSON({ access_token: 'access-token', refresh_token: 'never-retained', expires_in: 7200 }) : mockJSON(user);
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `${config.supabase}/auth/v1/token?grant_type=pkce`);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    auth_code: 'single-use-code', code_verifier: cookies(req(flow.cookie))[VERIFIER_COOKIE],
  });
  assert.equal(res.statusCode, 303);
  assert.equal(res.getHeader('Location'), '/workshop.html');
  const issued = res.getHeader('Set-Cookie').find(value => value.startsWith(`${SESSION_COOKIE}=`));
  assert.match(issued, /HttpOnly; Secure; SameSite=Lax; Max-Age=3600/);
  assert.doesNotMatch(JSON.stringify(res), /never-retained/);
});

test('callback cannot issue a session to an unapproved or spoofed identity', async () => {
  const flow = startedFlow();
  const res = response();
  await assert.rejects(() => finishGoogleLogin(req(flow.cookie, { url: flow.callback.href }), res, config, async url =>
    url.includes('/token?') ? mockJSON({ access_token: 'token', expires_in: 3600 }) :
      mockJSON({ ...user, identities: [], user_metadata: { provider: 'google', email_verified: true } }),
  ), error => error.code === 'account_not_allowed');
  assert.ok(res.getHeader('Set-Cookie').every(value => !value.startsWith(`${SESSION_COOKIE}=`)));
});

test('duplicate or malformed cookies are rejected', () => {
  assert.equal(cookies(req(`${SESSION_COOKIE}=first; ${SESSION_COOKIE}=second`))[SESSION_COOKIE], '');
  assert.equal(cookies(req(`${SESSION_COOKIE}=%xx`))[SESSION_COOKIE], '');
});

test('logout rejects cross-site requests and clears cookies while revoking only the current session', async () => {
  await assert.rejects(() => logout({ method: 'POST', headers: { origin: 'https://evil.test' } }, response(), config), error => error.status === 403);
  const res = response();
  let revoked;
  await logout(req(`${SESSION_COOKIE}=token`, { method: 'POST', headers: { cookie: `${SESSION_COOKIE}=token`, origin: config.origin } }), res, config,
    async url => { revoked = url; return mockJSON(null, 204); });
  assert.equal(revoked, `${config.supabase}/auth/v1/logout?scope=local`);
  assert.equal(res.getHeader('Location'), '/login.html?signedOut=1');
  assert.ok(res.getHeader('Set-Cookie').every(value => value.endsWith('Max-Age=0')));
});

test('private file lookup admits saved research assets but rejects source code, secrets and traversal', async () => {
  for (const path of ['/data.json', 'title-table.html', '/assets/history-CWBBRExPJ0I-p1.jpg']) {
    assert.ok(await resolvePrivateFile(path), path);
  }
  for (const path of [
    '.env', '.env.example', '/lib/auth.mjs', '/api/auth/session.mjs', 'README.md',
    '../data.json', '/assets/../data.json', '%2e%2e/data.json',
    '/assets%2f..%2fdata.json', '/%252e%252e/data.json',
    '//data.json', '/data.json?anything', 'C:\\Windows\\win.ini',
    '/assets/unregistered-image.png',
  ]) assert.equal(await resolvePrivateFile(path), null, path);
});

test('private handler rejects array query parameters without reading files', async () => {
  const res = response();
  await privateHandler({ method: 'GET', url: '/api/private', query: { path: ['data.json', '.env'] } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, 'not_found');
});
