import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  youtubeOAuthConfig, createYouTubeFlow, verifyYouTubeFlow, exchangeYouTubeGrant,
  createYouTubeConnectionHandler, YOUTUBE_SCOPES, YOUTUBE_CHANNEL_ID,
} from '../lib/youtube-oauth.mjs';

const env = {
  APP_ORIGIN: 'https://analytics.example.test', SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test',
  WORKSHOP_ALLOWED_EMAILS: 'team@example.test', NODE_ENV: 'production',
  YOUTUBE_CLIENT_ID: '123-scran.apps.googleusercontent.com', YOUTUBE_CLIENT_SECRET: 'test-client-secret-at-least-16',
};
const config = youtubeOAuthConfig(env);
const user = { id: 'team-user', email: 'team@example.test' };
const now = Date.parse('2026-10-20T12:00:00Z');
const mockJSON = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
function response() {
  return {
    headers: {}, statusCode: 200, body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    end(value = '') { this.body = value; this.ended = true; },
  };
}
function fixtures({ token = {}, channel = YOUTUBE_CHANNEL_ID, storeFails = false } = {}) {
  const requests = [], saves = [];
  return {
    requests, saves,
    fetcher: async (endpoint, options) => {
      requests.push({ endpoint, options });
      if (endpoint === 'https://oauth2.googleapis.com/token') return mockJSON({
        access_token: 'server-access-token', refresh_token: 'server-refresh-token',
        token_type: 'Bearer', scope: YOUTUBE_SCOPES.join(' '), ...token,
      });
      assert.equal(endpoint, 'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true');
      return mockJSON({ items: [{ id: channel }] });
    },
    setConnection: async (...args) => { if (storeFails) throw Error('private database error'); saves.push(args); },
  };
}
function callbackRequest(flow, extra = {}) {
  const query = new URLSearchParams({ action: 'callback', state: flow.state, code: 'one-use-code' });
  return {
    method: 'GET', url: `/api/connections/youtube?${query}`,
    headers: { cookie: `__Host-sp-youtube-state=${encodeURIComponent(flow.state)}; __Host-sp-youtube-pkce=${flow.verifier}` },
    ...extra,
  };
}

test('connection configuration fails closed without server credentials', () => {
  for (const altered of [
    { ...env, YOUTUBE_CLIENT_ID: '' }, { ...env, YOUTUBE_CLIENT_ID: 'https://evil.test' },
    { ...env, YOUTUBE_CLIENT_SECRET: 'tiny' }, { ...env, YOUTUBE_CLIENT_SECRET: 'secret\ninjection' },
  ]) assert.throws(() => youtubeOAuthConfig(altered), { code: 'youtube_not_configured' });
  assert.equal(config.callback, `${env.APP_ORIGIN}/api/connections/youtube?action=callback`);
});

test('authorization requests only read-only reporting scopes with offline PKCE and signed opaque state', () => {
  const flow = createYouTubeFlow(config, user, now);
  const url = new URL(flow.authorize);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), YOUTUBE_SCOPES.join(' '));
  assert.equal(url.searchParams.get('redirect_uri'), config.callback);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(flow.verifier).digest('base64url'));
  assert.ok(!flow.state.includes(user.id));
  assert.ok(!url.href.includes(config.clientSecret));
  assert.equal(verifyYouTubeFlow({ config, user, state: flow.state, cookieState: flow.state, verifier: flow.verifier, now }), true);
});

test('state rejects a different team user, expiry, tampering, missing cookies and verifier', () => {
  const flow = createYouTubeFlow(config, user, now);
  const args = { config, user, state: flow.state, cookieState: flow.state, verifier: flow.verifier, now };
  for (const extra of [
    { user: { id: 'another-team-user' } }, { now: now + 600_000 }, { now: now - 60_000 },
    { state: flow.state + 'x' }, { cookieState: '' }, { verifier: 'short' },
    { state: `A${flow.state.slice(1)}`, cookieState: `A${flow.state.slice(1)}` },
  ]) assert.throws(() => verifyYouTubeFlow({ ...args, ...extra }), { code: 'connection_expired' });
});

test('exchange verifies fixed channel and stores only refresh credential server-side', async () => {
  const mock = fixtures();
  const flow = createYouTubeFlow(config, user, now);
  const result = await exchangeYouTubeGrant({ config, user, code: 'code', verifier: flow.verifier, now, ...mock });
  assert.equal(result.connected, true);
  assert.deepEqual(mock.saves, [['youtube', {
    refreshToken: 'server-refresh-token', connectedAt: new Date(now).toISOString(), connectedBy: user.id,
  }, { accountId: YOUTUBE_CHANNEL_ID, scopes: [...YOUTUBE_SCOPES] }]]);
  assert.ok(!JSON.stringify(result).includes('token'));
  assert.ok(!JSON.stringify(mock.saves).includes('server-access-token'));
  assert.equal(mock.requests[0].options.redirect, 'error');
  assert.equal(new URLSearchParams(mock.requests[0].options.body).get('code_verifier'), flow.verifier);
  assert.equal(mock.requests[1].options.headers.Authorization, 'Bearer server-access-token');
});

test('wrong channel, missing offline grant, missing/read-write scopes never persist credentials', async () => {
  const flow = createYouTubeFlow(config, user, now);
  for (const [changes, code] of [
    [{ channel: 'UCdifferent' }, 'wrong_youtube_channel'],
    [{ token: { refresh_token: undefined } }, 'offline_grant_missing'],
    [{ token: { scope: YOUTUBE_SCOPES[0] } }, 'reporting_scopes_required'],
    [{ token: { scope: `${YOUTUBE_SCOPES.join(' ')} https://www.googleapis.com/auth/youtube.force-ssl` } }, 'reporting_scopes_required'],
  ]) {
    const mock = fixtures(changes);
    await assert.rejects(exchangeYouTubeGrant({ config, user, code: 'code', verifier: flow.verifier, now, ...mock }), { code });
    assert.equal(mock.saves.length, 0);
  }
});

test('HTTP errors and storage failures return safe codes without provider secrets', async () => {
  const flow = createYouTubeFlow(config, user, now);
  const mock = fixtures({ storeFails: true });
  await assert.rejects(exchangeYouTubeGrant({ config, user, code: 'code', verifier: flow.verifier, now, ...mock }), { code: 'connection_save_failed' });
  await assert.rejects(exchangeYouTubeGrant({
    config, user, code: 'code', verifier: flow.verifier, now,
    fetcher: async () => { throw Error('client_secret=private-provider-error'); },
  }), error => error.code === 'google_unavailable' && !error.message.includes('private-provider-error'));
});

test('start enforces origin and team authentication before creating a flow', async () => {
  let authorized = 0, storeCreated = 0;
  const handler = createYouTubeConnectionHandler({
    env, now: () => now, authorize: async () => { authorized++; return user; },
    storeFactory: () => { storeCreated++; return {}; },
  });
  const foreign = response();
  await handler({ method: 'POST', url: '/api/connections/youtube?action=start', headers: { origin: 'https://evil.test' } }, foreign);
  assert.equal(foreign.statusCode, 403);
  assert.equal(authorized, 0);
  assert.equal(storeCreated, 0);
  const good = response();
  await handler({ method: 'POST', url: '/api/connections/youtube?action=start', headers: { origin: config.origin } }, good);
  assert.equal(good.statusCode, 303);
  assert.equal(new URL(good.getHeader('Location')).origin, 'https://accounts.google.com');
  assert.ok(good.getHeader('Set-Cookie').every(value => value.includes('HttpOnly; Secure; SameSite=Lax; Max-Age=600')));
  const missingSession = response();
  const protectedHandler = createYouTubeConnectionHandler({
    env, storeFactory: () => { throw Error('must not reach store'); },
    fetcher: async () => { throw Error('must not reach Google'); },
  });
  await protectedHandler({ method: 'POST', url: '/api/connections/youtube?action=start', headers: { origin: config.origin } }, missingSession);
  assert.equal(missingSession.statusCode, 401);
});

test('callback reauthorizes session, validates state and clears cookies before safe success redirect', async () => {
  const mock = fixtures();
  let authorized = 0;
  const handler = createYouTubeConnectionHandler({
    env, now: () => now, fetcher: mock.fetcher,
    authorize: async () => { authorized++; return user; },
    storeFactory: () => ({ setConnection: mock.setConnection }),
  });
  const flow = createYouTubeFlow(config, user, now);
  const res = response();
  await handler(callbackRequest(flow), res);
  assert.equal(authorized, 1);
  assert.equal(res.getHeader('Location'), '/connections.html?connected=youtube');
  assert.ok(res.getHeader('Set-Cookie').every(value => value.includes('Max-Age=0')));
  assert.equal(res.getHeader('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(mock.saves.length, 1);
  const duplicate = response();
  const duplicateReq = callbackRequest(flow);
  duplicateReq.url += '&state=another-state';
  await handler(duplicateReq, duplicate);
  assert.equal(duplicate.getHeader('Location'), '/connections.html?error=connection_expired');
  assert.equal(mock.saves.length, 1);
});
