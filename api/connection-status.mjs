import { json } from '../lib/auth.mjs';
import { createCloudStore, CLOUD_SOURCES } from '../lib/cloud-store.mjs';
import { youtubeOAuthConfig } from '../lib/youtube-oauth.mjs';

const STATUSES = new Set(['ready', 'not-connected', 'blocked', 'failed', 'busy']);
const ERRORS = new Set(['authorization', 'not-connected', 'not-configured', 'blocked', 'configuration',
  'no-data', 'rate-limit', 'network', 'api-error', 'invalid-response', 'pagination', 'stale-data',
  'coverage-loss', 'content-type', 'privacy', 'sync_in_progress', 'newer_snapshot_exists', 'partial_refresh']);
const timestamp = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10) ? value : null;

export function publicConnectionStatuses(values) {
  return CLOUD_SOURCES.map(id => {
    const row = Array.isArray(values) ? values.find(value => value?.id === id) : null;
    return {
      id, connected: row?.connected === true, connectedAt: timestamp(row?.connectedAt),
      hasSnapshot: row?.hasSnapshot === true, capturedAt: timestamp(row?.capturedAt),
      lastSync: STATUSES.has(row?.lastSync?.status) ? {
        status: row.lastSync.status, completedAt: timestamp(row.lastSync.completedAt),
        errorCode: ERRORS.has(row.lastSync.errorCode) ? row.lastSync.errorCode : null,
      } : null,
    };
  });
}

export function createConnectionStatusHandler({
  storeFactory = createCloudStore, oauthConfig = youtubeOAuthConfig, env = process.env,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return json(res, 405, { error: 'method_not_allowed' });
    }
    const setup = { youtubeOAuth: false, youtubePublic: Boolean(env.YOUTUBE_PUBLIC_API_KEY), tiktokOAuth: false, instagramOAuth: false };
    try { oauthConfig(env); setup.youtubeOAuth = true; } catch { /* Setup remains unavailable. */ }
    try {
      return json(res, 200, { configured: true, setup, platforms: publicConnectionStatuses(await storeFactory().getStatuses()) });
    } catch (error) {
      return json(res, error.code === 'not-configured' ? 200 : 503, {
        configured: false, setup, error: error.code === 'not-configured' ? 'storage_not_configured' : 'storage_unavailable',
        platforms: publicConnectionStatuses([]),
      });
    }
  };
}

export default createConnectionStatusHandler();
