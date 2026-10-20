import { getGoogleAccessToken, requestPlatformJson, CollectionError } from './collectors.mjs';
import { windowMetrics } from './workshop-model.mjs';
import { readFile, writeFile, mkdir, lstat, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const ACTIVITY_METRICS = Object.freeze([
  'views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage',
  'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'
]);
export const REPORTS = Object.freeze({
  daily: { dimensions: 'day', metrics: ACTIVITY_METRICS.join(','), sort: 'day' },
  aggregate: { metrics: ACTIVITY_METRICS.join(',') },
  contentType: { dimensions: 'creatorContentType', metrics: 'views,estimatedMinutesWatched' },
  retention: { dimensions: 'elapsedVideoTimeRatio', metrics: 'audienceWatchRatio,relativeRetentionPerformance' },
  // averageViewDuration is deliberately excluded: the channel traffic-source
  // report supports views / engagedViews / estimatedMinutesWatched only.
  traffic: { dimensions: 'insightTrafficSourceType', metrics: 'views,estimatedMinutesWatched' }
});
const API = 'https://youtubeanalytics.googleapis.com/v2/reports';
const DATA_API = 'https://www.googleapis.com/youtube/v3/';
const fail = (code, message) => { throw new CollectionError(code, message); };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function reportingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    fail('configuration', 'Supply a valid --end date in YYYY-MM-DD format.');
  }
  return value;
}
export function pacificDate(timestamp) {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) fail('invalid-response', 'A publication timestamp is invalid.');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}
export function durationSeconds(value) {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value || '');
  if (!match) fail('invalid-response', 'A selected video returned an unsupported duration.');
  const seconds = Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  if (!(seconds > 0)) fail('invalid-response', 'A selected video does not have a positive recorded duration.');
  return seconds;
}
function count(value) {
  if (value === undefined || value === null) return null;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail('invalid-response', 'YouTube returned an invalid public counter.');
  return Number(value);
}
function thumbnail(value) {
  if (!value || typeof value.url !== 'string') return null;
  let url;
  try { url = new URL(value.url); } catch { fail('invalid-response', 'YouTube returned an invalid thumbnail URL.'); }
  if (url.protocol !== 'https:' || !['i.ytimg.com', 'i9.ytimg.com'].includes(url.hostname) || url.username || url.password) fail('invalid-response', 'YouTube returned an unexpected thumbnail host.');
  return { url: url.href, width: Number.isFinite(value.width) ? value.width : null, height: Number.isFinite(value.height) ? value.height : null };
}

export function decodeReport(payload, report) {
  if (payload.error) fail('api-error', 'YouTube rejected a report. No snapshot was replaced.');
  const expected = [...(report.dimensions ? report.dimensions.split(',') : []), ...report.metrics.split(',')];
  const headers = payload.columnHeaders?.map(header => header.name);
  if (!Array.isArray(headers) || headers.length !== expected.length || new Set(headers).size !== headers.length || expected.some(name => !headers.includes(name))) {
    fail('invalid-response', 'A YouTube report has unexpected columns. No snapshot was replaced.');
  }
  if (payload.rows === undefined) return [];
  if (!Array.isArray(payload.rows)) fail('invalid-response', 'A YouTube report has invalid rows.');
  const dimensions = new Set((report.dimensions || '').split(','));
  return payload.rows.map(row => {
    if (!Array.isArray(row) || row.length !== headers.length) fail('invalid-response', 'A YouTube report row is incomplete.');
    return Object.fromEntries(headers.map((name, index) => {
      const value = row[index];
      if (dimensions.has(name) && name !== 'elapsedVideoTimeRatio') {
        if (typeof value !== 'string' || !value.length || value.length > 150) fail('invalid-response', 'A YouTube report dimension is invalid.');
        if (name === 'day') reportingDate(value);
      } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail('invalid-response', 'A YouTube report metric is missing or invalid.');
      }
      if ((name === 'elapsedVideoTimeRatio' || name === 'relativeRetentionPerformance') && value > 1) fail('invalid-response', 'A YouTube retention ratio is out of range.');
      return [name, value];
    }));
  });
}

function assertUnique(rows, key) {
  if (new Set(rows.map(row => row[key])).size !== rows.length) fail('invalid-response', `YouTube returned duplicate ${key} rows. No snapshot was replaced.`);
}

/**
 * All Google requests are read-only GETs except the OAuth token refresh.
 * A complete selected-video refresh is returned only after every HTTP/report
 * validation succeeds. Callers must explicitly opt into committing it.
 */
export async function collectYouTubeEpisodes({
  snapshot, end, env = process.env, fetchImpl = fetch, capturedAt = new Date().toISOString()
}) {
  end = reportingDate(end);
  if (end >= pacificDate(capturedAt)) fail('configuration', 'The requested end must precede the current Pacific calendar date.');
  if (!Array.isArray(snapshot?.videos) || !snapshot.videos.length || snapshot.videos.length > 50 || snapshot.videos.some(video => !validId(video.id)) || new Set(snapshot.videos.map(video => video.id)).size !== snapshot.videos.length) {
    fail('configuration', 'The snapshot must contain 1–50 unique, valid selected YouTube video IDs.');
  }
  if (snapshot.apiThrough && end < snapshot.apiThrough) fail('configuration', 'The requested end precedes the saved API snapshot. Refusing to shorten coverage.');
  const token = await getGoogleAccessToken(env, fetchImpl);
  const headers = { Authorization: `Bearer ${token}` };
  const requests = [];
  const get = async (base, parameters) => {
    const url = new URL(base);
    Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const payload = await requestPlatformJson(fetchImpl, url.href, { method: 'GET', headers });
    if (payload.error) fail('api-error', 'Google rejected a read-only request. No snapshot was replaced.');
    return payload;
  };
  const channels = await get(`${DATA_API}channels`, { part: 'id', mine: 'true', maxResults: 50 });
  const ownedChannels = new Set((channels.items || []).map(item => item.id));
  if (!ownedChannels.size || channels.nextPageToken) fail('authorization', 'The authorised YouTube channel could not be established unambiguously.');
  const metadataResponse = await get(`${DATA_API}videos`, { part: 'snippet,contentDetails,status,statistics', id: snapshot.videos.map(video => video.id).join(',') });
  const metadataItems = metadataResponse.items || [];
  if (metadataItems.length !== snapshot.videos.length || new Set(metadataItems.map(item => item.id)).size !== snapshot.videos.length) {
    fail('invalid-response', 'YouTube did not return every selected video. The previous snapshot was retained.');
  }
  const metadata = new Map();
  for (const video of snapshot.videos) {
    const item = metadataItems.find(item => item.id === video.id);
    if (!item || !ownedChannels.has(item.snippet?.channelId)) fail('authorization', 'A selected video does not belong to the authorised channel.');
    if (item.status?.privacyStatus !== 'public') fail('privacy', 'A selected video is not public. Refusing to include its metadata in the public reporting source.');
    if (typeof item.snippet?.title !== 'string' || !item.snippet.title.length || typeof item.snippet.description !== 'string') fail('invalid-response', 'YouTube returned incomplete video metadata.');
    const publishedDate = pacificDate(item.snippet.publishedAt);
    if (publishedDate !== pacificDate(video.publishedAt)) fail('invalid-response', 'A selected publication date changed. Review the saved chronology before refreshing.');
    if (publishedDate > end) fail('configuration', 'The requested end is earlier than a selected video publication date.');
    if (item.snippet.tags !== undefined && (!Array.isArray(item.snippet.tags) || item.snippet.tags.some(tag => typeof tag !== 'string'))) fail('invalid-response', 'YouTube returned invalid tags.');
    const thumbnails = Object.fromEntries(Object.entries(item.snippet.thumbnails || {}).map(([name, value]) => [name, thumbnail(value)]).filter(([, value]) => value));
    const best = ['uhd', 'qhd', 'fhd', 'maxres', 'standard', 'high', 'medium', 'default'].map(size => thumbnails[size]).find(Boolean) || null;
    metadata.set(video.id, {
      source: 'YouTube Data API videos.list', capturedAt, channelId: item.snippet.channelId,
      title: item.snippet.title, description: item.snippet.description,
      tags: item.snippet.tags || [], tagsFieldReturned: Object.hasOwn(item.snippet, 'tags'),
      publishedAt: item.snippet.publishedAt, durationSeconds: durationSeconds(item.contentDetails?.duration),
      thumbnail: best, thumbnails, privacyStatus: item.status.privacyStatus,
      publicCounters: { views: count(item.statistics?.viewCount), likes: count(item.statistics?.likeCount), comments: count(item.statistics?.commentCount) }
    });
  }
  const query = async (video, type, through, paginate = false) => {
    const report = REPORTS[type];
    const parameters = { ids: 'channel==MINE', startDate: pacificDate(video.publishedAt), endDate: through, filters: `video==${video.id}`, ...report };
    const rows = [];
    for (let page = 0; page < (paginate ? 100 : 1); page++) {
      const request = paginate ? { ...parameters, startIndex: page * 200 + 1, maxResults: 200 } : parameters;
      const payload = await get(API, request);
      const decoded = decodeReport(payload, report);
      requests.push({ videoId: video.id, report: type, parameters: request, rowsReturned: decoded.length });
      rows.push(...decoded);
      if (!paginate || decoded.length < 200) return rows;
    }
    fail('pagination', 'A report exceeded the supported pagination limit. No snapshot was replaced.');
  };
  // Use the exact same metric set as aggregate reports to establish the common
  // processed date. Requested endDate is never claimed as returned coverage.
  const dailyById = new Map();
  for (const video of snapshot.videos) {
    const daily = await query(video, 'daily', end, true);
    if (!daily.length) fail('no-data', 'A selected video has no returned daily report. The previous snapshot was retained.');
    assertUnique(daily, 'day');
    const start = pacificDate(video.publishedAt);
    if (daily.some(row => row.day < start || row.day > end)) fail('invalid-response', 'A daily report contains a date outside its requested window.');
    daily.sort((a, b) => a.day.localeCompare(b.day));
    dailyById.set(video.id, daily);
  }
  const dailyLists = [...dailyById.values()];
  const sharedDates = dailyLists[0].map(row => row.day).filter(day => dailyLists.every(rows => rows.some(row => row.day === day)));
  const through = sharedDates.sort().at(-1);
  if (!through) fail('no-data', 'The selected videos have no common returned reporting date.');
  if (snapshot.apiThrough && through < snapshot.apiThrough) fail('stale-data', 'Returned data ends before the saved snapshot. No snapshot was replaced.');
  const next = structuredClone(snapshot);
  const warnings = [];
  for (const video of next.videos) {
    video.packagingCapturedAt ??= snapshot.capturedAt;
    const contentType = await query(video, 'contentType', through);
    if (!contentType.length || contentType.some(row => row.creatorContentType !== 'VIDEO_ON_DEMAND')) fail('content-type', 'Every selected video must be confirmed as VIDEO_ON_DEMAND by Analytics. Shorts, live streams and unknown content are excluded.');
    const aggregate = await query(video, 'aggregate', through);
    if (aggregate.length !== 1) fail('no-data', 'A selected video does not have one complete aggregate report.');
    const retention = await query(video, 'retention', through);
    assertUnique(retention, 'elapsedVideoTimeRatio');
    const traffic = await query(video, 'traffic', through, true);
    assertUnique(traffic, 'insightTrafficSourceType');
    const previousSource = { capturedAt: snapshot.capturedAt, start: pacificDate(video.publishedAt), end: snapshot.apiThrough, timezone: 'America/Los_Angeles', status: 'retained-historical' };
    const source = { capturedAt, start: pacificDate(video.publishedAt), end: through, requestedEnd: end, timezone: 'America/Los_Angeles', status: 'collected' };
    video.daily = dailyById.get(video.id).filter(row => row.day <= through);
    if (!video.daily.length) fail('no-data', 'A selected video has no dates inside the common reporting window.');
    // Earlier observations missing from a fresh result are not silently erased.
    const returnedDates = new Set(video.daily.map(row => row.day));
    const oldVideo = snapshot.videos.find(item => item.id === video.id);
    if ((oldVideo.daily || []).some(row => row.day <= through && !returnedDates.has(row.day))) fail('coverage-loss', 'A new report omits a previously recorded date. The previous snapshot was retained for review.');
    video.apiAggregate = { video: video.id, ...aggregate[0] };
    video.dailyCoverage = [video.daily[0].day, video.daily.at(-1).day];
    video.firstThreeAvailableCalendarDates = video.daily.slice(0, 3);
    video.subscribersNet = aggregate[0].subscribersGained - aggregate[0].subscribersLost;
    video.analyticsSource = source;
    video.contentTypeEvidence = { creatorContentType: 'VIDEO_ON_DEMAND', capturedAt, start: source.start, end: through, source: 'YouTube Analytics API' };
    if (video.metadata) video.metadataHistory = [...(video.metadataHistory || []), video.metadata];
    video.metadata = metadata.get(video.id);
    // Keep original local title/image and Studio cards together. Refreshed
    // metadata is a separate exact-date observation, never a historical test.
    if (retention.length) {
      video.retention = retention.sort((a, b) => a.elapsedVideoTimeRatio - b.elapsedVideoTimeRatio);
      const seconds = video.metadata.durationSeconds;
      const closest = video.retention.reduce((best, point) => Math.abs(point.elapsedVideoTimeRatio * seconds - 30) < Math.abs(best.elapsedVideoTimeRatio * seconds - 30) ? point : best);
      video.retentionNear30Seconds = { ...closest, sampledSeconds: closest.elapsedVideoTimeRatio * seconds };
      video.retentionSource = { ...source, durationSeconds: seconds, endStatus: 'query-bound-no-daily-completeness-signal' };
    } else {
      video.retentionSource ||= previousSource;
      warnings.push(`${video.id}: no new retention rows; previous curve retained with its original source date.`);
    }
    if (traffic.length) {
      video.traffic = traffic;
      video.trafficSource = { ...source, endStatus: 'query-bound-no-daily-completeness-signal' };
    } else {
      video.trafficSource ||= previousSource;
      warnings.push(`${video.id}: no new traffic rows; previous traffic retained with its original source date.`);
    }
    video.refreshReports = { capturedAt, retention: retention.length ? 'collected' : 'no-rows-retained-previous', traffic: traffic.length ? 'collected' : 'no-rows-retained-previous' };
    // Calendar dates in Analytics are Pacific; explicit publicationDate keeps
    // launches near UTC midnight anchored to the correct source day.
    video.reportingPublishedDate = pacificDate(video.publishedAt);
    video.windows = Object.fromEntries([3, 7].map(days => {
      const result = windowMetrics(video, days);
      return [days, { ...result, views: result.complete ? result.views : null, watchHours: result.complete ? result.watchHours : null, subscribersNet: result.complete ? result.subscribersNet : null }];
    }));
  }
  next.capturedAt = capturedAt;
  next.apiThrough = through;
  next.youtubeRefresh = { capturedAt, requestedEnd: end, actualThrough: through, timezone: 'America/Los_Angeles', selectedVideoIds: next.videos.map(video => video.id), warnings, metadataAsOf: capturedAt, preservedStudioCapturedAt: snapshot.studioCapturedAt || null };
  return { snapshot: next, evidence: { schema: 'scran-youtube-refresh-v1', capturedAt, requestedEnd: end, actualThrough: through, requests, warnings }, warnings };
}

async function rejectSymlink(path) {
  try { if ((await lstat(path)).isSymbolicLink()) fail('filesystem', 'Refusing a symbolic link at a snapshot or archive path.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function commitYouTubeRefresh({ root, originalBytes, result }) {
  const dataPath = resolve(root, 'data.json');
  const privateRoot = resolve(root, '.private');
  const archiveDirectory = resolve(privateRoot, 'youtube-imports');
  const lockPath = resolve(privateRoot, 'youtube-sync.lock');
  await rejectSymlink(dataPath);
  await rejectSymlink(privateRoot);
  await mkdir(privateRoot, { recursive: true });
  await rejectSymlink(archiveDirectory);
  await mkdir(archiveDirectory, { recursive: true });
  try { await writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') fail('locked', 'Another YouTube refresh holds the local lock. Wait for it to finish.'); throw error; }
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const temporaryPath = resolve(root, `.youtube-${id}.tmp`);
  const backupPath = resolve(archiveDirectory, `${id}-before.json`);
  try {
    const current = await readFile(dataPath);
    if (sha256(current) !== sha256(originalBytes)) fail('conflict', 'data.json changed during collection. The collected result was not written; rerun against the new snapshot.');
    await writeFile(backupPath, originalBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(resolve(archiveDirectory, `${id}-evidence.json`), JSON.stringify(result.evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(temporaryPath, JSON.stringify(result.snapshot) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, dataPath);
    return { backupPath, apiThrough: result.snapshot.apiThrough };
  } finally {
    await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(lockPath);
  }
}
