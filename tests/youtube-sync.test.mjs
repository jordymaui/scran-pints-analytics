import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectYouTubeEpisodes, commitYouTubeRefresh, decodeReport, REPORTS, ACTIVITY_METRICS, pacificDate } from '../lib/youtube-sync.mjs';
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

function mockYouTube({
  failReport, emptyRetention = false, omitOldDay = false, wrongOwner = false,
  wrongType = false, malformedMetric = false, extraVideos = [], pageSize = 50,
  repeatedPageToken = false, missingInventoryId, wrongChannel = false,
  expectedThrough = '2026-09-03', unexpectedTypeId = false, quietOldId,
  channelDays = ['2026-09-01', '2026-09-02', '2026-09-03'],
} = {}) {
  const calls = [];
  const catalog = [...ids.map(id => ({ id })), ...extraVideos];
  const byId = new Map(catalog.map(video => [video.id, video]));
  const publication = video => video.publishedAt || '2026-09-02T01:00:00Z';
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const response = payload => ({ ok: true, status: 200, json: async () => payload });
    if (url.pathname.endsWith('/channels')) return response({ items: [{ id: wrongChannel ? 'different-channel' : 'our-channel', contentDetails: { relatedPlaylists: { uploads: 'UUour_uploads_playlist' } } }] });
    if (url.pathname.endsWith('/playlistItems')) {
      assert.equal(url.searchParams.get('playlistId'), 'UUour_uploads_playlist');
      assert.equal(url.searchParams.get('part'), 'contentDetails');
      assert.equal(url.searchParams.get('maxResults'), '50');
      const offset = Number(url.searchParams.get('pageToken')?.replace('page-', '') || 0);
      const inventory = catalog.filter(video => video.id !== missingInventoryId);
      const next = offset + pageSize;
      return response({ items: inventory.slice(offset, next).map(video => ({ contentDetails: { videoId: video.id } })),
        ...(next < inventory.length || repeatedPageToken ? { nextPageToken: repeatedPageToken ? 'page-1' : `page-${next}` } : {}) });
    }
    if (url.pathname.endsWith('/videos')) return response({ items: url.searchParams.get('id').split(',').map(id => byId.get(id)).filter(video => !video.missingMetadata).map(video => ({
      id: video.id, snippet: { channelId: wrongOwner ? 'another-channel' : 'our-channel', title: `Current ${video.id}`, description: 'Recorded description\n00:00 Introduction', tags: ['food', 'football'], publishedAt: publication(video), thumbnails: video.noThumbnail ? {} : { high: { url: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`, width: 480, height: 360 } } },
      contentDetails: { duration: video.duration || 'PT10M' }, status: { privacyStatus: video.privacy || 'public' },
      statistics: { viewCount: '100', likeCount: '10', commentCount: '2' }
    })) });
    assert.equal(url.origin, 'https://youtubeanalytics.googleapis.com');
    assert.equal(url.searchParams.get('ids'), 'channel==MINE');
    if (!url.searchParams.has('filters')) {
      assert.equal(url.searchParams.get('dimensions'), 'day');
      assert.equal(url.searchParams.get('metrics'), ACTIVITY_METRICS.join(','));
      assert.equal(url.searchParams.get('endDate'), '2026-09-06');
      return response(report(REPORTS.daily, channelDays.map(day => [day, ...activity])));
    }
    const requestedIds = url.searchParams.get('filters').replace('video==', '').split(',');
    const requested = requestedIds.map(id => byId.get(id));
    assert.equal(url.searchParams.get('startDate'), requested.map(video => pacificDate(publication(video))).sort()[0]);
    const dimension = url.searchParams.get('dimensions') || '';
    const type = Object.keys(REPORTS).find(key => (REPORTS[key].dimensions || '') === dimension);
    assert.ok(type);
    assert.equal(url.searchParams.get('metrics'), REPORTS[type].metrics);
    if (type === failReport) return { ok: false, status: 403, json: async () => ({ error: 'sensitive body should never be printed' }) };
    if (type === 'contentType' || type === 'discovery') {
      assert.equal(url.searchParams.get('endDate'), '2026-09-06', 'format discovery uses the requested reporting cutoff');
      const rows = requested.flatMap(video => {
        const formats = video.type === null ? [] : Array.isArray(video.type) ? video.type : [wrongType ? 'SHORTS' : video.type || 'VIDEO_ON_DEMAND'];
        return formats.map(format => [...(type === 'discovery' ? [unexpectedTypeId ? 'UNEXPECTED1' : video.id] : []), format, 30, 90]);
      });
      const startIndex = Number(url.searchParams.get('startIndex') || 1) - 1;
      return response(report(REPORTS[type], rows.slice(startIndex, startIndex + 200)));
    }
    if (type === 'daily') {
      const last = requestedIds[0] === quietOldId ? '2026-09-02' : url.searchParams.get('filters') === `video==${ids[0]}` ? '2026-09-04' : '2026-09-03';
      const days = (requested[0].days ?? ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'].filter(day => day <= last && !(omitOldDay && day === '2026-09-01'))).filter(day => day <= url.searchParams.get('endDate'));
      return response(report(REPORTS.daily, days.map(day => [day, ...activity.map((value, i) => malformedMetric && i === 1 ? null : value)])));
    }
    assert.equal(url.searchParams.get('endDate'), expectedThrough, 'activity reports must use actual common coverage');
    if (type === 'aggregate') return response(report(REPORTS.aggregate, requested[0].emptyAggregate ? [] : [[30, 90, 180, 30, 6, 3, 3, 6, 3]]));
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
  assert.equal(result.snapshot.youtubeRefresh.discovery.status, 'complete');
  assert.equal(result.snapshot.youtubeRefresh.discovery.includedLongformCount, ids.length);
  assert.equal(result.snapshot.youtubeRefresh.coverageBasis, 'channel-daily-same-metrics');
  assert.equal(result.snapshot.videos[0].analyticsSource.endStatus, 'channel-daily-completeness-bound');
  const channelReport = mock.calls.find(call => call.url.origin === 'https://youtubeanalytics.googleapis.com' && !call.url.searchParams.has('filters'));
  assert.equal(channelReport.url.searchParams.get('metrics'), ACTIVITY_METRICS.join(','));
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

test('discovery paginates all uploads and metadata batches, adding only Analytics-confirmed long-form', async () => {
  const extraVideos = Array.from({ length: 53 }, (_, i) => ({
    id: String(i + 1).padStart(11, '0'),
    type: i === 0 ? 'VIDEO_ON_DEMAND' : 'SHORTS',
    // Equal duration proves that format is taken from Analytics, not length.
    duration: 'PT30S',
  }));
  const original = snapshot();
  const mock = mockYouTube({ extraVideos });
  const result = await collect(original, mock);
  const discovered = result.snapshot.videos.at(-1);
  assert.equal(result.snapshot.videos.length, 3);
  assert.equal(discovered.id, extraVideos[0].id);
  assert.equal(discovered.name, `Current ${discovered.id}`);
  assert.equal(discovered.title, discovered.metadata.title);
  assert.equal(discovered.thumb, `https://i.ytimg.com/vi/${discovered.id}/hqdefault.jpg`);
  assert.equal(discovered.packagingCapturedAt, capturedAt);
  assert.equal(discovered.discoveredAt, capturedAt);
  assert.equal(discovered.episode, null, 'never infer an editorial episode number');
  assert.equal(discovered.studio, undefined, 'never invent a Studio observation');
  assert.equal(discovered.durationSeconds, 30);
  assert.equal(discovered.contentTypeEvidence.creatorContentType, 'VIDEO_ON_DEMAND');
  assert.deepEqual(result.snapshot.history, original.history);
  assert.deepEqual(result.snapshot.videos.slice(0, 2).map(video => [video.id, video.title, video.thumb, video.episode]), original.videos.map(video => [video.id, video.title, video.thumb, video.episode]));
  assert.equal(mock.calls.filter(call => call.url.pathname.endsWith('/playlistItems')).length, 2);
  assert.equal(mock.calls.filter(call => call.url.pathname.endsWith('/videos')).length, 2);
  assert.ok(mock.calls.filter(call => call.url.searchParams.get('dimensions') === 'video,creatorContentType').every(call => call.url.searchParams.get('filters').split(',').length <= 50));
  assert.ok(!mock.calls.some(call => call.url.pathname.endsWith('/search')), 'uploads inventory avoids search ranking/limits');
  assert.deepEqual(result.snapshot.youtubeRefresh.discovery, {
    status: 'complete', inventoryComplete: true, observedAt: capturedAt,
    publicUploadsCount: 55, confirmedLongformCount: 3, includedLongformCount: 3,
    excludedShortsCount: 52, excludedLiveCount: 0, excludedOtherCount: 0,
    nonPublicOrUnavailableCount: 0, unknownFormatIds: [], unreportedLongformIds: [], pendingPublicationIds: [],
  });
});

test('unknown, mixed and missing format reports stay explicit; private metadata never enters the result', async () => {
  const extraVideos = [
    { id: 'unknown0001', type: 'UNSPECIFIED' },
    { id: 'noformat001', type: null },
    { id: 'mixed000001', type: ['VIDEO_ON_DEMAND', 'SHORTS'] },
    { id: 'futuretype1', type: 'FUTURE_UNDOCUMENTED_TYPE' },
    { id: 'live0000001', type: 'LIVE_STREAM', duration: 'PT0S' },
    { id: 'story000001', type: 'STORY' },
    { id: 'private0001', privacy: 'private' },
    { id: 'missing0001', missingMetadata: true },
    { id: 'pending0001', publishedAt: '2026-09-07T17:00:00Z', duration: 'PT0S' },
  ];
  const mock = mockYouTube({ extraVideos });
  const result = await collect(snapshot(), mock);
  const discovery = result.snapshot.youtubeRefresh.discovery;
  assert.equal(discovery.status, 'partial');
  assert.equal(discovery.publicUploadsCount, 9);
  assert.equal(discovery.excludedLiveCount, 1);
  assert.equal(discovery.excludedOtherCount, 1);
  assert.equal(discovery.nonPublicOrUnavailableCount, 2);
  assert.deepEqual(discovery.unknownFormatIds, ['futuretype1', 'mixed000001', 'noformat001', 'unknown0001']);
  assert.deepEqual(discovery.pendingPublicationIds, ['pending0001']);
  assert.equal(result.snapshot.videos.length, 2);
  assert.ok(!JSON.stringify(result.snapshot).includes('private0001'));
  assert.ok(!JSON.stringify(result.snapshot).includes('missing0001'));
  const analyticsCalls = mock.calls.filter(call => call.url.origin === 'https://youtubeanalytics.googleapis.com');
  assert.ok(analyticsCalls.every(call => !call.url.searchParams.get('filters')?.includes('pending0001')));
  assert.ok(result.warnings.some(warning => warning.includes('unknown format')));
});

test('new confirmed uploads without daily or aggregate data stay excluded without erasing existing evidence', async () => {
  const extraVideos = [
    { id: 'nodaily0001', days: [] },
    { id: 'oldonly0001', days: ['2026-09-01'] },
    { id: 'noaggregate', emptyAggregate: true },
    { id: 'notready001', publishedAt: '2026-09-05T17:00:00Z' },
  ];
  const result = await collect(snapshot(), mockYouTube({ extraVideos }));
  const discovery = result.snapshot.youtubeRefresh.discovery;
  assert.equal(result.snapshot.apiThrough, '2026-09-03');
  assert.equal(result.snapshot.videos.length, 3);
  assert.equal(discovery.confirmedLongformCount, 6);
  assert.equal(discovery.includedLongformCount, 3);
  assert.deepEqual(discovery.unreportedLongformIds, ['noaggregate', 'nodaily0001', 'notready001']);
  assert.equal(discovery.status, 'partial');
});

test('quiet old uploads and gaps do not pin the channel processing cutoff or exclude new long-form', async () => {
  const result = await collect(snapshot(), mockYouTube({
    extraVideos: [{ id: 'newlong0001', days: ['2026-09-02'], noThumbnail: true }],
    quietOldId: ids[1],
  }));
  assert.equal(result.snapshot.apiThrough, '2026-09-03');
  assert.equal(result.snapshot.videos.length, 3);
  assert.equal(result.snapshot.videos[1].dailyCoverage[1], '2026-09-02');
  assert.ok(!result.snapshot.videos[1].daily.some(row => row.day === '2026-09-03'), 'a missing day must not become an invented zero');
  assert.equal(result.snapshot.videos[1].analyticsSource.end, '2026-09-03');
  assert.equal(result.snapshot.videos.at(-1).thumb, null);
  assert.equal(result.snapshot.videos.at(-1).windows[3].complete, false);
  assert.equal(result.snapshot.youtubeRefresh.discovery.status, 'complete');
});

test('channel availability cannot invent a requested trailing date or regress saved coverage', async () => {
  for (const [channelDays, code] of [
    [[], 'no-data'], [['2026-09-01'], 'stale-data'], [['2026-09-07'], 'invalid-response'],
    [['2026-09-03', '2026-09-03'], 'invalid-response'],
  ]) await assert.rejects(collect(snapshot(), mockYouTube({ channelDays })), error => error.code === code);
});

test('discovery rejects inconsistent pagination, wrong channel and unrequested classification rows', async () => {
  for (const options of [
    { repeatedPageToken: true, pageSize: 1 },
    { missingInventoryId: ids[0] },
    { unexpectedTypeId: true },
    { wrongChannel: true },
  ]) {
    const original = snapshot();
    const copy = structuredClone(original);
    await assert.rejects(collect(original, mockYouTube(options)));
    assert.deepEqual(original, copy);
  }
  await assert.rejects(collect(snapshot(), {
    ...mockYouTube(), env: { YOUTUBE_ACCESS_TOKEN: 'test-token', YOUTUBE_CHANNEL_ID: 'wrong-saved-channel' },
  }), error => error.code === 'authorization');
});

test('format failure during discovery cannot replace the previous successful snapshot', async () => {
  const original = snapshot();
  const copy = structuredClone(original);
  await assert.rejects(collect(original, mockYouTube({ failReport: 'discovery' })), error => error.code === 'authorization');
  assert.deepEqual(original, copy);
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
