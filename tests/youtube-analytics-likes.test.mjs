import test from 'node:test';
import assert from 'node:assert/strict';
import { collectYouTubeShorts, collectTikTok } from '../lib/collectors.mjs';
import { validateSocialImport, YOUTUBE_ANALYTICS_PROVENANCE } from '../lib/social-schema.mjs';
import { validateChannelAnalytics } from '../api/workshop-data.mjs';
import { analyticsMetrics } from '../lib/workshop-model.mjs';
import { readBundledInputs, loadReportingInputs, loadPublicReport } from '../lib/cloud-report.mjs';
import { validatePublicYouTubeReport } from '../lib/report-model.mjs';
import { publicYouTubeFixture } from './fixtures/public-youtube.mjs';

const capturedAt = '2026-10-20T12:00:00.000Z';
const columns = ['day', 'creatorContentType', 'views', 'engagedViews', 'estimatedMinutesWatched',
  'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'];
const row = (day, likes, overrides = {}) => ({ day, creatorContentType: 'SHORTS', views: 20,
  engagedViews: 10, estimatedMinutesWatched: 6, likes, comments: 1, shares: 1,
  subscribersGained: 1, subscribersLost: 0, ...overrides });
const json = value => new Response(JSON.stringify(value), { status: 200 });
const collect = rows => collectYouTubeShorts({
  env: { YOUTUBE_ACCESS_TOKEN: 'test-only' }, start: '2026-10-01', end: '2026-10-19', capturedAt,
  fetchImpl: async () => json({
    columnHeaders: columns.map(name => ({ name })),
    rows: rows.map(value => columns.map(name => value[name])),
  }),
});
const document = source => ({ schemaVersion: 1, sources: [source] });

test('native YouTube Analytics like adjustments are retained and summed without clamping', async () => {
  const positive = await collect([row('2026-10-01', 3), row('2026-10-02', -1)]);
  assert.equal(positive.metrics.likes, 2);
  const negative = await collect([row('2026-10-01', -1), row('2026-10-02', -1)]);
  assert.equal(negative.metrics.likes, -2);
  assert.equal(negative.provenance.label, YOUTUBE_ANALYTICS_PROVENANCE);
  assert.equal(validateSocialImport(document(negative)).sources[0].metrics.likes, -2);
  assert.equal(analyticsMetrics({ likes: -2 }).likes, -2);
});

test('Analytics still rejects invalid likes and negative unrelated metrics', async () => {
  for (const likes of [-1.5, NaN, Infinity, -Number.MAX_SAFE_INTEGER - 1, '-1', null]) {
    await assert.rejects(collect([row('2026-10-01', likes)]), /invalid numeric metric/);
  }
  for (const metric of columns.slice(2).filter(name => name !== 'likes')) {
    await assert.rejects(collect([row('2026-10-01', 0, { [metric]: -1 })]), /invalid numeric metric/);
  }
});

test('signed likes require the exact Analytics source and never apply to content counters', async () => {
  const source = await collect([row('2026-10-01', -1)]);
  for (const change of [
    { id: 'instagram' }, { id: 'tiktok' },
    { provenance: { kind: 'platform-export', label: YOUTUBE_ANALYTICS_PROVENANCE } },
    { provenance: { kind: 'official-api', label: 'YouTube Data API public counters' } },
  ]) {
    const changed = structuredClone({ ...source, ...change });
    // Non-YouTube sources use the baseline schema. Keep this assertion focused
    // on signed likes rather than the additional Shorts-only history fields.
    delete changed.metrics.subscribersGained;
    delete changed.metrics.subscribersLost;
    changed.daily = changed.daily.map(({ day, views }) => ({ day, views }));
    assert.throws(() => validateSocialImport(document(changed)), /non-negative/);
  }
  const withContent = { ...source, content: [{
    id: 'abcdefghijk', title: 'Public counter', url: 'https://www.youtube.com/shorts/abcdefghijk',
    publishedAt: capturedAt, thumbnail: null, views: 1, likes: -1, comments: 0, shares: 0,
  }] };
  assert.throws(() => validateSocialImport(document(withContent)), /non-negative/);
  const publicReport = publicYouTubeFixture();
  publicReport.content[0].likes = -1;
  assert.throws(() => validatePublicYouTubeReport(publicReport));
  await assert.rejects(collectTikTok({
    env: { TIKTOK_ACCESS_TOKEN: 'test-only' }, capturedAt,
    fetchImpl: async endpoint => json({ error: { code: 'ok' }, data: endpoint.includes('/user/info/')
      ? { user: { open_id: 'test-account' } }
      : { videos: [{ id: '123', create_time: 1700000000,
        share_url: 'https://www.tiktok.com/@test/video/123', title: 'Test',
        view_count: 1, like_count: -1, comment_count: 0, share_count: 0 }], has_more: false } }),
  }), /invalid numeric metric/);
});

test('private channel validation accepts signed integer likes only', () => {
  const aggregate = { views: 20, estimatedMinutesWatched: 6, averageViewDuration: 18,
    averageViewPercentage: 50, likes: -1, comments: 1, shares: 1, subscribersGained: 1, subscribersLost: 0 };
  const report = { capturedAt, channelId: 'UCAX4l1JUAymaMHVKiRFzK-A',
    dateRange: { start: '2026-10-01', end: '2026-10-18', timezone: 'America/Los_Angeles' },
    aggregate, daily: [{ day: '2026-10-18', ...aggregate }],
    coverage: { startBasis: 'channel-created', endBasis: 'channel-daily-same-metrics' } };
  assert.equal(validateChannelAnalytics(report).aggregate.likes, -1);
  for (const values of [{ likes: -1.5 }, { likes: Infinity }, { comments: -1 }, { views: -1 }]) {
    assert.throws(() => validateChannelAnalytics({ ...report, aggregate: { ...aggregate, ...values } }));
  }
});

test('saved private episode adjustments load without changing the public Analytics boundary', async () => {
  const bundled = await readBundledInputs();
  const snapshot = structuredClone(bundled.snapshot);
  snapshot.videos[0].apiAggregate.likes = -1;
  snapshot.publicReport = publicYouTubeFixture();
  const options = { bundled, storeFactory: () => ({
    loadSnapshot: async id => id === 'youtube' ? { payload: snapshot } : null,
    getStatuses: async () => [], loadPublicYouTubeHistory: async () => [],
  }) };
  const privateReport = await loadReportingInputs(options);
  assert.equal(privateReport.origins.youtube, 'cloud');
  assert.equal(privateReport.snapshot.videos[0].apiAggregate.likes, -1);
  const publicReport = await loadPublicReport(options);
  assert.equal(publicReport.sources[0].metrics.likes, null);
  assert.equal(publicReport.sources[0].content[0].likes, snapshot.publicReport.content[0].likes);
  assert.equal(publicReport.sources[0].metrics.views, snapshot.publicReport.channel.views);
});
