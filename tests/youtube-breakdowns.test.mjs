import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { CHANNEL_BREAKDOWN_REPORTS, collectChannelBreakdowns, validateChannelBreakdowns } from '../lib/youtube-breakdowns.mjs';
import { createWorkshopDataHandler } from '../api/workshop-data.mjs';
import { buildPublicReport } from '../lib/report-model.mjs';

const fixtureRows = {
  traffic: [{ insightTrafficSourceType: 'YT_SEARCH', views: 10, estimatedMinutesWatched: 60 }],
  country: [{ country: 'GB', views: 10, estimatedMinutesWatched: 60 }],
  device: [{ deviceType: 'MOBILE', views: 0, estimatedMinutesWatched: 0 }],
  subscribed: [{ subscribedStatus: 'UNSUBSCRIBED', views: 10, estimatedMinutesWatched: 60 }],
  format: [{ creatorContentType: 'SHORTS', views: 10, estimatedMinutesWatched: 60 }],
  demographics: [{ ageGroup: '18-24', gender: 'female', viewerPercentage: 22.4 }],
  operatingSystem: [{ operatingSystem: 'ANDROID', views: 10, estimatedMinutesWatched: 60 }],
  playbackLocation: [{ insightPlaybackLocationType: 'WATCH', views: 10, estimatedMinutesWatched: 60 }],
  youtubeProduct: [{ youtubeProduct: 'CORE', views: 10, estimatedMinutesWatched: 60 }],
  liveOrOnDemand: [{ liveOrOnDemand: 'ON_DEMAND', views: 10, estimatedMinutesWatched: 60 }],
  sharing: [{ sharingService: 'WHATS_APP', shares: 3 }],
  searchTerms: [{ insightTrafficSourceDetail: 'football food', views: 10, estimatedMinutesWatched: 60 }],
  externalSources: [{ insightTrafficSourceDetail: 'example.com', views: 10, estimatedMinutesWatched: 60 }],
  suggestedVideos: [{ insightTrafficSourceDetail: 'abcdefghijk', views: 10, estimatedMinutesWatched: 60 }],
  engagement: [{ day: '2026-10-15', engagedViews: 7, dislikes: 0, videosAddedToPlaylists: 2,
    videosRemovedFromPlaylists: 1, redViews: 1, estimatedRedMinutesWatched: 2.5 }],
  cards: [{ day: '2026-10-15', cardImpressions: 10, cardClicks: 1, cardClickRate: .1,
    cardTeaserImpressions: 20, cardTeaserClicks: 2, cardTeaserClickRate: .1 }],
};
const options = {
  capturedAt: '2026-10-20T12:00:00Z', start: '2025-01-01', end: '2026-10-17',
  query: async ({ id }) => structuredClone(fixtureRows[id]),
};
const response = () => ({
  headers: {}, setHeader(key, value) { this.headers[key] = value; },
  end(value) { this.body = JSON.parse(value); },
});

test('optional channel reports use only supported native metric/dimension combinations', async () => {
  const calls = [];
  const result = await collectChannelBreakdowns({ ...options, query: async request => {
    calls.push(request);
    return structuredClone(fixtureRows[request.id]);
  } });
  assert.equal(calls.length, 16);
  assert.deepEqual(calls.find(call => call.id === 'traffic').report, {
    dimensions: 'insightTrafficSourceType', metrics: 'views,estimatedMinutesWatched', sort: 'insightTrafficSourceType',
  });
  assert.deepEqual(calls.find(call => call.id === 'demographics').report, {
    dimensions: 'ageGroup,gender', metrics: 'viewerPercentage', sort: 'ageGroup,gender',
  });
  assert.ok(calls.every(call => call.startDate === options.start && call.endDate === options.end &&
    !('accessToken' in call)));
  for (const id of ['searchTerms', 'externalSources', 'suggestedVideos']) {
    const request = calls.find(call => call.id === id);
    assert.equal(request.report.maxResults, 25);
    assert.equal(request.report.sort, '-views');
    assert.match(request.report.filters, /^insightTrafficSourceType==(?:YT_SEARCH|EXT_URL|RELATED_VIDEO)$/);
  }
  assert.deepEqual(Object.keys(result).sort(), Object.keys(CHANNEL_BREAKDOWN_REPORTS).sort());
  assert.equal(result.device.report.rows[0].views, 0);
  assert.equal(result.demographics.report.rows[0].viewerPercentage, 22.4);
  assert.equal(result.format.report.endStatus, 'query-bound-no-daily-completeness-signal');
  assert.deepEqual(validateChannelBreakdowns(result), result);
});

test('failures and empty rows preserve each earlier report without advancing its dates', async () => {
  const previous = await collectChannelBreakdowns({ ...options, capturedAt: '2026-10-18T12:00:00Z', end: '2026-10-15' });
  const original = structuredClone(previous);
  const result = await collectChannelBreakdowns({ ...options, previous, query: async ({ id }) => {
    if (id === 'traffic') throw new Error('PRIVATE_PROVIDER_BODY refresh_token=secret');
    if (id === 'country') return [];
    if (id === 'device') return [{ deviceType: 'MOBILE', views: '10', estimatedMinutesWatched: 60 }];
    return structuredClone(fixtureRows[id]);
  } });
  assert.equal(result.traffic.status, 'failed-retained');
  assert.equal(result.traffic.errorCode, 'report-unavailable');
  assert.equal(result.country.status, 'no-rows-retained');
  assert.equal(result.country.errorCode, null);
  assert.equal(result.device.status, 'failed-retained');
  assert.equal(result.device.errorCode, 'invalid-response');
  for (const id of ['traffic', 'country', 'device']) {
    assert.deepEqual(result[id].report, previous[id].report);
    assert.equal(result[id].attemptedAt, options.capturedAt);
    assert.equal(result[id].attemptedRange.end, options.end);
  }
  assert.equal(result.format.status, 'collected');
  assert.equal(result.format.report.capturedAt, options.capturedAt);
  assert.deepEqual(previous, original);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_BODY|refresh_token|secret/);
});

test('first empty or failed reports stay unavailable and malformed old history is discarded', async () => {
  const previous = await collectChannelBreakdowns(options);
  previous.traffic.report.accessToken = 'PRIVATE_TOKEN';
  const result = await collectChannelBreakdowns({ ...options, previous, query: async ({ id }) => {
    if (id === 'traffic') throw Error('provider response');
    return [];
  } });
  assert.deepEqual(result.traffic.report, null);
  assert.equal(result.traffic.status, 'failed');
  const fresh = await collectChannelBreakdowns({ ...options, query: async () => [] });
  assert.ok(Object.values(fresh).every(entry => entry.report === null && entry.status === 'no-rows'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN/);
});

test('strict optional schema rejects duplicates, extra secrets, forged status and invalid native values', async () => {
  const valid = await collectChannelBreakdowns(options);
  for (const alter of [
    value => { value.tokens = {}; },
    value => { value.traffic.errorCode = 'provider-message'; },
    value => { value.traffic.attemptedRange.end = '2026-02-30'; },
    value => { value.traffic.report.rows.push(value.traffic.report.rows[0]); },
    value => { value.traffic.report.rows[0].views = 0.5; },
    value => { value.traffic.report.rows[0].estimatedMinutesWatched = -1; },
    value => { value.traffic.report.rows[0].estimatedMinutesWatched = Infinity; },
    value => { value.traffic.report.rows[0].accessToken = 'secret'; },
    value => { value.traffic.report.capturedAt = '2026-10-21T12:00:00Z'; },
    value => { value.traffic.status = 'no-rows'; },
    value => { value.demographics.report.rows[0].viewerPercentage = 100.1; },
    value => { value.demographics.report.rows[0].gender = '\u0000'; },
    value => { value.cards.report.rows[0].cardClickRate = 1.1; },
    value => { value.sharing.report.rows[0].shares = .5; },
    value => { value.engagement.report.rows[0].day = '2024-12-31'; },
  ]) {
    const modified = structuredClone(valid); alter(modified);
    assert.throws(() => validateChannelBreakdowns(modified), /Invalid saved channel breakdown/);
  }
  const duplicate = await collectChannelBreakdowns({ ...options, query: async ({ id }) => [...fixtureRows[id], ...fixtureRows[id]] });
  assert.ok(Object.values(duplicate).every(entry => entry.status === 'failed' && entry.errorCode === 'invalid-response'));
});

test('optional daily reports preserve missing historical dates and bound concurrency', async () => {
  const previous = await collectChannelBreakdowns(options);
  const seen = { active: 0, maximum: 0 };
  const result = await collectChannelBreakdowns({ ...options, previous, query: async ({ id }) => {
    seen.active++;
    seen.maximum = Math.max(seen.maximum, seen.active);
    await new Promise(resolve => setImmediate(resolve));
    seen.active--;
    return id === 'engagement' ? [{ ...fixtureRows.engagement[0], day: '2026-10-16' }] : structuredClone(fixtureRows[id]);
  } });
  assert.ok(seen.maximum <= 6);
  assert.equal(result.engagement.status, 'failed-retained');
  assert.equal(result.engagement.errorCode, 'coverage-loss');
  assert.deepEqual(result.engagement.report, previous.engagement.report);
});

test('private endpoint isolates malformed optional breakdowns and public report excludes native rows', async () => {
  const valid = await collectChannelBreakdowns(options);
  const invalid = structuredClone(valid);
  invalid.traffic.report.rows[0].secret = 'PRIVATE_SENTINEL';
  for (const [input, expected] of [[valid, valid], [invalid, null]]) {
    const handler = createWorkshopDataHandler({
      authorize: async () => ({ id: 'approved' }),
      loadInputs: async () => ({ snapshot: { videos: [], channelBreakdowns: input },
        social: { sources: [] }, origins: { youtube: 'cloud' }, storageStatus: 'cloud' }),
    });
    const res = response(); await handler({ method: 'GET' }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.channelBreakdowns, expected);
    assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_SENTINEL/);
  }
  const publicReport = buildPublicReport({ channelBreakdowns: valid });
  assert.doesNotMatch(JSON.stringify(publicReport), /channelBreakdowns|viewerPercentage|YT_SEARCH|estimatedMinutesWatched/);
});

test('channel selector renders native demographics, retained dates, empty status and escaped dimensions', async () => {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', value: '', addEventListener() {} });
    return elements.get(selector);
  };
  const context = vm.createContext({ document: { querySelector: element }, Intl, Date, Number, String, Map, Set,
    createReportRefresh: () => ({ mount() {} }) });
  const source = (await readFile(new URL('../workshop.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/\r?\ncheckTeamAccess\(\);\r?\nload\(\);\s*$/, '');
  vm.runInContext(source, context);
  const previous = await collectChannelBreakdowns({ ...options, capturedAt: '2026-10-18T12:00:00Z', end: '2026-10-15' });
  context.fixture = { channelBreakdowns: await collectChannelBreakdowns({ ...options, previous,
    query: async ({ id }) => id === 'traffic' ? [] : structuredClone(fixtureRows[id]) }) };
  vm.runInContext('data = fixture;', context);
  element('#channel-breakdown').value = 'traffic';
  vm.runInContext('renderChannelBreakdown();', context);
  assert.match(element('#channel-breakdown-detail').innerHTML, /earlier report with its original dates/);
  assert.match(element('#channel-breakdown-detail').innerHTML, /collected 18 Oct 2026/);
  assert.match(element('#channel-breakdown-detail').innerHTML, /Latest attempt: 20 Oct 2026/);
  element('#channel-breakdown').value = 'demographics';
  vm.runInContext('renderChannelBreakdown();', context);
  assert.match(element('#channel-breakdown-detail').innerHTML, /22.4%/);
  assert.doesNotMatch(element('#channel-breakdown-detail').innerHTML, /Watch hours/);
  context.fixture.channelBreakdowns.device.report.rows[0].deviceType = '<script>TEST</script>';
  element('#channel-breakdown').value = 'device';
  vm.runInContext('renderChannelBreakdown();', context);
  assert.match(element('#channel-breakdown-detail').innerHTML, /&lt;script&gt;TEST&lt;\/script&gt;/);
  assert.match(element('#channel-breakdown-detail').innerHTML, /class="metric">0</);
  context.fixture.channelBreakdowns = await collectChannelBreakdowns({ ...options, query: async () => [] });
  vm.runInContext('renderChannelBreakdown();', context);
  assert.match(element('#channel-breakdown-detail').innerHTML, /unavailable, not zero/);
  assert.doesNotMatch(element('#channel-breakdown-detail').innerHTML, /<table/);
  context.fixture.channelBreakdowns = null;
  vm.runInContext('renderChannelBreakdown();', context);
  assert.match(element('#channel-breakdown-detail').innerHTML, /No valid saved devices report/);
});
