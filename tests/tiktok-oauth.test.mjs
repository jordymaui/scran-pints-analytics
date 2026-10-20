import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tiktokOAuthConfig, createTikTokFlow, verifyTikTokFlow, exchangeTikTokGrant,
  createTikTokConnectionHandler, TIKTOK_SCOPES,
} from '../lib/tiktok-oauth.mjs';

const env = {
  APP_ORIGIN: 'https://analytics.example.test', SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', WORKSHOP_ALLOWED_EMAILS: 'team@example.test',
  NODE_ENV: 'production', TIKTOK_CLIENT_KEY: 'test-client-key',
  TIKTOK_CLIENT_SECRET: 'test-client-secret-at-least-16',
};
const config = tiktokOAuthConfig(env), user = { id: 'verified-team-user', email: 'team@example.test' };
const now = Date.parse('2026-10-20T16:00:00.000Z');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; }, end(value = '') { this.body = value; } };
}
function fixture({ token = {}, profile = {}, saveFails = false } = {}) {
  const requests = [], saves = [];
  return {
    requests, saves,
    fetcher: async (endpoint, options) => {
      requests.push({ endpoint, options });
      assert.equal(options.redirect, 'error');
      if (endpoint.endsWith('/oauth/token/')) return json({
        open_id: 'app-scoped-owner', access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH',
        token_type: 'Bearer', expires_in: 86400, refresh_expires_in: 31536000,
        scope: TIKTOK_SCOPES.join(','), ...token,
      });
      assert.equal(endpoint, 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,username,display_name');
      assert.equal(options.headers.Authorization, 'Bearer PRIVATE_ACCESS');
      return json({ error: { code: 'ok' }, data: { user: {
        open_id: 'app-scoped-owner', username: 'scranpints', display_name: 'Scran & Pints', ...profile,
      } } });
    },
    setConnection: async (...values) => {
      if (saveFails) throw Error('PRIVATE_DATABASE_DETAIL');
      saves.push(values);
    },
  };
}
function callback(flow, extra = {}) {
  const query = new URLSearchParams({ state: flow.state, code: 'code-with-*0!' });
  return { method: 'GET', url: `/api/connections/tiktok?${query}`,
    headers: { cookie: `__Host-sp-tiktok-state=${encodeURIComponent(flow.state)}` }, ...extra };
}

test('TikTok config requires server credentials, HTTPS and a verified expected username', () => {
  assert.equal(config.expectedUsername, 'scranpints');
  assert.equal(config.callback, `${env.APP_ORIGIN}/api/connections/tiktok`);
  assert.equal(new URL(config.callback).search, '');
  for (const change of [
    { TIKTOK_CLIENT_KEY: '' }, { TIKTOK_CLIENT_SECRET: 'short' },
    { TIKTOK_EXPECTED_USERNAME: 'https://evil.test' },
    { APP_ORIGIN: 'http://localhost:5186', NODE_ENV: 'development' },
  ]) assert.throws(() => tiktokOAuthConfig({ ...env, ...change }), { code: 'tiktok_not_configured' });
});

test('authorization is read-only, requests four exact scopes and has session-bound opaque state', () => {
  const flow = createTikTokFlow(config, user, now), url = new URL(flow.authorize);
  assert.equal(url.origin, 'https://www.tiktok.com');
  assert.equal(url.pathname, '/v2/auth/authorize/');
  assert.equal(url.searchParams.get('scope'), TIKTOK_SCOPES.join(','));
  assert.equal(url.searchParams.get('redirect_uri'), config.callback);
  assert.equal(url.searchParams.get('disable_auto_auth'), '1');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.doesNotMatch(url.href, /client_secret|video.publish|video.upload/);
  assert.ok(!flow.state.includes(user.id));
  assert.equal(verifyTikTokFlow({ config, user, state: flow.state, cookieState: flow.state, now }), true);
});

test('state rejects tampering, expiry, wrong team session and missing browser cookie', () => {
  const { state } = createTikTokFlow(config, user, now);
  for (const extra of [
    { state: state + 'x' }, { cookieState: '' }, { user: { id: 'different-team-user' } },
    { now: now + 600000 }, { now: now - 60000 },
    { state: `A${state.slice(1)}`, cookieState: `A${state.slice(1)}` },
  ]) assert.throws(() => verifyTikTokFlow({ config, user, state, cookieState: state, now, ...extra }),
    { code: 'tiktok_connection_expired' });
});

test('grant verifies username/open ID and stores renewable credentials only on the server', async () => {
  const mock = fixture();
  const result = await exchangeTikTokGrant({ config, user, code: 'one-use-code*0!', now, ...mock });
  assert.deepEqual(result, { connected: true, connectedAt: '2026-10-20T16:00:00.000Z' });
  assert.equal(mock.saves.length, 1);
  const [platform, credentials, metadata] = mock.saves[0];
  assert.equal(platform, 'tiktok');
  assert.equal(credentials.accessToken, 'PRIVATE_ACCESS');
  assert.equal(credentials.refreshToken, 'PRIVATE_REFRESH');
  assert.equal(credentials.expiresAt, '2026-10-21T16:00:00.000Z');
  assert.equal(credentials.refreshExpiresAt, '2027-10-20T16:00:00.000Z');
  assert.equal(credentials.connectedBy, user.id);
  assert.equal(metadata.accountId, 'app-scoped-owner');
  assert.deepEqual(metadata.scopes, TIKTOK_SCOPES);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|app-scoped-owner|username|email/);
  const body = new URLSearchParams(mock.requests[0].options.body);
  assert.equal(body.get('redirect_uri'), config.callback);
  assert.equal(body.get('code'), 'one-use-code*0!');
  assert.equal(body.get('client_secret'), config.clientSecret);
});

test('wrong account, missing/extra scopes and malformed tokens never persist credentials', async () => {
  for (const [changes, extra, code] of [
    [{ profile: { username: 'another_brand' } }, {}, 'wrong_tiktok_account'],
    [{ profile: { open_id: 'different-user' } }, {}, 'wrong_tiktok_account'],
    [{}, { existingAccountId: 'prior-owner' }, 'wrong_tiktok_account'],
    [{ token: { scope: 'user.info.basic,video.list' } }, {}, 'tiktok_reporting_scopes_required'],
    [{ token: { scope: `${TIKTOK_SCOPES.join(',')},video.publish` } }, {}, 'tiktok_reporting_scopes_required'],
    [{ token: { refresh_token: undefined } }, {}, 'tiktok_grant_invalid'],
    [{ token: { expires_in: -1 } }, {}, 'tiktok_grant_invalid'],
  ]) {
    const mock = fixture(changes);
    await assert.rejects(exchangeTikTokGrant({ config, user, code: 'code', now, ...mock, ...extra }), { code });
    assert.equal(mock.saves.length, 0);
  }
});

test('provider and storage errors remain static without raw details or tokens', async () => {
  await assert.rejects(exchangeTikTokGrant({ config, user, code: 'code', now,
    fetcher: async () => { throw Error('PRIVATE_PROVIDER_BODY'); } }), error =>
      error.code === 'tiktok_unavailable' && !error.message.includes('PRIVATE_'));
  await assert.rejects(exchangeTikTokGrant({ config, user, code: 'code', now, ...fixture({ saveFails: true }) }),
    { code: 'tiktok_connection_save_failed' });
});

test('start requires same-origin POST and team authorization before setting secure flow cookie', async () => {
  let authorized = 0;
  const handler = createTikTokConnectionHandler({ env, now: () => now,
    authorize: async () => { authorized++; return user; }, storeFactory: () => ({}) });
  const foreign = response();
  await handler({ method: 'POST', url: '/api/connections/tiktok', headers: { origin: 'https://elsewhere.test' } }, foreign);
  assert.equal(foreign.statusCode, 403);
  assert.equal(authorized, 0);
  const good = response();
  await handler({ method: 'POST', url: '/api/connections/tiktok', headers: { origin: env.APP_ORIGIN } }, good);
  assert.equal(good.statusCode, 303);
  assert.equal(new URL(good.headers.location).origin, 'https://www.tiktok.com');
  assert.ok(good.headers['set-cookie'].every(value => value.includes('HttpOnly; Secure; SameSite=Lax; Max-Age=600')));
  const anonymous = response();
  await createTikTokConnectionHandler({ env, storeFactory: () => { throw Error('Must not read storage'); } })(
    { method: 'POST', url: '/api/connections/tiktok', headers: { origin: env.APP_ORIGIN } }, anonymous);
  assert.equal(anonymous.statusCode, 401);
});

test('callback rechecks team session/state, pins prior account, and clears flow cookie', async () => {
  const mock = fixture(), flow = createTikTokFlow(config, user, now);
  let authorized = 0;
  const handler = createTikTokConnectionHandler({ env, now: () => now, fetcher: mock.fetcher,
    authorize: async () => { authorized++; return user; },
    storeFactory: () => ({ getConnection: async () => ({ accountId: 'app-scoped-owner' }), setConnection: mock.setConnection }) });
  const res = response();
  await handler(callback(flow), res);
  assert.equal(authorized, 1);
  assert.equal(res.headers.location, '/connections.html?connected=tiktok');
  assert.ok(res.headers['set-cookie'].every(value => value.includes('Max-Age=0')));
  assert.equal(res.headers['cache-control'], 'private, no-store, max-age=0');
  assert.equal(mock.saves.length, 1);
  const duplicate = response(), req = callback(flow);
  req.url += '&state=second';
  await handler(req, duplicate);
  assert.equal(duplicate.headers.location, '/connections.html?error=tiktok_connection_expired');
  assert.equal(mock.saves.length, 1);
});
