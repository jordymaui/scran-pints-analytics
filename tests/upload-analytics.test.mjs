import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterUploads, reportRowsCsv, uploadTotalsCsv, uploadSeries, reachRows, reachDailyTotals,
  reachRowsCsv, mountUploadAnalytics, formatUploadMetric,
} from '../upload-analytics.js';

const report = rows => ({
  status: 'collected', attemptedAt: '2026-10-20T12:00:00Z',
  attemptedRange: { start: '2026-08-28', end: '2026-10-19', timezone: 'America/Los_Angeles' },
  errorCode: null, report: {
    capturedAt: '2026-10-20T12:00:00Z',
    dateRange: { start: '2026-08-28', end: '2026-10-19', timezone: 'America/Los_Angeles' },
    rows,
  },
});
const video = (id, title, format, views) => ({
  id, title, creatorContentType: format, publishedAt: '2026-10-01T10:00:00Z',
  aggregate: views === null ? { status: 'failed', report: null } : report([{ views, averageViewPercentage: 65.4321 }]),
});

test('upload catalog searches every upload and sorts known native totals before unavailable values', () => {
  const videos = [
    video('aBcDeFgHi12', 'Arsenal food', 'VIDEO_ON_DEMAND', 50),
    video('bBcDeFgHi12', 'Brighton FOOD', 'SHORTS', 0),
    video('cBcDeFgHi12', 'Unknown report', 'UNSPECIFIED', null),
  ];
  assert.deepEqual(filterUploads(videos, { search: 'food' }).map(row => row.id), ['aBcDeFgHi12', 'bBcDeFgHi12']);
  assert.deepEqual(filterUploads(videos, { format: 'SHORTS' }).map(row => row.id), ['bBcDeFgHi12']);
  assert.equal(filterUploads(videos, { search: ' cBcDeFgHi12 ' })[0], videos[2]);
  assert.deepEqual(filterUploads(videos).map(row => row.id), videos.map(row => row.id));
  assert.equal(videos[0].title, 'Arsenal food');
});

test('exports keep all native rows, independent dates and retained statuses without inventing missing totals', () => {
  const entry = report(Array.from({ length: 201 }, (_, i) => ({ day: `day-${i}`, views: i, averageViewPercentage: 65.4321 })));
  entry.status = 'failed-retained';
  entry.report.capturedAt = '2026-10-18T12:00:00Z';
  const csv = reportRowsCsv(entry, { videoId: 'aBcDeFgHi12', title: '=HYPERLINK("bad")' });
  assert.equal(csv.split('\r\n').length, 202);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /"failed-retained"/);
  assert.match(csv, /"2026-10-18T12:00:00Z"/);
  assert.match(csv, /"2026-10-20T12:00:00Z"/);
  assert.match(csv, /"65\.4321"/);
  assert.match(csv, /"day-200","200"/);
  const totals = uploadTotalsCsv([video('aBcDeFgHi12', 'True zero', 'SHORTS', 0), video('bBcDeFgHi12', 'Missing', 'SHORTS', null)]);
  assert.match(totals, /"0","65\.4321"/);
  assert.match(totals, /"Missing".*"failed","","","","","",""/);
});

test('daily chart preserves absent dates and negative adjustments; retention has native numeric positions', () => {
  const daily = uploadSeries([
    { day: '2026-10-03', likes: -1 }, { day: '2026-10-01', likes: 0 },
    { day: '2026-10-04', likes: 2 }, { day: '2026-10-05', likes: null },
  ], 'likes');
  assert.deepEqual(daily.segments.map(rows => rows.map(row => row.y)), [[0], [-1, 2]]);
  const retention = uploadSeries([
    { elapsedVideoTimeRatio: 0.5, audienceWatchRatio: 1.2 },
    { elapsedVideoTimeRatio: 0.1, audienceWatchRatio: 0.8 },
  ], 'audienceWatchRatio', 'elapsedVideoTimeRatio');
  assert.deepEqual(retention.points.map(row => [row.x, row.y]), [[0.1, 0.8], [0.5, 1.2]]);
  assert.equal(retention.segments.length, 1);
});

const reachRow = (date, videoId, impressions, impressionsCtr, generated = '2026-10-19T10:00:00Z') => ({
  date, videoId, impressions, impressionsCtr, reportGeneratedAt: generated, capturedAt: '2026-10-20T12:00:00Z',
});

test('reach sums available impressions without averaging CTR, filling gaps or counting replaced reports twice', () => {
  const bulk = { daily: [
    reachRow('2026-10-17', 'aBcDeFgHi12', 100, 0.034),
    reachRow('2026-10-17', 'aBcDeFgHi12', 120, 0.035, '2026-10-20T10:00:00Z'),
    reachRow('2026-10-17', 'bBcDeFgHi12', 80, 0),
    reachRow('2026-10-19', 'aBcDeFgHi12', null, null),
    reachRow('2026-10-20', 'aBcDeFgHi12', 0, 0),
  ] };
  assert.deepEqual(reachDailyTotals(bulk), [
    { day: '2026-10-17', impressions: 200, uploadsReported: 2 },
    { day: '2026-10-19', impressions: null, uploadsReported: 1 },
    { day: '2026-10-20', impressions: 0, uploadsReported: 1 },
  ]);
  assert.deepEqual(reachRows(bulk, 'aBcDeFgHi12').map(row => row.impressionsCtr), [0.035, null, 0]);
  assert.equal(bulk.daily[0].impressions, 100);
  assert.deepEqual(uploadSeries(reachDailyTotals(bulk), 'impressions').segments.map(segment => segment.map(row => row.y)), [[200], [0]]);
});

test('reach CSV preserves native CTR values and each report generation/import date', () => {
  const csv = reachRowsCsv({ daily: [
    reachRow('2026-10-17', 'aBcDeFgHi12', 100, 0.034),
    reachRow('2026-10-18', 'bBcDeFgHi12', 50, 0.034),
  ] }, 'aBcDeFgHi12');
  assert.match(csv, /"impressionsCtrRatio"/);
  assert.match(csv, /"100","0\.034","2026-10-19T10:00:00Z","2026-10-20T12:00:00Z"/);
  assert.equal(csv.split('\r\n').length, 2);
  assert.doesNotMatch(csv, /bBcDeFgHi12/);
});

test('verified Reporting API CTR ratios display as percentages without changing native exports', () => {
  const rows = [
    reachRow('2026-10-16', 'CWBBRExPJ0I', 50, 0.06),
    reachRow('2026-10-17', 'CWBBRExPJ0I', 32, 0.15625),
    reachRow('2026-10-18', 'CWBBRExPJ0I', 47, 0.1276595744680851),
  ];
  assert.deepEqual(rows.map(row => formatUploadMetric('impressionsCtr', row.impressionsCtr)), ['6%', '15.625%', '12.766%']);
  assert.equal(formatUploadMetric('impressionsCtr', 0), '0%');
  assert.equal(formatUploadMetric('impressionsCtr', null), 'Unavailable');
  assert.equal(formatUploadMetric('impressions', 50), '50');
  const csv = reachRowsCsv({ daily: rows });
  assert.match(csv, /"50","0\.06"/);
  assert.match(csv, /"32","0\.15625"/);
  assert.match(csv, /"47","0\.1276595744680851"/);
  assert.doesNotMatch(csv, /%/);
});

test('pending reach is visible without invented metrics, and saved dates stay distinct from latest check', () => {
  const reach = { innerHTML: '' };
  const container = {
    innerHTML: '', classList: { add() {} }, addEventListener() {},
    querySelector(selector) { return selector === '[data-slot="reach"]' ? reach : null; },
  };
  mountUploadAnalytics(container, { bulkReach: {
    status: 'pending', checkedAt: '2026-10-20T12:00:00Z', dateRange: null, daily: [], availableDates: [], pendingReports: 0,
  } });
  assert.match(container.innerHTML, /Thumbnail reach/);
  assert.match(reach.innerHTML, /Waiting for Google reports/);
  assert.match(reach.innerHTML, /48 hours/);
  assert.match(reach.innerHTML, /preceding 30 days/);
  assert.doesNotMatch(reach.innerHTML, /<dd>|<svg/);
  mountUploadAnalytics(container, { bulkReach: {
    status: 'partial', checkedAt: '2026-10-20T12:00:00Z', pendingReports: 2,
    dateRange: { start: '2026-10-16', end: '2026-10-17', timezone: 'America/Los_Angeles' },
    availableDates: [{ date: '2026-10-16', publicRows: 0 }, { date: '2026-10-17', publicRows: 1 }],
    daily: [reachRow('2026-10-17', 'aBcDeFgHi12', 100, 0.034)],
  } });
  assert.match(reach.innerHTML, /2 reports waiting to import/);
  assert.match(reach.innerHTML, /Reported dates: 2026-10-17 to 2026-10-17/);
  assert.match(reach.innerHTML, /Imported report coverage: 2026-10-16 to 2026-10-17/);
  assert.match(reach.innerHTML, /Last checked 2026-10-20/);
  assert.match(reach.innerHTML, /2 daily reports imported/);
  assert.match(reach.innerHTML, /<dd>100<\/dd>/);
});
