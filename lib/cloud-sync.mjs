import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  collectYouTubeShorts, collectTikTok, collectInstagram,
  requestPlatformJson, CollectionError,
} from './collectors.mjs';
import { collectYouTubeEpisodes, pacificDate } from './youtube-sync.mjs';
import { collectPublicYouTube } from './youtube-public.mjs';
import { validateSocialImport } from './social-schema.mjs';
import { youtubeCoverage, validatePublicYouTubeReport } from './report-model.mjs';

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
  // Ask for the latest available data. YouTube stops at the last day for which
  // every requested metric is available; collectors retain that actual cutoff.
  const end = pacificDate(capturedAt);
  return { start: calendarOffset(end, -27), end };
}

export function shortsHistoryStart(youtube, previous) {
  const candidates = [
    youtube?.channelAnalytics?.dateRange?.start,
    previous?.dateRange?.start,
    ...(youtube?.videos || []).map(video => video.publishedAt),
    ...(youtube?.publicReport?.content || []).map(video => video.publishedAt),
  ].filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .map(value => value.includes('T') ? pacificDate(value) : value)
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
  if (!candidates.length) fail('configuration', 'Refresh the channel inventory before collecting Shorts history.');
  return candidates[0];
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
  youtubePublic: collectPublicYouTube,
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
      if (source !== 'youtube' && !connection?.credentials) fail('not-connected');
      const deadline = AbortSignal.timeout(270000);
      const boundedFetch = (endpoint, options = {}) => fetchImpl(endpoint, {
        ...options,
        signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      });
      let payload;
      let warningCount = 0;
      let components = null;
      let youtubeWindow = null;
      if (source === 'youtube') {
        const latest = await store.loadSnapshot('youtube');
        const snapshot = structuredClone(latest?.payload || await seedLoader());
        for (const video of snapshot.videos || []) video.packagingCapturedAt ||= snapshot.capturedAt;
        const tasks = [];
        components = {
          public: { status: 'not-configured', capturedAt: snapshot.publicReport?.capturedAt || null },
          analytics: { status: 'not-connected', capturedAt: snapshot.capturedAt || null },
        };
        if (env.YOUTUBE_PUBLIC_API_KEY) tasks.push({ id: 'public', run: async () => {
          const collected = await (collectors.youtubePublic || collectPublicYouTube)({
            env: { YOUTUBE_PUBLIC_API_KEY: env.YOUTUBE_PUBLIC_API_KEY },
            fetchImpl: boundedFetch, capturedAt: startedAt,
          });
          const report = validatePublicYouTubeReport(collected);
          if (report.capturedAt !== startedAt) fail('invalid-response');
          return report;
        } });
        if (connection?.credentials) tasks.push({ id: 'analytics', run: async () => {
          const collected = await collectors.youtube({
            snapshot: structuredClone(snapshot), end: window.end, env: youtubeEnvironment(connection, env),
            fetchImpl: boundedFetch, capturedAt: startedAt,
          });
          if (!collected?.snapshot || collected.snapshot.capturedAt !== startedAt) fail('invalid-response');
          return collected;
        } });
        if (!tasks.length) fail('not-connected');
        const results = await Promise.allSettled(tasks.map(task => task.run()));
        payload = snapshot;
        let collectedPublic = null;
        let succeeded = false;
        for (let index = 0; index < tasks.length; index++) {
          const { id } = tasks[index];
          const collected = results[index];
          if (collected.status === 'rejected') {
            const code = collected.reason instanceof CollectionError && Object.hasOwn(FAILURE_MESSAGES, collected.reason.code)
              ? collected.reason.code : 'refresh_failed';
            components[id] = { ...components[id], status: 'failed', errorCode: code };
            warningCount++;
            continue;
          }
          succeeded = true;
          components[id] = { status: 'ready', capturedAt: startedAt };
          if (id === 'public') collectedPublic = collected.value;
          else {
            payload = collected.value.snapshot;
            warningCount += collected.value.warnings?.length || 0;
            const publications = (payload.videos || []).map(video => pacificDate(video.publishedAt)).sort();
            requestedWindow = { start: payload.channelAnalytics?.dateRange?.start || publications[0] || window.start, end: window.end };
          }
        }
        if (!succeeded) throw results.find(result => result.status === 'rejected').reason;
        if (collectedPublic) payload.publicReport = collectedPublic;
        else if (snapshot.publicReport) payload.publicReport = snapshot.publicReport;
        // Public-only refreshes advance the cloud row, never the private capture.
        if (components.analytics.status !== 'ready') {
          requestedWindow = null;
          youtubeWindow = { start: startedAt.slice(0, 10), end: startedAt.slice(0, 10), scope: 'public-channel-lifetime-counters-at-capture' };
        }
      } else if (source === 'youtube-shorts') {
        const [youtube, previous] = await Promise.all([
          store.loadSnapshot('youtube'), store.loadSnapshot('youtube-shorts'),
        ]);
        const start = shortsHistoryStart(youtube?.payload || await seedLoader(), previous?.payload);
        requestedWindow = { start, end: window.end };
        payload = await collectors['youtube-shorts']({
          ...requestedWindow, previous: previous?.payload, env: youtubeEnvironment(connection, env),
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
      if (!payload || (source !== 'youtube' && payload.capturedAt !== startedAt)) fail('invalid-response');
      if (source !== 'youtube') {
        if (payload.id !== source) fail('invalid-response');
        try {
          payload = validateSocialImport({ schemaVersion: 1, sources: [payload] }).sources[0];
        } catch { fail('invalid-response'); }
      }
      const coverage = source === 'youtube' ? youtubeCoverage(payload) : null;
      const saved = await store.saveSnapshot(source, payload, {
        capturedAt: startedAt, status: coverage?.status === 'partial' ||
          warningCount > 0 || payload.publicReport?.inventory.complete === false ||
          components && Object.values(components).some(row => row.status === 'failed') ? 'partial' : 'ready',
      });
      if (saved?.saved === false) {
        result = { ...base, status: 'blocked', errorCode: 'newer_snapshot_exists', message: 'A newer successful report is already stored; it was kept.' };
      } else {
        result = {
          ...base, status: 'ready', capturedAt: startedAt,
          window: source === 'youtube'
            ? youtubeWindow || { start: requestedWindow.start, end: payload.apiThrough,
              scope: coverage.status === 'selected' ? 'selected-videos-since-publication'
                : coverage.status === 'complete' ? 'all-public-longform-since-publication' : 'partial-public-longform-since-publication' }
            : payload.dateRange,
          warningCount, ...(coverage ? { coverage } : {}), ...(components ? { components } : {}),
          ...(source === 'youtube' && payload.uploadAnalytics ? { uploadCoverage: {
            ...payload.uploadAnalytics.coverage,
            includedUploads: payload.uploadAnalytics.videos.length,
            reports: Object.fromEntries(['aggregate', 'daily', 'retention', 'traffic'].map(key => [key, {
              collected: payload.uploadAnalytics.videos.filter(video => video[key]?.status === 'collected').length,
              noRows: payload.uploadAnalytics.videos.filter(video => video[key]?.status === 'no-rows').length,
              retained: payload.uploadAnalytics.videos.filter(video => video[key]?.status?.endsWith('-retained')).length,
              failed: payload.uploadAnalytics.videos.filter(video => video[key]?.status === 'failed').length,
            }])),
          } } : {}),
          ...(source === 'youtube' && payload.bulkReach ? { bulkReach: {
            status: payload.bulkReach.status, capturedAt: payload.bulkReach.capturedAt,
            reportCount: payload.bulkReach.reports.length,
            pendingReportCount: payload.bulkReach.pendingReports.length,
          } } : {}),
          ...(warningCount > 0 || coverage?.status === 'partial' ||
            components && Object.values(components).some(row => row.status === 'failed')
            ? { errorCode: 'partial_refresh', message: 'Available reports were saved. Some reports have gaps or retained their earlier successful capture.' } : {}),
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
