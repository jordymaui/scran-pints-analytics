import { json } from '../lib/auth.mjs';
import { createCloudStore, CLOUD_SOURCES, publicSyncErrorCode } from '../lib/cloud-store.mjs';
import { youtubeOAuthConfig } from '../lib/youtube-oauth.mjs';
import { instagramOAuthConfig } from '../lib/instagram-oauth.mjs';
import { tiktokOAuthConfig } from '../lib/tiktok-oauth.mjs';

const STATUSES = new Set(['ready', 'not-connected', 'blocked', 'failed', 'busy']);
const BROWSER_STATES = new Set(['configured', 'connecting', 'ready', 'login-required', 'failed']);
const timestamp = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10) ? value : null;

export function publicConnectionStatuses(values) {
  return CLOUD_SOURCES.map(id => {
    const row = Array.isArray(values) ? values.find(value => value?.id === id) : null;
    const mode = id === 'instagram' && row?.mode === 'browser-sweep' ? 'browser-sweep' : 'official-api';
    const browserState = mode === 'browser-sweep' && BROWSER_STATES.has(row?.browserState) ? row.browserState : null;
    const connected = row?.connected === true && (mode !== 'browser-sweep' || browserState === 'ready');
    return {
      id, mode, browserState, connected, connectedAt: connected ? timestamp(row?.connectedAt) : null,
      hasSnapshot: row?.hasSnapshot === true, capturedAt: timestamp(row?.capturedAt),
      lastSync: STATUSES.has(row?.lastSync?.status) ? {
        status: row.lastSync.status, completedAt: timestamp(row.lastSync.completedAt),
        errorCode: publicSyncErrorCode(row.lastSync.errorCode),
        warningCount: Number.isSafeInteger(row.lastSync.warningCount) && row.lastSync.warningCount >= 0 ? row.lastSync.warningCount : null,
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
    const setup = { youtubeOAuth: false, youtubePublic: Boolean(env.YOUTUBE_PUBLIC_API_KEY), tiktokOAuth: false,
      instagramOAuth: false, instagramBrowser: true };
    try { oauthConfig(env); setup.youtubeOAuth = true; } catch { /* Setup remains unavailable. */ }
    try { instagramOAuthConfig(env); setup.instagramOAuth = true; } catch { /* Setup remains unavailable. */ }
    try { tiktokOAuthConfig(env); setup.tiktokOAuth = true; } catch { /* Setup remains unavailable. */ }
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
