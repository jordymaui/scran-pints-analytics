import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  authConfig, authorizeRequest, cookieName, cookies, json, privateHeaders,
  redirect, sameOriginPost, setCookie,
} from './auth.mjs';
import { requestPlatformJson } from './collectors.mjs';

export const INSTAGRAM_SCOPES = Object.freeze(['instagram_business_basic', 'instagram_business_manage_insights']);
export const INSTAGRAM_STATE_COOKIE = '__Host-sp-instagram-state';
export const INSTAGRAM_EXPECTED_USERNAME = 'scranpints';
const FLOW_SECONDS = 600;
const safeString = (value, max = 8192) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\u0000-\u001f\u007f]/.test(value);
export class InstagramOAuthError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new InstagramOAuthError(code, status); };

export function instagramOAuthConfig(env = process.env, auth = authConfig(env)) {
  const clientId = env.INSTAGRAM_CLIENT_ID;
  const clientSecret = env.INSTAGRAM_CLIENT_SECRET;
  const expectedUsername = (env.INSTAGRAM_EXPECTED_USERNAME || INSTAGRAM_EXPECTED_USERNAME).toLowerCase();
  const apiVersion = env.INSTAGRAM_API_VERSION || 'v24.0';
  if (!/^\d{5,40}$/.test(clientId || '') || !safeString(clientSecret, 500) || clientSecret.length < 16 ||
      !/^[a-z0-9_.]{1,30}$/.test(expectedUsername) || !/^v(?:2[2-9]|[3-9]\d)\.\d$/.test(apiVersion)) {
    fail('instagram_not_configured', 503);
  }
  return { ...auth, clientId, clientSecret, expectedUsername, apiVersion,
    callback: `${auth.origin}/api/connections/instagram` };
}
function signed(config, value) {
  return createHmac('sha256', config.clientSecret).update(`scran-instagram-oauth-v1:${value}`).digest('base64url');
}
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.length <= 2048 &&
    a.length === b.length && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function createInstagramFlow(config, user, now = Date.now()) {
  if (!safeString(user?.id, 200)) fail('session_invalid', 401);
  const issued = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, nonce: randomBytes(24).toString('base64url'),
    user: signed(config, `user:${user.id}`), iat: issued, exp: issued + FLOW_SECONDS })).toString('base64url');
  const state = `${payload}.${signed(config, `state:${payload}`)}`;
  const authorize = new URL('https://www.instagram.com/oauth/authorize');
  authorize.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callback,
    response_type: 'code', scope: INSTAGRAM_SCOPES.join(','), state, enable_fb_login: 'false', force_reauth: 'true' }).toString();
  return { state, authorize: authorize.href };
}
export function verifyInstagramFlow({ config, user, state, cookieState, now = Date.now() }) {
  if (!equal(state, cookieState)) fail('connection_expired', 401);
  const parts = state.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !equal(parts[1], signed(config, `state:${parts[0]}`))) fail('connection_expired', 401);
  let data;
  try { data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { fail('connection_expired', 401); }
  const seconds = Math.floor(now / 1000);
  if (data.v !== 1 || !/^[A-Za-z0-9_-]{32}$/.test(data.nonce || '') || !Number.isSafeInteger(data.iat) ||
      !Number.isSafeInteger(data.exp) || data.exp - data.iat !== FLOW_SECONDS || data.iat > seconds + 30 ||
      data.exp <= seconds || !safeString(user?.id, 200) || !equal(data.user, signed(config, `user:${user.id}`))) fail('connection_expired', 401);
  return true;
}
function single(payload) {
  if (Array.isArray(payload?.data)) return payload.data.length === 1 ? payload.data[0] : null;
  return payload;
}
export async function exchangeInstagramGrant({ config, code, user, setConnection, existingAccountId = null, fetcher = fetch, now = Date.now() }) {
  if (!safeString(code, 2048) || !safeString(user?.id, 200)) fail('connection_expired', 401);
  let token;
  try {
    token = single(await requestPlatformJson(fetcher, 'https://api.instagram.com/oauth/access_token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
        grant_type: 'authorization_code', redirect_uri: config.callback, code }).toString(),
    }));
  } catch { fail('instagram_unavailable', 502); }
  if (!token || token.error || !safeString(token.access_token) || !/^\d{1,40}$/.test(String(token.user_id || ''))) fail('instagram_grant_missing', 400);
  const rawScopes = token.permissions ?? token.scope;
  const scopes = Array.isArray(rawScopes) ? [...new Set(rawScopes)]
    : typeof rawScopes === 'string' ? [...new Set(rawScopes.split(/[,\s]+/).filter(Boolean))] : [];
  if (INSTAGRAM_SCOPES.some(scope => !scopes.includes(scope)) || scopes.some(scope => !INSTAGRAM_SCOPES.includes(scope))) fail('instagram_scopes_required', 403);
  let longLived;
  try {
    const endpoint = new URL('https://graph.instagram.com/access_token');
    endpoint.search = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: config.clientSecret,
      access_token: token.access_token }).toString();
    longLived = await requestPlatformJson(fetcher, endpoint.href);
  } catch { fail('instagram_unavailable', 502); }
  if (longLived.error || !safeString(longLived.access_token) || String(longLived.token_type).toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(longLived.expires_in) || longLived.expires_in < 86400 || longLived.expires_in > 90 * 86400) fail('instagram_grant_missing', 400);
  let profile;
  try {
    const endpoint = new URL(`https://graph.instagram.com/${config.apiVersion}/me`);
    endpoint.searchParams.set('fields', 'user_id,username');
    profile = single(await requestPlatformJson(fetcher, endpoint.href, { headers: { Authorization: `Bearer ${longLived.access_token}` } }));
  } catch { fail('instagram_account_verification_failed', 502); }
  const accountId = String(profile?.user_id || '');
  if (profile?.error || !/^\d{1,40}$/.test(accountId) || typeof profile?.username !== 'string' ||
      profile.username.toLowerCase() !== config.expectedUsername || (existingAccountId && existingAccountId !== accountId)) fail('wrong_instagram_account', 403);
  const connectedAt = new Date(now).toISOString();
  try {
    await setConnection('instagram', { accessToken: longLived.access_token, tokenIssuedAt: connectedAt,
      expiresAt: new Date(now + longLived.expires_in * 1000).toISOString(), accountUsername: profile.username,
      connectedAt, connectedBy: user.id }, { accountId, scopes });
  } catch { fail('connection_save_failed', 503); }
  return { connected: true, connectedAt };
}
function clearFlow(res, config) { setCookie(res, INSTAGRAM_STATE_COOKIE, '', 0, config); }
export function createInstagramConnectionHandler({ env = process.env, fetcher = fetch, storeFactory,
  authorize = authorizeRequest, now = () => Date.now() } = {}) {
  return async function instagramConnection(req, res) {
    privateHeaders(res);
    let config, callback = false;
    try {
      const auth = authConfig(env);
      const url = new URL(req.url, auth.origin);
      if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST'); json(res, 405, { error: 'method_not_allowed' }); return;
      }
      callback = req.method === 'GET';
      if (!callback) sameOriginPost(req, auth);
      const user = await authorize(req, res, { config: auth, fetcher, redirect: callback });
      if (!user) return;
      config = instagramOAuthConfig(env, auth);
      const store = storeFactory({ env, fetcher });
      if (!callback) {
        const flow = createInstagramFlow(config, user, now());
        setCookie(res, INSTAGRAM_STATE_COOKIE, flow.state, FLOW_SECONDS, config);
        redirect(res, flow.authorize); return;
      }
      const jar = cookies(req);
      clearFlow(res, config);
      if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')) {
        fail(url.searchParams.has('error') ? 'consent_cancelled' : 'connection_expired', 401);
      }
      verifyInstagramFlow({ config, user, state: url.searchParams.get('state'), cookieState: jar[cookieName(INSTAGRAM_STATE_COOKIE, config)], now: now() });
      const previous = await store.getConnection('instagram');
      await exchangeInstagramGrant({ config, code: url.searchParams.get('code'), user, existingAccountId: previous?.accountId,
        setConnection: store.setConnection.bind(store), fetcher, now: now() });
      redirect(res, '/connections.html?connected=instagram');
    } catch (error) {
      if (callback && config) clearFlow(res, config);
      const code = error instanceof InstagramOAuthError ? error.code : error?.code === 'not-configured' ? 'storage_not_configured'
        : ['origin_not_allowed', 'method_not_allowed', 'auth_not_configured'].includes(error?.code) ? error.code : 'connection_unavailable';
      if (code === 'origin_not_allowed' || code === 'method_not_allowed') {
        if (code === 'method_not_allowed') res.setHeader('Allow', 'POST');
        json(res, error.status || 403, { error: code });
      } else redirect(res, `/connections.html?error=${encodeURIComponent(code)}`);
    }
  };
}

