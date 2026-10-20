import { createHash, timingSafeEqual } from 'node:crypto';
import { authorizeRequest, authConfig, sameOriginPost, AuthError, json, privateHeaders } from '../lib/auth.mjs';
import { createCloudStore } from '../lib/cloud-store.mjs';
import { CLOUD_SOURCES, syncCloudSource } from '../lib/cloud-sync.mjs';

export function validCronAuthorization(header, secret) {
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 512 ||
      typeof header !== 'string' || header.length > 1024) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export function requestedSource(requestUrl) {
  let url;
  try { url = new URL(requestUrl, 'https://internal.invalid'); } catch {
    throw new AuthError(400, 'invalid_source');
  }
  if (url.searchParams.getAll('source').length !== 1 ||
      [...url.searchParams.keys()].some(key => key !== 'source') ||
      !CLOUD_SOURCES.includes(url.searchParams.get('source'))) {
    throw new AuthError(400, 'invalid_source');
  }
  return url.searchParams.get('source');
}

export function createSyncHandler({
  env = process.env, fetchImpl = fetch, storeFactory = createCloudStore,
  synchronize = syncCloudSource, authorize = authorizeRequest,
  getAuthConfig = authConfig,
} = {}) {
  return async function handler(req, res) {
    privateHeaders(res);
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return json(res, 405, { error: 'method_not_allowed' });
    }
    try {
      // Bound storage, authorization, and provider I/O together below Vercel's
      // configured 300-second duration, including cleanup after a failed report.
      const deadline = AbortSignal.timeout(280_000);
      const boundedFetch = (endpoint, options = {}) => fetchImpl(endpoint, {
        ...options,
        signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      });
      if (req.method === 'GET') {
        if (!env.CRON_SECRET || env.CRON_SECRET.length < 16) return json(res, 503, { error: 'cron_not_configured' });
        if (!validCronAuthorization(req.headers?.authorization, env.CRON_SECRET)) {
          return json(res, 401, { error: 'cron_unauthorized' });
        }
      } else {
        const config = getAuthConfig(env);
        sameOriginPost(req, config);
        if (!await authorize(req, res, { config, fetcher: boundedFetch })) return;
      }
      const source = requestedSource(req.url);
      const store = storeFactory({ env, fetcher: boundedFetch });
      const result = await synchronize({
        source, store, env, fetchImpl: boundedFetch,
        trigger: req.method === 'GET' ? 'cron' : 'manual',
      });
      const status = result.status === 'ready' ? 200 : result.status === 'failed' ? 502 : 409;
      return json(res, status, result);
    } catch (error) {
      if (error instanceof AuthError) return json(res, error.status, { error: error.code });
      return json(res, 503, { error: 'sync_unavailable', message: 'The refresh service is unavailable. The last successful reports remain available.' });
    }
  };
}

export default createSyncHandler();
