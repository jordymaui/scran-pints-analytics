import { getGoogleAccessToken, requestPlatformJson, CollectionError } from './collectors.mjs';
import { windowMetrics, workshopThumbnail } from './workshop-model.mjs';
import { normalizeYouTubeContentType } from './youtube-content-type.mjs';
import { validatePublicYouTubeReport } from './report-model.mjs';
import { collectChannelBreakdowns, collectUploadAnalytics } from './youtube-breakdowns.mjs';
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
  // A multi-ID video filter permits adding video to any report's dimensions.
  // https://developers.google.com/youtube/analytics/reference/reports/query#filters
  discovery: { dimensions: 'video,creatorContentType', metrics: 'views,estimatedMinutesWatched', sort: 'video,creatorContentType' },
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
const MAX_UPLOADS = 5000;
const chunks = (values, size) => Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));

async function mapLimited(values, operation, concurrency = 4) {
  const result = new Array(values.length);
  let cursor = 0, failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failure && cursor < values.length) {
      const index = cursor++;
      try { result[index] = await operation(values[index], index); }
      catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return result;
}

export function reportingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    fail('configuration', 'Supply a valid --end date in YYYY-MM-DD format.');
  }
  return value;
}
export function pacificDate(timestamp) {
  if (typeof timestamp !== 'string' || !timestamp.length) fail('invalid-response', 'A publication timestamp is invalid.');
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
function thumbnail(value, videoId) {
  if (!value || typeof value.url !== 'string') return null;
  let url;
  try { url = new URL(value.url); } catch { fail('invalid-response', 'YouTube returned an invalid thumbnail URL.'); }
  if (!workshopThumbnail(url.href) || url.pathname.split('/')[2] !== videoId) fail('invalid-response', 'YouTube returned an unexpected thumbnail URL.');
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
      // Owner reports returned signed like adjustments. Preserve the native
      // integer without reinterpreting it as dislikes or inferring its cause.
      if (dimensions.has(name) && name !== 'elapsedVideoTimeRatio') {
        if (typeof value !== 'string' || !value.length ||
          value.length > (name === 'insightTrafficSourceDetail' ? 2048 : 150) ||
          /[\u0000-\u001f\u007f]/.test(value)) fail('invalid-response', 'A YouTube report dimension is invalid.');
        if (name === 'day') reportingDate(value);
      } else if (typeof value !== 'number' || !Number.isFinite(value) ||
          (name === 'likes' ? !Number.isSafeInteger(value) : value < 0)) {
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

function channelReportingStart(channel, publicItems, end, capturedAt) {
  const earliestUpload = publicItems.map(item => pacificDate(item.snippet.publishedAt)).sort()[0];
  const publishedAt = channel.snippet?.publishedAt;
  try {
    if (typeof publishedAt === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(publishedAt) &&
        Number.isFinite(Date.parse(publishedAt)) && Date.parse(publishedAt) <= Date.parse(capturedAt) &&
        reportingDate(publishedAt.slice(0, 10))) {
      const start = pacificDate(publishedAt);
      if (start <= end && (!earliestUpload || start <= earliestUpload)) {
        return { start, startBasis: 'channel-created' };
      }
    }
  } catch { /* Invalid creation metadata falls back to the known public catalog. */ }
  if (!earliestUpload || earliestUpload > end) fail('no-data', 'A valid channel reporting start could not be established.');
  return { start: earliestUpload, startBasis: 'earliest-known-public-upload' };
}

function assertActivityCounters(rows) {
  const counters = ['views', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'];
  if (rows.some(row => counters.some(key => !Number.isSafeInteger(row[key])))) {
    fail('invalid-response', 'A channel activity counter is not a valid whole number.');
  }
}

/**
 * All Google requests are read-only GETs except the OAuth token refresh.
 * Public uploads are inventoried through the channel's uploads playlist.
 * Only Analytics-confirmed VIDEO_ON_DEMAND uploads enter episode reporting.
 * Transport/malformed-response failures abort the whole refresh; missing new
 * format/data is an explicit coverage exclusion, never an invented zero.
 */
export async function collectYouTubeEpisodes({
  snapshot, end, env = process.env, fetchImpl = fetch, capturedAt = new Date().toISOString()
}) {
  end = reportingDate(end);
  if (end > pacificDate(capturedAt)) fail('configuration', 'The requested end cannot follow the current Pacific calendar date.');
  if (!Array.isArray(snapshot?.videos) || !snapshot.videos.length || snapshot.videos.length > MAX_UPLOADS || snapshot.videos.some(video => !validId(video.id)) || new Set(snapshot.videos.map(video => video.id)).size !== snapshot.videos.length) {
    fail('configuration', 'The snapshot must contain valid, unique YouTube video IDs within the collection limit.');
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
  const queryRows = async (type, parameters, report, videoIds, paginate = false) => {
    const rows = [];
    // Some official report types are ranked top-25 lists, not an unbounded
    // collection. Honour that API limit and never overwrite it with page size.
    const paged = paginate && !report.maxResults;
    for (let page = 0; page < (paged ? 100 : 1); page++) {
      const request = paged ? { ...parameters, startIndex: page * 200 + 1, maxResults: 200 } : parameters;
      const payload = await get(API, request);
      const decoded = decodeReport(payload, report);
      requests.push({ ...(videoIds.length === 1 ? { videoId: videoIds[0] } : { videoIds }), report: type, parameters: request, rowsReturned: decoded.length });
      rows.push(...decoded);
      if (!paged || decoded.length < 200) return rows;
    }
    fail('pagination', 'A report exceeded the supported pagination limit. No snapshot was replaced.');
  };
  const query = (video, type, through, paginate = false) => queryRows(type, {
    ids: 'channel==MINE', startDate: pacificDate(video.publishedAt), endDate: through,
    filters: `video==${video.id}`, ...REPORTS[type],
  }, REPORTS[type], [video.id], paginate);
  const existing = new Map(snapshot.videos.map(video => [video.id, video]));
  const warnings = [];
  const discovery = {
    status: 'complete', inventoryComplete: false, observedAt: capturedAt,
    publicUploadsCount: 0, confirmedLongformCount: 0, includedLongformCount: 0,
    excludedShortsCount: 0, excludedLiveCount: 0, excludedOtherCount: 0,
    nonPublicOrUnavailableCount: 0, unknownFormatIds: [], unreportedLongformIds: [],
    pendingPublicationIds: [], channelPublicVideoCount: null, supplementalPublicIdsCount: 0,
  };
  const channels = await get(`${DATA_API}channels`, { part: 'id,snippet,contentDetails,statistics', mine: 'true', maxResults: 50 });
  if (!Array.isArray(channels.items) || channels.items.length !== 1 || channels.nextPageToken ||
      typeof channels.items[0].id !== 'string' ||
      (env.YOUTUBE_CHANNEL_ID && env.YOUTUBE_CHANNEL_ID !== 'MINE' && env.YOUTUBE_CHANNEL_ID !== channels.items[0].id)) {
    fail('authorization', 'The authorised YouTube channel could not be established unambiguously.');
  }
  const channel = channels.items[0];
  discovery.channelPublicVideoCount = count(channel.statistics?.videoCount);
  const playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (typeof playlistId !== 'string' || !/^[A-Za-z0-9_-]{10,100}$/.test(playlistId)) fail('invalid-response', 'YouTube did not return the channel uploads playlist.');
  const uploadIds = new Set(), pageTokens = new Set();
  let pageToken, inventoryPages = 0, repeatedUploadEntries = 0;
  do {
    if (inventoryPages++ >= MAX_UPLOADS / 50) fail('pagination', 'The uploads inventory exceeded the safe collection limit; the previous snapshot was kept.');
    const inventory = await get(`${DATA_API}playlistItems`, { part: 'contentDetails', playlistId, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
    if (!Array.isArray(inventory.items) || inventory.items.length > 50) fail('invalid-response', 'The uploads inventory returned invalid items.');
    for (const item of inventory.items) {
      const id = item?.contentDetails?.videoId;
      if (!validId(id)) fail('invalid-response', 'The uploads inventory contains an invalid video ID. The previous snapshot was retained.');
      // The owner uploads playlist can repeat a valid video across entries or
      // pages. Collect its metadata/report once; pagination guards stay separate.
      if (uploadIds.has(id)) { repeatedUploadEntries++; continue; }
      uploadIds.add(id);
    }
    pageToken = inventory.nextPageToken;
    if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || pageToken.length > 2048 || /[\s\u0000-\u001f]/.test(pageToken) || pageTokens.has(pageToken))) fail('pagination', 'The uploads inventory returned an invalid or repeated page token.');
    if (pageToken) pageTokens.add(pageToken);
    if (uploadIds.size > MAX_UPLOADS) fail('pagination', 'The uploads inventory exceeded the safe collection limit; the previous snapshot was kept.');
  } while (pageToken);
  if (repeatedUploadEntries) warnings.push(`The uploads playlist returned ${repeatedUploadEntries} repeated entries; each unique video was collected once.`);
  // Owner playlist pages can omit IDs present in an independently collected
  // public inventory. Treat that validated catalog only as ID candidates: every
  // supplemental ID still needs fresh owner metadata and format checks below.
  let publicInventory = null;
  if (snapshot.publicReport) {
    try {
      const validated = validatePublicYouTubeReport(snapshot.publicReport);
      if (validated.channel.id === channel.id) publicInventory = validated;
    } catch { /* A malformed optional public catalog cannot establish any IDs. */ }
  }
  for (const item of publicInventory?.content || []) {
    if (!uploadIds.has(item.id)) {
      uploadIds.add(item.id);
      discovery.supplementalPublicIdsCount++;
      if (uploadIds.size > MAX_UPLOADS) fail('pagination', 'The combined uploads inventory exceeded the safe collection limit; the previous snapshot was kept.');
    }
  }
  if ([...existing.keys()].some(id => !uploadIds.has(id))) fail('coverage-loss', 'A previously included video is missing from the channel uploads inventory. The previous snapshot was retained for review.');
  const metadataItems = (await mapLimited(chunks([...uploadIds], 50), async ids => {
    const result = await get(`${DATA_API}videos`, { part: 'snippet,contentDetails,status,statistics', id: ids.join(',') });
    if (!Array.isArray(result.items) || result.items.some(item => !ids.includes(item.id)) || new Set(result.items.map(item => item.id)).size !== result.items.length) fail('invalid-response', 'YouTube returned an invalid video metadata batch.');
    return result.items;
  })).flat();
  const itemsById = new Map(metadataItems.map(item => [item.id, item]));
  const publicItems = [];
  for (const id of uploadIds) {
    const item = itemsById.get(id);
    if (!item || item.status?.privacyStatus !== 'public') {
      if (existing.has(id)) fail('privacy', 'A previously included video is unavailable or no longer public. The previous snapshot was retained for review.');
      discovery.nonPublicOrUnavailableCount++;
      continue;
    }
    if (item.snippet?.channelId !== channel.id) fail('authorization', 'An upload does not belong to the authorised channel.');
    if (typeof item.snippet.title !== 'string' || !item.snippet.title.length) fail('invalid-response', 'YouTube returned incomplete public video metadata.');
    const publishedDate = pacificDate(item.snippet.publishedAt);
    const old = existing.get(id);
    if (old && publishedDate !== pacificDate(old.publishedAt)) fail('invalid-response', 'A saved publication date changed. Review the chronology before refreshing.');
    discovery.publicUploadsCount++;
    if (publishedDate > end) {
      if (old) fail('configuration', 'The requested end is earlier than a previously included video publication date.');
      discovery.pendingPublicationIds.push(id);
    } else publicItems.push(item);
  }
  discovery.inventoryComplete = discovery.channelPublicVideoCount !== null &&
    discovery.publicUploadsCount === discovery.channelPublicVideoCount;
  if (!discovery.inventoryComplete) {
    warnings.push(discovery.channelPublicVideoCount === null
      ? 'The channel public video count was unavailable; discovered inventory coverage remains partial.'
      : `The verified inventory contains ${discovery.publicUploadsCount} public uploads; the channel reports ${discovery.channelPublicVideoCount}. Inventory coverage remains partial.`);
  }
  // creatorContentType is available from 2019 onward. Batch classification
  // reduces requests without inferring format from duration, URL or title.
  const typesById = new Map(), typeSources = new Map();
  await mapLimited(chunks(publicItems, 50), async items => {
    const ids = items.map(item => item.id);
    const start = [items.map(item => pacificDate(item.snippet.publishedAt)).sort()[0], '2019-01-01'].sort().at(-1);
    if (start > end) return;
    const report = ids.length === 1 ? REPORTS.contentType : REPORTS.discovery;
    const parameters = { ids: 'channel==MINE', startDate: start, endDate: end, filters: `video==${ids.join(',')}`, ...report };
    const rows = await queryRows('contentType', parameters, report, ids, true);
    const unique = new Set();
    for (const row of rows) {
      const id = ids.length === 1 ? ids[0] : row.video;
      const type = normalizeYouTubeContentType(row.creatorContentType);
      const key = `${id}:${type || row.creatorContentType}`;
      if (!ids.includes(id) || unique.has(key)) fail('invalid-response', 'The format report returned unexpected or repeated video/type rows.');
      unique.add(key);
      if (!typesById.has(id)) typesById.set(id, []);
      typesById.get(id).push(type);
    }
    ids.forEach(id => typeSources.set(id, { start, end }));
  });
  const metadata = new Map(), candidates = [];
  for (const item of publicItems) {
    const types = typesById.get(item.id) || [];
    if (types.length !== 1 || types[0] !== 'VIDEO_ON_DEMAND') {
      if (existing.has(item.id)) fail('content-type', 'A previously included video is not unambiguously confirmed as VIDEO_ON_DEMAND. The previous snapshot was retained.');
      if (types.length === 1 && types[0] === 'SHORTS') discovery.excludedShortsCount++;
      else if (types.length === 1 && types[0] === 'LIVE_STREAM') discovery.excludedLiveCount++;
      else if (types.length === 1 && types[0] === 'STORY') discovery.excludedOtherCount++;
      else discovery.unknownFormatIds.push(item.id);
      continue;
    }
    discovery.confirmedLongformCount++;
    if (typeof item.snippet.description !== 'string' || (item.snippet.tags !== undefined && (!Array.isArray(item.snippet.tags) || item.snippet.tags.some(tag => typeof tag !== 'string')))) fail('invalid-response', 'YouTube returned invalid description or tags.');
    const thumbnails = Object.fromEntries(Object.entries(item.snippet.thumbnails || {}).map(([name, value]) => [name, thumbnail(value, item.id)]).filter(([, value]) => value));
    const best = ['uhd', 'qhd', 'fhd', 'maxres', 'standard', 'high', 'medium', 'default'].map(size => thumbnails[size]).find(Boolean) || null;
    const record = {
      source: 'YouTube Data API videos.list', capturedAt, channelId: item.snippet.channelId,
      title: item.snippet.title, description: item.snippet.description,
      tags: item.snippet.tags || [], tagsFieldReturned: Object.hasOwn(item.snippet, 'tags'),
      publishedAt: item.snippet.publishedAt, durationSeconds: durationSeconds(item.contentDetails?.duration),
      thumbnail: best, thumbnails, privacyStatus: item.status.privacyStatus,
      publicCounters: { views: count(item.statistics?.viewCount), likes: count(item.statistics?.likeCount), comments: count(item.statistics?.commentCount) },
    };
    metadata.set(item.id, record);
    candidates.push(existing.get(item.id) || {
      id: item.id, name: record.title, title: record.title, episode: null,
      publishedAt: record.publishedAt, durationSeconds: record.durationSeconds,
      thumb: best?.url || null, packagingCapturedAt: capturedAt, discoveredAt: capturedAt,
      retention: [], traffic: [], retentionNear30Seconds: null,
    });
  }
  if (candidates.length > 1000) fail('pagination', 'The verified long-form catalog exceeds the current snapshot limit. The previous snapshot was kept.');
  // Channel activity establishes which date this exact metric set has reached.
  // Requiring a latest-day row for every individual upload would mistake quiet
  // or omitted video-days for an unprocessed channel and pin coverage forever.
  // The unfiltered channel report also retains all-format activity, including
  // Shorts before the first long-form upload. It is never a sum of video rows.
  const channelWindow = channelReportingStart(channel, publicItems, end, capturedAt);
  const channelStart = channelWindow.start;
  const channelDaily = await queryRows('channelDaily', {
    ids: 'channel==MINE', startDate: channelStart, endDate: end, ...REPORTS.daily,
  }, REPORTS.daily, [], true);
  assertUnique(channelDaily, 'day');
  assertActivityCounters(channelDaily);
  if (channelDaily.some(row => row.day < channelStart || row.day > end)) fail('invalid-response', 'Channel activity returned a date outside the requested window.');
  channelDaily.sort((a, b) => a.day.localeCompare(b.day));
  const through = channelDaily.at(-1)?.day;
  if (!through) fail('no-data', 'Channel activity did not return a processed reporting date. The previous snapshot was retained.');
  if (snapshot.apiThrough && through < snapshot.apiThrough) fail('stale-data', 'Returned channel activity ends before the saved report. No snapshot was replaced.');
  const channelAggregate = await queryRows('channelAggregate', {
    ids: 'channel==MINE', startDate: channelStart, endDate: through, ...REPORTS.aggregate,
  }, REPORTS.aggregate, []);
  if (channelAggregate.length !== 1) fail('no-data', 'Channel activity did not return one complete aggregate report. The previous snapshot was retained.');
  const channelDates = new Set(channelDaily.map(row => row.day));
  if ((snapshot.channelAnalytics?.daily || []).some(row =>
    row.day >= channelStart && row.day <= through && !channelDates.has(row.day))) {
    fail('coverage-loss', 'Channel activity omitted a previously saved date. The previous snapshot was retained for review.');
  }
  assertActivityCounters(channelAggregate);
  const dailyById = new Map();
  await mapLimited(candidates, async video => {
    if (pacificDate(video.publishedAt) > through) {
      if (existing.has(video.id)) fail('stale-data', 'The processed channel date precedes an already included publication. The previous snapshot was retained.');
      discovery.unreportedLongformIds.push(video.id);
      return;
    }
    const daily = await query(video, 'daily', through, true);
    if (!daily.length) {
      if (existing.has(video.id)) fail('no-data', 'A previously included video has no returned daily report. The previous snapshot was retained.');
      discovery.unreportedLongformIds.push(video.id);
      return;
    }
    assertUnique(daily, 'day');
    const start = pacificDate(video.publishedAt);
    if (daily.some(row => row.day < start || row.day > through)) fail('invalid-response', 'A daily report contains a date outside its requested window.');
    daily.sort((a, b) => a.day.localeCompare(b.day));
    dailyById.set(video.id, daily);
  });
  const next = structuredClone(snapshot);
  const newVideos = candidates.filter(video => !existing.has(video.id) && dailyById.has(video.id)).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));
  next.videos = [...next.videos, ...newVideos];
  next.videos = (await mapLimited(next.videos, async video => {
    video.packagingCapturedAt ??= snapshot.capturedAt;
    const aggregate = await query(video, 'aggregate', through);
    if (aggregate.length !== 1) {
      if (aggregate.length || existing.has(video.id)) fail('no-data', 'A previously included video does not have one complete aggregate report.');
      discovery.unreportedLongformIds.push(video.id);
      return null;
    }
    const retention = await query(video, 'retention', through);
    assertUnique(retention, 'elapsedVideoTimeRatio');
    const traffic = await query(video, 'traffic', through, true);
    assertUnique(traffic, 'insightTrafficSourceType');
    const previousSource = { capturedAt: snapshot.capturedAt, start: pacificDate(video.publishedAt), end: snapshot.apiThrough, timezone: 'America/Los_Angeles', status: 'retained-historical' };
    const source = { capturedAt, start: pacificDate(video.publishedAt), end: through, requestedEnd: end, timezone: 'America/Los_Angeles', status: 'collected', endStatus: 'channel-daily-completeness-bound' };
    video.daily = dailyById.get(video.id).filter(row => row.day <= through);
    if (!video.daily.length) fail('no-data', 'A selected video has no dates inside the common reporting window.');
    // Earlier observations missing from a fresh result are not silently erased.
    const returnedDates = new Set(video.daily.map(row => row.day));
    const oldVideo = snapshot.videos.find(item => item.id === video.id);
    if ((oldVideo?.daily || []).some(row => row.day <= through && !returnedDates.has(row.day))) fail('coverage-loss', 'A new report omits a previously recorded date. The previous snapshot was retained for review.');
    video.apiAggregate = { video: video.id, ...aggregate[0] };
    video.dailyCoverage = [video.daily[0].day, video.daily.at(-1).day];
    video.firstThreeAvailableCalendarDates = video.daily.slice(0, 3);
    video.subscribersNet = aggregate[0].subscribersGained - aggregate[0].subscribersLost;
    video.analyticsSource = source;
    video.contentTypeEvidence = { creatorContentType: 'VIDEO_ON_DEMAND', capturedAt, ...typeSources.get(video.id), source: 'YouTube Analytics API' };
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
      video.retentionSource ||= existing.has(video.id) ? previousSource : { ...source, status: 'unavailable' };
      warnings.push(`${video.id}: no new retention rows; ${existing.has(video.id) ? 'previous curve retained with its original source date' : 'retention unavailable'}.`);
    }
    if (traffic.length) {
      video.traffic = traffic;
      video.trafficSource = { ...source, endStatus: 'query-bound-no-daily-completeness-signal' };
    } else {
      video.trafficSource ||= existing.has(video.id) ? previousSource : { ...source, status: 'unavailable' };
      warnings.push(`${video.id}: no new traffic rows; ${existing.has(video.id) ? 'previous traffic retained with its original source date' : 'traffic unavailable'}.`);
    }
    video.refreshReports = { capturedAt, retention: retention.length ? 'collected' : existing.has(video.id) ? 'no-rows-retained-previous' : 'no-rows', traffic: traffic.length ? 'collected' : existing.has(video.id) ? 'no-rows-retained-previous' : 'no-rows' };
    // Calendar dates in Analytics are Pacific; explicit publicationDate keeps
    // launches near UTC midnight anchored to the correct source day.
    video.reportingPublishedDate = pacificDate(video.publishedAt);
    video.windows = Object.fromEntries([3, 7].map(days => {
      const result = windowMetrics(video, days);
      return [days, { ...result, views: result.complete ? result.views : null, watchHours: result.complete ? result.watchHours : null, subscribersNet: result.complete ? result.subscribersNet : null }];
    }));
    return video;
  })).filter(Boolean);
  for (const key of ['unknownFormatIds', 'unreportedLongformIds', 'pendingPublicationIds']) discovery[key] = [...new Set(discovery[key])].sort();
  discovery.includedLongformCount = next.videos.length;
  if (!discovery.inventoryComplete || discovery.unknownFormatIds.length || discovery.unreportedLongformIds.length || discovery.pendingPublicationIds.length) {
    discovery.status = 'partial';
  }
  if (discovery.unknownFormatIds.length || discovery.unreportedLongformIds.length || discovery.pendingPublicationIds.length) {
    warnings.push(`Discovery exclusions: ${discovery.unknownFormatIds.length} public uploads have unknown format, ${discovery.unreportedLongformIds.length} verified long-form uploads lack returned reporting data, ${discovery.pendingPublicationIds.length} uploads were published after the reporting cutoff.`);
  }
  next.capturedAt = capturedAt;
  next.apiThrough = through;
  next.channelAnalytics = {
    capturedAt, channelId: channel.id,
    dateRange: { start: channelStart, end: through, timezone: 'America/Los_Angeles' },
    aggregate: channelAggregate[0], daily: channelDaily,
    coverage: { startBasis: channelWindow.startBasis, endBasis: 'channel-daily-same-metrics' },
  };
  next.channelBreakdowns = await collectChannelBreakdowns({
    previous: snapshot.channelBreakdowns, capturedAt, start: channelStart, end: through,
    query: ({ id, report, startDate, endDate }) => queryRows(`channel-${id}`, {
      ids: 'channel==MINE', startDate, endDate, ...report,
    }, report, [], true),
  });
  const publicCatalog = metadataItems.filter(item => item.status?.privacyStatus === 'public').map(item => {
    const thumbnails = Object.values(item.snippet.thumbnails || {})
      .map(value => thumbnail(value, item.id)).filter(Boolean)
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    let seconds = null;
    try { seconds = durationSeconds(item.contentDetails?.duration); }
    catch { /* Upcoming or current live uploads can lack a final duration. */ }
    const types = typesById.get(item.id) || [];
    const oldVideo = existing.get(item.id);
    const metadataHistory = [...(oldVideo?.metadataHistory || []), ...(oldVideo?.metadata ? [oldVideo.metadata] : [])]
      .filter(observation => observation.privacyStatus === 'public' && observation.channelId === channel.id)
      .map(observation => ({ capturedAt: observation.capturedAt, title: observation.title,
        description: observation.description, tags: observation.tags, thumbnail: observation.thumbnail?.url || null }));
    return {
      id: item.id, title: item.snippet.title, publishedAt: item.snippet.publishedAt,
      description: item.snippet.description,
      tags: Array.isArray(item.snippet.tags) ? item.snippet.tags : [], metadataHistory,
      durationSeconds: seconds, thumbnail: thumbnails[0]?.url || null,
      creatorContentType: types.length === 1 && types[0] ? types[0] : 'UNSPECIFIED',
    };
  }).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));
  next.uploadAnalytics = await collectUploadAnalytics({
    catalog: publicCatalog, previous: snapshot.uploadAnalytics, capturedAt,
    channelId: channel.id, start: channelStart, end: through,
    coverage: { scope: 'verified-public-uploads', inventoryComplete: discovery.inventoryComplete,
      publicUploadsCount: discovery.publicUploadsCount, channelPublicVideoCount: discovery.channelPublicVideoCount },
    query: ({ type, report, videoIds, startDate, endDate }) => queryRows(`upload-${type}`, {
      ids: 'channel==MINE', startDate, endDate, filters: `video==${videoIds.join(',')}`, ...report,
    }, report, videoIds, type !== 'retention'),
  });
  const breakdownFailures = Object.values(next.channelBreakdowns).filter(entry => entry.status.startsWith('failed')).length;
  if (breakdownFailures) warnings.push(`${breakdownFailures} optional channel reports failed; any earlier valid reports retain their original dates.`);
  const uploadEntries = next.uploadAnalytics.videos.flatMap(video =>
    ['aggregate', 'daily', 'retention', 'traffic'].map(id => video[id]));
  const uploadFailures = uploadEntries.filter(entry => entry.status.startsWith('failed')).length;
  const uploadEmpty = uploadEntries.filter(entry => entry.status.startsWith('no-rows')).length;
  if (uploadFailures || uploadEmpty) warnings.push(`All-upload reports: ${uploadFailures} failed, ${uploadEmpty} returned no rows; each upload retains explicit report status and any earlier valid source dates.`);
  next.youtubeRefresh = { capturedAt, requestedEnd: end, actualThrough: through, coverageBasis: 'channel-daily-same-metrics', timezone: 'America/Los_Angeles', selectedVideoIds: next.videos.map(video => video.id), discovery, warnings, metadataAsOf: capturedAt, preservedStudioCapturedAt: snapshot.studioCapturedAt || null };
  return { snapshot: next, evidence: { schema: 'scran-youtube-refresh-v1', capturedAt, requestedEnd: end, actualThrough: through, discovery, requests, warnings }, warnings };
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
