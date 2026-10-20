import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  authConfig, authorizeRequest, cookieName, cookies, json, privateHeaders,
  redirect, sameOriginPost, setCookie,
} from './auth.mjs';
import { requestPlatformJson } from './collectors.mjs';

export const TIKTOK_SCOPES = Object.freeze(['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list']);
export const TIKTOK_EXPECTED_USERNAME = 'scranpints';
export const TIKTOK_STATE_COOKIE = '__Host-sp-tiktok-state';
const FLOW_SECONDS = 600;
const safe = (value, max = 8192) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  !/[\s\u0000-\u001f\u007f]/.test(value);
const username = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.]{1,23}$/.test(value) && !value.endsWith('.');

export class TikTokOAuthError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new TikTokOAuthError(code, status); };

export function tiktokOAuthConfig(env = process.env, auth = authConfig(env)) {
  const clientKey = env.TIKTOK_CLIENT_KEY, clientSecret = env.TIKTOK_CLIENT_SECRET;
  const expectedUsername = (env.TIKTOK_EXPECTED_USERNAME || TIKTOK_EXPECTED_USERNAME).replace(/^@/, '');
  if (!safe(clientKey, 300) || clientKey.length < 8 || !safe(clientSecret, 500) || clientSecret.length < 16 ||
      !username(expectedUsername) || !auth.origin.startsWith('https://')) fail('tiktok_not_configured', 503);
  // TikTok Web requires an exact static HTTPS redirect URI without query parameters.
  return { ...auth, clientKey, clientSecret, expectedUsername: expectedUsername.toLowerCase(),
    callback: `${auth.origin}/api/connections/tiktok` };
}
function signed(config, value) {
  return createHmac('sha256', config.clientSecret).update(`scran-tiktok-oauth-v1:${value}`).digest('base64url');
}
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.length <= 2048 &&
    a.length === b.length && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function createTikTokFlow(config, user, now = Date.now()) {
  if (!safe(user?.id, 200)) fail('session_invalid', 401);
  const issued = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, nonce: randomBytes(24).toString('base64url'),
    user: signed(config, `user:${user.id}`), iat: issued, exp: issued + FLOW_SECONDS })).toString('base64url');
  const state = `${payload}.${signed(config, `state:${payload}`)}`;
  const authorize = new URL('https://www.tiktok.com/v2/auth/authorize/');
  for (const [key, value] of Object.entries({
    client_key: config.clientKey, response_type: 'code', scope: TIKTOK_SCOPES.join(','),
    redirect_uri: config.callback, state, disable_auto_auth: '1',
  })) authorize.searchParams.set(key, value);
  // TikTok's documented confidential web flow uses client_secret and state.
  // code_verifier is documented for mobile/desktop, not this web flow.
  return { state, authorize: authorize.href };
}
export function verifyTikTokFlow({ config, user, state, cookieState, now = Date.now() }) {
  if (!equal(state, cookieState)) fail('tiktok_connection_expired', 401);
  const parts = state.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !equal(parts[1], signed(config, `state:${parts[0]}`))) fail('tiktok_connection_expired', 401);
  let data;
  try { data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { fail('tiktok_connection_expired', 401); }
  const seconds = Math.floor(now / 1000);
  if (data.v !== 1 || !/^[A-Za-z0-9_-]{32}$/.test(data.nonce || '') ||
      !Number.isSafeInteger(data.iat) || !Number.isSafeInteger(data.exp) || data.exp - data.iat !== FLOW_SECONDS ||
      data.iat > seconds + 30 || data.exp <= seconds || !safe(user?.id, 200) ||
      !equal(data.user, signed(config, `user:${user.id}`))) fail('tiktok_connection_expired', 401);
  return true;
}

export async function exchangeTikTokGrant({
  config, code, user, setConnection, existingAccountId = null, fetcher = fetch, now = Date.now(),
}) {
  if (!safe(code, 2048) || !safe(user?.id, 200)) fail('tiktok_connection_expired', 401);
  let token;
  try {
    token = await requestPlatformJson(fetcher, 'https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: config.clientKey, client_secret: config.clientSecret,
        code, grant_type: 'authorization_code', redirect_uri: config.callback }).toString(),
    });
  } catch { fail('tiktok_unavailable', 502); }
  const seconds = value => Number.isSafeInteger(value) && value > 0 && value <= 366 * 86400;
  if (token.error || !safe(token.access_token) || !safe(token.refresh_token) || !safe(token.open_id, 300) ||
      String(token.token_type).toLowerCase() !== 'bearer' || !seconds(token.expires_in) || !seconds(token.refresh_expires_in)) {
    fail('tiktok_grant_invalid', 400);
  }
  const scopes = typeof token.scope === 'string' ? [...new Set(token.scope.split(',').map(value => value.trim()))] : [];
  if (TIKTOK_SCOPES.some(scope => !scopes.includes(scope)) || scopes.some(scope => !TIKTOK_SCOPES.includes(scope))) {
    fail('tiktok_reporting_scopes_required', 403);
  }
  let response;
  try {
    response = await requestPlatformJson(fetcher, 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,username,display_name', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
  } catch { fail('tiktok_account_verification_failed', 502); }
  const profile = response.data?.user;
  if (response.error?.code !== 'ok' || profile?.open_id !== token.open_id ||
      !username(profile?.username) || profile.username.toLowerCase() !== config.expectedUsername ||
      existingAccountId && existingAccountId !== token.open_id) fail('wrong_tiktok_account', 403);
  const connectedAt = new Date(now).toISOString();
  const accountLabel = typeof profile.display_name === 'string'
    ? profile.display_name.replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, 150) || profile.username
    : profile.username;
  try {
    await setConnection('tiktok', {
      accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: new Date(now + token.expires_in * 1000).toISOString(),
      refreshExpiresAt: new Date(now + token.refresh_expires_in * 1000).toISOString(),
      connectedAt, connectedBy: user.id, accountLabel, username: profile.username,
    }, { accountId: token.open_id, scopes });
  } catch { fail('tiktok_connection_save_failed', 503); }
  return { connected: true, connectedAt };
}

export function createTikTokConnectionHandler({
  env = process.env, fetcher = fetch, storeFactory, authorize = authorizeRequest, now = () => Date.now(),
} = {}) {
  return async function tiktokConnection(req, res) {
    privateHeaders(res);
    let config, callback = false;
    try {
      const auth = authConfig(env);
      if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method_not_allowed' });
      }
      callback = req.method === 'GET';
      const url = new URL(req.url, auth.origin);
      if (!callback) {
        sameOriginPost(req, auth);
        if (url.search) return json(res, 400, { error: 'unexpected_parameters' });
      }
      const user = await authorize(req, res, { config: auth, fetcher, redirect: callback });
      if (!user) return;
      config = tiktokOAuthConfig(env, auth);
      const store = storeFactory({ env, fetcher });
      if (!callback) {
        const flow = createTikTokFlow(config, user, now());
        setCookie(res, TIKTOK_STATE_COOKIE, flow.state, FLOW_SECONDS, config);
        return redirect(res, flow.authorize);
      }
      const jar = cookies(req);
      setCookie(res, TIKTOK_STATE_COOKIE, '', 0, config);
      if (url.searchParams.has('error')) fail('tiktok_consent_cancelled', 401);
      if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) {
        fail('tiktok_connection_expired', 401);
      }
      verifyTikTokFlow({ config, user, state: url.searchParams.get('state'),
        cookieState: jar[cookieName(TIKTOK_STATE_COOKIE, config)], now: now() });
      const previous = await store.getConnection('tiktok');
      await exchangeTikTokGrant({ config, code: url.searchParams.get('code'), user,
        existingAccountId: previous?.accountId || null, setConnection: store.setConnection.bind(store), fetcher, now: now() });
      return redirect(res, '/connections.html?connected=tiktok');
    } catch (error) {
      if (callback && config) setCookie(res, TIKTOK_STATE_COOKIE, '', 0, config);
      const code = error instanceof TikTokOAuthError ? error.code : error?.code === 'not-configured' ? 'storage_not_configured'
        : ['origin_not_allowed', 'method_not_allowed', 'auth_not_configured'].includes(error?.code) ? error.code : 'tiktok_connection_unavailable';
      if (code === 'origin_not_allowed' || code === 'method_not_allowed') return json(res, error.status || 403, { error: code });
      return redirect(res, `/connections.html?error=${encodeURIComponent(code)}`);
    }
  };
}
