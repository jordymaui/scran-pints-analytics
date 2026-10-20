// Server-only, explicit publication boundary for the selected performance fields.
// Never pass a raw Analytics snapshot, audience breakdown or workshop object on.
import { validateSocialImport, YOUTUBE_ANALYTICS_PROVENANCE } from './social-schema.mjs';

const CHANNEL_ID = 'UCAX4l1JUAymaMHVKiRFzK-A';
const TIME_ZONE = 'America/Los_Angeles';
const ACTIVITY_FIELDS = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage',
  'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'];
const COUNTS = new Set(['views', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost']);
const invalid = () => { throw Error('Invalid performance source.'); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const instant = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)) && day(value.slice(0, 10));

function reportingWindow(capturedAt, range) {
  if (!instant(capturedAt) || !keys(range, ['start', 'end', 'timezone']) ||
      !day(range.start) || !day(range.end) || range.timezone !== TIME_ZONE ||
      range.start > range.end || Date.parse(range.end) - Date.parse(range.start) > 20_000 * 86_400_000) invalid();
  const captureDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(capturedAt));
  if (range.end > captureDay) invalid();
  return { start: range.start, end: range.end, timeZone: TIME_ZONE };
}

function activity(row, daily = false) {
  if (!keys(row, daily ? ['day', ...ACTIVITY_FIELDS] : ACTIVITY_FIELDS) ||
      ACTIVITY_FIELDS.some(key => typeof row[key] !== 'number' || !Number.isFinite(row[key]) ||
        (key !== 'likes' && row[key] < 0) || (COUNTS.has(key) && !Number.isSafeInteger(row[key])))) invalid();
  return {
    views: row.views, watchHours: row.estimatedMinutesWatched / 60,
    likes: row.likes, comments: row.comments, shares: row.shares,
    subscribersGained: row.subscribersGained, subscribersLost: row.subscribersLost,
    subscribersNet: row.subscribersGained - row.subscribersLost,
  };
}

export function projectChannelPerformance(report) {
  if (!keys(report, ['capturedAt', 'channelId', 'dateRange', 'aggregate', 'daily', 'coverage']) ||
      report.channelId !== CHANNEL_ID ||
      !keys(report.coverage, ['startBasis', 'endBasis']) ||
      !['channel-created', 'earliest-known-public-upload'].includes(report.coverage.startBasis) ||
      report.coverage.endBasis !== 'channel-daily-same-metrics' ||
      !Array.isArray(report.daily) || !report.daily.length || report.daily.length > 20_000) invalid();
  const dateRange = reportingWindow(report.capturedAt, report.dateRange);
  const seen = new Set();
  const daily = report.daily.map(row => {
    const metrics = activity(row, true);
    if (!day(row.day) || row.day < dateRange.start || row.day > dateRange.end || seen.has(row.day)) invalid();
    seen.add(row.day);
    return { date: row.day, ...metrics };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (!seen.has(dateRange.end)) invalid();
  return { capturedAt: report.capturedAt, dateRange, daily, totals: activity(report.aggregate) };
}

export function projectShortsPerformance(value) {
  const report = validateSocialImport({ schemaVersion: 1, sources: [value] }).sources[0];
  if (report.id !== 'youtube-shorts' || report.provenance.kind !== 'official-api' ||
      report.provenance.label !== YOUTUBE_ANALYTICS_PROVENANCE) invalid();
  const dateRange = reportingWindow(report.capturedAt, report.dateRange);
  return {
    capturedAt: report.capturedAt, dateRange,
    daily: report.daily.map(row => ({
      date: row.day, views: row.views, watchHours: null, likes: null, comments: null, shares: null,
      subscribersGained: null, subscribersLost: null, subscribersNet: null,
    })),
    totals: {
      views: report.metrics.views, watchHours: report.metrics.watchHours,
      likes: report.metrics.likes, comments: report.metrics.comments, shares: report.metrics.shares,
      subscribersGained: null, subscribersLost: null, subscribersNet: report.metrics.subscribersNet,
    },
  };
}
