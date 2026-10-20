import { authorizeRequest, json } from '../lib/auth.mjs';
import { createCloudStore, CLOUD_SOURCES } from '../lib/cloud-store.mjs';
import { youtubeOAuthConfig } from '../lib/youtube-oauth.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: 'method_not_allowed' });
  }
  if (!await authorizeRequest(req, res)) return;
  const setup = { youtubeOAuth: false, tiktokOAuth: false, instagramOAuth: false };
  try { youtubeOAuthConfig(); setup.youtubeOAuth = true; } catch { /* Setup remains unavailable. */ }
  try {
    return json(res, 200, { configured: true, setup, platforms: await createCloudStore().getStatuses() });
  } catch (error) {
    return json(res, error.code === 'not-configured' ? 200 : 503, {
      configured: false, setup, error: error.code === 'not-configured' ? 'storage_not_configured' : 'storage_unavailable',
      platforms: CLOUD_SOURCES.map(id => ({ id, connected: false, connectedAt: null, hasSnapshot: false, capturedAt: null, lastSync: null })),
    });
  }
}
