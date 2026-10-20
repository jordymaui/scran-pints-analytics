import test from 'node:test';
import assert from 'node:assert/strict';
import { collectUploadAnalytics, validateUploadAnalytics, UPLOAD_REPORTS,
  UPLOAD_ACTIVITY_METRICS } from '../lib/youtube-breakdowns.mjs';

const ids = ['longform001', 'shortvid001', 'livevid0001', 'unknown0001'];
const catalog = ids.map((id, index) => ({
  id, title: `Public ${id}`, description: 'Observed description\n00:00 Start',
  tags: ['food', 'football'], metadataHistory: [], publishedAt: '2026-08-28T12:00:00Z',
  durationSeconds: index === 2 ? null : 60,
  thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  creatorContentType: ['VIDEO_ON_DEMAND', 'SHORTS', 'LIVE_STREAM', 'UNSPECIFIED'][index],
}));
const metrics = () => Object.fromEntries(UPLOAD_ACTIVITY_METRICS.map(key =>
  [key, key === 'likes' ? -1 : key === 'averageViewPercentage' ? 150 : 10]));
const defaults = {
  catalog, channelId: 'UCtest', capturedAt: '2026-10-20T12:00:00Z',
  start: '2026-08-28', end: '2026-10-18',
  coverage: { scope: 'verified-public-uploads', inventoryComplete: true,
    publicUploadsCount: 4, channelPublicVideoCount: 4 },
};
function queryFixture({ fail, empty, omitDay = false, calls = [], activity = metrics } = {}) {
  return async request => {
    calls.push(request);
    const { type, videoIds } = request;
    if (type === fail) throw Error('PRIVATE_PROVIDER_MESSAGE token=secret');
    if (type === 'retention' || type === 'retentionSegments') {
      assert.equal(videoIds.length, 1, 'YouTube retention cannot use a multi-video filter');
      const values = { elapsedVideoTimeRatio: .5, audienceWatchRatio: 1.2,
        relativeRetentionPerformance: .6, startedWatching: 0, stoppedWatching: 4, totalSegmentImpressions: 12 };
      return videoIds[0] === empty ? [] : [Object.fromEntries(
        ['elapsedVideoTimeRatio', ...request.report.metrics.split(',')].map(key => [key, values[key]]))];
    }
    return videoIds.flatMap(id => {
      if (id === empty) return [];
      const prefix = videoIds.length > 1 ? { video: id } : {};
      if (type === 'aggregate') return [{ ...prefix, ...activity() }];
      if (type === 'daily') return (omitDay ? ['2026-10-18'] : ['2026-10-17', '2026-10-18'])
        .map(day => ({ ...prefix, day, ...activity() }));
      return [{ ...prefix, insightTrafficSourceType: 'SHORTS', views: 10, estimatedMinutesWatched: 10 }];
    });
  };
}

test('all public formats get native per-video reports, including explicit no-data rows', async () => {
  const calls = [];
  const result = await collectUploadAnalytics({ ...defaults,
    query: queryFixture({ calls, empty: ids[2] }) });
  assert.deepEqual(result.videos.map(video => video.id), ids);
  assert.equal(result.videos[1].daily.report.rows[0].engagedViews, 10);
  assert.equal(result.videos[1].aggregate.report.rows[0].likes, -1);
  assert.equal(result.videos[1].aggregate.report.rows[0].averageViewPercentage, 150);
  assert.ok(['aggregate', 'daily', 'retention', 'traffic'].every(id => result.videos[2][id].status === 'no-rows'));
  assert.equal(result.videos[3].creatorContentType, 'UNSPECIFIED');
  assert.equal(result.videos[3].aggregate.status, 'collected');
  assert.equal(calls.filter(call => call.type === 'retention').length, 4);
  assert.equal(calls.find(call => call.type === 'daily').report.dimensions, 'video,day');
  assert.equal(calls.find(call => call.type === 'traffic').report.dimensions, 'video,insightTrafficSourceType');
  assert.ok(calls.every(call => call.startDate === defaults.start && call.endDate === defaults.end));
  assert.deepEqual(validateUploadAnalytics(result), result);
  assert.deepEqual(catalog[0].metadataHistory, [], 'caller data is not mutated');
});

test('per-report failures and missing dates retain original evidence and metadata observations', async () => {
  const previous = await collectUploadAnalytics({ ...defaults,
    capturedAt: '2026-10-19T12:00:00Z', query: queryFixture() });
  const original = structuredClone(previous);
  const latest = catalog.map(video => ({ ...video, title: 'New observed title', description: 'New copy', tags: ['new'] }));
  const result = await collectUploadAnalytics({ ...defaults, catalog: latest, previous,
    query: queryFixture({ fail: 'retention', omitDay: true }) });
  for (const video of result.videos) {
    assert.equal(video.retention.status, 'failed-retained');
    assert.equal(video.retention.errorCode, 'report-unavailable');
    assert.equal(video.retention.report.capturedAt, previous.capturedAt);
    assert.equal(video.daily.status, 'failed-retained');
    assert.equal(video.daily.errorCode, 'coverage-loss');
    assert.equal(video.metadataCapturedAt, defaults.capturedAt);
    assert.equal(video.metadataHistory[0].capturedAt, previous.capturedAt);
    assert.match(video.metadataHistory[0].title, /^Public /);
    assert.equal(video.title, 'New observed title');
  }
  assert.deepEqual(previous, original);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_MESSAGE|secret/);
});

test('malformed rows fail only their report; uploaded IDs cannot be injected by batch data', async () => {
  const base = queryFixture();
  const result = await collectUploadAnalytics({ ...defaults, query: async request => {
    const rows = await base(request);
    if (request.type === 'aggregate') rows[0].video = 'outsider001';
    if (request.type === 'daily') rows[0].shares = -1;
    return rows;
  } });
  assert.ok(result.videos.every(video => video.aggregate.status === 'failed'));
  assert.equal(result.videos[0].daily.status, 'failed');
  assert.equal(result.videos[0].daily.errorCode, 'invalid-response');
  assert.equal(result.videos[1].daily.status, 'collected');
  assert.equal(result.videos[0].retention.status, 'collected');
});

test('strict upload boundary rejects extra secrets, forged inventory, unsafe thumbnails and dates', async () => {
  const valid = await collectUploadAnalytics({ ...defaults, query: queryFixture() });
  for (const change of [
    value => { value.token = 'secret'; },
    value => { value.videos[0].credentials = {}; },
    value => { value.videos[0].thumbnail = 'https://example.com/anything.jpg'; },
    value => { value.videos[0].thumbnail = `https://i.ytimg.com/vi/${ids[1]}/hqdefault.jpg`; },
    value => { value.videos[0].description = '\u0000'; },
    value => { value.videos[0].metadataCapturedAt = '2026-10-19T12:00:00Z'; },
    value => { value.videos[0].metadataHistory.push({ capturedAt: '2026-10-21T12:00:00Z',
      title: 'Future', description: '', tags: [], thumbnail: null }); },
    value => { value.videos[0].aggregate.report.rows[0].views = -1; },
    value => { value.videos[0].retention.report.rows[0].relativeRetentionPerformance = 1.01; },
    value => { value.videos[0].daily.report.rows[0].day = '2026-08-27'; },
    value => { value.coverage.publicUploadsCount = 3; },
    value => { value.coverage.channelPublicVideoCount = 5; },
    value => { value.videos.push(value.videos[0]); },
  ]) {
    const modified = structuredClone(valid); change(modified);
    assert.throws(() => validateUploadAnalytics(modified));
  }
  const partial = structuredClone(valid);
  partial.coverage.inventoryComplete = false;
  partial.coverage.channelPublicVideoCount = 5;
  assert.deepEqual(validateUploadAnalytics(partial), partial);
});

test('traffic batches respect video-times-day bounds and retention concurrency stays bounded', async () => {
  let active = 0, maximum = 0;
  const calls = [];
  const oldCatalog = Array.from({ length: 12 }, (_, index) => ({ ...catalog[0],
    id: `video${String(index).padStart(6, '0')}`, thumbnail: null, publishedAt: '2000-01-01T12:00:00Z' }));
  const result = await collectUploadAnalytics({ ...defaults, catalog: oldCatalog, start: '2000-01-01',
    coverage: { ...defaults.coverage, publicUploadsCount: 12, channelPublicVideoCount: 12 },
    query: async request => {
      calls.push(request);
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return [];
    } });
  assert.equal(result.videos.length, 12);
  assert.ok(maximum <= 6);
  const dates = (Date.parse(defaults.end) - Date.parse('2000-01-01')) / 86400000 + 1;
  assert.ok(calls.filter(call => call.type === 'traffic').every(call => call.videoIds.length * dates <= 50000));
  assert.ok(calls.filter(call => call.type === 'retention').every(call => call.videoIds.length === 1));
  assert.equal(Object.keys(UPLOAD_REPORTS).length, 4);
});

test('failed large daily batches retry each affected upload without repeating successful batches', async () => {
  const many = Array.from({ length: 184 }, (_, index) => ({ ...catalog[0],
    id: `video${String(index).padStart(6, '0')}`, thumbnail: null }));
  let active = 0, maximum = 0;
  const retries = [];
  const query = queryFixture();
  const result = await collectUploadAnalytics({ ...defaults, catalog: many,
    coverage: { ...defaults.coverage, publicUploadsCount: 184, channelPublicVideoCount: 184 },
    query: async request => {
      active++; maximum = Math.max(maximum, active);
      try {
        await new Promise(resolve => setImmediate(resolve));
        if (request.type === 'daily' && request.videoIds.length === 50) {
          throw Object.assign(Error('PRIVATE_PROVIDER_MESSAGE'), { code: 'pagination' });
        }
        if (request.type === 'daily' && request.videoIds.length === 1) retries.push(request.videoIds[0]);
        return query(request);
      } finally { active--; }
    } });
  assert.equal(retries.length, 150);
  assert.equal(new Set(retries).size, 150);
  assert.ok(maximum <= 6);
  assert.ok(result.videos.every(video => video.daily.status === 'collected'));
  assert.ok(result.videos.every(video => video.daily.report.rows[0].engagedViews === 10));
  assert.equal(result.videos[183].daily.report.rows[0].likes, -1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_MESSAGE/);
});

test('an unrecoverable individual daily report keeps safe reason and its original evidence', async () => {
  const previous = await collectUploadAnalytics({ ...defaults,
    capturedAt: '2026-10-19T12:00:00Z', query: queryFixture() });
  const query = queryFixture();
  const result = await collectUploadAnalytics({ ...defaults, previous, query: async request => {
    if (request.type === 'daily' && (request.videoIds.length > 1 || request.videoIds[0] === ids[0])) {
      throw Object.assign(Error('PRIVATE_PROVIDER_MESSAGE token=secret'), { code: 'invalid-response' });
    }
    return query(request);
  } });
  assert.equal(result.videos[0].daily.status, 'failed-retained');
  assert.equal(result.videos[0].daily.errorCode, 'invalid-response');
  assert.equal(result.videos[0].daily.report.capturedAt, previous.capturedAt);
  assert.ok(result.videos.slice(1).every(video => video.daily.status === 'collected'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_MESSAGE|secret/);
});

test('basic retention survives empty, failed or differently sampled optional segment reports', async () => {
  const query = queryFixture();
  for (const mode of ['empty', 'failed', 'other-ratio', 'invalid']) {
    const result = await collectUploadAnalytics({ ...defaults, query: async request => {
      if (request.type !== 'retentionSegments') return query(request);
      if (mode === 'failed') throw Object.assign(Error('PRIVATE_PROVIDER_MESSAGE'), { code: 'http-error' });
      if (mode === 'empty') return [];
      return [{ elapsedVideoTimeRatio: mode === 'other-ratio' ? .6 : .5,
        startedWatching: mode === 'invalid' ? -1 : 1, stoppedWatching: 2, totalSegmentImpressions: 3 }];
    } });
    for (const video of result.videos) {
      assert.equal(video.retention.status, 'collected', mode);
      const row = video.retention.report.rows[0];
      assert.equal(row.audienceWatchRatio, 1.2);
      assert.equal(row.relativeRetentionPerformance, .6);
      assert.equal(row.startedWatching, null);
      assert.equal(row.stoppedWatching, null);
      assert.equal(row.totalSegmentImpressions, null);
    }
    assert.deepEqual(validateUploadAnalytics(result), result);
    const invalid = structuredClone(result);
    invalid.videos[0].retention.report.rows[0].audienceWatchRatio = null;
    assert.throws(() => validateUploadAnalytics(invalid), 'only optional segment counts may be null');
  }
});

function jsonbRoundTrip(value) {
  if (Array.isArray(value)) return value.map(jsonbRoundTrip);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, jsonbRoundTrip(value[key])]));
  return value;
}
function observation(video, capturedAt) {
  return { capturedAt, title: video.title, description: video.description,
    tags: [...video.tags], thumbnail: video.thumbnail };
}

test('metadata history deduplicates by values across JSONB key order and repeated collections', async () => {
  const older = catalog.map(video => ({ ...video,
    metadataHistory: [jsonbRoundTrip(observation(video, '2026-10-18T12:00:00Z'))] }));
  const previous = jsonbRoundTrip(await collectUploadAnalytics({ ...defaults, catalog: older,
    capturedAt: '2026-10-19T12:00:00Z', query: queryFixture() }));
  const latest = catalog.map(video => ({ ...video,
    metadataHistory: [observation(video, '2026-10-18T12:00:00Z')] }));
  const result = await collectUploadAnalytics({ ...defaults, catalog: latest, previous, query: queryFixture() });
  assert.ok(result.videos.every(video => video.metadataHistory.length === 2));
  assert.deepEqual(validateUploadAnalytics(jsonbRoundTrip(result)), jsonbRoundTrip(result));
  assert.equal(previous.videos[0].metadataHistory.length, 1, 'previous data is not mutated');
});

test('saved duplicate observations repair on a clone while distinct history and strict validation remain', async () => {
  const saved = await collectUploadAnalytics({ ...defaults, query: queryFixture() });
  const observed = observation(saved.videos[0], '2026-10-19T12:00:00Z');
  saved.videos[0].metadataHistory = [observed, jsonbRoundTrip(observed),
    { ...observed, title: 'Different observed title at the same timestamp' }];
  const canonical = jsonbRoundTrip(saved);
  const repaired = validateUploadAnalytics(canonical);
  assert.equal(canonical.videos[0].metadataHistory.length, 3, 'stored input is never mutated');
  assert.equal(repaired.videos[0].metadataHistory.length, 2);
  assert.equal(repaired.videos[0].metadataHistory[1].title, 'Different observed title at the same timestamp');
  assert.deepEqual(validateUploadAnalytics(jsonbRoundTrip(repaired)), jsonbRoundTrip(repaired));
  for (const change of [
    value => { value.videos[0].metadataHistory[1].token = 'secret'; },
    value => { value.videos[0].metadataHistory[1].capturedAt = '2026-10-21T12:00:00Z'; },
    value => { value.videos[0].metadataHistory[1].thumbnail = 'https://example.com/secret.jpg'; },
    value => { value.videos[0].daily.report.rows[0].views = -1; },
  ]) {
    const invalid = structuredClone(canonical);
    change(invalid);
    assert.throws(() => validateUploadAnalytics(invalid));
  }
  const refreshed = await collectUploadAnalytics({ ...defaults, capturedAt: '2026-10-21T12:00:00Z',
    previous: canonical, query: queryFixture({ fail: 'retention' }) });
  assert.equal(refreshed.videos[0].metadataHistory.length, 3);
  assert.equal(refreshed.videos[0].retention.status, 'failed-retained');
  assert.equal(refreshed.videos[0].retention.report.capturedAt, defaults.capturedAt);
});
