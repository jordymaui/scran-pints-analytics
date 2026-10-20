import { createCloudStore } from '../lib/cloud-store.mjs';
import { syncCloudSource } from '../lib/cloud-sync.mjs';
import { sameOriginPost, AuthError, json } from '../lib/auth.mjs';

export const PUBLIC_REFRESH_INTERVAL_MS = 5 * 60_000;

function publicState(state) {
  return { running: state.running === true, capturedAt: state.capturedAt,
    analyticsCapturedAt: state.analyticsCapturedAt, analyticsThrough: state.analyticsThrough,
    lastSync: state.lastSync ? { status: state.lastSync.status, errorCode: state.lastSync.errorCode,
      completedAt: state.lastSync.completedAt } : null };
}

function publicOrigin(env) {
  try {
    const url = new URL(env.APP_ORIGIN);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        url.protocol !== 'https:' && !(local && url.protocol === 'http:' && env.NODE_ENV !== 'production' && !env.VERCEL)) throw Error();
    return url.origin;
  } catch { throw new AuthError(503, 'refresh_not_configured'); }
}

// A fixed reporting action. No caller-selected account, platform, credentials or scope.
export function createPublicRefreshHandler({ env = process.env, fetchImpl = fetch,
  storeFactory = createCloudStore, synchronize = syncCloudSource } = {}) {
  return async function handler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return json(res, 405, { error: 'method_not_allowed' });
    }
    try {
      const url = new URL(req.url, 'https://internal.invalid');
      if (url.search || req.method === 'POST' && req.body != null && req.body !== '' &&
          (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) {
        return json(res, 400, { error: 'unexpected_parameters' });
      }
      if (req.method === 'POST') sameOriginPost(req, { origin: publicOrigin(env) });
      const deadline = AbortSignal.timeout(280_000);
      const boundedFetch = (endpoint, options = {}) => fetchImpl(endpoint, {
        ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      });
      const store = storeFactory({ env, fetcher: boundedFetch });
      if (req.method === 'GET') return json(res, 200, publicState(await store.getPublicYouTubeRefreshState()));

      const result = await synchronize({ source: 'youtube', store, env, fetchImpl: boundedFetch,
        trigger: 'manual', minimumIntervalMs: PUBLIC_REFRESH_INTERVAL_MS });
      const state = publicState(await store.getPublicYouTubeRefreshState());
      const status = result.status === 'recent' ? 'recent' : result.status === 'busy' ? 'busy'
        : result.status === 'ready'
          ? result.components?.public?.status === 'ready' && result.components?.analytics?.status === 'ready'
            ? 'refreshed' : 'partial'
          : 'failed';
      if (result.retryAt) res.setHeader('Retry-After', String(Math.max(1, Math.ceil((Date.parse(result.retryAt) - Date.now()) / 1000))));
      return json(res, status === 'failed' ? 502 : status === 'busy' ? 202 : 200, {
        ...state, status,
        ...(status === 'recent' ? { retryAt: result.retryAt,
          lastSyncStatus: result.lastSyncStatus } : {}),
      });
    } catch (error) {
      if (error instanceof AuthError) return json(res, error.status, { error: error.code });
      return json(res, 503, { status: 'failed', message: 'YouTube could not be refreshed. The previous report remains available.' });
    }
  };
}

export default createPublicRefreshHandler();
