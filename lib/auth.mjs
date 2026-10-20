import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = '__Host-sp-session';
export const VERIFIER_COOKIE = '__Host-sp-pkce';
export const STATE_COOKIE = '__Host-sp-state';
const SESSION_SECONDS = 3600;
const FLOW_SECONDS = 600;

export class AuthError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function authConfig(env = process.env) {
  try {
    const origin = new URL(env.APP_ORIGIN);
    const supabase = new URL(env.SUPABASE_URL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw Error();
    if (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:' && env.NODE_ENV !== 'production' && !env.VERCEL)) throw Error();
    if (supabase.protocol !== 'https:' || supabase.username || supabase.password || supabase.search || supabase.hash || supabase.pathname !== '/') throw Error();
    const key = env.SUPABASE_PUBLISHABLE_KEY || '';
    if (!key.startsWith('sb_publishable_')) throw Error();
    const emails = new Set((env.WORKSHOP_ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
    if (!emails.size || [...emails].some(x => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) throw Error();
    return { origin: origin.origin, supabase: supabase.origin, key, emails, secureCookies: origin.protocol === 'https:' };
  } catch {
    throw new AuthError(503, 'auth_not_configured');
  }
}

export function privateHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

export function json(res, status, value) {
  privateHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

export function redirect(res, location) {
  privateHeaders(res);
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.end();
}

export function cookies(req) {
  const result = Object.create(null);
  for (const pair of String(req.headers?.cookie || '').split(';')) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const name = pair.slice(0, at).trim();
    // Reject ambiguous duplicate cookie names rather than choosing a value.
    if (Object.hasOwn(result, name)) {
      result[name] = '';
      continue;
    }
    try { result[name] = decodeURIComponent(pair.slice(at + 1).trim()); } catch { result[name] = ''; }
  }
  return result;
}

export function cookieName(name, config) {
  // HTTP loopback development uses distinct names because __Host- cookies
  // always require Secure. Production/Vercel cannot configure an HTTP origin.
  return config?.secureCookies === false ? name.replace('__Host-', 'dev-') : name;
}

export function setCookie(res, name, value, seconds, config) {
  const old = res.getHeader('Set-Cookie');
  const values = old ? (Array.isArray(old) ? old : [old]) : [];
  const secure = config?.secureCookies === false ? '' : ' Secure;';
  res.setHeader('Set-Cookie', [...values, `${cookieName(name, config)}=${encodeURIComponent(value)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${Math.max(0, Math.floor(seconds))}`]);
}

export function clearFlow(res, config) {
  setCookie(res, VERIFIER_COOKIE, '', 0, config);
  setCookie(res, STATE_COOKIE, '', 0, config);
}

export function sameOriginPost(req, config) {
  if (req.method !== 'POST') throw new AuthError(405, 'method_not_allowed');
  if (req.headers?.origin !== config.origin) throw new AuthError(403, 'origin_not_allowed');
  const site = req.headers?.['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new AuthError(403, 'origin_not_allowed');
}

export function startGoogleLogin(req, res, config = authConfig()) {
  sameOriginPost(req, config);
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const callback = new URL('/api/auth/callback', config.origin);
  callback.searchParams.set('flow_state', state);
  const authorize = new URL('/auth/v1/authorize', config.supabase);
  authorize.searchParams.set('provider', 'google');
  authorize.searchParams.set('redirect_to', callback.href);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 's256');
  authorize.searchParams.set('scopes', 'openid email profile');
  authorize.searchParams.set('prompt', 'select_account');
  setCookie(res, VERIFIER_COOKIE, verifier, FLOW_SECONDS, config);
  setCookie(res, STATE_COOKIE, state, FLOW_SECONDS, config);
  redirect(res, authorize.href);
}

async function authFetch(config, pathname, options = {}, fetcher = globalThis.fetch) {
  let response;
  try {
    response = await fetcher(`${config.supabase}/auth/v1/${pathname}`, {
      ...options,
      headers: { apikey: config.key, 'Content-Type': 'application/json', ...options.headers },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
      cache: 'no-store',
    });
  } catch {
    throw new AuthError(503, 'auth_unavailable');
  }
  if (!response.ok) {
    throw new AuthError(response.status >= 500 || response.status === 429 ? 503 : 401,
      response.status >= 500 || response.status === 429 ? 'auth_unavailable' : 'session_invalid');
  }
  try { return await response.json(); } catch { throw new AuthError(503, 'auth_unavailable'); }
}

export function allowlistedGoogleUser(user, config) {
  const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (!user?.id || user.is_anonymous || !user.email_confirmed_at || !config.emails.has(email)) return false;
  // identity_data is supplied by the verified provider. user_metadata is editable
  // by the user and deliberately never participates in authorization.
  return Array.isArray(user.identities) && user.identities.some(identity =>
    identity.provider === 'google' &&
    identity.identity_data?.email_verified === true &&
    typeof identity.identity_data?.email === 'string' &&
    identity.identity_data.email.trim().toLowerCase() === email
  );
}

export async function verifiedUser(token, config, fetcher = globalThis.fetch) {
  if (!token || token.length > 12000 || /[\s\r\n]/.test(token)) throw new AuthError(401, 'sign_in_required');
  const user = await authFetch(config, 'user', { headers: { Authorization: `Bearer ${token}` } }, fetcher);
  if (!allowlistedGoogleUser(user, config)) throw new AuthError(403, 'account_not_allowed');
  return { id: user.id, email: user.email.toLowerCase() };
}

function equalState(a, b) {
  return typeof a === 'string' && typeof b === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a) &&
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function finishGoogleLogin(req, res, config = authConfig(), fetcher = globalThis.fetch) {
  if (req.method !== 'GET') throw new AuthError(405, 'method_not_allowed');
  const url = new URL(req.url, config.origin);
  const jar = cookies(req);
  clearFlow(res, config);
  const state = jar[cookieName(STATE_COOKIE, config)];
  const verifier = jar[cookieName(VERIFIER_COOKIE, config)];
  const code = url.searchParams.get('code');
  if (!equalState(url.searchParams.get('flow_state'), state) ||
      !/^[A-Za-z0-9_-]{64}$/.test(verifier || '') ||
      !code || code.length > 2048 || url.searchParams.has('error')) {
    throw new AuthError(401, 'login_expired');
  }
  const session = await authFetch(config, 'token?grant_type=pkce', {
    method: 'POST',
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  }, fetcher);
  await verifiedUser(session.access_token, config, fetcher);
  const duration = Math.min(SESSION_SECONDS, Number(session.expires_in));
  if (!Number.isFinite(duration) || duration < 1) throw new AuthError(401, 'session_invalid');
  setCookie(res, SESSION_COOKIE, session.access_token, duration, config);
  redirect(res, '/workshop.html');
}

export async function authorizeRequest(req, res, { redirect: toLogin = false, config, fetcher } = {}) {
  privateHeaders(res);
  try {
    config ||= authConfig();
    return await verifiedUser(cookies(req)[cookieName(SESSION_COOKIE, config)], config, fetcher);
  } catch (error) {
    const failure = error instanceof AuthError ? error : new AuthError(503, 'auth_unavailable');
    if (failure.status === 401 || failure.status === 403) setCookie(res, SESSION_COOKIE, '', 0, config);
    if (toLogin) redirect(res, `/login.html?error=${failure.code}`);
    else json(res, failure.status, { authenticated: false, error: failure.code });
    return null;
  }
}

export function authFailure(res, error, { toLogin = false } = {}) {
  const failure = error instanceof AuthError ? error : new AuthError(503, 'auth_unavailable');
  if (failure.status === 405) res.setHeader('Allow', 'POST');
  if (toLogin) redirect(res, `/login.html?error=${failure.code}`);
  else json(res, failure.status, { error: failure.code });
}

export async function logout(req, res, config = authConfig(), fetcher = globalThis.fetch) {
  sameOriginPost(req, config);
  const token = cookies(req)[cookieName(SESSION_COOKIE, config)];
  setCookie(res, SESSION_COOKIE, '', 0, config);
  clearFlow(res, config);
  if (token && token.length <= 12000 && !/[\s\r\n]/.test(token)) {
    // Also ask Supabase to revoke this session. A network failure still clears
    // this browser's cookie; no refresh token is ever kept by this application.
    try {
      await fetcher(`${config.supabase}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: { apikey: config.key, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch { /* The browser session has already been cleared. */ }
  }
  redirect(res, '/login.html?signedOut=1');
}
