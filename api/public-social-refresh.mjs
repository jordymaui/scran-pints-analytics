import { createCloudStore, publicSyncErrorCode } from '../lib/cloud-store.mjs';
import { syncCloudSource } from '../lib/cloud-sync.mjs';
import { sameOriginPost, AuthError, json } from '../lib/auth.mjs';
import { PUBLIC_REFRESH_INTERVAL_MS } from './public-refresh.mjs';

const SOURCES = Object.freeze(['instagram', 'tiktok']);
const OUTCOMES = new Set(['refreshed', 'partial', 'recent', 'busy', 'failed', 'not-connected']);
const SYNC_STATUSES = new Set(['ready', 'failed', 'blocked', 'not-connected', 'busy']);
const BROWSER_STATES = new Set(['not-configured', 'configured', 'ready', 'login-required', 'connecting', 'failed']);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const warningCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function publicStates(values) {
  return SOURCES.map(id => {
    const row = values?.find(value => value?.id === id) || {};
    const capturedAt = timestamp(row.capturedAt), lastSyncAt = timestamp(row.lastSyncAt);
    const lastSyncStatus = SYNC_STATUSES.has(row.lastSyncStatus) ? row.lastSyncStatus : null;
    const lastSyncErrorCode = publicSyncErrorCode(row.lastSyncErrorCode), warnings = warningCount(row.warningCount);
    return { id, connected: row.connected === true, running: row.running === true, capturedAt, lastSyncStatus,
      lastSyncAt, lastSyncErrorCode, warningCount: warnings,
      mode: ['browser-sweep', 'official-api'].includes(row.mode) ? row.mode : null,
      browserState: BROWSER_STATES.has(row.browserState) ? row.browserState : null,
      status: !row.connected ? 'not-connected' : row.running ? 'busy' : lastSyncStatus === 'ready' && (capturedAt || lastSyncAt)
        ? lastSyncErrorCode === 'partial_refresh' || warnings > 0 ? 'partial' : 'refreshed' : 'failed' };
  });
}
function appOrigin(env) {
  try {
    const url = new URL(env.APP_ORIGIN);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        url.protocol !== 'https:' && !(local && url.protocol === 'http:' && env.NODE_ENV !== 'production' && !env.VERCEL)) throw Error();
    return url.origin;
  } catch { throw new AuthError(503, 'refresh_not_configured'); }
}

// Only the two configured Scran & Pints accounts. No public selection of an
// account, provider, date range, token or reporting permission is accepted.
export function createPublicSocialRefreshHandler({ env = process.env, fetchImpl = fetch,
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
      if (req.method === 'POST') sameOriginPost(req, { origin: appOrigin(env) });
      const deadline = AbortSignal.timeout(280_000);
      const boundedFetch = (endpoint, options = {}) => fetchImpl(endpoint, {
        ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      });
      const store = storeFactory({ env, fetcher: boundedFetch });
      const before = publicStates(await store.getPublicSocialRefreshState());
      if (req.method === 'GET') return json(res, 200, { sources: before });
      const results = await Promise.all(before.map(async row => {
        if (!row.connected) return { id: row.id, status: 'not-connected' };
        try {
          const result = await synchronize({ source: row.id, store, env, fetchImpl: boundedFetch,
            trigger: 'manual', minimumIntervalMs: PUBLIC_REFRESH_INTERVAL_MS });
          const status = result.status === 'ready' ? result.errorCode === 'partial_refresh' || warningCount(result.warningCount) > 0
            ? 'partial' : 'refreshed' : OUTCOMES.has(result.status) ? result.status : 'failed';
          return { id: row.id, status,
            ...(result.status === 'ready' ? { lastSyncStatus: 'ready', lastSyncErrorCode: publicSyncErrorCode(result.errorCode),
              ...(timestamp(result.completedAt) ? { lastSyncAt: timestamp(result.completedAt) } : {}),
              ...(result.warningCount !== undefined ? { warningCount: warningCount(result.warningCount) } : {}) } : {}),
            ...(status === 'recent' ? { retryAt: timestamp(result.retryAt),
              ...(result.lastSyncStatus !== undefined ? { lastSyncStatus: SYNC_STATUSES.has(result.lastSyncStatus) ? result.lastSyncStatus : null } : {}),
              ...(result.lastSyncErrorCode !== undefined ? { lastSyncErrorCode: publicSyncErrorCode(result.lastSyncErrorCode) } : {}) } : {}) };
        } catch { return { id: row.id, status: 'failed' }; }
      }));
      const after = publicStates(await store.getPublicSocialRefreshState());
      return json(res, 200, { sources: after.map(row => ({ ...row, ...results.find(value => value.id === row.id) })) });
    } catch (error) {
      if (error instanceof AuthError) return json(res, error.status, { error: error.code });
      return json(res, 503, { error: 'refresh_unavailable', message: 'Social reports could not be refreshed. Previous reports remain available.' });
    }
  };
}

export default createPublicSocialRefreshHandler();
