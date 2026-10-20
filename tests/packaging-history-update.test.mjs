import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { projectStudioSnapshot, studioThumbnailAssets } from '../lib/studio-projection.mjs';
import { groupTests } from '../lib/workshop-model.mjs';

const snapshot = JSON.parse(await readFile(new URL('../data.json', import.meta.url), 'utf8'));
const hullAuditNote = 'YouTube Studio Video Details checked on 20 October 2026 showed the ordinary title, thumbnail and A/B testing button, but did not expose a past test report. This does not establish that no prior test existed.';
const previousDigests = {
  CWBBRExPJ0I: '922d9277b04e5c960a3eabed1727714e9bc8e90e0cf5a76e1e6f700dd760978b',
  a4uUoOby5G0: '8577be27caa8fc358ea73843ae739f256bbadacef7354cb9c924b1a755f72862',
  nrVntdSPHgg: '5af59fd6eb8175a21bcf40828b39e8183916129025bc3d95c6c61c6481333009',
  '2uHiaCxzPRM': 'ca148a71e37357f6a29a33a3b95de3399d57a9b7469499783de7f0d21aaff751',
  s8IZpVJzjX4: 'c83dc7cd9df97d4b254d51259c7154162bc545a16fa9b0c606a1ffbe2edbe2c5',
};

test('new Studio evidence preserves every previously saved history record without fabricating episode analytics', () => {
  for (const [id, digest] of Object.entries(previousDigests)) {
    const previous = structuredClone(snapshot.history.videos.find(video => video.videoId === id));
    previous.variants = previous.variants.filter(variant => variant.testId !== `${id}-studio-2026-10-20`);
    previous.tests = previous.tests.filter(round => round.testId !== `${id}-studio-2026-10-20`);
    previous.missingHistory = previous.missingHistory.filter(note => note !== hullAuditNote);
    assert.equal(createHash('sha256').update(JSON.stringify(previous)).digest('hex'), digest, id);
  }
  assert.equal(snapshot.videos.length, 5);
  assert.equal(snapshot.history.videos.length, 7);
  const hull = snapshot.history.videos.find(video => video.videoId === 'CWBBRExPJ0I');
  assert.equal(hull.variants.length, 3);
  assert.equal(hull.tests.length, 0);
  assert.ok(hull.missingHistory.includes(hullAuditNote));
  for (const id of ['US9uzJCjH3E', 'h0V1oFHQOrU']) {
    assert.equal(snapshot.videos.some(video => video.id === id), false);
    const history = snapshot.history.videos.find(video => video.videoId === id);
    assert.equal(history.publishedAt, null);
    assert.deepEqual(history.videoMetricSnapshots, []);
    assert.equal(history.publishedPublic, true);
  }
});

test('four new title-only rounds retain unavailable shares and insufficient-impressions outcomes', async () => {
  const expected = {
    s8IZpVJzjX4: {
      titles: ['Does Coventry City have English Footballs BEST Pint?', 'Is this the BEST Pint in English Football?',
        'This Football Club has the BEST Beer in England.'],
      window: /4 October 2026 at 21:24 to 18 October 2026 at 21:57/,
    },
    '2uHiaCxzPRM': {
      titles: ['Does Ed Sheeran have the BEST Food in English Football?', 'This Football Club has the BEST Pie in England!',
        'This Football Club has the BEST food in the Premier League'],
      window: /4 October 2026 at 22:19 to 18 October 2026 at 23:19/,
    },
    nrVntdSPHgg: {
      titles: ['Is this the SCARIEST Food in English Football?', "Is this English Football's WORST Stadium Food?",
        'I Tried the WORST Food in the Premier League...'],
      window: /4 October 2026 at 21:34 to 18 October 2026 at 21:39/,
    },
    a4uUoOby5G0: {
      titles: ['Man City Guilty of 115 Charges BUT is their Stadium Food criminal too?',
        "115 Charges and THIS is Man City's Stadium Food?!", 'Man City found GUILTY of £10.50 Stadium Combo'],
      window: /4 October 2026 at 21:20 to 18 October 2026 at 21:21/,
    },
  };
  const assets = studioThumbnailAssets(snapshot);
  const projected = projectStudioSnapshot(snapshot, { historicalSnapshot: snapshot });
  for (const [id, fixture] of Object.entries(expected)) {
    const history = snapshot.history.videos.find(video => video.videoId === id);
    const round = groupTests({ videos: [history] }).find(item => item.testId === `${id}-studio-2026-10-20`);
    assert.equal(round.type, 'title-only');
    assert.deepEqual(round.variants.map(variant => variant.title), fixture.titles);
    assert.deepEqual(round.variants.map(variant => variant.metrics.watchTimeSharePct), [null, null, null]);
    assert.equal(round.highestShare, null);
    assert.match(round.status, /Test finished/);
    assert.match(round.result, /Not enough impressions to declare a winner/);
    assert.match(round.window, fixture.window);
    assert.match(round.window, /timezone not specified/);
    const asset = `assets/history-${id}-studio-4.webp`;
    assert.ok(assets.includes(asset));
    const digest = createHash('sha256').update(await readFile(new URL(`../${asset}`, import.meta.url))).digest('hex');
    for (const variant of round.variants) {
      assert.equal(variant.webThumbnail, asset);
      assert.equal(variant.thumbnailSha256, digest);
      assert.ok(variant.caveats.some(value => /same thumbnail/.test(value)));
    }
    const publicRound = groupTests(projected.history).find(item => item.testId === round.testId);
    assert.equal(publicRound.type, 'title-only');
    assert.deepEqual(publicRound.variants.map(variant => variant.metrics.watchTimeSharePct), [null, null, null]);
  }
});

test('Eastleigh preserves the declared combined-test winner, original titles and all three exact thumbnails', async () => {
  const record = snapshot.history.videos.find(video => video.videoId === 'US9uzJCjH3E');
  const round = groupTests({ videos: [record] })[0];
  assert.equal(record.tests.length, 1);
  assert.deepEqual(round.variants.map(variant => variant.title), [
    'I Tried the Food at This WW2 Football Club!',
    'I Ate at One of Football’s Most HISTORIC Clubs!',
    'This Football Club Made WW2 Planes, Now It Makes Food!',
  ]);
  assert.deepEqual(round.variants.map(variant => variant.metrics.watchTimeSharePct), [28.6, 39.3, 32.1]);
  assert.match(round.status, /We have a winner!/);
  assert.match(round.result, /declared variant 2 the winner/);
  assert.match(round.window, /14 October 2026 at 17:31 to 20 October 2026 at 05:14/);
  assert.match(round.window, /timezone not specified/);
  for (const variant of round.variants) {
    assert.match(variant.observedAt, /^2026-10-20T/);
    assert.ok(variant.caveats.some(value => /cannot isolate/.test(value)));
    const bytes = await readFile(new URL(`../${variant.webThumbnail}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), variant.thumbnailSha256);
  }
});

test('Wembley preserves stopped status and identical titles without declaring a winner from shares', async () => {
  const record = snapshot.history.videos.find(video => video.videoId === 'h0V1oFHQOrU');
  const round = groupTests({ videos: [record] })[0];
  assert.equal(record.tests.length, 1);
  assert.deepEqual(round.variants.map(variant => variant.title), [
    'I ate at Englands BIGGEST Football Stadium!', 'I ate at Englands BIGGEST Football Stadium!',
  ]);
  assert.deepEqual(round.variants.map(variant => variant.metrics.watchTimeSharePct), [62, 38]);
  assert.match(round.status, /You stopped the test/);
  assert.doesNotMatch(round.status, /winner/i);
  assert.match(round.result, /No winner designation was shown/);
  assert.match(round.window, /8 October 2026 at 22:13 to 10 October 2026 at 13:19/);
  for (const variant of round.variants) {
    const bytes = await readFile(new URL(`../${variant.webThumbnail}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), variant.thumbnailSha256);
  }
});

test('reviewed public history can expose only its approved thumbnails independently of episode data', () => {
  const assets = studioThumbnailAssets(snapshot);
  const projected = projectStudioSnapshot(snapshot, { historicalSnapshot: snapshot });
  for (const [id, count] of [['US9uzJCjH3E', 3], ['h0V1oFHQOrU', 2]]) {
    for (let index = 1; index <= count; index++) assert.ok(assets.includes(`assets/history-${id}-studio-${index}.jpg`));
    const history = projected.history.videos.find(video => video.videoId === id);
    assert.equal(history.variants.length, count);
    assert.ok(history.variants.every(variant => variant.webThumbnail));
    assert.doesNotMatch(JSON.stringify(history), /outputs\/|thumbnailPath|thumbnailSha256|sources/);
  }
  const unreviewed = structuredClone(snapshot);
  for (const video of unreviewed.history.videos.filter(video => video.publishedPublic)) video.publishedPublic = 'true';
  assert.equal(studioThumbnailAssets(unreviewed).some(path => path.includes('US9uzJCjH3E') || path.includes('h0V1oFHQOrU')), false);
  assert.equal(projectStudioSnapshot(unreviewed, { historicalSnapshot: unreviewed }).history.videos.length, 5);
  const invalid = structuredClone(snapshot);
  invalid.history.videos.push({ videoId: '../data.json', publishedPublic: true, variants: [{ webThumbnail: 'data.json' }] });
  assert.deepEqual(studioThumbnailAssets(invalid), assets);
  const rawCloud = { ...snapshot, history: { videos: [{ videoId: 'aBcDeFgHi12', publishedPublic: true, variants: [] }] } };
  assert.equal(projectStudioSnapshot(rawCloud, { historicalSnapshot: snapshot }).history.videos.some(video => video.videoId === 'aBcDeFgHi12'), false);
});
