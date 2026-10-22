import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { youtubeThumbnailPreview } from '../thumbnail-preview.js';
import { projectStudioSnapshot, studioThumbnailAssets } from '../lib/studio-projection.mjs';
import { createWorkshopDataHandler } from '../api/workshop-data.mjs';
import { createConnectionStatusHandler } from '../api/connection-status.mjs';
import * as workshopModel from '../lib/workshop-model.mjs';

const bundled = JSON.parse(await readFile(new URL('../data.json', import.meta.url), 'utf8'));
const capture = '2026-10-20T12:00:00Z';
const native = { views: 0, estimatedMinutesWatched: 12, averageViewDuration: 34,
  averageViewPercentage: 56, likes: -1, comments: 2, shares: 3, subscribersGained: 4, subscribersLost: 5 };
const channel = {
  capturedAt: capture, channelId: 'UCAX4l1JUAymaMHVKiRFzK-A',
  dateRange: { start: '2026-10-01', end: '2026-10-03', timezone: 'America/Los_Angeles' },
  aggregate: native, daily: [{ day: '2026-10-03', ...native }],
  coverage: { startBasis: 'channel-created', endBasis: 'channel-daily-same-metrics' },
};
const shorts = {
  id: 'youtube-shorts', label: 'YouTube Shorts', accountLabel: 'Scran & Pints', status: 'snapshot',
  capturedAt: capture, dateRange: channel.dateRange, scope: 'Native daily Shorts rows.',
  provenance: { kind: 'official-api', label: 'YouTube Analytics API' },
  metrics: { views: 45, engagedViews: 30, watchHours: 6, likes: 7, comments: 8, shares: 9, subscribersNet: -1, followers: null },
  daily: [{ day: '2026-10-03', views: 45 }], content: [],
};
const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
  end(value) { this.body = JSON.parse(value); } });

test('anonymous Studio GET publishes selected report fields without source paths, credentials, notes or nonpublic content', async () => {
  const snapshot = structuredClone(bundled);
  snapshot.channelAnalytics = channel;
  snapshot.credentials = { refreshToken: 'PRIVATE_TOKEN' };
  snapshot.finances = { balance: 'PRIVATE_FINANCE' };
  snapshot.workshopNotes = 'PRIVATE_NOTEBOOK';
  snapshot.history = { videos: [{ videoId: bundled.videos[0].id, variants: [{ title: 'UNREVIEWED_CLOUD_HISTORY' }] }] };
  snapshot.videos[0].apiAggregate.revenue = 'PRIVATE_REVENUE';
  snapshot.videos[0].retention[0].accountId = 'PRIVATE_ACCOUNT';
  snapshot.videos[1].metadata = { privacyStatus: 'private', title: 'NONPUBLIC_TITLE', channelId: channel.channelId };
  const handler = createWorkshopDataHandler({ loadInputs: async () => ({
    snapshot, historicalSnapshot: bundled, social: { sources: [shorts] },
    origins: { youtube: 'cloud', 'youtube-shorts': 'cloud' }, storageStatus: 'cloud',
  }) });
  const res = response();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.videos.length, bundled.videos.length - 1);
  assert.equal(res.body.channelAnalytics.aggregate.views, 0);
  assert.equal(res.body.channelAnalytics.aggregate.likes, -1);
  assert.equal(res.body.shortsAnalytics.metrics.engagedViews, 30);
  assert.match(res.headers['cache-control'], /no-store/);
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_|NONPUBLIC_TITLE|UNREVIEWED_CLOUD_HISTORY|thumbnailPath|webEvidence|metadataHistory|channelId|work\/scran|rocky-brain|openclaw/);
  assert.ok(res.body.history.videos.some(video => video.variants.some(variant => variant.webThumbnail)));
  assert.ok(res.body.history.videos.every(video => video.variants.every(variant => variant.status !== 'draft')));
  const post = response();
  await handler({ method: 'POST' }, post);
  assert.equal(post.statusCode, 405);
});

test('only reviewed bundled non-draft thumbnail crops enter the build allowlist', () => {
  const assets = studioThumbnailAssets(bundled);
  assert.ok(assets.includes('assets/history-CWBBRExPJ0I-p1.jpg'));
  assert.ok(assets.includes('assets/history-nrVntdSPHgg-studio-1.jpg'));
  assert.ok(assets.every(path => !/evidence|screenshot|\.json|\.html|\.\./.test(path)));
  const changed = structuredClone(bundled);
  changed.history.videos[0].variants.push(
    { status: 'current', webThumbnail: 'assets/evidence-nrVntdSPHgg-p2.jpg' },
    { status: 'draft', webThumbnail: 'assets/history-CWBBRExPJ0I-p999.jpg' },
    { status: 'current', webThumbnail: 'assets/history-CWBBRExPJ0I-p1.jpg/../../data.json' },
  );
  assert.deepEqual(studioThumbnailAssets(changed), assets);
});

test('Studio projection preserves renderer contracts, dates, metadata distinctions and packaging results', async () => {
  const snapshot = structuredClone(bundled);
  snapshot.videos[0].metadata = { channelId: channel.channelId, privacyStatus: 'public',
    title: 'Public current title', description: 'Public description', tags: [], tagsFieldReturned: true,
    capturedAt: capture, publishedAt: snapshot.videos[0].publishedAt,
    thumbnail: { url: `https://i.ytimg.com/vi/${snapshot.videos[0].id}/hqdefault.jpg` } };
  const projected = projectStudioSnapshot(snapshot, { historicalSnapshot: bundled, channelAnalytics: channel, shortsAnalytics: shorts });
  assert.equal(projected.videos[0].metadata.tagsFieldReturned, true);
  assert.equal(projected.studioCapturedAt, bundled.studioCapturedAt);
  assert.equal(projected.videos[0].studio.capturedAt, bundled.videos[0].studio.capturedAt);
  assert.ok(projected.history.videos.some(video => video.variants.some(variant => variant.observedAt === '2026-09-09')));
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', value: '', dataset: {},
      addEventListener() {}, focus() {}, querySelectorAll() { return []; } });
    return elements.get(selector);
  };
  element('#analytics-sort').value = 'views';
  element('#analytics-video').value = bundled.videos[0].id;
  element('#packaging-video').value = 'all';
  element('#packaging-scope').value = 'latest';
  const context = vm.createContext({ ...workshopModel, youtubeThumbnailPreview, fixture: projected,
    createReportRefresh: () => ({ mount() {} }),
    document: { querySelector: element, querySelectorAll: () => [] }, window: {},
    Intl, Date, Number, String, Map, Set });
  const source = (await readFile(new URL('../workshop.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/\r?\n(?:checkTeamAccess|load)\(\);/g, '');
  vm.runInContext(source, context);
  vm.runInContext('data = fixture; tests = groupTests(data.history); initializeAnalytics(); renderMetadata(); renderPackaging();', context);
  assert.match(element('#shorts-analytics').innerHTML, /YouTube Analytics API/);
  assert.match(element('#metadata-body').innerHTML, /Public current title|The returned tag list was empty/);
  assert.match(element('#packaging-results').innerHTML, /PAIRING RESULTS ONLY/);
  assert.doesNotMatch([...elements.values()].map(row => row.innerHTML).join(''), /undefined|NaN|Infinity/);
});

test('public Connections returns exact sanitized status fields and rejects writes', async () => {
  let calls = 0;
  const handler = createConnectionStatusHandler({
    env: { YOUTUBE_PUBLIC_API_KEY: 'PRIVATE_API_KEY' }, oauthConfig: () => ({ clientSecret: 'PRIVATE_CLIENT_SECRET' }),
    storeFactory: () => ({ getStatuses: async () => { calls++; return [{
      id: 'youtube', connected: true, connectedAt: capture, hasSnapshot: true, capturedAt: capture,
      email: 'PRIVATE_EMAIL', accountId: 'PRIVATE_ACCOUNT', credentials: { accessToken: 'PRIVATE_TOKEN' },
      lastSync: { status: 'ready', completedAt: capture, errorCode: 'partial_refresh', rawError: 'PRIVATE_RAW_ERROR' },
    }, { id: 'tiktok', connected: false, lastSync: { status: 'failed', errorCode: 'private_token_disguised_as_code' } }]; } }),
  });
  const res = response(); await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200); assert.equal(calls, 1);
  assert.equal(res.body.platforms.length, 4);
  assert.equal(res.body.platforms[0].connected, true);
  assert.equal(res.body.platforms[0].lastSync.errorCode, 'partial_refresh');
  assert.equal(res.body.platforms[3].lastSync.errorCode, null);
  assert.deepEqual(res.body.setup, { youtubeOAuth: true, youtubePublic: true, tiktokOAuth: false, instagramOAuth: false, instagramBrowser: true });
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_|private_token|accountId|email|credentials/);
  assert.match(res.headers['cache-control'], /no-store/);
  const post = response(); await handler({ method: 'POST' }, post);
  assert.equal(post.statusCode, 405); assert.equal(calls, 1);
});

test('Connections storage failures expose a static status without provider diagnostics', async () => {
  const handler = createConnectionStatusHandler({ env: {}, oauthConfig: () => { throw Error(); },
    storeFactory: () => { throw Error('PRIVATE_TOKEN provider payload'); } });
  const res = response(); await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'storage_unavailable');
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_TOKEN|provider payload/);
});
