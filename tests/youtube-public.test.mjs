import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPublicYouTube, PUBLIC_YOUTUBE_CHANNEL_ID } from '../lib/youtube-public.mjs';
import { syncCloudSource } from '../lib/cloud-sync.mjs';
import { CollectionError } from '../lib/collectors.mjs';
import { publicYouTubeFixture } from './fixtures/public-youtube.mjs';

const NOW = '2026-10-20T12:00:00.000Z';
const env = { YOUTUBE_PUBLIC_API_KEY: 'test-api-key-not-real' };
const response = data => new Response(JSON.stringify(data));
function publicApi({ pages, videoItems, subscribersHidden = false, videoCount = 2 } = {}) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname.endsWith('/channels')) return response({ items: [{
      id: PUBLIC_YOUTUBE_CHANNEL_ID, snippet: { title: 'Scran & Pints' },
      contentDetails: { relatedPlaylists: { uploads: 'UUscranpublicuploads' } },
      statistics: { viewCount: '99999', subscriberCount: '12300', hiddenSubscriberCount: subscribersHidden, videoCount: String(videoCount) },
    }] });
    if (url.pathname.endsWith('/playlistItems')) {
      if (pages) return response(pages(url.searchParams.get('pageToken')));
      return response(url.searchParams.has('pageToken')
        ? { items: [{ contentDetails: { videoId: 'PublicVid34' } }] }
        : { items: [{ contentDetails: { videoId: 'PublicVid12' } }], nextPageToken: 'second-page' });
    }
    if (url.pathname.endsWith('/videos')) return response({ items: videoItems || ['PublicVid12', 'PublicVid34'].map(id => ({
      id, snippet: { title: id, channelId: PUBLIC_YOUTUBE_CHANNEL_ID, publishedAt: '2026-10-18T12:00:00Z',
        thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } } },
      statistics: { viewCount: '123', likeCount: '2' }, status: { privacyStatus: 'public' },
    })) });
    throw Error('Unexpected endpoint');
  };
  return { fetchImpl, calls };
}

test('public collection uses only API-key Data API resources and paginates all formats', async () => {
  const { fetchImpl, calls } = publicApi();
  const report = await collectPublicYouTube({ env: { ...env, YOUTUBE_ACCESS_TOKEN: 'must-not-be-used' }, fetchImpl, capturedAt: NOW });
  assert.equal(report.channel.views, 99999, 'Use native channel counter, not sum of video counters');
  assert.equal(report.channel.subscribers, 12300);
  assert.equal(report.content.length, 2);
  assert.equal(report.content[0].comments, null, 'Unavailable counters stay null');
  assert.equal(report.inventory.complete, true);
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/playlistItems')).length, 2);
  assert.ok(calls.every(call => call.url.hostname === 'www.googleapis.com' && call.url.searchParams.get('key') === env.YOUTUBE_PUBLIC_API_KEY));
  assert.ok(calls.every(call => !call.options.headers?.Authorization && !call.options.headers?.authorization));
  assert.doesNotMatch(JSON.stringify(report), /test-api-key|must-not-be-used|watchHours|subscribersNet|creatorContentType/);
});

test('hidden subscriber counts stay unavailable and a missing upload is marked partial', async () => {
  const { fetchImpl } = publicApi({ videoItems: [], subscribersHidden: true });
  const report = await collectPublicYouTube({ env, fetchImpl, capturedAt: NOW });
  assert.equal(report.channel.subscribers, null);
  assert.equal(report.channel.views, 99999);
  assert.equal(report.inventory.complete, false);
  assert.equal(report.inventory.publicUploadsCount, 0);
});

test('broken and unbounded pagination rejects without publishing a partial collection', async () => {
  for (const nextPageToken of ['repeat', '\r\ninvalid', 'x'.repeat(1001)]) {
    const { fetchImpl } = publicApi({ pages: () => ({ items: [], nextPageToken }) });
    await assert.rejects(collectPublicYouTube({ env, fetchImpl, capturedAt: NOW }), error => error.code === 'pagination');
  }
  let index = 0;
  const { fetchImpl, calls } = publicApi({ pages: () => ({ items: [], nextPageToken: `page${++index}` }) });
  await assert.rejects(collectPublicYouTube({ env, fetchImpl, capturedAt: NOW }), error => error.code === 'pagination');
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/playlistItems')).length, 100);
});

test('a rejected API key never reaches error output', async () => {
  await assert.rejects(collectPublicYouTube({ env, capturedAt: NOW,
    fetchImpl: async () => new Response(`{"error":"${env.YOUTUBE_PUBLIC_API_KEY}"}`, { status: 403 }),
  }), error => error.code === 'authorization' && !error.message.includes(env.YOUTUBE_PUBLIC_API_KEY));
});

function storeFor({ connection = null, snapshot } = {}) {
  const calls = [];
  return { calls, acquireSyncLock: async () => true, releaseSyncLock: async () => true,
    getConnection: async () => connection, loadSnapshot: async () => ({ payload: snapshot }),
    saveSnapshot: async (id, payload, metadata) => { calls.push({ id, payload, metadata }); return { saved: true }; },
    recordSyncResult: async (_id, run) => calls.push({ run }),
  };
}
const privateSeed = () => ({
  capturedAt: '2026-10-01T12:00:00Z', apiThrough: '2026-09-28',
  videos: [{ id: 'PrivateId12', publishedAt: '2026-08-01T12:00:00Z', apiAggregate: { views: 999999999 } }],
});

test('public refresh succeeds before owner OAuth while preserving the private capture date', async () => {
  const seed = privateSeed();
  const store = storeFor({ snapshot: seed });
  const result = await syncCloudSource({ source: 'youtube', store, env, now: () => NOW,
    collectors: { youtubePublic: async () => publicYouTubeFixture(NOW), youtube: () => { throw Error('No grant: must not run'); } },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.components.public.status, 'ready');
  assert.equal(result.components.analytics.status, 'not-connected');
  assert.equal(result.window.scope, 'public-channel-lifetime-counters-at-capture');
  const saved = store.calls[0];
  assert.equal(saved.payload.capturedAt, seed.capturedAt);
  assert.equal(saved.payload.publicReport.capturedAt, NOW);
  assert.equal(saved.metadata.capturedAt, NOW);
  assert.equal(saved.payload.videos[0].packagingCapturedAt, seed.capturedAt);
});

test('a private authorization failure does not discard a successful public refresh or redate private data', async () => {
  const seed = privateSeed();
  const store = storeFor({ snapshot: seed, connection: { credentials: { accessToken: 'private-secret' } } });
  const result = await syncCloudSource({ source: 'youtube', store, env, now: () => NOW,
    collectors: { youtubePublic: async () => publicYouTubeFixture(NOW),
      youtube: async () => { throw new CollectionError('authorization', 'private-secret'); } },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.components.analytics.status, 'failed');
  assert.equal(result.errorCode, 'partial_refresh');
  assert.equal(store.calls[0].payload.capturedAt, seed.capturedAt);
  assert.equal(store.calls[0].metadata.status, 'partial');
  assert.doesNotMatch(JSON.stringify(result), /private-secret|test-api-key/);
});

test('public key failure retains the last public capture while a successful private refresh advances only private data', async () => {
  const seed = privateSeed();
  seed.publicReport = publicYouTubeFixture(seed.capturedAt);
  const store = storeFor({ snapshot: seed, connection: { credentials: { accessToken: 'private-secret' } } });
  const result = await syncCloudSource({ source: 'youtube', store, env, now: () => NOW,
    collectors: { youtubePublic: async () => { throw new CollectionError('authorization', env.YOUTUBE_PUBLIC_API_KEY); },
      youtube: async () => ({ snapshot: { ...seed, capturedAt: NOW }, warnings: [] }) },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.components.public.status, 'failed');
  assert.equal(store.calls.at(-1).run.errorCode, 'partial_refresh');
  assert.equal(store.calls[0].payload.publicReport.capturedAt, seed.capturedAt);
  assert.equal(store.calls[0].payload.capturedAt, NOW);
  assert.doesNotMatch(JSON.stringify(result), /test-api-key|private-secret/);
});

test('public-only failure preserves the previous good snapshot and sanitized failure status', async () => {
  const seed = privateSeed();
  seed.publicReport = publicYouTubeFixture(seed.capturedAt);
  const store = storeFor({ snapshot: seed });
  const result = await syncCloudSource({ source: 'youtube', store, env, now: () => NOW,
    collectors: { youtubePublic: async () => { throw new CollectionError('authorization', env.YOUTUBE_PUBLIC_API_KEY); } },
  });
  assert.equal(result.status, 'failed');
  assert.equal(store.calls.some(call => call.payload), false);
  assert.doesNotMatch(JSON.stringify(result), /test-api-key/);
});
