import test from 'node:test';
import assert from 'node:assert/strict';
import { filterUploads, reportRowsCsv, uploadTotalsCsv, uploadSeries } from '../upload-analytics.js';

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
