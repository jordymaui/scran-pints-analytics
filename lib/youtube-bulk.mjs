// Server-only YouTube Reporting API reach ingestion. Does not edit videos.
import { CollectionError, getGoogleAccessToken } from './collectors.mjs';

export const REACH_REPORT_TYPE = 'channel_reach_basic_a1';
const SOURCE = 'youtube-reporting-reach';
const ORIGIN = 'https://youtubereporting.googleapis.com';
const CHANNEL = 'UCAX4l1JUAymaMHVKiRFzK-A';
const ZONE = 'America/Los_Angeles';
const CSV_HEADERS = ['date', 'channel_id', 'video_id', 'video_thumbnail_impressions', 'video_thumbnail_impressions_ctr'];
const MAX_CSV_BYTES = 8 * 1024 * 1024;
const MAX_REPORTS = 3660;
const MAX_ROWS = 200000;
const ERRORS = new Set(['network', 'authorization', 'service-disabled', 'rate-limit', 'http-error',
  'invalid-response', 'pagination', 'limit', 'deferred', 'not-configured']);
const fail = code => { throw new CollectionError(code, 'YouTube bulk reach could not be collected. Earlier valid reports were retained.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const videoId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
const resourceId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const instant = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
  date(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const pacific = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(value));
const safeCode = error => ERRORS.has(error?.code) ? error.code : 'invalid-response';
const period = value => `${value.startTime}/${value.endTime}`;
const rowMetric = (value, integer) => value === null || typeof value === 'number' && Number.isFinite(value) &&
  value >= 0 && (integer ? Number.isSafeInteger(value) : value <= 100);
function ids(values) {
  if (!Array.isArray(values) || values.length > 5000 || values.some(value => !videoId(value))) fail('invalid-response');
  return new Set(values);
}
function windowValid(value, capturedAt) {
  if (!resourceId(value.id) || !resourceId(value.jobId) || !instant(value.startTime) ||
      !instant(value.endTime) || !instant(value.createTime) ||
      Date.parse(value.createTime) > Date.parse(capturedAt) ||
      Date.parse(value.endTime) > Date.parse(value.createTime)) return false;
  const duration = Date.parse(value.endTime) - Date.parse(value.startTime);
  // A Pacific calendar date can be 23/24/25 hours at DST transitions.
  return duration >= 23 * 3600000 && duration <= 25 * 3600000 &&
    pacific(value.startTime) === pacific(new Date(Date.parse(value.endTime) - 1).toISOString());
}
function numericCell(value, integer) {
  if (value === '') return null;
  if (!/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) fail('invalid-response');
  const result = Number(value);
  if (!rowMetric(result, integer)) fail('invalid-response');
  return result;
}

// RFC 4180 quoting, CRLF/LF and BOM; bounded input, no eval or raw CSV passthrough.
function csv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) fail('limit');
  const output = [];
  let row = [], field = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; } else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; closed = false;
      if (char !== ',') {
        if (char === '\r' && text[index + 1] === '\n') index++;
        if (row.length > 1 || row[0] !== '') output.push(row);
        row = [];
      }
    } else if (char === '"' && !field && !closed) quoted = true;
    else {
      if (closed || char === '"') fail('invalid-response');
      field += char;
    }
    if (field.length > 2048 || row.length > 50 || output.length > 100000) fail('limit');
  }
  if (quoted) fail('invalid-response');
  if (field || row.length || closed) { row.push(field); output.push(row); }
  return output;
}

export function parseYouTubeReachCsv(text, { channelId = CHANNEL, publicVideoIds, reportDate } = {}) {
  const visible = ids(publicVideoIds);
  if (!date(reportDate)) fail('invalid-response');
  const records = csv(text), headers = records.shift();
  if (!headers || headers.length !== CSV_HEADERS.length || new Set(headers).size !== headers.length ||
      CSV_HEADERS.some(key => !headers.includes(key))) fail('invalid-response');
  const seen = new Set(), rows = [];
  for (const values of records) {
    if (values.length !== headers.length) fail('invalid-response');
    const row = Object.fromEntries(headers.map((key, index) => [key, values[index]]));
    const day = /^\d{8}$/.test(row.date) ? `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6)}` : row.date;
    if (!date(day) || day !== reportDate || (row.channel_id && row.channel_id !== channelId) ||
        (row.video_id && !videoId(row.video_id))) fail('invalid-response');
    const impressions = numericCell(row.video_thumbnail_impressions, true);
    const impressionsCtr = numericCell(row.video_thumbnail_impressions_ctr, false);
    // Blank IDs represent anonymized/deleted resources. They cannot authorize a public video.
    if (!row.channel_id || !visible.has(row.video_id)) continue;
    if (seen.has(row.video_id)) fail('invalid-response');
    seen.add(row.video_id);
    rows.push({ date: day, videoId: row.video_id, impressions, impressionsCtr });
  }
  return rows.sort((a, b) => a.videoId.localeCompare(b.videoId));
}

export function validateYouTubeBulkReach(value, { channelId = CHANNEL } = {}) {
  if (!keys(value, ['schemaVersion', 'source', 'reportTypeId', 'channelId', 'capturedAt', 'status', 'errorCode', 'job', 'reports', 'pendingReports']) ||
      value.schemaVersion !== 1 || value.source !== SOURCE || value.reportTypeId !== REACH_REPORT_TYPE ||
      value.channelId !== channelId || !instant(value.capturedAt) ||
      !['ready', 'pending', 'partial', 'not-configured'].includes(value.status) ||
      (value.errorCode !== null && !ERRORS.has(value.errorCode)) ||
      !Array.isArray(value.reports) || value.reports.length > MAX_REPORTS ||
      !Array.isArray(value.pendingReports) || value.pendingReports.length > MAX_REPORTS) fail('invalid-response');
  if (value.job !== null && (!keys(value.job, ['id', 'createTime', 'expireTime']) || !resourceId(value.job.id) ||
      !instant(value.job.createTime) || Date.parse(value.job.createTime) > Date.parse(value.capturedAt) ||
      (value.job.expireTime !== null && !instant(value.job.expireTime)))) fail('invalid-response');
  const windows = new Set();
  let count = 0;
  for (const report of value.reports) {
    if (!keys(report, ['id', 'jobId', 'startTime', 'endTime', 'createTime', 'importedAt', 'rows']) ||
        !windowValid(report, value.capturedAt) || !instant(report.importedAt) ||
        Date.parse(report.importedAt) > Date.parse(value.capturedAt) ||
        Date.parse(report.importedAt) < Date.parse(report.createTime) ||
        windows.has(period(report)) || !Array.isArray(report.rows) || report.rows.length > 5000) fail('invalid-response');
    windows.add(period(report));
    const seen = new Set();
    for (const row of report.rows) {
      if (!keys(row, ['date', 'videoId', 'impressions', 'impressionsCtr']) || row.date !== pacific(report.startTime) ||
          !videoId(row.videoId) || seen.has(row.videoId) ||
          !rowMetric(row.impressions, true) || !rowMetric(row.impressionsCtr, false)) fail('invalid-response');
      seen.add(row.videoId);
    }
    count += report.rows.length;
  }
  if (count > MAX_ROWS) fail('limit');
  const pendingIds = new Set();
  for (const pending of value.pendingReports) {
    if (!keys(pending, ['id', 'jobId', 'startTime', 'endTime', 'createTime', 'errorCode']) ||
        !windowValid(pending, value.capturedAt) || !ERRORS.has(pending.errorCode) || pendingIds.has(pending.id)) fail('invalid-response');
    pendingIds.add(pending.id);
  }
  return structuredClone(value);
}

function safeDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid-response'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash ||
      !/^\/v1\/media\/[A-Za-z0-9_./%-]+$/.test(url.pathname) ||
      [...url.searchParams].some(([key, value]) => key !== 'alt' || value !== 'media')) fail('invalid-response');
  url.searchParams.set('alt', 'media');
  return url.href;
}
async function bodyText(response, maximum) {
  if (Number(response.headers?.get('content-length')) > maximum) fail('limit');
  if (!response.body?.getReader) {
    const result = await response.text();
    if (Buffer.byteLength(result) > maximum) fail('limit');
    return result;
  }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); fail('limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** createJob is opt-in and only creates a nonmonetary report schedule, never edits a video.
 * Provider failures are isolated from core Analytics collection. now is injectable for deterministic tests.
 */
export async function collectYouTubeBulkReach(options = {}) {
  const { channelId = CHANNEL, publicVideoIds, previous = null,
    capturedAt = new Date().toISOString(), now = () => new Date().toISOString() } = options;
  const visible = ids(publicVideoIds);
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId) || !instant(capturedAt) || typeof now !== 'function') fail('invalid-response');
  const state = { capturedAt, job: null, reports: [], pendingReports: [] };
  let prior = null;
  try {
    if (previous) prior = validateYouTubeBulkReach(previous, { channelId });
    if (prior && Date.parse(prior.capturedAt) > Date.parse(capturedAt)) fail('invalid-response');
    state.job = prior?.job || null;
    state.reports = (prior?.reports || []).map(report => ({
      ...report, rows: report.rows.filter(row => visible.has(row.videoId)),
    }));
    state.pendingReports = prior?.pendingReports || [];
    return await collectReach({ ...options, channelId, publicVideoIds, capturedAt, now, prior, state });
  } catch (error) {
    // Never leak provider messages, request URLs, OAuth material, or a raw CSV.
    return validateYouTubeBulkReach({
      schemaVersion: 1, source: SOURCE, reportTypeId: REACH_REPORT_TYPE, channelId,
      capturedAt: state.capturedAt, status: state.reports.length || state.job ? 'partial' : 'not-configured',
      errorCode: safeCode(error), job: state.job, reports: state.reports, pendingReports: state.pendingReports,
    }, { channelId });
  }
}

async function collectReach({
  env = process.env, fetchImpl = fetch, channelId = CHANNEL, publicVideoIds, previous = null,
  capturedAt, createJob = false, maxDownloads = 90, accessToken = null, now, prior, state,
} = {}) {
  const visible = ids(publicVideoIds);
  if (typeof createJob !== 'boolean' || !Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > 90) fail('invalid-response');
  const token = accessToken ?? await getGoogleAccessToken(env, fetchImpl);
  if (typeof token !== 'string' || !token || token.length > 10000 || /\s|[\u0000-\u001f\u007f]/.test(token)) fail('authorization');
  const headers = { Authorization: `Bearer ${token}` };
  function observedNow() {
    const observed = now();
    if (!instant(observed)) fail('invalid-response');
    if (Date.parse(observed) > Date.parse(capturedAt)) capturedAt = observed;
    state.capturedAt = capturedAt;
  }
  async function request(url, options = {}, raw = false) {
    const target = new URL(url);
    if (target.origin !== ORIGIN || target.username || target.password || target.hash) fail('invalid-response');
    let response;
    try {
      response = await fetchImpl(target.href, { ...options, headers: { ...headers, ...options.headers },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch { fail('network'); }
    observedNow();
    if (!response.ok) {
      if (response.status === 409) fail('conflict');
      if (response.status === 401) fail('authorization');
      if (response.status === 429) fail('rate-limit');
      if (response.status === 403) {
        // Inspect only known structured reason codes; never forward Google diagnostics.
        let error;
        try { error = JSON.parse(await bodyText(response, 65536)); } catch { /* Static code below. */ }
        const reasons = [...(error?.error?.errors || []), ...(error?.error?.details || [])].map(item => item?.reason);
        fail(reasons.some(reason => ['SERVICE_DISABLED', 'accessNotConfigured'].includes(reason)) ? 'service-disabled' : 'authorization');
      }
      fail('http-error');
    }
    const text = await bodyText(response, raw ? MAX_CSV_BYTES : 2 * 1024 * 1024);
    if (raw) return text;
    try { const result = JSON.parse(text); if (!object(result)) fail('invalid-response'); return result; }
    catch { fail('invalid-response'); }
  }
  async function list(path, field) {
    const rows = [], seen = new Set();
    let next = '';
    for (let page = 0; page < 100; page++) {
      const url = new URL(`${ORIGIN}/v1/${path}`);
      url.searchParams.set('pageSize', '100');
      if (next) url.searchParams.set('pageToken', next);
      const result = await request(url.href);
      if (result[field] !== undefined && !Array.isArray(result[field])) fail('invalid-response');
      rows.push(...(result[field] || []));
      if (rows.length > MAX_REPORTS) fail('limit');
      next = result.nextPageToken;
      if (!next) return rows;
      if (typeof next !== 'string' || next.length > 2048 || seen.has(next)) fail('pagination');
      seen.add(next);
    }
    fail('pagination');
  }
  const matchingJobs = values => values.filter(job => job?.reportTypeId === REACH_REPORT_TYPE).map(job => {
    if (!resourceId(job.id) || !instant(job.createTime) ||
        Date.parse(job.createTime) > Date.parse(capturedAt) || (job.expireTime && !instant(job.expireTime))) fail('invalid-response');
    return { id: job.id, createTime: job.createTime, expireTime: job.expireTime || null };
  });
  let jobs = matchingJobs(await list('jobs', 'jobs'));
  const active = () => jobs.filter(job => !job.expireTime || Date.parse(job.expireTime) > Date.parse(capturedAt))
    .sort((a, b) => a.createTime.localeCompare(b.createTime))[0] || null;
  if (!active() && createJob) {
    const types = await list('reportTypes', 'reportTypes');
    if (!types.some(type => type.id === REACH_REPORT_TYPE && !type.deprecateTime && !type.systemManaged)) fail('not-configured');
    try {
      const job = await request(`${ORIGIN}/v1/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportTypeId: REACH_REPORT_TYPE, name: 'Scran & Pints daily thumbnail reach' }),
      });
      jobs.push(...matchingJobs([job]));
    } catch (error) {
      if (error.code !== 'conflict') throw error;
      jobs = matchingJobs(await list('jobs', 'jobs'));
    }
    if (!active()) fail('invalid-response');
  }
  if (jobs.length > 20) fail('limit');
  state.job = active();
  const saved = new Map((prior?.reports || []).map(report => [period(report), {
    ...report, rows: report.rows.filter(row => visible.has(row.videoId)),
  }]));
  const candidates = new Map();
  for (const job of jobs) {
    const reports = await list(`jobs/${encodeURIComponent(job.id)}/reports`, 'reports');
    for (const report of reports) {
      const meta = { id: report.id, jobId: report.jobId || job.id, startTime: report.startTime,
        endTime: report.endTime, createTime: report.createTime };
      if (meta.jobId !== job.id || !windowValid(meta, capturedAt)) fail('invalid-response');
      const candidate = { ...meta, downloadUrl: safeDownloadUrl(report.downloadUrl) };
      const old = candidates.get(period(meta));
      if (!old || Date.parse(meta.createTime) > Date.parse(old.createTime) ||
          (meta.createTime === old.createTime && meta.id > old.id)) candidates.set(period(meta), candidate);
    }
  }
  const needed = [...candidates.values()].filter(report => {
    const old = saved.get(period(report));
    return !old || (old.id !== report.id && Date.parse(report.createTime) > Date.parse(old.createTime));
  }).sort((a, b) => a.startTime.localeCompare(b.startTime) || a.createTime.localeCompare(b.createTime));
  const pending = needed.slice(maxDownloads).map(({ downloadUrl: ignored, ...meta }) => ({ ...meta, errorCode: 'deferred' }));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, needed.length, maxDownloads) }, async () => {
    while (cursor < Math.min(needed.length, maxDownloads)) {
      const candidate = needed[cursor++];
      const { downloadUrl, ...meta } = candidate;
      try {
        const rows = parseYouTubeReachCsv(await request(downloadUrl, {}, true), {
          channelId, publicVideoIds, reportDate: pacific(meta.startTime),
        });
        // A backfill replaces the entire old period, including valid empty files.
        saved.set(period(meta), { ...meta, importedAt: capturedAt, rows });
      } catch (error) { pending.push({ ...meta, errorCode: safeCode(error) }); }
    }
  }));
  const reports = [...saved.values()].sort((a, b) => a.startTime.localeCompare(b.startTime));
  return validateYouTubeBulkReach({
    schemaVersion: 1, source: SOURCE, reportTypeId: REACH_REPORT_TYPE, channelId, capturedAt,
    status: pending.length ? 'partial' : reports.length ? 'ready' : active() ? 'pending' : 'not-configured',
    errorCode: pending.length ? pending[0].errorCode : null,
    job: active(), reports, pendingReports: pending.sort((a, b) => a.startTime.localeCompare(b.startTime)),
  }, { channelId });
}

/** Public rows only; no channel/job/report IDs, download URLs or raw CSV. */
export function projectYouTubeBulkReach(value, publicVideoIds) {
  if (!value) return null;
  const valid = validateYouTubeBulkReach(value), visible = ids(publicVideoIds);
  const daily = valid.reports.flatMap(report => report.rows.filter(row => visible.has(row.videoId)).map(row => ({
    ...row, reportGeneratedAt: report.createTime, capturedAt: report.importedAt,
  }))).sort((a, b) => a.date.localeCompare(b.date) || a.videoId.localeCompare(b.videoId));
  const availableDates = valid.reports.map(report => ({
    date: pacific(report.startTime), reportGeneratedAt: report.createTime, capturedAt: report.importedAt,
    publicRows: report.rows.filter(row => visible.has(row.videoId)).length,
  }));
  return {
    source: 'YouTube Reporting API — daily thumbnail reach', status: valid.status, checkedAt: valid.capturedAt, errorCode: valid.errorCode,
    dateRange: availableDates.length ? { start: availableDates[0].date, end: availableDates.at(-1).date, timezone: ZONE } : null,
    pendingReports: valid.pendingReports.length, availableDates, daily,
  };
}
