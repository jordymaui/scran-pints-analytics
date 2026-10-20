import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudStore } from '../lib/cloud-store.mjs';
import { loadPublicReport, loadReportingInputs, readBundledInputs } from '../lib/cloud-report.mjs';
import { publicYouTubeFixture } from './fixtures/public-youtube.mjs';

const bundled = await readBundledInputs();
const current = publicYouTubeFixture('2026-10-20T12:00:00.000Z');
function observation(capturedAt, views = 100, subscribers = 10, videoCount = 1) {
  const report = publicYouTubeFixture(capturedAt);
  report.channel = { ...report.channel, views, subscribers, videoCount };
  report.inventory.complete = false;
  return report;
}
function storeWith(history, report = current) {
  return {
    loadSnapshot: async source => source === 'youtube' ? {
      payload: { ...bundled.snapshot, ...(report ? { publicReport: report } : {}) },
    } : null,
    getStatuses: async () => [],
    loadPublicYouTubeHistory: async () => {
      if (history instanceof Error) throw history;
      return history;
    },
  };
}
async function youtube(history, report = current) {
  const result = await loadPublicReport({ bundled, storeFactory: () => storeWith(history, report) });
  return result.sources.find(source => source.id === 'youtube-longform');
}
const point = report => ({
  capturedAt: report.capturedAt, views: report.channel.views,
  subscribers: report.channel.subscribers, videoCount: report.channel.videoCount,
});

test('history storage query pages rows and selects only the public report JSON field', async () => {
  let request;
  const store = createCloudStore({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_TEST_ONLY' },
    fetcher: async (url, init) => {
      request = { url: new URL(url), init };
      return new Response(JSON.stringify(Array.from({ length: 95 }, () => ({
        publicReport: current, payload: { refreshToken: 'PRIVATE_ARCHIVE' },
      }))));
    },
  });
  const history = await store.loadPublicYouTubeHistory();
  assert.equal(request.url.pathname, '/rest/v1/analytics_snapshot_history');
  assert.equal(request.url.searchParams.get('source'), 'eq.youtube');
  assert.equal(request.url.searchParams.get('select'), 'publicReport:payload->publicReport');
  assert.equal(request.url.searchParams.get('payload->publicReport'), 'not.is.null');
  assert.equal(request.url.searchParams.get('limit'), '100');
  assert.equal(request.url.searchParams.get('order'), 'captured_at.desc,archived_at.desc,id.desc');
  assert.equal(request.init.method, 'GET');
  assert.equal(history.length, 95);
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE_ARCHIVE|refreshToken/);
});

test('first public capture yields one native observation, while a historical bundle yields none', async () => {
  assert.deepEqual((await youtube([])).counterHistory, [point(current)]);
  assert.deepEqual((await youtube([current], null)).counterHistory, []);
});

test('history allows only validated reports for this channel and never projects private Analytics', async () => {
  const valid = observation('2026-10-19T10:00:00.000Z', 0, null, 0);
  const wrongChannel = observation('2026-10-18T10:00:00.000Z');
  wrongChannel.channel.id = 'UC_OTHER_CHANNEL';
  const extraField = observation('2026-10-17T10:00:00.000Z');
  extraField.privateCredentials = 'PRIVATE';
  const wrongSchema = observation('2026-10-16T10:00:00.000Z');
  wrongSchema.schemaVersion = 2;
  const missingCounter = observation('2026-10-15T10:00:00.000Z');
  delete missingCounter.channel.views;
  const badDate = observation('2026-02-31T10:00:00.000Z');
  const source = await youtube([
    valid, bundled.snapshot, { payload: { publicReport: valid } }, wrongChannel,
    extraField, wrongSchema, missingCounter, badDate, null,
  ]);
  assert.deepEqual(source.counterHistory, [point(valid), point(current)]);
  assert.deepEqual(Object.keys(source.counterHistory[0]), ['capturedAt', 'views', 'subscribers', 'videoCount']);
  assert.doesNotMatch(JSON.stringify(source.counterHistory), /PRIVATE|watch|daily|title|content|payload|credential/i);
});

test('history sorts actual public capture times, deduplicates exact captures, and gives current row priority', async () => {
  const early = observation('2026-10-18T01:00:00.000Z', 99);
  const later = observation('2026-10-19T01:00:00.000Z', 98);
  const repeated = observation(current.capturedAt, 7);
  const source = await youtube([later, repeated, early, structuredClone(later)]);
  assert.deepEqual(source.counterHistory, [point(early), point(later), point(current)]);
  assert.equal(source.counterHistory[1].views, 98, 'Native counters may decrease; do not manufacture growth');
});

test('history retains every archived observation and ignores observations newer than current', async () => {
  const history = Array.from({ length: 120 }, (_, index) =>
    observation(new Date(Date.parse(current.capturedAt) - (index + 1) * 86_400_000).toISOString(), index));
  const source = await youtube(history);
  assert.equal(source.counterHistory.length, 121);
  assert.deepEqual(source.counterHistory.at(-1), point(current));
  assert.equal(source.counterHistory[0].capturedAt, history[119].capturedAt);
  assert.deepEqual((await youtube([observation('2026-10-21T12:00:00.000Z')])).counterHistory, [point(current)]);
});

test('history storage reads every page rather than the first page only', async () => {
  const offsets = [];
  const store = createCloudStore({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_TEST_ONLY' },
    fetcher: async url => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      offsets.push(offset);
      return new Response(JSON.stringify(Array.from({ length: offset === 0 ? 100 : 3 },
        () => ({ publicReport: current }))));
    },
  });
  assert.equal((await store.loadPublicYouTubeHistory()).length, 103);
  assert.deepEqual(offsets, [0, 100]);
});

test('failed or malformed history reads retain the current public report without disclosing errors', async () => {
  for (const history of [new Error('PRIVATE provider response'), { private: true }, undefined]) {
    const source = await youtube(history);
    assert.deepEqual(source.counterHistory, [point(current)]);
    assert.equal(source.metrics.views, current.channel.views);
    assert.doesNotMatch(JSON.stringify(source), /PRIVATE provider/);
  }
});

test('protected reporting input reads do not request public observation history', async () => {
  let reads = 0;
  const store = storeWith([]);
  store.loadPublicYouTubeHistory = async () => { reads++; return []; };
  await loadReportingInputs({ bundled, storeFactory: () => store });
  assert.equal(reads, 0);
});
