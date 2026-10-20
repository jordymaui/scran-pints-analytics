import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectYouTubeShorts, collectTikTok, collectSocial, getGoogleAccessToken } from '../lib/collectors.mjs';
import { syncSocial } from '../scripts/sync-social.mjs';

const CAPTURED = '2026-10-20T12:00:00.000Z';
const YT_COLUMNS = ['day', 'creatorContentType', 'views', 'engagedViews', 'estimatedMinutesWatched', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const youtubeReport = (rows, names = YT_COLUMNS) => ({
  columnHeaders: names.map(name => ({ name })),
  rows: rows.map(row => names.map(name => row[name])),
});
const youtubeRow = (day, creatorContentType = 'SHORTS', overrides = {}) => ({
  day, creatorContentType, views: 20, engagedViews: 10, estimatedMinutesWatched: 6,
  likes: 2, comments: 1, shares: 1, subscribersGained: 1, subscribersLost: 2, ...overrides,
});
const video = (id = '123', overrides = {}) => ({
  id, create_time: 1700000000, share_url: `https://www.tiktok.com/@scran_test/video/${id}?source=share`,
  title: 'A test video', view_count: 50, like_count: 3, comment_count: 1, share_count: 2, ...overrides,
});
const tiktokOk = data => ({ data, error: { code: 'ok', message: '' } });

test('YouTube parses column names, selects exact Shorts, and preserves lag/missing days', async () => {
  let calls = 0;
  const result = await collectYouTubeShorts({
    env: { YOUTUBE_ACCESS_TOKEN: 'test-access' }, start: '2026-10-01', end: '2026-10-19', capturedAt: CAPTURED,
    fetchImpl: async (endpoint, options) => {
      calls++;
      const url = new URL(endpoint);
      assert.equal(url.origin, 'https://youtubeanalytics.googleapis.com');
      assert.equal(url.searchParams.get('dimensions'), 'day,creatorContentType');
      assert.equal(url.searchParams.get('ids'), 'channel==MINE');
      assert.equal(options.headers.Authorization, 'Bearer test-access');
      assert.equal(options.redirect, 'error');
      return json(youtubeReport([
        youtubeRow('2026-10-01'), youtubeRow('2026-10-03'),
        youtubeRow('2026-10-17', 'VIDEO_ON_DEMAND', { views: 9000 }),
      ], [...YT_COLUMNS].reverse()));
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.metrics.views, 40);
  assert.equal(result.metrics.engagedViews, 20);
  assert.equal(result.metrics.watchHours, 0.2);
  assert.equal(result.metrics.subscribersNet, -2);
  assert.equal(result.metrics.followers, null);
  assert.equal(result.dateRange.end, '2026-10-17');
  assert.deepEqual(result.daily.map(row => row.day), ['2026-10-01', '2026-10-03']);
  assert.match(result.scope, /requested through 2026-10-19/);
  assert.equal(result.content.length, 0);
});

test('YouTube paginates a full first page without dropping or double-counting rows', async () => {
  const allRows = Array.from({ length: 201 }, (_, index) => youtubeRow(new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10)));
  const starts = [];
  const result = await collectYouTubeShorts({
    env: { YOUTUBE_ACCESS_TOKEN: 'test-access' }, start: '2026-01-01', end: '2026-08-01', capturedAt: CAPTURED,
    fetchImpl: async endpoint => {
      const index = Number(new URL(endpoint).searchParams.get('startIndex'));
      starts.push(index);
      return json(youtubeReport(allRows.slice(index - 1, index + 199)));
    },
  });
  assert.deepEqual(starts, [1, 201]);
  assert.equal(result.daily.length, 201);
  assert.equal(result.metrics.views, 4020);
});

test('YouTube refreshes a server-side OAuth grant and never puts it in the request URL', async () => {
  let request;
  const token = await getGoogleAccessToken({
    YOUTUBE_CLIENT_ID: 'client-example', YOUTUBE_CLIENT_SECRET: 'secret-example', YOUTUBE_REFRESH_TOKEN: 'refresh-example',
  }, async (endpoint, options) => {
    request = { endpoint, options };
    return json({ access_token: 'access-example', token_type: 'Bearer' });
  });
  assert.equal(token, 'access-example');
  assert.equal(request.endpoint, 'https://oauth2.googleapis.com/token');
  assert.equal(request.options.method, 'POST');
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'refresh-example');
});

test('YouTube refuses unsupported/malformed reports and missing Shorts rather than inventing zero', async () => {
  const base = { env: { YOUTUBE_ACCESS_TOKEN: 'test-access' }, start: '2026-10-01', end: '2026-10-19', capturedAt: CAPTURED };
  await assert.rejects(collectYouTubeShorts({ ...base, fetchImpl: async () => json(youtubeReport([youtubeRow('2026-10-01', 'VIDEO_ON_DEMAND')])) }), /no Shorts rows/);
  await assert.rejects(collectYouTubeShorts({ ...base, fetchImpl: async () => json({ columnHeaders: [{ name: 'views' }], rows: [[20]] }) }), /missing or duplicate/);
  await assert.rejects(collectYouTubeShorts({ ...base, fetchImpl: async () => json(youtubeReport([youtubeRow('2026-10-01'), youtubeRow('2026-10-01')])) }), /repeated/);
  await assert.rejects(collectYouTubeShorts({ ...base, fetchImpl: async () => json({ error: { message: 'private API error text' } }) }), /rejected the report/);
});

test('TikTok paginates public counters, strips tracking and does not invent period or watch-time data', async () => {
  const requests = [];
  const result = await collectTikTok({
    env: { TIKTOK_ACCESS_TOKEN: 'test-token' }, capturedAt: CAPTURED,
    fetchImpl: async (endpoint, options) => {
      requests.push({ endpoint, options });
      if (endpoint.includes('/user/info/')) return json(tiktokOk({ user: { open_id: 'private-account-id', display_name: 'Scran test', follower_count: 123 } }));
      const body = JSON.parse(options.body);
      return json(tiktokOk(body.cursor === undefined
        ? { videos: [video('123')], has_more: true, cursor: 123456 }
        : { videos: [video('456')], has_more: false, cursor: 123457 }));
    },
  });
  assert.equal(requests.length, 3);
  assert.equal(JSON.parse(requests[2].options.body).cursor, 123456);
  assert.equal(result.metrics.views, 100);
  assert.equal(result.metrics.followers, 123);
  assert.equal(result.metrics.watchHours, null);
  assert.equal(result.metrics.engagedViews, null);
  assert.deepEqual(result.daily, []);
  assert.deepEqual(result.dateRange, { start: '2026-10-20', end: '2026-10-20', timezone: 'UTC' });
  assert.match(result.scope, /Lifetime counters/);
  assert.equal(result.content[0].url, 'https://www.tiktok.com/@scran_test/video/123');
  assert.equal(result.content[0].thumbnail, null);
  assert.ok(!JSON.stringify(result).includes('private-account-id'));
  assert.ok(!JSON.stringify(result).includes('test-token'));
});

test('TikTok missing counters remain unknown and incomplete pagination fails closed', async () => {
  const base = { env: { TIKTOK_ACCESS_TOKEN: 'test-token' }, capturedAt: CAPTURED };
  const result = await collectTikTok({ ...base, fetchImpl: async endpoint => endpoint.includes('/user/info/')
    ? json(tiktokOk({ user: { open_id: 'account' } }))
    : json(tiktokOk({ videos: [video('123', { share_count: undefined })], has_more: false })) });
  assert.equal(result.metrics.shares, null);
  assert.equal(result.metrics.followers, null);
  let pages = 0;
  await assert.rejects(collectTikTok({ ...base, fetchImpl: async endpoint => {
    if (endpoint.includes('/user/info/')) return json(tiktokOk({ user: { open_id: 'account' } }));
    pages++;
    return json(tiktokOk({ videos: [video(String(100 + pages))], has_more: true, cursor: 123 }));
  } }), /pagination did not advance/);
  await assert.rejects(collectTikTok({ ...base, fetchImpl: async () => json({ error: { code: 'access_token_invalid', message: 'private upstream error' } }) }), /rejected the request/);
});

test('missing configuration and upstream failures expose no credentials or raw provider errors', async () => {
  let calls = 0;
  const missing = await collectSocial({ env: {}, fetchImpl: async () => { calls++; throw new Error('should not call'); } });
  assert.equal(calls, 0);
  assert.deepEqual(missing.statuses.map(row => row.status), ['not-configured', 'blocked', 'not-configured']);
  const failed = await collectSocial({
    sources: ['tiktok'], env: { TIKTOK_ACCESS_TOKEN: 'private-secret-value' },
    fetchImpl: async () => { throw new Error('private-secret-value https://token-bearing.example'); },
  });
  assert.equal(failed.document.sources.length, 0);
  assert.equal(failed.statuses[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(failed), /private-secret-value|token-bearing/);
  const unauthorized = await collectSocial({
    sources: ['tiktok'], env: { TIKTOK_ACCESS_TOKEN: 'private-secret-value' },
    fetchImpl: async () => json({ error: { message: 'private-secret-value' } }, 401),
  });
  assert.equal(unauthorized.statuses[0].code, 'authorization');
  assert.doesNotMatch(JSON.stringify(unauthorized), /private-secret-value/);
});

async function privateFixture(t) {
  const testRoot = fileURLToPath(new URL('../.private/collector-tests/', import.meta.url));
  await mkdir(testRoot, { recursive: true });
  const dir = await mkdtemp(join(testRoot, 'sync-test-'));
  t.after(() => {
    const target = resolve(dir);
    assert.equal(dirname(target).toLowerCase(), resolve(testRoot).toLowerCase());
    assert.ok(basename(target).startsWith('sync-test-'));
    return rm(target, { recursive: true, force: true });
  });
  return { dir, outputPath: join(dir, 'social.json'), privateDir: join(dir, 'private') };
}

const tiktokFetch = async endpoint => endpoint.includes('/user/info/')
  ? json(tiktokOk({ user: { open_id: 'account', follower_count: 20 } }))
  : json(tiktokOk({ videos: [video()], has_more: false }));

test('sync dry run changes no files; partial write retains failed platforms and archives prior data', async t => {
  const paths = await privateFixture(t);
  const older = await collectYouTubeShorts({
    env: { YOUTUBE_ACCESS_TOKEN: 'test' }, start: '2026-10-01', end: '2026-10-19',
    fetchImpl: async () => json(youtubeReport([youtubeRow('2026-10-01')])), capturedAt: CAPTURED,
  });
  const previous = JSON.stringify({ schemaVersion: 1, sources: [older] });
  await writeFile(paths.outputPath, previous);
  const options = { ...paths, env: { TIKTOK_ACCESS_TOKEN: 'private-token' }, fetchImpl: tiktokFetch, capturedAt: CAPTURED };
  const dry = await syncSocial(options);
  assert.equal(dry.written, false);
  assert.equal(await readFile(paths.outputPath, 'utf8'), previous);
  await assert.rejects(readdir(paths.privateDir), { code: 'ENOENT' });
  const written = await syncSocial({ ...options, write: true });
  assert.equal(written.written, true);
  assert.deepEqual(written.retainedSourceIds, ['youtube-shorts']);
  const actual = JSON.parse(await readFile(paths.outputPath, 'utf8'));
  assert.deepEqual(actual.sources.map(row => row.id), ['youtube-shorts', 'tiktok']);
  const archives = await readdir(join(paths.privateDir, 'social-imports'));
  assert.equal(archives.length, 1);
  assert.equal(await readFile(join(paths.privateDir, 'social-imports', archives[0]), 'utf8'), previous);
  assert.deepEqual(await readdir(join(paths.privateDir, 'sync-staging')), []);
  assert.doesNotMatch(JSON.stringify(written), /private-token/);
});

test('sync with only failed sources never overwrites last successful snapshot', async t => {
  const paths = await privateFixture(t);
  const original = '{ "schemaVersion": 1, "sources": [] }\n';
  await writeFile(paths.outputPath, original);
  const result = await syncSocial({
    ...paths, write: true, sources: ['tiktok'],
    env: { TIKTOK_ACCESS_TOKEN: 'private-token' }, fetchImpl: async () => json({}, 429),
  });
  assert.equal(result.written, false);
  assert.equal(result.statuses[0].code, 'rate-limit');
  assert.equal(await readFile(paths.outputPath, 'utf8'), original);
  await assert.rejects(readdir(paths.privateDir), { code: 'ENOENT' });
});
