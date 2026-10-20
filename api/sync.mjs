import { createHash, timingSafeEqual } from 'node:crypto';
import { authorizeRequest, authConfig, sameOriginPost, AuthError, json, privateHeaders } from '../lib/auth.mjs';
import { createCloudStore } from '../lib/cloud-store.mjs';
import { CLOUD_SOURCES, syncCloudSource, importTikTokStudioSupplement, StudioImportError } from '../lib/cloud-sync.mjs';

const MAX_IMPORT_BODY = 2_000_000;
async function readSyncOperation(req) {
  const type = req.headers?.['content-type'] || '';
  const declaredLength = Number(req.headers?.['content-length'] || 0);
  if (declaredLength > MAX_IMPORT_BODY) throw new AuthError(413, 'payload_too_large');
  const emptyBody = req.body === undefined || req.body === null || req.body === '' ||
    Buffer.isBuffer(req.body) && req.body.length === 0;
  if (emptyBody && declaredLength === 0 && !req.headers?.['transfer-encoding']) return null;
  if (!/^application\/json(?:;|$)/i.test(type)) throw new AuthError(415, 'json_required');
  try {
    let raw = req.body;
    if (raw === undefined) {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > MAX_IMPORT_BODY) throw new AuthError(413, 'payload_too_large');
        chunks.push(Buffer.from(chunk));
      }
      raw = Buffer.concat(chunks).toString('utf8');
    }
    if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
    if (typeof raw !== 'string') raw = JSON.stringify(raw);
    if (Buffer.byteLength(raw) > MAX_IMPORT_BODY) throw new AuthError(413, 'payload_too_large');
    const input = JSON.parse(raw);
    if (!input || Array.isArray(input) || typeof input !== 'object' ||
        input.operation !== 'studio-import' || !Object.hasOwn(input, 'report') ||
        Object.keys(input).some(key => !['operation', 'report'].includes(key))) throw Error();
    return input;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(400, 'invalid_sync_operation');
  }
}

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
  getAuthConfig = authConfig, importStudio = importTikTokStudioSupplement,
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
      const operation = req.method === 'POST' ? await readSyncOperation(req) : null;
      if (operation && source !== 'tiktok') throw new AuthError(400, 'invalid_sync_operation');
      const store = storeFactory({ env, fetcher: boundedFetch });
      if (operation) {
        const result = await importStudio({ store, report: operation.report });
        return json(res, result.status === 'imported' ? 200 : 409, result);
      }
      const result = await synchronize({
        source, store, env, fetchImpl: boundedFetch,
        trigger: req.method === 'GET' ? 'cron' : 'manual',
      });
      const status = result.status === 'ready' ? 200 : result.status === 'failed' ? 502 : 409;
      return json(res, status, result);
    } catch (error) {
      if (error instanceof AuthError || error instanceof StudioImportError) return json(res, error.status, { error: error.code });
      return json(res, 503, { error: 'sync_unavailable', message: 'The refresh service is unavailable. The last successful reports remain available.' });
    }
  };
}

export default createSyncHandler();
