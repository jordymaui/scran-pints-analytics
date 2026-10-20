import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectYouTubeBulkReach, parseYouTubeReachCsv, projectYouTubeBulkReach,
  validateYouTubeBulkReach, REACH_REPORT_TYPE,
} from '../lib/youtube-bulk.mjs';

const CHANNEL = 'UCAX4l1JUAymaMHVKiRFzK-A';
const VIDEO = 'abcdefghijk', PRIVATE = 'lmnopqrstuv';
const CAPTURED = '2026-10-20T15:00:00.000Z';
const ORIGIN = 'https://youtubereporting.googleapis.com';
const HEADER = 'date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr';
const csv = (rows = [`20261018,${CHANNEL},${VIDEO},100,4.5`]) => `${HEADER}\r\n${rows.join('\r\n')}\r\n`;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const job = (extra = {}) => ({ id: 'job-1', reportTypeId: REACH_REPORT_TYPE, createTime: '2026-10-01T12:00:00Z', ...extra });
const report = (extra = {}) => ({
  id: 'report-1', jobId: 'job-1', startTime: '2026-10-18T07:00:00Z',
  endTime: '2026-10-19T07:00:00Z', createTime: '2026-10-20T08:00:00Z',
  downloadUrl: `${ORIGIN}/v1/media/report-1`, ...extra,
});
const options = (extra = {}) => ({
  accessToken: 'test-token', channelId: CHANNEL, publicVideoIds: [VIDEO], capturedAt: CAPTURED,
  now: () => CAPTURED, ...extra,
});
function fetcher({ jobs = [job()], reports = [report()], files = {}, override } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.origin, ORIGIN);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.equal(init.redirect, 'error');
    if (override) {
      const result = await override(url, init);
      if (result !== undefined) return result;
    }
    if (url.pathname === '/v1/jobs') return json({ jobs });
    if (url.pathname.endsWith('/reports')) return json({ reports });
    if (url.pathname.startsWith('/v1/media/')) {
      const file = files[url.pathname] ?? csv();
      if (file instanceof Error) throw file;
      return new Response(file);
    }
    throw new Error('Unexpected test request');
  };
  return { fetchImpl, calls };
}

test('CSV preserves native values and missing cells, filters nonpublic IDs, and uses headers', () => {
  const rows = parseYouTubeReachCsv(csv([
    `20261018,${CHANNEL},${VIDEO},0,`,
    `20261018,${CHANNEL},${PRIVATE},999,9`,
    '20261018,,,123,1',
  ]), { channelId: CHANNEL, publicVideoIds: [VIDEO], reportDate: '2026-10-18' });
  assert.deepEqual(rows, [{ date: '2026-10-18', videoId: VIDEO, impressions: 0, impressionsCtr: null }]);
  const reordered = '"video_thumbnail_impressions_ctr","video_id","channel_id","date","video_thumbnail_impressions"\n' +
    `"4.5","${VIDEO}","${CHANNEL}","2026-10-18","100"\n`;
  assert.equal(parseYouTubeReachCsv(reordered, { publicVideoIds: [VIDEO], reportDate: '2026-10-18' })[0].impressionsCtr, 4.5);
});

test('CSV rejects foreign channels, impossible dates, duplicate rows and malformed numeric cells', () => {
  for (const row of [
    `20261018,UCXXXXXXXXXXXXXXXXXXXXXX,${VIDEO},1,2`,
    `20260230,${CHANNEL},${VIDEO},1,2`,
    `20261018,${CHANNEL},${VIDEO},-1,2`,
    `20261018,${CHANNEL},${VIDEO},1,101`,
    `20261018,${CHANNEL},${VIDEO},NaN,2`,
  ]) assert.throws(() => parseYouTubeReachCsv(csv([row]), { publicVideoIds: [VIDEO], reportDate: '2026-10-18' }));
  const row = `20261018,${CHANNEL},${VIDEO},1,2`;
  assert.throws(() => parseYouTubeReachCsv(csv([row, row]), { publicVideoIds: [VIDEO], reportDate: '2026-10-18' }));
});

test('existing job ingests only public rows and projection excludes resource IDs and tokens', async () => {
  const mock = fetcher();
  const result = await collectYouTubeBulkReach(options(mock));
  assert.equal(result.status, 'ready');
  assert.equal(result.errorCode, null);
  assert.equal(result.reports[0].rows[0].impressionsCtr, 4.5);
  assert.equal(mock.calls.filter(call => call.init.method === 'POST').length, 0);
  const publicReport = projectYouTubeBulkReach(result, [VIDEO]);
  assert.equal(publicReport.daily.length, 1);
  assert.deepEqual(publicReport.dateRange, { start: '2026-10-18', end: '2026-10-18', timezone: 'America/Los_Angeles' });
  assert.doesNotMatch(JSON.stringify(publicReport), /test-token|job-1|report-1|downloadUrl|channelId/);
  assert.deepEqual(projectYouTubeBulkReach(result, []).daily, []);
});

test('creation is opt-in; new job remains pending with a later real creation timestamp', async () => {
  const inactive = fetcher({ jobs: [] });
  assert.equal((await collectYouTubeBulkReach(options(inactive))).status, 'not-configured');
  assert.equal(inactive.calls.length, 1);
  const later = '2026-10-20T15:00:02.000Z';
  const mock = fetcher({ jobs: [], reports: [], override: (url, init) => {
    if (url.pathname === '/v1/reportTypes') return json({ reportTypes: [{ id: REACH_REPORT_TYPE }] });
    if (url.pathname === '/v1/jobs' && init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { reportTypeId: REACH_REPORT_TYPE, name: 'Scran & Pints daily thumbnail reach' });
      return json(job({ createTime: '2026-10-20T15:00:01.000Z' }));
    }
  } });
  const result = await collectYouTubeBulkReach(options({ ...mock, createJob: true, now: () => later }));
  assert.equal(result.status, 'pending');
  assert.equal(result.capturedAt, later);
  assert.equal(result.job.id, 'job-1');
  assert.deepEqual(result.reports, []);
});

test('newest backfill replaces the whole period, including a valid header-only file', async () => {
  const previous = await collectYouTubeBulkReach(options(fetcher()));
  const mock = fetcher({
    reports: [report(), report({ id: 'newer', createTime: '2026-10-20T09:00:00Z', downloadUrl: `${ORIGIN}/v1/media/newer` })],
    files: { '/v1/media/newer': `${HEADER}\n` },
  });
  const result = await collectYouTubeBulkReach(options({ ...mock, previous }));
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].id, 'newer');
  assert.deepEqual(result.reports[0].rows, []);
  assert.equal(projectYouTubeBulkReach(result, [VIDEO]).availableDates[0].publicRows, 0);
});

test('failed new backfill retains previous dated report with a sanitized partial status', async () => {
  const previous = await collectYouTubeBulkReach(options(fetcher()));
  const mock = fetcher({
    reports: [report({ id: 'newer', createTime: '2026-10-20T09:00:00Z', downloadUrl: `${ORIGIN}/v1/media/newer` })],
    files: { '/v1/media/newer': new Error('secret-provider-message') },
  });
  const result = await collectYouTubeBulkReach(options({ ...mock, previous }));
  assert.equal(result.status, 'partial');
  assert.equal(result.errorCode, 'network');
  assert.deepEqual(result.reports, previous.reports);
  assert.equal(result.pendingReports.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret-provider-message/);
});

test('provider failure and service-disabled are nonfatal without leaking diagnostics', async () => {
  for (const response of [
    new Error('access-token-secret'),
    json({ error: { message: 'secret', details: [{ reason: 'SERVICE_DISABLED' }] } }, 403),
  ]) {
    const result = await collectYouTubeBulkReach(options({ fetchImpl: async () => {
      if (response instanceof Error) throw response;
      return response;
    } }));
    assert.equal(result.status, 'not-configured');
    assert.equal(result.errorCode, response instanceof Error ? 'network' : 'service-disabled');
    assert.doesNotMatch(JSON.stringify(result), /access-token-secret|"message"/);
  }
});

test('unsafe download hosts never receive the access token', async () => {
  const mock = fetcher({ reports: [report({ downloadUrl: 'https://attacker.invalid/v1/media/stolen' })] });
  const result = await collectYouTubeBulkReach(options(mock));
  assert.equal(result.status, 'partial');
  assert.equal(result.errorCode, 'invalid-response');
  assert.ok(mock.calls.every(call => call.url.origin === ORIGIN));
  assert.equal(mock.calls.length, 2);
});

test('pagination cycles fail safely and deferred downloads remain explicit', async () => {
  const cycle = fetcher({ override: url => url.pathname === '/v1/jobs'
    ? json({ jobs: [job()], nextPageToken: 'same' }) : undefined });
  assert.equal((await collectYouTubeBulkReach(options(cycle))).errorCode, 'pagination');
  const older = report({ id: 'older', startTime: '2026-10-17T07:00:00Z', endTime: '2026-10-18T07:00:00Z',
    downloadUrl: `${ORIGIN}/v1/media/older` });
  const mock = fetcher({ reports: [report(), older],
    files: { '/v1/media/older': csv([`20261017,${CHANNEL},${VIDEO},50,3`]) } });
  const result = await collectYouTubeBulkReach(options({ ...mock, maxDownloads: 1 }));
  assert.equal(result.status, 'partial');
  assert.equal(result.reports[0].id, 'older');
  assert.equal(result.pendingReports[0].errorCode, 'deferred');
});

test('saved reach validation rejects private extra fields and impossible windows', async () => {
  const valid = await collectYouTubeBulkReach(options(fetcher()));
  assert.throws(() => validateYouTubeBulkReach({ ...valid, credentials: 'secret' }));
  const wrongWindow = structuredClone(valid);
  wrongWindow.reports[0].endTime = '2026-10-20T07:00:00Z';
  assert.throws(() => validateYouTubeBulkReach(wrongWindow));
  const wrongRow = structuredClone(valid);
  wrongRow.reports[0].rows[0].date = '2026-10-17';
  assert.throws(() => validateYouTubeBulkReach(wrongRow));
});
