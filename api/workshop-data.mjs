import { json } from '../lib/auth.mjs';
import { loadReportingInputs } from '../lib/cloud-report.mjs';
import { validateSocialImport } from '../lib/social-schema.mjs';
import { validateChannelBreakdowns } from '../lib/youtube-breakdowns.mjs';
import { projectStudioSnapshot } from '../lib/studio-projection.mjs';

const ACTIVITY_FIELDS = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage',
  'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'];
const COUNTS = new Set(['views', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost']);
export function validateChannelAnalytics(report) {
  const invalid = () => { throw Error('Invalid saved channel Analytics report.'); };
  const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
  const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const activity = (row, daily = false) => keys(row, daily ? ['day', ...ACTIVITY_FIELDS] : ACTIVITY_FIELDS) &&
    ACTIVITY_FIELDS.every(key => typeof row[key] === 'number' && Number.isFinite(row[key]) &&
      (key === 'likes' || row[key] >= 0) && (!COUNTS.has(key) || Number.isSafeInteger(row[key])));
  if (!keys(report, ['capturedAt', 'channelId', 'dateRange', 'aggregate', 'daily', 'coverage']) ||
      typeof report.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(report.capturedAt) ||
      !Number.isFinite(Date.parse(report.capturedAt)) || !day(report.capturedAt.slice(0, 10)) ||
      report.channelId !== 'UCAX4l1JUAymaMHVKiRFzK-A' ||
      !keys(report.dateRange, ['start', 'end', 'timezone']) ||
      !day(report.dateRange.start) || !day(report.dateRange.end) ||
      report.dateRange.start > report.dateRange.end || report.dateRange.end > report.capturedAt.slice(0, 10) ||
      report.dateRange.timezone !== 'America/Los_Angeles' ||
      !keys(report.coverage, ['startBasis', 'endBasis']) ||
      !['channel-created', 'earliest-known-public-upload'].includes(report.coverage.startBasis) ||
      report.coverage.endBasis !== 'channel-daily-same-metrics' || !activity(report.aggregate) ||
      !Array.isArray(report.daily) || !report.daily.length || report.daily.length > 20000) invalid();
  const seen = new Set();
  for (const row of report.daily) {
    if (!activity(row, true) || !day(row.day) || row.day < report.dateRange.start ||
        row.day > report.dateRange.end || seen.has(row.day)) invalid();
    seen.add(row.day);
  }
  if (!seen.has(report.dateRange.end)) invalid();
  return structuredClone(report);
}

export function createWorkshopDataHandler({ loadInputs = loadReportingInputs } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return json(res, 405, { error: 'method_not_allowed' });
    }
    try {
      const { snapshot, historicalSnapshot, social, storageStatus, origins } = await loadInputs();
      const shorts = origins['youtube-shorts'] === 'cloud'
        ? social.sources.find(source => source.id === 'youtube-shorts') : null;
      // Never infer an account connection from a bundled import.
      const shortsAnalytics = shorts
        ? validateSocialImport({ schemaVersion: 1, sources: [shorts] }).sources[0] : null;
      const channelAnalytics = snapshot.channelAnalytics ? validateChannelAnalytics(snapshot.channelAnalytics) : null;
      let channelBreakdowns = null;
      try {
        if (snapshot.channelBreakdowns) channelBreakdowns = validateChannelBreakdowns(snapshot.channelBreakdowns);
      } catch { /* Optional malformed reports never hide valid core Analytics. */ }
      return json(res, 200, projectStudioSnapshot(snapshot, {
        historicalSnapshot, channelAnalytics, channelBreakdowns, shortsAnalytics,
        storageStatus, snapshotOrigin: origins.youtube,
      }));
    } catch { json(res, 503, { error: 'workshop_snapshot_unavailable' }); }
  };
}

export default createWorkshopDataHandler();
