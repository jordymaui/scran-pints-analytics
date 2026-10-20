import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  authConfig, authorizeRequest, cookieName, cookies, json, privateHeaders,
  redirect, sameOriginPost, setCookie,
} from './auth.mjs';
import { requestPlatformJson } from './collectors.mjs';

export const YOUTUBE_CHANNEL_ID = 'UCAX4l1JUAymaMHVKiRFzK-A';
export const YOUTUBE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
]);
export const YOUTUBE_STATE_COOKIE = '__Host-sp-youtube-state';
export const YOUTUBE_PKCE_COOKIE = '__Host-sp-youtube-pkce';
const FLOW_SECONDS = 600;
const IDENTITY_SCOPES = new Set(['openid', 'email', 'profile', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile']);
const safeString = (value, max = 8192) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\u0000-\u001f\u007f]/.test(value);

export class YouTubeOAuthError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new YouTubeOAuthError(code, status); };

export function youtubeOAuthConfig(env = process.env, auth = authConfig(env)) {
  const clientId = env.YOUTUBE_CLIENT_ID;
  const clientSecret = env.YOUTUBE_CLIENT_SECRET;
  if (!safeString(clientId, 300) || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) || !safeString(clientSecret, 500) || clientSecret.length < 16) {
    fail('youtube_not_configured', 503);
  }
  return { ...auth, clientId, clientSecret, callback: `${auth.origin}/api/connections/youtube?action=callback` };
}

function signed(config, value) {
  return createHmac('sha256', config.clientSecret).update(`scran-youtube-oauth-v1:${value}`).digest('base64url');
}
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.length <= 2048 &&
    a.length === b.length && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function createYouTubeFlow(config, user, now = Date.now()) {
  if (!safeString(user?.id, 200)) fail('session_invalid', 401);
  const verifier = randomBytes(48).toString('base64url');
  const issued = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1, nonce: randomBytes(24).toString('base64url'),
    user: signed(config, `user:${user.id}`), iat: issued, exp: issued + FLOW_SECONDS,
  })).toString('base64url');
  const state = `${payload}.${signed(config, `state:${payload}`)}`;
  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [name, value] of Object.entries({
    client_id: config.clientId, redirect_uri: config.callback, response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '), state, access_type: 'offline',
    prompt: 'consent select_account', include_granted_scopes: 'false',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })) authorize.searchParams.set(name, value);
  return { verifier, state, authorize: authorize.href };
}

export function verifyYouTubeFlow({ config, user, state, cookieState, verifier, now = Date.now() }) {
  if (!equal(state, cookieState) || !/^[A-Za-z0-9_-]{64}$/.test(verifier || '')) fail('connection_expired', 401);
  const parts = state.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !equal(parts[1], signed(config, `state:${parts[0]}`))) fail('connection_expired', 401);
  let data;
  try { data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { fail('connection_expired', 401); }
  const seconds = Math.floor(now / 1000);
  if (data.v !== 1 || !/^[A-Za-z0-9_-]{32}$/.test(data.nonce || '') ||
      !Number.isSafeInteger(data.iat) || !Number.isSafeInteger(data.exp) ||
      data.exp - data.iat !== FLOW_SECONDS || data.iat > seconds + 30 || data.exp <= seconds ||
      !safeString(user?.id, 200) || !equal(data.user, signed(config, `user:${user.id}`))) fail('connection_expired', 401);
  return true;
}

export async function exchangeYouTubeGrant({ config, code, verifier, user, setConnection, fetcher = fetch, now = Date.now() }) {
  if (!safeString(code, 2048) || !/^[A-Za-z0-9_-]{64}$/.test(verifier || '')) fail('connection_expired', 401);
  let token;
  try {
    token = await requestPlatformJson(fetcher, 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: config.clientId, client_secret: config.clientSecret,
        redirect_uri: config.callback, grant_type: 'authorization_code', code_verifier: verifier,
      }).toString(),
    });
  } catch { fail('google_unavailable', 502); }
  if (token.error || !safeString(token.access_token) || !safeString(token.refresh_token) || String(token.token_type).toLowerCase() !== 'bearer') {
    fail('offline_grant_missing', 400);
  }
  const scopes = typeof token.scope === 'string' ? [...new Set(token.scope.trim().split(/\s+/))] : [];
  if (YOUTUBE_SCOPES.some(scope => !scopes.includes(scope)) || scopes.some(scope => !YOUTUBE_SCOPES.includes(scope) && !IDENTITY_SCOPES.has(scope))) {
    fail('reporting_scopes_required', 403);
  }
  let channel;
  try {
    channel = await requestPlatformJson(fetcher, 'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
  } catch { fail('channel_verification_failed', 502); }
  if (channel.error || !Array.isArray(channel.items) || channel.items.length !== 1 || channel.items[0].id !== YOUTUBE_CHANNEL_ID) {
    fail('wrong_youtube_channel', 403);
  }
  const connectedAt = new Date(now).toISOString();
  try {
    await setConnection('youtube', { refreshToken: token.refresh_token, connectedAt, connectedBy: user.id }, {
      accountId: YOUTUBE_CHANNEL_ID, scopes,
    });
  } catch { fail('connection_save_failed', 503); }
  return { connected: true, connectedAt };
}

function clearFlow(res, config) {
  setCookie(res, YOUTUBE_STATE_COOKIE, '', 0, config);
  setCookie(res, YOUTUBE_PKCE_COOKIE, '', 0, config);
}

export function createYouTubeConnectionHandler({
  env = process.env, fetcher = fetch, storeFactory, authorize = authorizeRequest, now = () => Date.now(),
} = {}) {
  return async function youtubeConnection(req, res) {
    privateHeaders(res);
    let config;
    let callback = false;
    try {
      const auth = authConfig(env);
      const url = new URL(req.url, auth.origin);
      if (url.searchParams.getAll('action').length !== 1 || !['start', 'callback'].includes(url.searchParams.get('action'))) {
        json(res, 400, { error: 'invalid_action' }); return;
      }
      callback = url.searchParams.get('action') === 'callback';
      if (callback) {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); json(res, 405, { error: 'method_not_allowed' }); return; }
      } else sameOriginPost(req, auth);
      // Revalidate the team session on both legs; OAuth state is bound to its ID.
      const user = await authorize(req, res, { config: auth, fetcher, redirect: callback });
      if (!user) return;
      config = youtubeOAuthConfig(env, auth);
      const store = storeFactory({ env, fetcher });
      if (!callback) {
        const flow = createYouTubeFlow(config, user, now());
        setCookie(res, YOUTUBE_STATE_COOKIE, flow.state, FLOW_SECONDS, config);
        setCookie(res, YOUTUBE_PKCE_COOKIE, flow.verifier, FLOW_SECONDS, config);
        redirect(res, flow.authorize);
        return;
      }
      const jar = cookies(req);
      clearFlow(res, config);
      if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 ||
          url.searchParams.has('error')) fail(url.searchParams.has('error') ? 'consent_cancelled' : 'connection_expired', 401);
      const verifier = jar[cookieName(YOUTUBE_PKCE_COOKIE, config)];
      verifyYouTubeFlow({ config, user, state: url.searchParams.get('state'), cookieState: jar[cookieName(YOUTUBE_STATE_COOKIE, config)], verifier, now: now() });
      await exchangeYouTubeGrant({ config, code: url.searchParams.get('code'), verifier, user, setConnection: store.setConnection.bind(store), fetcher, now: now() });
      redirect(res, '/connections.html?connected=youtube');
    } catch (error) {
      if (callback && config) clearFlow(res, config);
      const code = error instanceof YouTubeOAuthError ? error.code : error?.code === 'not-configured' ? 'storage_not_configured' :
        ['origin_not_allowed', 'method_not_allowed', 'auth_not_configured'].includes(error?.code) ? error.code : 'connection_unavailable';
      if (code === 'origin_not_allowed' || code === 'method_not_allowed') {
        if (code === 'method_not_allowed') res.setHeader('Allow', 'POST');
        json(res, error.status || 403, { error: code });
      } else redirect(res, `/connections.html?error=${encodeURIComponent(code)}`);
    }
  };
}
