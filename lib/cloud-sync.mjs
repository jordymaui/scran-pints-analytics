import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  collectYouTubeShorts, collectTikTok, collectInstagram,
  requestPlatformJson, CollectionError,
} from './collectors.mjs';
import { collectYouTubeEpisodes, pacificDate } from './youtube-sync.mjs';
import { validateSocialImport } from './social-schema.mjs';

export const CLOUD_SOURCES = Object.freeze(['youtube', 'youtube-shorts', 'instagram', 'tiktok']);
const FAILURE_MESSAGES = Object.freeze({
  authorization: 'The platform authorization needs attention. Reconnect the account.',
  'not-connected': 'Connect this platform in the team workspace before refreshing its reports.',
  'not-configured': 'The platform application is not configured in the server environment.',
  blocked: 'This connection is awaiting provider setup and verified reporting access.',
  configuration: 'The reporting configuration needs attention before this source can refresh.',
  'no-data': 'The platform returned no usable report. The previous successful snapshot was kept.',
  'rate-limit': 'The platform rate limit was reached. The previous successful snapshot was kept.',
  network: 'The platform could not be reached. The previous successful snapshot was kept.',
  'api-error': 'The platform rejected the report. The previous successful snapshot was kept.',
  'invalid-response': 'The platform report did not pass validation. The previous successful snapshot was kept.',
  pagination: 'The report could not be collected completely. The previous successful snapshot was kept.',
  'stale-data': 'The returned report was older than the saved report. The saved report was kept.',
  'coverage-loss': 'The returned report lost previously available coverage. The saved report was kept.',
  'content-type': 'A selected video did not match the required format. The saved report was kept.',
  privacy: 'A selected video is no longer public. The saved report was kept for review.',
});

function fail(code, message = FAILURE_MESSAGES[code] || FAILURE_MESSAGES.configuration) {
  throw new CollectionError(code, message);
}

function calendarOffset(day, offset) {
  const instant = new Date(`${day}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + offset);
  return instant.toISOString().slice(0, 10);
}

export function scheduledWindow(capturedAt) {
  // A three-day delay reflects the documented Analytics processing window.
  // Actual returned coverage remains the authority and is preserved by collectors.
  const end = calendarOffset(pacificDate(capturedAt), -3);
  return { start: calendarOffset(end, -27), end };
}

function youtubeEnvironment(connection, env) {
  const credentials = connection?.credentials;
  if (!credentials || (!credentials.refreshToken && !credentials.accessToken)) fail('not-connected');
  const channelId = credentials.channelId || connection.accountId || 'MINE';
  const result = {
    YOUTUBE_CLIENT_ID: env.YOUTUBE_CLIENT_ID,
    YOUTUBE_CLIENT_SECRET: env.YOUTUBE_CLIENT_SECRET,
    YOUTUBE_CHANNEL_ID: channelId,
    YOUTUBE_ACCOUNT_LABEL: credentials.accountLabel || 'Scran & Pints',
  };
  if (credentials.refreshToken) {
    if (!result.YOUTUBE_CLIENT_ID || !result.YOUTUBE_CLIENT_SECRET) fail('not-configured');
    result.YOUTUBE_REFRESH_TOKEN = credentials.refreshToken;
  } else {
    result.YOUTUBE_ACCESS_TOKEN = credentials.accessToken;
  }
  return result;
}

/**
 * Refresh a TikTok grant and persist any rotated refresh token before further
 * requests. Its token response is never returned to callers or public snapshots.
 */
async function tiktokEnvironment(connection, env, store, fetchImpl, capturedAt) {
  const credentials = connection?.credentials;
  if (!credentials || (!credentials.refreshToken && !credentials.accessToken)) fail('not-connected');
  let accessToken = credentials.accessToken;
  let accountId = connection.accountId;
  const freshUntil = Date.parse(credentials.expiresAt || '');
  if (credentials.refreshToken && (!accessToken || !Number.isFinite(freshUntil) || freshUntil < Date.parse(capturedAt) + 300000)) {
    if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) fail('not-configured');
    const response = await requestPlatformJson(fetchImpl, 'https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token', refresh_token: credentials.refreshToken,
      }).toString(),
    });
    if (response.error || typeof response.access_token !== 'string' || !response.access_token ||
        typeof response.refresh_token !== 'string' || !response.refresh_token ||
        !Number.isFinite(response.expires_in) || response.expires_in <= 0 ||
        typeof response.open_id !== 'string' || !response.open_id ||
        (connection.accountId && response.open_id !== connection.accountId)) {
      fail('authorization');
    }
    const next = {
      ...credentials,
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: new Date(Date.parse(capturedAt) + response.expires_in * 1000).toISOString(),
    };
    if (Number.isFinite(response.refresh_expires_in) && response.refresh_expires_in > 0) {
      next.refreshExpiresAt = new Date(Date.parse(capturedAt) + response.refresh_expires_in * 1000).toISOString();
    }
    const scopes = typeof response.scope === 'string' ? response.scope.split(',').map(scope => scope.trim()).filter(Boolean) : connection.scopes || [];
    await store.setConnection('tiktok', next, { accountId: response.open_id, scopes });
    accessToken = response.access_token;
    accountId = response.open_id;
  }
  if (!accessToken || (Number.isFinite(freshUntil) && freshUntil < Date.parse(capturedAt) && !credentials.refreshToken)) fail('authorization');
  return {
    TIKTOK_ACCESS_TOKEN: accessToken,
    TIKTOK_ACCOUNT_LABEL: credentials.accountLabel,
    TIKTOK_OPEN_ID: accountId,
  };
}

async function bundledSeed() {
  // This is a bundled first-run seed on Vercel, not mutable local runtime state.
  return JSON.parse(await readFile(new URL('../data.json', import.meta.url), 'utf8'));
}

const defaultCollectors = {
  youtube: collectYouTubeEpisodes,
  'youtube-shorts': collectYouTubeShorts,
  tiktok: collectTikTok,
  instagram: collectInstagram,
};

export async function syncCloudSource({
  source, store, env = process.env, fetchImpl = fetch,
  trigger = 'manual', now = () => new Date().toISOString(),
  collectors = defaultCollectors, seedLoader = bundledSeed,
} = {}) {
  if (!CLOUD_SOURCES.includes(source) || !['manual', 'cron'].includes(trigger)) fail('configuration');
  const runId = randomUUID();
  const startedAt = now();
  const window = scheduledWindow(startedAt);
  let requestedWindow = source.startsWith('youtube') ? window : null;
  const lockSource = source.startsWith('youtube') ? 'youtube' : source;
  const base = { source, runId, startedAt };
  let locked = false;
  let result;
  try {
    locked = await store.acquireSyncLock(lockSource, {
      owner: runId,
      expiresAt: new Date(Date.parse(startedAt) + 600000).toISOString(),
    });
    if (!locked) {
      result = { ...base, status: 'busy', errorCode: 'sync_in_progress', message: 'A refresh for this platform is already running.' };
    } else {
      const connectionSource = source.startsWith('youtube') ? 'youtube' : source;
      const connection = await store.getConnection(connectionSource);
      if (!connection?.credentials) fail('not-connected');
      const deadline = AbortSignal.timeout(270000);
      const boundedFetch = (endpoint, options = {}) => fetchImpl(endpoint, {
        ...options,
        signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      });
      let payload;
      let warningCount = 0;
      if (source === 'youtube') {
        const latest = await store.loadSnapshot('youtube');
        const snapshot = structuredClone(latest?.payload || await seedLoader());
        for (const video of snapshot.videos || []) video.packagingCapturedAt ||= snapshot.capturedAt;
        const collected = await collectors.youtube({
          snapshot, end: window.end, env: youtubeEnvironment(connection, env),
          fetchImpl: boundedFetch, capturedAt: startedAt,
        });
        payload = collected.snapshot;
        warningCount = collected.warnings?.length || 0;
        const publications = (payload.videos || []).map(video => pacificDate(video.publishedAt)).sort();
        requestedWindow = { start: publications[0] || window.start, end: window.end };
      } else if (source === 'youtube-shorts') {
        payload = await collectors['youtube-shorts']({
          ...window, env: youtubeEnvironment(connection, env),
          fetchImpl: boundedFetch, capturedAt: startedAt,
        });
      } else if (source === 'tiktok') {
        const providerEnv = await tiktokEnvironment(connection, env, store, boundedFetch, startedAt);
        payload = await collectors.tiktok({ env: providerEnv, fetchImpl: boundedFetch, capturedAt: startedAt });
      } else {
        payload = await collectors.instagram({
          env: {
            INSTAGRAM_ACCESS_TOKEN: connection.credentials.accessToken,
            INSTAGRAM_ACCOUNT_ID: connection.accountId,
            INSTAGRAM_API_VERSION: env.INSTAGRAM_API_VERSION,
          },
          fetchImpl: boundedFetch, capturedAt: startedAt, ...window,
        });
      }
      if (!payload || payload.capturedAt !== startedAt) fail('invalid-response');
      if (source !== 'youtube') {
        if (payload.id !== source) fail('invalid-response');
        try {
          payload = validateSocialImport({ schemaVersion: 1, sources: [payload] }).sources[0];
        } catch { fail('invalid-response'); }
      }
      const saved = await store.saveSnapshot(source, payload, { capturedAt: startedAt, status: 'ready' });
      if (saved?.saved === false) {
        result = { ...base, status: 'blocked', errorCode: 'newer_snapshot_exists', message: 'A newer successful report is already stored; it was kept.' };
      } else {
        result = {
          ...base, status: 'ready', capturedAt: startedAt,
          window: source === 'youtube'
            ? { start: requestedWindow.start, end: payload.apiThrough, scope: 'selected-videos-since-publication' }
            : payload.dateRange,
          warningCount,
        };
      }
    }
  } catch (error) {
    const code = error instanceof CollectionError && Object.hasOwn(FAILURE_MESSAGES, error.code)
      ? error.code : 'refresh_failed';
    result = {
      ...base,
      status: code === 'not-connected' ? 'not-connected'
        : ['not-configured', 'blocked', 'configuration'].includes(code) ? 'blocked' : 'failed',
      errorCode: code,
      message: FAILURE_MESSAGES[code] || 'Refresh failed. The previous successful report remains available.',
    };
  } finally {
    if (locked) {
      try { await store.releaseSyncLock(lockSource, runId); } catch { /* The bounded lease expires automatically. */ }
    }
  }
  const completedAt = now();
  result.completedAt = completedAt;
  try {
    await store.recordSyncResult(source, {
      status: result.status, errorCode: result.errorCode || null,
      message: result.message || null, completedAt, runId, startedAt, trigger, requestedWindow,
    });
    result.auditRecorded = true;
  } catch {
    result.auditRecorded = false;
  }
  return result;
}
