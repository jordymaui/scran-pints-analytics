import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectYouTubeEpisodes, commitYouTubeRefresh, decodeReport, REPORTS, ACTIVITY_METRICS, pacificDate } from '../lib/youtube-sync.mjs';
import { metadataAudit, windowMetrics } from '../lib/workshop-model.mjs';
import { normalizeYouTubeContentType } from '../lib/youtube-content-type.mjs';
import { publicYouTubeFixture } from './fixtures/public-youtube.mjs';
import { CHANNEL_BREAKDOWN_REPORTS, UPLOAD_REPORTS, UPLOAD_ACTIVITY_METRICS } from '../lib/youtube-breakdowns.mjs';

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
  channelPublishedAt = '2026-08-01T01:00:00Z', channelDailyValues = activity,
  channelAggregateRows = [[300, 990, 198, 33, 60, 30, 30, 70, 20]],
  inventoryIds,
  defaultContentType = 'videoOnDemand',
  channelVideoCount, channelId = 'our-channel',
  requestedEnd = '2026-09-06',
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
    if (url.pathname.endsWith('/channels')) {
      assert.equal(url.searchParams.get('part'), 'id,snippet,contentDetails,statistics');
      return response({ items: [{ id: wrongChannel ? 'different-channel' : channelId,
        ...(channelPublishedAt === null ? {} : { snippet: { publishedAt: channelPublishedAt } }),
        ...(channelVideoCount === null ? {} : { statistics: { videoCount: String(channelVideoCount ?? catalog.filter(video => !video.privacy || video.privacy === 'public').length) } }),
        contentDetails: { relatedPlaylists: { uploads: 'UUour_uploads_playlist' } } }] });
    }
    if (url.pathname.endsWith('/playlistItems')) {
      assert.equal(url.searchParams.get('playlistId'), 'UUour_uploads_playlist');
      assert.equal(url.searchParams.get('part'), 'contentDetails');
      assert.equal(url.searchParams.get('maxResults'), '50');
      const offset = Number(url.searchParams.get('pageToken')?.replace('page-', '') || 0);
      const inventory = (inventoryIds || catalog.map(video => video.id)).filter(id => id !== missingInventoryId);
      const next = offset + pageSize;
      return response({ items: inventory.slice(offset, next).map(id => ({ contentDetails: { videoId: id } })),
        ...(next < inventory.length || repeatedPageToken ? { nextPageToken: repeatedPageToken ? 'page-1' : `page-${next}` } : {}) });
    }
    if (url.pathname.endsWith('/videos')) return response({ items: url.searchParams.get('id').split(',').map(id => byId.get(id)).filter(video => !video.missingMetadata).map(video => ({
      id: video.id, snippet: { channelId: wrongOwner ? 'another-channel' : video.channelId || channelId, title: `Current ${video.id}`, description: 'Recorded description\n00:00 Introduction', tags: ['food', 'football'], publishedAt: publication(video), thumbnails: video.noThumbnail ? {} : { high: { url: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`, width: 480, height: 360 } } },
      contentDetails: { duration: video.duration || 'PT10M' }, status: { privacyStatus: video.privacy || 'public' },
      statistics: { viewCount: '100', likeCount: '10', commentCount: '2' }
    })) });
    assert.equal(url.origin, 'https://youtubeanalytics.googleapis.com');
    assert.equal(url.searchParams.get('ids'), 'channel==MINE');
    if (!url.searchParams.get('filters')?.startsWith('video==') &&
      url.searchParams.get('metrics') !== ACTIVITY_METRICS.join(',')) {
      const definition = Object.values(CHANNEL_BREAKDOWN_REPORTS).find(value =>
        value.dimensions === url.searchParams.get('dimensions') &&
        value.metrics === url.searchParams.get('metrics') &&
        (value.filters || null) === url.searchParams.get('filters'));
      assert.ok(definition, 'only declared optional channel reports are requested');
      if (definition.maxResults) assert.equal(url.searchParams.get('maxResults'), String(definition.maxResults));
      return response(report(definition, []));
    }
    if (!url.searchParams.has('filters')) {
      assert.equal(url.searchParams.get('metrics'), ACTIVITY_METRICS.join(','));
      const channelType = url.searchParams.has('dimensions') ? 'channelDaily' : 'channelAggregate';
      if (failReport === channelType) return { ok: false, status: 403, json: async () => ({ error: 'sensitive provider body' }) };
      if (channelType === 'channelAggregate') {
        assert.equal(url.searchParams.get('endDate'), expectedThrough, 'channel aggregate uses the actual daily cutoff');
        return response(report(REPORTS.aggregate, channelAggregateRows));
      }
      assert.equal(url.searchParams.get('dimensions'), 'day');
      assert.equal(url.searchParams.get('endDate'), requestedEnd);
      const startIndex = Number(url.searchParams.get('startIndex') || 1) - 1;
      return response(report(REPORTS.daily, channelDays.slice(startIndex, startIndex + 200).map(day => [day, ...channelDailyValues])));
    }
    const requestedIds = url.searchParams.get('filters').replace('video==', '').split(',');
    const requested = requestedIds.map(id => byId.get(id));
    const dimension = url.searchParams.get('dimensions') || '';
    const uploadType = Object.keys(UPLOAD_REPORTS).find(type =>
      UPLOAD_REPORTS[type].metrics === url.searchParams.get('metrics') &&
      [UPLOAD_REPORTS[type].dimensions || '', ['video', UPLOAD_REPORTS[type].dimensions].filter(Boolean).join(',')].includes(dimension) &&
      (UPLOAD_REPORTS[type].metrics !== REPORTS[type]?.metrics || dimension.startsWith('video,')));
    if (uploadType) {
      const definition = { ...UPLOAD_REPORTS[uploadType], ...(dimension ? { dimensions: dimension } : {}) };
      const prefix = id => dimension.startsWith('video') ? [id] : [];
      const values = UPLOAD_ACTIVITY_METRICS.map(key =>
        ACTIVITY_METRICS.includes(key) ? activity[ACTIVITY_METRICS.indexOf(key)] : 1);
      if (uploadType === 'retention') return response(report(definition,
        emptyRetention ? [] : [[.5, .4, .3, 1, 2, 3]]));
      if (uploadType === 'traffic') return response(report(definition,
        requestedIds.map(id => [...prefix(id), 'YT_SEARCH', 30, 90])));
      if (uploadType === 'aggregate') return response(report(definition,
        requestedIds.map(id => [...prefix(id), ...values])));
      return response(report(definition, requestedIds.map(id => [...prefix(id), '2026-09-02', ...values])));
    }
    assert.equal(url.searchParams.get('startDate'), requested.map(video => pacificDate(publication(video))).sort()[0]);
    const type = Object.keys(REPORTS).find(key => (REPORTS[key].dimensions || '') === dimension);
    assert.ok(type);
    assert.equal(url.searchParams.get('metrics'), REPORTS[type].metrics);
    if (type === failReport) return { ok: false, status: 403, json: async () => ({ error: 'sensitive body should never be printed' }) };
    if (type === 'contentType' || type === 'discovery') {
      assert.equal(url.searchParams.get('endDate'), requestedEnd, 'format discovery uses the requested reporting cutoff');
      const rows = requested.flatMap(video => {
        const formats = video.type === null ? [] : Array.isArray(video.type) ? video.type : [wrongType ? 'shorts' : video.type || defaultContentType];
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

test('private channel Analytics preserves native all-format totals and the actual daily reporting window', async () => {
  const mock = mockYouTube();
  const result = await collect(snapshot(), mock);
  const analytics = result.snapshot.channelAnalytics;
  assert.equal(analytics.capturedAt, capturedAt);
  assert.equal(analytics.channelId, 'our-channel');
  assert.deepEqual(analytics.dateRange, {
    start: '2026-07-31', end: '2026-09-03', timezone: 'America/Los_Angeles',
  }, 'channel creation is converted to the Analytics reporting timezone');
  assert.deepEqual(analytics.coverage, { startBasis: 'channel-created', endBasis: 'channel-daily-same-metrics' });
  assert.deepEqual(analytics.aggregate, Object.fromEntries(ACTIVITY_METRICS.map((key, i) =>
    [key, [300, 990, 198, 33, 60, 30, 30, 70, 20][i]])));
  assert.equal(analytics.aggregate.subscribersGained, 70, 'channel subscriptions must not be summed from video watch-page attribution');
  assert.notEqual(analytics.aggregate.views, result.snapshot.videos.reduce((sum, video) => sum + video.apiAggregate.views, 0));
  assert.deepEqual(analytics.daily.map(row => row.day), ['2026-09-01', '2026-09-02', '2026-09-03']);
  const channelRequests = mock.calls.filter(call => call.url.origin === 'https://youtubeanalytics.googleapis.com' &&
    !call.url.searchParams.has('filters') && call.url.searchParams.get('metrics') === ACTIVITY_METRICS.join(','));
  assert.equal(channelRequests.length, 2);
  assert.ok(channelRequests.every(call => call.url.searchParams.get('startDate') === analytics.dateRange.start));
  assert.ok(channelRequests.every(call => call.url.searchParams.get('metrics') === ACTIVITY_METRICS.join(',')));
  assert.equal(channelRequests.find(call => !call.url.searchParams.has('dimensions')).url.searchParams.get('endDate'), analytics.dateRange.end);
});

test('missing or invalid channel creation falls back to the earliest known public upload including earlier Shorts', async () => {
  for (const channelPublishedAt of [null, 'not-a-date', '2026-02-31T01:00:00Z', '2026-09-09T12:00:00Z', '2026-09-01T12:00:00Z']) {
    const mock = mockYouTube({
      channelPublishedAt,
      extraVideos: [{ id: 'earliershrt', type: 'SHORTS', publishedAt: '2026-08-15T01:00:00Z' }],
      channelDays: ['2026-08-14', '2026-09-01', '2026-09-03'],
    });
    const result = await collect(snapshot(), mock);
    assert.equal(result.snapshot.channelAnalytics.dateRange.start, '2026-08-14');
    assert.equal(result.snapshot.channelAnalytics.coverage.startBasis, 'earliest-known-public-upload');
    assert.equal(result.snapshot.channelAnalytics.daily[0].day, '2026-08-14');
    assert.equal(result.snapshot.youtubeRefresh.discovery.excludedShortsCount, 1);
    assert.equal(result.snapshot.videos.length, 2, 'the all-format channel window does not add Shorts to long-form analysis');
  }
});

test('channel daily pagination keeps returned gaps and genuine zeros without filling omitted days', async () => {
  const mock = mockYouTube({
    channelDailyValues: ACTIVITY_METRICS.map(() => 0),
    channelAggregateRows: [ACTIVITY_METRICS.map(() => 0)],
    channelDays: ['2026-09-03', '2026-09-01'],
  });
  const result = await collect(snapshot(), mock);
  assert.deepEqual(result.snapshot.channelAnalytics.daily.map(row => row.day), ['2026-09-01', '2026-09-03']);
  assert.equal(result.snapshot.channelAnalytics.aggregate.views, 0);
  assert.equal(result.snapshot.channelAnalytics.daily[0].views, 0);

  const channelDays = [];
  for (let time = Date.parse('2026-01-01'); time <= Date.parse('2026-09-03'); time += 86_400_000) {
    channelDays.push(new Date(time).toISOString().slice(0, 10));
  }
  const paginated = mockYouTube({ channelPublishedAt: '2026-01-01T08:00:00Z', channelDays });
  const collected = await collect(snapshot(), paginated);
  assert.equal(collected.snapshot.channelAnalytics.daily.length, channelDays.length);
  assert.equal(paginated.calls.filter(call => call.url.searchParams.get('dimensions') === 'day' &&
    call.url.searchParams.get('metrics') === ACTIVITY_METRICS.join(',') && !call.url.searchParams.has('filters')).length, 2);
});

test('incomplete or malformed channel activity rejects the refresh without redating prior channel Analytics', async () => {
  const invalidMetric = [...activity];
  invalidMetric[1] = null;
  const fractionalCounter = [...activity];
  fractionalCounter[0] = 1.5;
  for (const options of [
    { channelAggregateRows: [] },
    { channelAggregateRows: [activity, activity] },
    { channelAggregateRows: [invalidMetric] },
    { channelAggregateRows: [fractionalCounter] },
    { channelDailyValues: fractionalCounter },
    { channelDays: ['2026-07-30', '2026-09-03'] },
    { failReport: 'channelAggregate' },
    { failReport: 'channelDaily' },
  ]) {
    const original = snapshot();
    original.channelAnalytics = { capturedAt: original.capturedAt, note: 'Previously saved observation' };
    const copy = structuredClone(original);
    await assert.rejects(collect(original, mockYouTube(options)));
    assert.deepEqual(original, copy);
  }
});

test('empty retention preserves old curve and explicitly keeps its earlier source date', async () => {
  const before = snapshot();
  const result = await collect(before, mockYouTube({ emptyRetention: true }));
  assert.deepEqual(result.snapshot.videos[0].retention, before.videos[0].retention);
  assert.equal(result.snapshot.videos[0].retentionSource.end, before.apiThrough);
  assert.equal(result.snapshot.videos[0].retentionSource.capturedAt, before.capturedAt);
  assert.equal(result.snapshot.videos[0].refreshReports.retention, 'no-rows-retained-previous');
  assert.equal(result.warnings.filter(warning => warning.includes('no new retention rows')).length, 2);
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

test('missing authorization and future-day requests fail without a network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected'); };
  await assert.rejects(collect(snapshot(), { env: {}, fetchImpl }), error => error.code === 'not-configured');
  await assert.rejects(collect(snapshot(), { end: '2026-09-09', fetchImpl }), error => error.code === 'configuration');
  assert.equal(calls, 0);
});

test('today may be requested but the provider response still determines the actual cutoff', async () => {
  const result = await collect(snapshot(), { ...mockYouTube({ requestedEnd: '2026-09-08' }), end: '2026-09-08' });
  assert.equal(result.snapshot.youtubeRefresh.requestedEnd, '2026-09-08');
  assert.equal(result.snapshot.apiThrough, '2026-09-03');
  assert.equal(result.snapshot.uploadAnalytics.dateRange.end, '2026-09-03');
});

test('channel history cannot silently drop a previously returned daily observation', async () => {
  const original = snapshot();
  original.channelAnalytics = { daily: [{ day: '2026-08-05', views: 1 }] };
  const copy = structuredClone(original);
  await assert.rejects(collect(original, mockYouTube()), error => error.code === 'coverage-loss');
  assert.deepEqual(original, copy);
});

test('report decoding follows returned headers and rejects incomplete metric arrays', () => {
  assert.deepEqual(decodeReport({ columnHeaders: [{ name: 'views' }, { name: 'creatorContentType' }, { name: 'estimatedMinutesWatched' }], rows: [[10, 'VIDEO_ON_DEMAND', 30]] }, REPORTS.contentType), [{ views: 10, creatorContentType: 'VIDEO_ON_DEMAND', estimatedMinutesWatched: 30 }]);
  assert.throws(() => decodeReport(report(REPORTS.aggregate, [[1]]), REPORTS.aggregate));
  assert.throws(() => decodeReport({ columnHeaders: [{ name: 'views' }], rows: [[1]] }, REPORTS.aggregate));
});

test('content types normalize only documented values and exact observed owner-report aliases', () => {
  for (const [input, expected] of [
    ['shorts', 'SHORTS'], ['videoOnDemand', 'VIDEO_ON_DEMAND'], ['creatorContentTypeUnspecified', 'UNSPECIFIED'],
    ...['SHORTS', 'VIDEO_ON_DEMAND', 'LIVE_STREAM', 'STORY', 'UNSPECIFIED'].map(value => [value, value]),
  ]) assert.equal(normalizeYouTubeContentType(input), expected);
  for (const value of [null, 1, {}, 'VideoOnDemand', 'VIDEOONDEMAND', ' Shorts ', 'short', 'liveStream', 'newFutureType', '__proto__']) {
    assert.equal(normalizeYouTubeContentType(value), null);
  }
});

test('observed format aliases classify long-form and Shorts while unknown formats remain explicit', async () => {
  const result = await collect(snapshot(), mockYouTube({ extraVideos: [
    { id: 'camelvid001', type: 'videoOnDemand' },
    { id: 'camelshort1', type: 'shorts' },
    { id: 'camelnone01', type: 'creatorContentTypeUnspecified' },
  ] }));
  assert.equal(result.snapshot.videos.length, 3);
  assert.equal(result.snapshot.videos.at(-1).id, 'camelvid001');
  assert.equal(result.snapshot.videos.at(-1).contentTypeEvidence.creatorContentType, 'VIDEO_ON_DEMAND');
  assert.equal(result.snapshot.youtubeRefresh.discovery.excludedShortsCount, 1);
  assert.deepEqual(result.snapshot.youtubeRefresh.discovery.unknownFormatIds, ['camelnone01']);
  assert.equal((await collect(snapshot(), mockYouTube({ defaultContentType: 'VIDEO_ON_DEMAND' }))).snapshot.videos.length, 2);
  await assert.rejects(collect(snapshot(), mockYouTube({ extraVideos: [
    { id: 'aliasdup001', type: ['videoOnDemand', 'VIDEO_ON_DEMAND'] },
  ] })), error => error.code === 'invalid-response');
});

test('native signed like adjustments are preserved while other metrics and fractional likes stay invalid', async () => {
  const adjusted = [...activity];
  adjusted[ACTIVITY_METRICS.indexOf('likes')] = -1;
  assert.equal(decodeReport(report(REPORTS.aggregate, [adjusted]), REPORTS.aggregate)[0].likes, -1);
  const result = await collect(snapshot(), mockYouTube({
    channelDailyValues: adjusted, channelAggregateRows: [adjusted],
  }));
  assert.equal(result.snapshot.channelAnalytics.aggregate.likes, -1);
  assert.ok(result.snapshot.channelAnalytics.daily.every(row => row.likes === -1));
  for (const metric of ACTIVITY_METRICS.filter(name => name !== 'likes')) {
    const invalid = [...activity];
    invalid[ACTIVITY_METRICS.indexOf(metric)] = -1;
    assert.throws(() => decodeReport(report(REPORTS.aggregate, [invalid]), REPORTS.aggregate),
      error => error.code === 'invalid-response');
  }
  for (const value of [-1.5, Number.MAX_SAFE_INTEGER + 1, null, '1']) {
    const invalid = [...activity];
    invalid[ACTIVITY_METRICS.indexOf('likes')] = value;
    assert.throws(() => decodeReport(report(REPORTS.aggregate, [invalid]), REPORTS.aggregate),
      error => error.code === 'invalid-response');
  }
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
    channelPublicVideoCount: 55, supplementalPublicIdsCount: 0,
  });
});

function publicInventory(videoIds) {
  const fixture = publicYouTubeFixture('2026-09-03T12:00:00Z');
  const template = fixture.content[0];
  fixture.channel.videoCount = videoIds.length;
  fixture.inventory.publicUploadsCount = videoIds.length;
  fixture.content = videoIds.map(id => ({
    ...template, id, url: `https://www.youtube.com/watch?v=${id}`, thumbnail: null,
  }));
  return fixture;
}

test('validated same-channel public inventory supplies missing IDs that are rechecked with owner metadata', async () => {
  const extraVideos = Array.from({ length: 6 }, (_, i) => ({ id: `supplement${i}`, type: 'shorts' }));
  const before = snapshot();
  before.publicReport = publicInventory([...ids, ...extraVideos.map(video => video.id)]);
  const mock = mockYouTube({ extraVideos, inventoryIds: ids, channelId: before.publicReport.channel.id });
  const result = await collect(before, mock);
  const discovery = result.snapshot.youtubeRefresh.discovery;
  assert.equal(discovery.channelPublicVideoCount, 8);
  assert.equal(discovery.publicUploadsCount, 8);
  assert.equal(discovery.supplementalPublicIdsCount, 6);
  assert.equal(discovery.excludedShortsCount, 6);
  assert.equal(discovery.inventoryComplete, true);
  assert.equal(discovery.status, 'complete');
  assert.deepEqual(mock.calls.filter(call => call.url.pathname.endsWith('/videos'))
    .flatMap(call => call.url.searchParams.get('id').split(',')), [...ids, ...extraVideos.map(video => video.id)]);
  assert.equal(result.snapshot.channelAnalytics.aggregate.views, 300);
  assert.ok(Object.values(result.snapshot.channelBreakdowns).every(entry => entry.status === 'no-rows'),
    'empty optional breakdowns do not discard successful core Analytics');
  assert.deepEqual(new Set(result.snapshot.uploadAnalytics.videos.map(video => video.id)),
    new Set([...ids, ...extraVideos.map(video => video.id)]), 'all public formats enter the per-upload ledger');
  assert.equal(result.snapshot.uploadAnalytics.videos.filter(video => video.creatorContentType === 'SHORTS').length, 6);

  const missingOld = await collect(before, mockYouTube({
    extraVideos, inventoryIds: [ids[1]], channelId: before.publicReport.channel.id,
  }));
  assert.equal(missingOld.snapshot.youtubeRefresh.discovery.supplementalPublicIdsCount, 7);
  assert.equal(missingOld.snapshot.videos.length, 2, 'an existing video can be recovered by validated current owner metadata');
});

test('saved public IDs never bypass current privacy or ownership checks', async () => {
  const before = snapshot();
  before.publicReport = publicInventory([...ids, 'supplement0']);
  const common = { inventoryIds: ids, channelId: before.publicReport.channel.id };
  const privateResult = await collect(before, mockYouTube({
    ...common, extraVideos: [{ id: 'supplement0', type: 'shorts', privacy: 'private' }],
  }));
  assert.equal(privateResult.snapshot.youtubeRefresh.discovery.publicUploadsCount, 2);
  assert.equal(privateResult.snapshot.youtubeRefresh.discovery.nonPublicOrUnavailableCount, 1);
  assert.equal(privateResult.snapshot.youtubeRefresh.discovery.excludedShortsCount, 0);
  await assert.rejects(collect(before, mockYouTube({
    ...common, extraVideos: [{ id: 'supplement0', type: 'shorts', channelId: 'another-channel' }],
  })), error => error.code === 'authorization');
});

test('malformed or other-channel public catalogs cannot supplement owner inventory', async () => {
  for (const change of [report => { report.schemaVersion = 2; }, report => { report.channel.id = 'another-channel'; }]) {
    const before = snapshot();
    before.publicReport = publicInventory([...ids, 'supplement0']);
    change(before.publicReport);
    const mock = mockYouTube({
      inventoryIds: ids, extraVideos: [{ id: 'supplement0', type: 'shorts' }],
      channelId: publicYouTubeFixture().channel.id,
    });
    const result = await collect(before, mock);
    assert.equal(result.snapshot.youtubeRefresh.discovery.supplementalPublicIdsCount, 0);
    assert.equal(result.snapshot.youtubeRefresh.discovery.inventoryComplete, false);
    assert.equal(result.snapshot.youtubeRefresh.discovery.status, 'partial');
    assert.ok(mock.calls.filter(call => call.url.pathname.endsWith('/videos')).every(call =>
      !call.url.searchParams.get('id').includes('supplement0')));
  }
  const before = snapshot();
  before.publicReport = publicInventory([...ids, 'supplement0']);
  const result = await collect(before, mockYouTube({
    inventoryIds: ids, extraVideos: [{ id: 'supplement0', type: 'shorts' }], channelId: 'another-owner',
  }));
  assert.equal(result.snapshot.youtubeRefresh.discovery.supplementalPublicIdsCount, 0);
  assert.equal(result.snapshot.youtubeRefresh.discovery.status, 'partial');
});

test('missing or mismatched native channel counts make inventory partial without dropping core reports', async () => {
  for (const channelVideoCount of [null, 1, 3]) {
    const result = await collect(snapshot(), mockYouTube({ channelVideoCount }));
    const discovery = result.snapshot.youtubeRefresh.discovery;
    assert.equal(discovery.channelPublicVideoCount, channelVideoCount);
    assert.equal(discovery.inventoryComplete, false);
    assert.equal(discovery.status, 'partial');
    assert.equal(result.snapshot.videos.length, 2);
    assert.equal(result.snapshot.channelAnalytics.aggregate.views, 300);
    assert.ok(result.warnings.some(warning => warning.includes('coverage remains partial')));
  }
});

test('valid repeated owner-playlist entries are deduplicated before metadata and Analytics collection', async () => {
  const extraVideos = Array.from({ length: 142 }, (_, i) => ({
    id: String(i + 1).padStart(11, '0'), type: 'SHORTS',
  }));
  const uniqueIds = [...ids, ...extraVideos.map(video => video.id)];
  // Reproduce the observed owner response: two unique 50-item pages, then
  // 50 valid entries containing six repeats and 44 new videos.
  const inventoryIds = [...uniqueIds.slice(0, 100), ...uniqueIds.slice(94, 100), ...uniqueIds.slice(100)];
  const mock = mockYouTube({ extraVideos, inventoryIds });
  const result = await collect(snapshot(), mock);
  const requestedMetadataIds = mock.calls.filter(call => call.url.pathname.endsWith('/videos'))
    .flatMap(call => call.url.searchParams.get('id').split(','));
  assert.deepEqual(requestedMetadataIds, uniqueIds);
  assert.equal(new Set(requestedMetadataIds).size, 144);
  assert.equal(mock.calls.filter(call => call.url.pathname.endsWith('/playlistItems')).length, 3);
  assert.equal(result.snapshot.youtubeRefresh.discovery.publicUploadsCount, 144);
  assert.equal(result.snapshot.youtubeRefresh.discovery.excludedShortsCount, 142);
  assert.equal(result.snapshot.videos.length, 2);
  assert.ok(result.warnings.some(warning => warning.includes('6 repeated entries')));
});

test('deduplication retains invalid-ID rejection and an independent bound on duplicate-only pages', async () => {
  for (const invalidId of ['', 'too-short', null, { id: ids[0] }]) {
    await assert.rejects(collect(snapshot(), mockYouTube({ inventoryIds: [...ids, invalidId] })),
      error => error.code === 'invalid-response');
  }
  const cycle = mockYouTube({ inventoryIds: [ids[0], ids[0]], pageSize: 1, repeatedPageToken: true });
  await assert.rejects(collect(snapshot(), cycle), error => error.code === 'pagination');
  assert.equal(cycle.calls.filter(call => call.url.pathname.endsWith('/playlistItems')).length, 2,
    'a repeated item does not bypass the repeated page-token guard');
  const mock = mockYouTube({ inventoryIds: Array.from({ length: 101 }, () => ids[0]), pageSize: 1 });
  const original = snapshot();
  const copy = structuredClone(original);
  await assert.rejects(collect(original, mock), error => error.code === 'pagination');
  assert.equal(mock.calls.filter(call => call.url.pathname.endsWith('/playlistItems')).length, 100);
  assert.deepEqual(original, copy);
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
