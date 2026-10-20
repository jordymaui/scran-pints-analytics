import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectYouTubeEpisodes, commitYouTubeRefresh, decodeReport, REPORTS, ACTIVITY_METRICS } from '../lib/youtube-sync.mjs';
import { metadataAudit, windowMetrics } from '../lib/workshop-model.mjs';

const ids = ['abcdefghijk', 'lmnopqrstuv'];
const capturedAt = '2026-09-08T12:00:00Z';
const activity = [10, 30, 180, 30, 2, 1, 1, 2, 1];
const report = (definition, rows) => ({
  columnHeaders: [...(definition.dimensions ? definition.dimensions.split(',') : []), ...definition.metrics.split(',')].map(name => ({ name })),
  ...(rows === undefined ? {} : { rows })
});
const snapshot = () => ({
  capturedAt: '2026-09-03T12:00:00Z',
  apiThrough: '2026-09-02',
  studioCapturedAt: '2026-09-03T15:00:00Z',
  history: { videos: [{ videoId: ids[0], tests: [{ testId: 'old-test', status: 'inconclusive' }], variants: [{ title: 'Historical pair', status: 'test' }] }] },
  videos: ids.map((id, i) => ({
    id, name: `Episode ${i + 1}`, title: 'Historic title', thumb: `assets/${id}.jpg`,
    publishedAt: '2026-09-02T01:00:00Z', durationSeconds: 600, episode: i + 1,
    daily: ['2026-09-01', '2026-09-02'].map(day => ({ day, ...Object.fromEntries(ACTIVITY_METRICS.map((key, index) => [key, activity[index]])) })),
    retention: [{ elapsedVideoTimeRatio: .05, audienceWatchRatio: .7, relativeRetentionPerformance: .4 }],
    retentionNear30Seconds: { sampledSeconds: 30, audienceWatchRatio: .7 },
    traffic: [{ insightTrafficSourceType: 'YT_SEARCH', views: 20, estimatedMinutesWatched: 60 }],
    studio: { capturedAt: '2026-09-03T15:00:00Z', ctrPct: 4.1, note: 'Preserve this verbatim' }
  }))
});

function mockYouTube({ failReport, emptyRetention = false, omitOldDay = false, wrongOwner = false, wrongType = false, malformedMetric = false } = {}) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const response = payload => ({ ok: true, status: 200, json: async () => payload });
    if (url.pathname.endsWith('/channels')) return response({ items: [{ id: 'our-channel' }] });
    if (url.pathname.endsWith('/videos')) return response({ items: ids.map(id => ({
      id, snippet: { channelId: wrongOwner ? 'another-channel' : 'our-channel', title: `Current ${id}`, description: 'Recorded description\n00:00 Introduction', tags: ['food', 'football'], publishedAt: '2026-09-02T01:00:00Z', thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 360 } } },
      contentDetails: { duration: 'PT10M' }, status: { privacyStatus: 'public' },
      statistics: { viewCount: '100', likeCount: '10', commentCount: '2' }
    })) });
    assert.equal(url.origin, 'https://youtubeanalytics.googleapis.com');
    assert.equal(url.searchParams.get('ids'), 'channel==MINE');
    assert.equal(url.searchParams.get('startDate'), '2026-09-01');
    const dimension = url.searchParams.get('dimensions') || '';
    const type = Object.keys(REPORTS).find(key => (REPORTS[key].dimensions || '') === dimension);
    assert.ok(type);
    assert.equal(url.searchParams.get('metrics'), REPORTS[type].metrics);
    if (type === failReport) return { ok: false, status: 403, json: async () => ({ error: 'sensitive body should never be printed' }) };
    if (type === 'daily') {
      const last = url.searchParams.get('filters') === `video==${ids[0]}` ? '2026-09-04' : '2026-09-03';
      const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'].filter(day => day <= last && !(omitOldDay && day === '2026-09-01'));
      return response(report(REPORTS.daily, days.map(day => [day, ...activity.map((value, i) => malformedMetric && i === 1 ? null : value)])));
    }
    assert.equal(url.searchParams.get('endDate'), '2026-09-03', 'non-daily reports must use actual common coverage');
    if (type === 'contentType') return response(report(REPORTS.contentType, [[wrongType ? 'SHORTS' : 'VIDEO_ON_DEMAND', 30, 90]]));
    if (type === 'aggregate') return response(report(REPORTS.aggregate, [[30, 90, 180, 30, 6, 3, 3, 6, 3]]));
    if (type === 'retention') return response(report(REPORTS.retention, emptyRetention ? undefined : [[.05, .75, .45], [.5, .4, .3]]));
    if (type === 'traffic') return response(report(REPORTS.traffic, [['YT_SEARCH', 30, 90]]));
    throw new Error('Unexpected endpoint in test');
  };
  return { fetchImpl, calls };
}
const collect = (fixture, options = {}) => collectYouTubeEpisodes({ snapshot: fixture, end: '2026-09-06', capturedAt, env: { YOUTUBE_ACCESS_TOKEN: 'test-token' }, ...options });

test('collector uses supported isolated reports and actual common returned date', async () => {
  const before = snapshot();
  const original = structuredClone(before);
  const mock = mockYouTube();
  const result = await collect(before, mock);
  assert.equal(result.snapshot.apiThrough, '2026-09-03');
  assert.equal(result.evidence.requestedEnd, '2026-09-06');
  assert.equal(result.snapshot.videos[0].apiAggregate.views, 30);
  assert.equal(result.snapshot.videos[0].daily.length, 3);
  assert.equal(result.snapshot.videos[0].subscribersNet, 3);
  assert.equal(result.snapshot.videos[0].windows[3].views, 30);
  assert.equal(result.snapshot.videos[0].windows[3].start, '2026-09-01');
  assert.equal(result.snapshot.videos[0].windows[7].complete, false);
  assert.deepEqual(result.snapshot.history, original.history);
  assert.equal(result.snapshot.videos[0].packagingCapturedAt, original.capturedAt);
  assert.deepEqual(result.snapshot.videos[0].studio, original.videos[0].studio);
  assert.equal(result.snapshot.studioCapturedAt, original.studioCapturedAt);
  assert.equal(result.snapshot.videos[0].title, 'Historic title');
  assert.equal(result.snapshot.videos[0].thumb, original.videos[0].thumb);
  assert.equal(result.snapshot.videos[0].metadata.title, `Current ${ids[0]}`);
  assert.equal(result.snapshot.videos[0].metadata.capturedAt, capturedAt);
  assert.deepEqual(before, original, 'input snapshot must not mutate');
  assert.ok(mock.calls.every(call => call.options.method === 'GET'));
  const trafficCall = mock.calls.find(call => call.url.searchParams.get('dimensions') === 'insightTrafficSourceType');
  assert.equal(trafficCall.url.searchParams.get('metrics'), 'views,estimatedMinutesWatched');
  assert.ok(!JSON.stringify(result).includes('test-token'));
});

test('empty retention preserves old curve and explicitly keeps its earlier source date', async () => {
  const before = snapshot();
  const result = await collect(before, mockYouTube({ emptyRetention: true }));
  assert.deepEqual(result.snapshot.videos[0].retention, before.videos[0].retention);
  assert.equal(result.snapshot.videos[0].retentionSource.end, before.apiThrough);
  assert.equal(result.snapshot.videos[0].retentionSource.capturedAt, before.capturedAt);
  assert.equal(result.snapshot.videos[0].refreshReports.retention, 'no-rows-retained-previous');
  assert.equal(result.warnings.length, 2);
});

test('partial API failure rejects the whole refresh without changing original data', async () => {
  const before = snapshot();
  const bytes = JSON.stringify(before);
  await assert.rejects(collect(before, mockYouTube({ failReport: 'traffic' })), error => error.code === 'authorization' && !error.message.includes('sensitive'));
  assert.equal(JSON.stringify(before), bytes);
});

test('owner mismatch, Shorts classification, missing old rows and missing metrics all fail closed', async () => {
  for (const option of [{ wrongOwner: true }, { wrongType: true }, { omitOldDay: true }, { malformedMetric: true }]) {
    await assert.rejects(collect(snapshot(), mockYouTube(option)));
  }
});

test('missing authorization and current-day requests fail without a network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected'); };
  await assert.rejects(collect(snapshot(), { env: {}, fetchImpl }), error => error.code === 'not-configured');
  await assert.rejects(collect(snapshot(), { end: '2026-09-08', fetchImpl }), error => error.code === 'configuration');
  assert.equal(calls, 0);
});

test('report decoding follows returned headers and rejects incomplete metric arrays', () => {
  assert.deepEqual(decodeReport({ columnHeaders: [{ name: 'views' }, { name: 'creatorContentType' }, { name: 'estimatedMinutesWatched' }], rows: [[10, 'VIDEO_ON_DEMAND', 30]] }, REPORTS.contentType), [{ views: 10, creatorContentType: 'VIDEO_ON_DEMAND', estimatedMinutesWatched: 30 }]);
  assert.throws(() => decodeReport(report(REPORTS.aggregate, [[1]]), REPORTS.aggregate));
  assert.throws(() => decodeReport({ columnHeaders: [{ name: 'views' }], rows: [[1]] }, REPORTS.aggregate));
});

test('metadata audit uses actual collected content with dates, including empty fields', () => {
  const audit = metadataAudit({ title: 'Old', metadata: { title: 'New title', description: '', tags: [], capturedAt } });
  assert.equal(audit.title, 'New title');
  assert.equal(audit.capturedAt, capturedAt);
  assert.equal(audit.description, 'Empty at capture');
  assert.equal(audit.tags, '0 returned');
  assert.equal(audit.characters, 9);
});

test('Pacific publication date can differ from the UTC timestamp in launch windows', () => {
  const video = snapshot().videos[0];
  video.reportingPublishedDate = '2026-09-01';
  video.daily.push({ day: '2026-09-03', views: 10, estimatedMinutesWatched: 30, subscribersGained: 2, subscribersLost: 1 });
  assert.equal(windowMetrics(video, 3).complete, true);
  assert.equal(windowMetrics(video, 3).start, '2026-09-01');
});

test('write archives exact original bytes, preserves test evidence, and refuses concurrent changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scran-youtube-sync-'));
  try {
    const originalBytes = Buffer.from(JSON.stringify(snapshot(), null, 3) + '\r\n');
    await writeFile(join(root, 'data.json'), originalBytes);
    const result = await collect(snapshot(), mockYouTube());
    const written = await commitYouTubeRefresh({ root, originalBytes, result });
    assert.deepEqual(await readFile(written.backupPath), originalBytes);
    const next = JSON.parse(await readFile(join(root, 'data.json'), 'utf8'));
    assert.equal(next.apiThrough, '2026-09-03');
    assert.deepEqual(next.history, snapshot().history);
    assert.equal((await readdir(join(root, '.private', 'youtube-imports'))).length, 2);
    await assert.rejects(commitYouTubeRefresh({ root, originalBytes, result }), error => error.code === 'conflict');
    assert.deepEqual(JSON.parse(await readFile(join(root, 'data.json'), 'utf8')), next);
    assert.ok(!(await readdir(join(root, '.private'))).includes('youtube-sync.lock'));
  } finally {
    // This exact mkdtemp directory is test-owned; no user-selected path is removed.
    await rm(root, { recursive: true, force: true });
  }
});
