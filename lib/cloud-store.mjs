// Server-only persistence. Never import this module from a public browser asset.
export const CLOUD_SOURCES = Object.freeze(['youtube', 'youtube-shorts', 'instagram', 'tiktok']);
const RUN_STATUSES = new Set(['ready', 'not-connected', 'blocked', 'failed', 'busy']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export class CloudStoreError extends Error {
  constructor(code = 'unavailable') {
    super(`Cloud storage ${code}.`);
    this.name = 'CloudStoreError';
    this.code = code;
  }
}

export function cloudConfig(env = process.env) {
  try {
    const url = new URL(env.SUPABASE_URL);
    const key = env.SUPABASE_SECRET_KEY;
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || !/^sb_secret_[A-Za-z0-9_-]+$/.test(key || '')) throw Error();
    return { url: url.origin, key };
  } catch { throw new CloudStoreError('not-configured'); }
}

function sourceId(source) {
  if (!CLOUD_SOURCES.includes(source)) throw new CloudStoreError('invalid-input');
  return source;
}
function timestamp(value) {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new CloudStoreError('invalid-input');
  }
  return new Date(value).toISOString();
}
function object(value, maxBytes = 8_000_000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CloudStoreError('invalid-input');
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > maxBytes) throw Error();
    return JSON.parse(serialized);
  } catch { throw new CloudStoreError('invalid-input'); }
}
function shortText(value, length = 500) {
  if (typeof value !== 'string' || value.length > length || /[\u0000-\u001f\u007f]/.test(value)) throw new CloudStoreError('invalid-input');
  return value;
}
function errorCode(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : null;
}
function safeTimestamp(value) {
  try { return value == null ? null : timestamp(value); } catch { return null; }
}
function metadataFor({ runId = null, startedAt = null, trigger = null, requestedWindow = null }) {
  if (runId !== null && !UUID.test(runId)) throw new CloudStoreError('invalid-input');
  if (trigger !== null && !['cron', 'manual'].includes(trigger)) throw new CloudStoreError('invalid-input');
  const metadata = { runId, startedAt: startedAt === null ? null : timestamp(startedAt), trigger };
  if (requestedWindow !== null) {
    const { start, end } = object(requestedWindow, 1000);
    if (![start, end].every(day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      safeTimestamp(`${day}T00:00:00Z`)) || start > end) throw new CloudStoreError('invalid-input');
    metadata.requestedWindow = { start, end };
  }
  return metadata;
}

export function createCloudStore({ env = process.env, fetcher = fetch } = {}) {
  const config = cloudConfig(env);
  async function request(path, { method = 'GET', body, prefer } = {}) {
    let response;
    try {
      response = await fetcher(`${config.url}/rest/v1/${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: {
          apikey: config.key, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(prefer ? { Prefer: prefer } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new CloudStoreError('unavailable'); }
    // Provider bodies may contain query fragments or credentials. Never expose them.
    if (!response.ok) throw new CloudStoreError('unavailable');
    if (response.status === 204 || method === 'DELETE') return null;
    try {
      const text = await response.text();
      if (text.length > 12_000_000) throw Error();
      return text ? JSON.parse(text) : null;
    } catch { throw new CloudStoreError('unavailable'); }
  }
  async function rows(path) {
    const value = await request(path);
    if (!Array.isArray(value)) throw new CloudStoreError('unavailable');
    return value;
  }
  async function lastSyncRun(source) {
    const [run] = await rows(`analytics_sync_runs?source=eq.${sourceId(source)}&select=status,error_code,completed_at&order=completed_at.desc&limit=1`);
    if (!run) return null;
    const completedAt = safeTimestamp(run.completed_at);
    const code = run.error_code == null ? null : errorCode(run.error_code);
    if (!RUN_STATUSES.has(run.status) || !completedAt || run.error_code != null && !code) {
      throw new CloudStoreError('unavailable');
    }
    return { status: run.status, errorCode: code, completedAt };
  }
  return {
    getLastSyncRun: lastSyncRun,
    async getPublicYouTubeRefreshState({ now = () => Date.now() } = {}) {
      const select = [
        'publicSchema:payload->publicReport->schemaVersion',
        'publicChannelId:payload->publicReport->channel->>id',
        'publicCapturedAt:payload->publicReport->>capturedAt',
        'analyticsChannelId:payload->channelAnalytics->>channelId',
        'analyticsCapturedAt:payload->channelAnalytics->>capturedAt',
        'analyticsStart:payload->channelAnalytics->dateRange->>start',
        'analyticsThrough:payload->channelAnalytics->dateRange->>end',
        'analyticsTimezone:payload->channelAnalytics->dateRange->>timezone',
        'analyticsEndBasis:payload->channelAnalytics->coverage->>endBasis',
      ].join(',');
      const [locks, snapshots, lastSync] = await Promise.all([
        rows('analytics_sync_locks?source=eq.youtube&select=expires_at&limit=1'),
        rows(`analytics_snapshots?source=eq.youtube&select=${select}&limit=1`),
        lastSyncRun('youtube'),
      ]);
      const current = now();
      if (!Number.isFinite(current)) throw new CloudStoreError('unavailable');
      const expiry = safeTimestamp(locks[0]?.expires_at);
      if (locks.length && !expiry) throw new CloudStoreError('unavailable');
      const row = snapshots[0], expected = 'UCAX4l1JUAymaMHVKiRFzK-A';
      const validTime = value => {
        const result = safeTimestamp(value);
        return result && Date.parse(result) <= current ? result : null;
      };
      const capturedAt = row?.publicSchema === 1 && row.publicChannelId === expected
        ? validTime(row.publicCapturedAt) : null;
      let analyticsCapturedAt = row?.analyticsChannelId === expected ? validTime(row.analyticsCapturedAt) : null;
      const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        safeTimestamp(`${value}T00:00:00Z`);
      if (!analyticsCapturedAt || row.analyticsTimezone !== 'America/Los_Angeles' ||
          row.analyticsEndBasis !== 'channel-daily-same-metrics' ||
          !day(row.analyticsStart) || !day(row.analyticsThrough) ||
          row.analyticsStart > row.analyticsThrough ||
          row.analyticsThrough > new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles',
            year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(analyticsCapturedAt))) {
        analyticsCapturedAt = null;
      }
      return { running: Boolean(expiry && Date.parse(expiry) > current), capturedAt,
        analyticsCapturedAt, analyticsThrough: analyticsCapturedAt ? row.analyticsThrough : null, lastSync };
    },
    async getNotebook() {
      const [row] = await rows('analytics_workshop_notebook?id=eq.team&select=version,drafts,updated_at&limit=1');
      return row ? { version: row.version, drafts: row.drafts, updatedAt: row.updated_at } :
        { version: 0, drafts: [], updatedAt: null };
    },
    async saveNotebook({ drafts, expectedVersion, updatedBy }) {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !UUID.test(updatedBy || '') ||
          !Array.isArray(drafts) || drafts.length > 200) throw new CloudStoreError('invalid-input');
      const safeDrafts = object({ drafts }, 2_000_000).drafts;
      const result = await request('rpc/analytics_save_notebook', { method: 'POST', body: {
        p_drafts: safeDrafts, p_expected_version: expectedVersion, p_updated_by: updatedBy,
      } });
      if (result === null) throw new CloudStoreError('version-conflict');
      if (!result || !Number.isSafeInteger(result.version) || !Array.isArray(result.drafts)) throw new CloudStoreError('unavailable');
      return { version: result.version, drafts: result.drafts, updatedAt: result.updatedAt };
    },
    async getConnection(platform) {
      const [row] = await rows(`analytics_connections?platform=eq.${sourceId(platform)}&select=credentials,account_id,scopes,updated_at&limit=1`);
      return row ? { credentials: row.credentials, accountId: row.account_id, scopes: row.scopes, updatedAt: row.updated_at } : null;
    },
    async setConnection(platform, credentials, { accountId = null, scopes = [] } = {}) {
      if (!Array.isArray(scopes) || scopes.length > 30 || scopes.some(scope => typeof scope !== 'string' || !scope || scope.length > 200 || /\s/.test(scope))) throw new CloudStoreError('invalid-input');
      await request('analytics_connections?on_conflict=platform', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: { platform: sourceId(platform), credentials: object(credentials, 64_000),
          account_id: accountId === null ? null : shortText(accountId, 200),
          scopes: [...new Set(scopes)], updated_at: new Date().toISOString() },
      });
    },
    async loadSnapshot(source) {
      const [row] = await rows(`analytics_snapshots?source=eq.${sourceId(source)}&select=payload,captured_at,updated_at,status&limit=1`);
      return row ? { payload: row.payload, capturedAt: row.captured_at, updatedAt: row.updated_at, status: row.status } : null;
    },
    async loadPublicYouTubeHistory() {
      // Project only the independently collected public Data API report. Archived
      // private Analytics payloads must never travel through this history read.
      const history = [];
      for (let offset = 0; offset < 100000; offset += 100) {
        const page = await rows(`analytics_snapshot_history?source=eq.youtube&select=publicReport:payload->publicReport&payload->publicReport=not.is.null&order=captured_at.desc,archived_at.desc,id.desc&limit=100&offset=${offset}`);
        history.push(...page.map(row => row?.publicReport));
        if (page.length < 100) return history;
      }
      // Refuse a truncated archive instead of silently returning a recent slice.
      throw new CloudStoreError('unavailable');
    },
    async saveSnapshot(source, payload, { capturedAt = payload?.capturedAt, status = 'ready' } = {}) {
      if (!['ready', 'partial'].includes(status)) throw new CloudStoreError('invalid-input');
      const result = await request('rpc/analytics_save_snapshot', { method: 'POST', body: {
        p_source: sourceId(source), p_payload: object(payload), p_captured_at: timestamp(capturedAt), p_status: status,
      } });
      if (typeof result !== 'boolean') throw new CloudStoreError('unavailable');
      return { saved: result };
    },
    async recordSyncResult(source, result) {
      if (!RUN_STATUSES.has(result?.status)) throw new CloudStoreError('invalid-input');
      const code = result.errorCode == null ? null : errorCode(result.errorCode);
      if (result.errorCode != null && !code) throw new CloudStoreError('invalid-input');
      await request('analytics_sync_runs', { method: 'POST', prefer: 'return=minimal', body: {
        source: sourceId(source), status: result.status, error_code: code,
        message: result.message == null ? null : shortText(result.message),
        completed_at: timestamp(result.completedAt || new Date().toISOString()),
        metadata: metadataFor(result),
      } });
    },
    async getStatuses() {
      const [connections, snapshots, ...runs] = await Promise.all([
        rows('analytics_connections?select=platform,updated_at'),
        rows('analytics_snapshots?select=source,captured_at'),
        ...CLOUD_SOURCES.map(source => rows(`analytics_sync_runs?source=eq.${source}&select=status,error_code,completed_at&order=completed_at.desc&limit=1`)),
      ]);
      return CLOUD_SOURCES.map((id, index) => {
        const connection = connections.find(row => row.platform === (id === 'youtube-shorts' ? 'youtube' : id));
        const snapshot = snapshots.find(row => row.source === id);
        const run = runs[index][0];
        return {
          id, connected: Boolean(connection), connectedAt: safeTimestamp(connection?.updated_at),
          hasSnapshot: Boolean(snapshot), capturedAt: safeTimestamp(snapshot?.captured_at),
          lastSync: run && RUN_STATUSES.has(run.status) ? {
            status: run.status, errorCode: errorCode(run.error_code), completedAt: safeTimestamp(run.completed_at),
          } : null,
        };
      });
    },
    async acquireSyncLock(source, { owner, expiresAt }) {
      if (!UUID.test(owner || '')) throw new CloudStoreError('invalid-input');
      const expiry = timestamp(expiresAt);
      if (Date.parse(expiry) <= Date.now() || Date.parse(expiry) > Date.now() + 15 * 60_000) throw new CloudStoreError('invalid-input');
      const result = await request('rpc/analytics_acquire_sync_lock', { method: 'POST', body: {
        p_source: sourceId(source), p_owner: owner, p_expires_at: expiry,
      } });
      if (typeof result !== 'boolean') throw new CloudStoreError('unavailable');
      return result;
    },
    async releaseSyncLock(source, owner) {
      if (!UUID.test(owner || '')) throw new CloudStoreError('invalid-input');
      const result = await request('rpc/analytics_release_sync_lock', { method: 'POST', body: { p_source: sourceId(source), p_owner: owner } });
      if (typeof result !== 'boolean') throw new CloudStoreError('unavailable');
      return result;
    },
  };
}

export const getConnection = (...args) => createCloudStore().getConnection(...args);
export const setConnection = (...args) => createCloudStore().setConnection(...args);
export const loadSnapshot = (...args) => createCloudStore().loadSnapshot(...args);
export const loadPublicYouTubeHistory = (...args) => createCloudStore().loadPublicYouTubeHistory(...args);
export const saveSnapshot = (...args) => createCloudStore().saveSnapshot(...args);
export const recordSyncResult = (...args) => createCloudStore().recordSyncResult(...args);
export const getStatuses = (...args) => createCloudStore().getStatuses(...args);
export const getLastSyncRun = (...args) => createCloudStore().getLastSyncRun(...args);
export const getPublicYouTubeRefreshState = (...args) => createCloudStore().getPublicYouTubeRefreshState(...args);
export const acquireSyncLock = (...args) => createCloudStore().acquireSyncLock(...args);
export const releaseSyncLock = (...args) => createCloudStore().releaseSyncLock(...args);
export const getNotebook = (...args) => createCloudStore().getNotebook(...args);
export const saveNotebook = (...args) => createCloudStore().saveNotebook(...args);
