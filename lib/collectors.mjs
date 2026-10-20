import { validateSocialImport, YOUTUBE_ANALYTICS_PROVENANCE } from './social-schema.mjs';
import { normalizeYouTubeContentType } from './youtube-content-type.mjs';

const YOUTUBE_METRICS = [
  'views', 'engagedViews', 'estimatedMinutesWatched', 'likes', 'comments', 'shares',
  'subscribersGained', 'subscribersLost',
];
const YOUTUBE_COLUMNS = ['day', 'creatorContentType', ...YOUTUBE_METRICS];
const TIKTOK_VIDEO_FIELDS = [
  'id', 'create_time', 'share_url', 'title', 'video_description',
  'view_count', 'like_count', 'comment_count', 'share_count',
];
const API_ORIGINS = new Set([
  'https://oauth2.googleapis.com', 'https://youtubeanalytics.googleapis.com',
  'https://www.googleapis.com', 'https://youtube.googleapis.com',
  'https://youtubereporting.googleapis.com', 'https://open.tiktokapis.com',
]);

export class CollectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectionError';
    this.code = code;
  }
}

function unavailable(code, message) { throw new CollectionError(code, message); }

function reportingDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    unavailable('configuration', 'An explicit valid --start and --end date in YYYY-MM-DD format is required for YouTube.');
  }
  return value;
}

function count(value, { optional = false, fractional = false, signed = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (!signed && value < 0) ||
      (!fractional && !Number.isSafeInteger(value))) {
    unavailable('invalid-response', 'A platform returned an invalid numeric metric. The previous snapshot was retained.');
  }
  return value;
}

function publicText(value, fallback, maximum = 150) {
  const clean = typeof value === 'string' ? value.replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (clean || fallback).slice(0, maximum);
}

function tokenValue(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    unavailable('configuration', 'A valid server-side access token is required.');
  }
  return value.trim();
}

export async function requestPlatformJson(fetchImpl, endpoint, options = {}) {
  let target;
  try { target = new URL(endpoint); } catch { unavailable('configuration', 'The collector endpoint is invalid.'); }
  if (!API_ORIGINS.has(target.origin) || target.username || target.password) {
    unavailable('configuration', 'The collector endpoint is outside the supported official API origins.');
  }
  let response;
  try {
    response = await fetchImpl(endpoint, {
      ...options,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    unavailable('network', 'The platform request could not complete. Check connectivity and retry; the previous snapshot was retained.');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      unavailable('authorization', 'The platform rejected authorization. Check the account grant and required read-only permissions.');
    }
    if (response.status === 429) unavailable('rate-limit', 'The platform rate limit was reached. Retry later; the previous snapshot was retained.');
    unavailable('http-error', 'The platform returned an unsuccessful response. The previous snapshot was retained.');
  }
  let payload;
  try { payload = await response.json(); } catch {
    unavailable('invalid-response', 'The platform returned an unreadable response. The previous snapshot was retained.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    unavailable('invalid-response', 'The platform returned an unexpected response. The previous snapshot was retained.');
  }
  return payload;
}

function validatedSource(source) {
  try { return validateSocialImport({ schemaVersion: 1, sources: [source] }).sources[0]; } catch {
    unavailable('invalid-response', 'The collected data did not pass the public snapshot checks. The previous snapshot was retained.');
  }
}

export async function getGoogleAccessToken(env, fetchImpl) {
  if (env.YOUTUBE_ACCESS_TOKEN) return tokenValue(env.YOUTUBE_ACCESS_TOKEN);
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET || !env.YOUTUBE_REFRESH_TOKEN) {
    unavailable('not-configured', 'Set YOUTUBE_ACCESS_TOKEN or the three YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN values on the server.');
  }
  const payload = await requestPlatformJson(fetchImpl, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      refresh_token: env.YOUTUBE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (payload.error || typeof payload.access_token !== 'string') {
    unavailable('authorization', 'Google did not issue an access token. Re-authorize the channel with the required read-only scope.');
  }
  return tokenValue(payload.access_token);
}

/**
 * Owned-channel Analytics API only. `creatorContentType` is the authoritative
 * discriminator; current duration and public lifetime counts are never used.
 * Metrics are additive sums of paginated daily SHORTS rows, not causal evidence.
 */
export async function collectYouTubeShorts({
  env = process.env, fetchImpl = fetch, start, end, capturedAt = new Date().toISOString(),
} = {}) {
  if (!env.YOUTUBE_ACCESS_TOKEN && !(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REFRESH_TOKEN)) {
    unavailable('not-configured', 'YouTube reporting authorization has not been configured. Google identity sign-in alone does not grant Analytics access.');
  }
  start = reportingDay(start);
  end = reportingDay(end);
  if (start > end) unavailable('configuration', 'The reporting start date must be on or before its end date.');
  const channel = env.YOUTUBE_CHANNEL_ID || 'MINE';
  if (channel !== 'MINE' && !/^UC[A-Za-z0-9_-]{22}$/.test(channel)) {
    unavailable('configuration', 'YOUTUBE_CHANNEL_ID must be MINE or a valid YouTube channel ID.');
  }
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const headers = { Authorization: `Bearer ${accessToken}` };
  const rows = [];
  const seen = new Set();
  let startIndex = 1;
  let exhausted = false;
  for (let page = 0; page < 1000; page++) {
    const endpoint = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    endpoint.search = new URLSearchParams({
      ids: `channel==${channel}`,
      startDate: start, endDate: end,
      dimensions: 'day,creatorContentType',
      metrics: YOUTUBE_METRICS.join(','),
      sort: 'day,creatorContentType',
      maxResults: '200',
      startIndex: String(startIndex),
    }).toString();
    const payload = await requestPlatformJson(fetchImpl, endpoint.href, { headers });
    if (payload.error) unavailable('api-error', 'YouTube rejected the report request. Verify the channel grant and supported report parameters.');
    if (!Array.isArray(payload.columnHeaders)) unavailable('invalid-response', 'YouTube did not return report column headers.');
    const names = payload.columnHeaders.map(column => column?.name);
    if (new Set(names).size !== names.length || !YOUTUBE_COLUMNS.every(name => names.includes(name))) {
      unavailable('invalid-response', 'YouTube returned missing or duplicate report columns.');
    }
    const pageRows = payload.rows ?? [];
    if (!Array.isArray(pageRows) || pageRows.length > 200) unavailable('invalid-response', 'YouTube returned an invalid report page.');
    for (const row of pageRows) {
      if (!Array.isArray(row) || row.length !== names.length) unavailable('invalid-response', 'YouTube returned an incomplete report row.');
      const record = Object.fromEntries(names.map((name, index) => [name, row[index]]));
      const date = reportingDay(record.day);
      if (date < start || date > end || typeof record.creatorContentType !== 'string') {
        unavailable('invalid-response', 'YouTube returned a row outside the requested reporting window.');
      }
      record.creatorContentType = normalizeYouTubeContentType(record.creatorContentType) ?? record.creatorContentType;
      const key = `${date}:${record.creatorContentType}`;
      if (seen.has(key)) unavailable('pagination', 'YouTube repeated report rows; collection stopped to prevent double counting.');
      seen.add(key);
      for (const metric of YOUTUBE_METRICS) record[metric] = count(record[metric], {
        fractional: metric === 'estimatedMinutesWatched', signed: metric === 'likes',
      });
      rows.push(record);
    }
    if (pageRows.length < 200) { exhausted = true; break; }
    startIndex += pageRows.length;
  }
  if (!exhausted) unavailable('pagination', 'YouTube pagination exceeded the collection limit. No partial report was published.');
  const shorts = rows.filter(row => row.creatorContentType === 'SHORTS');
  if (!shorts.length) unavailable('no-data', 'YouTube returned no Shorts rows for this window. Missing or delayed data was not converted to zero.');
  const lastReportedDay = rows.reduce((latest, row) => row.day > latest ? row.day : latest, start);
  const sum = metric => shorts.reduce((total, row) => total + row[metric], 0);
  return validatedSource({
    id: 'youtube-shorts', label: 'YouTube Shorts',
    accountLabel: publicText(env.YOUTUBE_ACCOUNT_LABEL, 'Authorized YouTube channel'),
    status: 'snapshot', capturedAt,
    dateRange: { start, end: lastReportedDay, timezone: 'America/Los_Angeles' },
    scope: `Owned-channel Shorts only, selected by YouTube creatorContentType. Counts sum returned daily rows for ${start} through ${lastReportedDay}; requested through ${end}. Missing dates remain missing. Processing can lag; the latest returned date is not a guarantee that every day is final. Excludes long-form and live video. Followers are unavailable in this report.`,
    provenance: { kind: 'official-api', label: YOUTUBE_ANALYTICS_PROVENANCE },
    metrics: {
      views: sum('views'), engagedViews: sum('engagedViews'),
      watchHours: sum('estimatedMinutesWatched') / 60,
      likes: sum('likes'), comments: sum('comments'), shares: sum('shares'),
      followers: null, subscribersNet: sum('subscribersGained') - sum('subscribersLost'),
    },
    daily: shorts.map(row => ({ day: row.day, views: row.views })),
    content: [],
  });
}

function tiktokPayload(payload) {
  if (!payload.error || payload.error.code !== 'ok' || !payload.data || typeof payload.data !== 'object') {
    unavailable('api-error', 'TikTok rejected the request or returned an incomplete response. Verify the approved scopes and account grant.');
  }
  return payload.data;
}

function tiktokCanonicalUrl(value) {
  let url;
  try { url = new URL(value); } catch { unavailable('invalid-response', 'TikTok returned an invalid public video URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(url.hostname) ||
      !/^\/@[A-Za-z0-9_.]+\/video\/\d+\/?$/.test(url.pathname)) {
    unavailable('invalid-response', 'TikTok returned an unexpected public video URL.');
  }
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Display API counters are lifetime observations, not period analytics. They
 * intentionally produce no daily view series or invented watch-time metrics.
 */
export async function collectTikTok({
  env = process.env, fetchImpl = fetch, capturedAt = new Date().toISOString(),
} = {}) {
  if (!env.TIKTOK_ACCESS_TOKEN) unavailable('not-configured', 'TikTok needs an approved application, account authorization and TIKTOK_ACCESS_TOKEN on the server.');
  const accessToken = tokenValue(env.TIKTOK_ACCESS_TOKEN);
  const headers = { Authorization: `Bearer ${accessToken}` };
  const profile = tiktokPayload(await requestPlatformJson(fetchImpl,
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,follower_count',
    { headers })).user;
  if (!profile || typeof profile.open_id !== 'string' || !profile.open_id) {
    unavailable('invalid-response', 'TikTok did not return the authorized account identity.');
  }
  if (env.TIKTOK_OPEN_ID && profile.open_id !== env.TIKTOK_OPEN_ID) {
    unavailable('authorization', 'TikTok returned a different account from the saved connection.');
  }
  const content = [];
  const ids = new Set();
  const cursors = new Set();
  let cursor;
  let exhausted = false;
  for (let page = 0; page < 2500; page++) {
    const data = tiktokPayload(await requestPlatformJson(fetchImpl,
      `https://open.tiktokapis.com/v2/video/list/?fields=${TIKTOK_VIDEO_FIELDS.join(',')}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_count: 20, ...(cursor === undefined ? {} : { cursor }) }),
      }));
    if (!Array.isArray(data.videos) || data.videos.length > 20 || typeof data.has_more !== 'boolean') {
      unavailable('invalid-response', 'TikTok returned an invalid video page.');
    }
    for (const item of data.videos) {
      if (!item || typeof item.id !== 'string' || !/^\d+$/.test(item.id) || ids.has(item.id)) {
        unavailable('pagination', 'TikTok returned invalid or repeated video IDs; collection stopped to prevent double counting.');
      }
      ids.add(item.id);
      const createTime = count(item.create_time);
      const date = new Date(createTime * 1000);
      if (!Number.isFinite(date.getTime())) unavailable('invalid-response', 'TikTok returned an invalid publication timestamp.');
      content.push({
        id: item.id,
        title: publicText(item.title || item.video_description, 'Untitled TikTok video', 1000),
        url: tiktokCanonicalUrl(item.share_url), publishedAt: date.toISOString(), thumbnail: null,
        views: count(item.view_count, { optional: true }),
        likes: count(item.like_count, { optional: true }),
        comments: count(item.comment_count, { optional: true }),
        shares: count(item.share_count, { optional: true }),
      });
    }
    if (!data.has_more) { exhausted = true; break; }
    if (!data.videos.length || !Number.isSafeInteger(data.cursor) || data.cursor < 0 || cursors.has(data.cursor)) {
      unavailable('pagination', 'TikTok pagination did not advance. No partial report was published.');
    }
    cursors.add(data.cursor);
    cursor = data.cursor;
  }
  if (!exhausted) unavailable('pagination', 'TikTok pagination exceeded the collection limit. No partial report was published.');
  const observedDay = capturedAt.slice(0, 10);
  const sum = metric => content.some(item => item[metric] === null) ? null : content.reduce((total, item) => total + item[metric], 0);
  return validatedSource({
    id: 'tiktok', label: 'TikTok',
    accountLabel: publicText(env.TIKTOK_ACCOUNT_LABEL || profile.display_name, 'Authorized TikTok account'),
    status: 'snapshot', capturedAt,
    dateRange: { start: observedDay, end: observedDay, timezone: 'UTC' },
    scope: `Lifetime counters observed on ${observedDay} for all ${content.length} public videos returned by TikTok Display API. The date is the observation date, not a daily or reporting-period total. Account followers are current. Deleted/private videos are excluded; view totals are not unique people. Watch time, retention and historical daily views are unavailable from this endpoint.`,
    provenance: { kind: 'official-api', label: 'TikTok Display API v2 — public video lifetime counters' },
    metrics: {
      views: sum('views'), engagedViews: null, watchHours: null,
      likes: sum('likes'), comments: sum('comments'), shares: sum('shares'),
      followers: count(profile.follower_count, { optional: true }), subscribersNet: null,
    },
    daily: [], content,
  });
}

export async function collectInstagram() {
  unavailable('blocked', 'Instagram setup is pending: create the Meta application, authorize the professional account, and verify its API version and supported insights metric matrix before enabling collection.');
}

export async function collectSocial({
  sources = ['youtube-shorts', 'instagram', 'tiktok'],
  env = process.env, fetchImpl = fetch, start, end, capturedAt = new Date().toISOString(),
} = {}) {
  const adapters = { 'youtube-shorts': collectYouTubeShorts, instagram: collectInstagram, tiktok: collectTikTok };
  if (!sources.length || sources.some(id => !Object.hasOwn(adapters, id)) || new Set(sources).size !== sources.length) {
    unavailable('configuration', 'Choose unique supported sources: youtube-shorts, instagram, tiktok.');
  }
  const results = await Promise.all(sources.map(async id => {
    try {
      const source = await adapters[id]({ env, fetchImpl, start, end, capturedAt });
      return { source, status: { id, status: 'ready', message: 'A validated dated snapshot was collected.' } };
    } catch (error) {
      const known = error instanceof CollectionError;
      const state = known && error.code === 'not-configured' ? 'not-configured'
        : known && ['blocked', 'configuration'].includes(error.code) ? 'blocked' : 'failed';
      return {
        source: null,
        status: {
          id, status: state,
          code: known ? error.code : 'collection-failed',
          message: known ? error.message : 'Collection failed. The previous snapshot was retained.',
        },
      };
    }
  }));
  return {
    document: { schemaVersion: 1, sources: results.flatMap(result => result.source ? [result.source] : []) },
    statuses: results.map(result => result.status),
  };
}
