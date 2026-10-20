// Native channel reports supported by the existing yt-analytics.readonly grant.
// https://developers.google.com/youtube/analytics/channel_reports
const activity = dimensions => Object.freeze({
  dimensions, metrics: 'views,estimatedMinutesWatched', sort: dimensions,
});
export const CHANNEL_BREAKDOWN_REPORTS = Object.freeze({
  traffic: activity('insightTrafficSourceType'),
  country: activity('country'),
  device: activity('deviceType'),
  subscribed: activity('subscribedStatus'),
  format: activity('creatorContentType'),
  demographics: Object.freeze({
    dimensions: 'ageGroup,gender', metrics: 'viewerPercentage', sort: 'ageGroup,gender',
  }),
});

const TIMEZONE = 'America/Los_Angeles';
const END_STATUS = 'query-bound-no-daily-completeness-signal';
const STATUSES = ['collected', 'no-rows', 'failed', 'no-rows-retained', 'failed-retained'];
const invalid = () => { throw new Error('Invalid saved channel breakdown.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key));
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)) && day(value.slice(0, 10));
const range = (value, capturedAt) => keys(value, ['start', 'end', 'timezone']) &&
  day(value.start) && day(value.end) && value.start <= value.end &&
  value.end <= capturedAt.slice(0, 10) && value.timezone === TIMEZONE;

function validateRows(rows, definition) {
  if (!Array.isArray(rows) || rows.length > 1000) invalid();
  const dimensions = definition.dimensions.split(',');
  const metrics = definition.metrics.split(',');
  const seen = new Set();
  for (const row of rows) {
    if (!keys(row, [...dimensions, ...metrics]) ||
        dimensions.some(key => typeof row[key] !== 'string' || !row[key].trim() ||
          row[key].length > 150 || /[\u0000-\u001f\u007f]/.test(row[key])) ||
        metrics.some(key => typeof row[key] !== 'number' || !Number.isFinite(row[key]) ||
          row[key] < 0 || (key === 'views' && !Number.isSafeInteger(row[key])) ||
          (key === 'viewerPercentage' && row[key] > 100))) invalid();
    const identity = JSON.stringify(dimensions.map(key => row[key]));
    if (seen.has(identity)) invalid();
    seen.add(identity);
  }
}

function validateEntry(entry, definition) {
  if (!keys(entry, ['status', 'attemptedAt', 'attemptedRange', 'errorCode', 'report']) ||
      !STATUSES.includes(entry.status) || !timestamp(entry.attemptedAt) ||
      !range(entry.attemptedRange, entry.attemptedAt)) invalid();
  const failed = entry.status.startsWith('failed');
  if (failed ? !['report-unavailable', 'invalid-response'].includes(entry.errorCode) : entry.errorCode !== null) invalid();
  const hasReport = entry.status === 'collected' || entry.status.endsWith('-retained');
  if (!hasReport) {
    if (entry.report !== null) invalid();
    return;
  }
  const report = entry.report;
  if (!keys(report, ['capturedAt', 'dateRange', 'endStatus', 'rows']) ||
      !timestamp(report.capturedAt) || !range(report.dateRange, report.capturedAt) ||
      Date.parse(report.capturedAt) > Date.parse(entry.attemptedAt) ||
      report.endStatus !== END_STATUS || !Array.isArray(report.rows) || !report.rows.length) invalid();
  if (entry.status === 'collected' && (report.capturedAt !== entry.attemptedAt ||
      report.dateRange.start !== entry.attemptedRange.start ||
      report.dateRange.end !== entry.attemptedRange.end)) invalid();
  validateRows(report.rows, definition);
}

/** Strict private storage/API boundary. Unknown fields are never forwarded. */
export function validateChannelBreakdowns(value) {
  if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(CHANNEL_BREAKDOWN_REPORTS, key))) invalid();
  for (const [id, entry] of Object.entries(value)) validateEntry(entry, CHANNEL_BREAKDOWN_REPORTS[id]);
  return structuredClone(value);
}

/**
 * query({id, report, startDate, endDate}) supplies decoded native row objects.
 * It must paginate the report; this module never makes requests or reads tokens.
 * Each optional report fails independently, preserving a valid older report.
 */
export async function collectChannelBreakdowns({ query, previous = {}, capturedAt, start, end }) {
  const attemptedRange = { start, end, timezone: TIMEZONE };
  if (typeof query !== 'function' || !timestamp(capturedAt) || !range(attemptedRange, capturedAt)) {
    throw new Error('Invalid channel breakdown collection options.');
  }
  const entries = await Promise.all(Object.entries(CHANNEL_BREAKDOWN_REPORTS).map(async ([id, definition]) => {
    let retained = null;
    try {
      const prior = previous?.[id];
      validateEntry(prior, definition);
      if (prior.report && Date.parse(prior.report.capturedAt) <= Date.parse(capturedAt)) retained = structuredClone(prior.report);
    } catch { /* Invalid optional history must not block the core refresh. */ }
    const entry = { status: 'failed', attemptedAt: capturedAt, attemptedRange: { ...attemptedRange },
      errorCode: 'report-unavailable', report: retained };
    let rows;
    try {
      rows = await query({ id, report: definition, startDate: start, endDate: end });
    } catch {
      entry.status = retained ? 'failed-retained' : 'failed';
      return [id, entry];
    }
    try { validateRows(rows, definition); }
    catch {
      entry.status = retained ? 'failed-retained' : 'failed';
      entry.errorCode = 'invalid-response';
      return [id, entry];
    }
    entry.errorCode = null;
    entry.status = rows.length ? 'collected' : retained ? 'no-rows-retained' : 'no-rows';
    if (rows.length) entry.report = { capturedAt, dateRange: { ...attemptedRange },
      endStatus: END_STATUS, rows: structuredClone(rows) };
    return [id, entry];
  }));
  return validateChannelBreakdowns(Object.fromEntries(entries));
}
