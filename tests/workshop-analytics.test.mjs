import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { analyticsMetrics, analyticsDailySeries } from '../lib/workshop-model.mjs';
import { createWorkshopDataHandler, validateChannelAnalytics } from '../api/workshop-data.mjs';
import { buildPublicReport } from '../lib/report-model.mjs';

const values = { views: 17, estimatedMinutesWatched: 90, averageViewDuration: 123.4,
  averageViewPercentage: 42.7, likes: 4, comments: 2, shares: 1, subscribersGained: 5, subscribersLost: 7 };
const channel = () => ({
  capturedAt: '2026-10-20T12:00:00Z', channelId: 'UCAX4l1JUAymaMHVKiRFzK-A',
  dateRange: { start: '2026-10-01', end: '2026-10-03', timezone: 'America/Los_Angeles' },
  aggregate: { ...values }, daily: [{ day: '2026-10-01', ...values }, { day: '2026-10-03', ...values, views: 0 }],
  coverage: { startBasis: 'channel-created', endBasis: 'channel-daily-same-metrics' },
});
const shorts = () => ({
  id: 'youtube-shorts', label: 'YouTube Shorts', accountLabel: 'Scran & Pints', status: 'snapshot',
  capturedAt: '2026-10-19T12:00:00Z',
  dateRange: { start: '2026-10-01', end: '2026-10-03', timezone: 'America/Los_Angeles' },
  scope: 'Returned daily Shorts rows in this reporting window.',
  provenance: { kind: 'official-api', label: 'YouTube Analytics API' },
  metrics: { views: 12, engagedViews: 8, watchHours: 1.2, likes: 2, comments: 0, shares: 1, subscribersNet: -1, followers: null },
  daily: [{ day: '2026-10-01', views: 12 }, { day: '2026-10-03', views: 0 }], content: [],
});
const response = () => ({
  headers: {}, setHeader(key, value) { this.headers[key] = value; },
  end(value) { this.body = JSON.parse(value); },
});

test('native Analytics metrics preserve zero, averages, negative net and missing operands', () => {
  const metrics = analyticsMetrics(values);
  assert.equal(metrics.watchHours, 1.5);
  assert.equal(metrics.averageViewDuration, 123.4);
  assert.equal(metrics.averageViewPercentage, 42.7);
  assert.equal(metrics.subscribersNet, -2);
  const missing = analyticsMetrics({ views: 0, subscribersGained: 4, estimatedMinutesWatched: null });
  assert.equal(missing.views, 0);
  assert.equal(missing.watchHours, null);
  assert.equal(missing.subscribersNet, null);
});

test('daily trends keep absent/duplicate source dates as gaps and count true zero dates', () => {
  const report = channel();
  const rows = analyticsDailySeries(report.daily, report.dateRange);
  assert.deepEqual(rows.map(row => row.views), [17, null, 0]);
  assert.equal(rows[1].coverage, 'No returned row');
  assert.equal(rows[2].coverage, 'Returned row');
  assert.equal(rows[0].averageViewDuration, 123.4);
  const duplicate = analyticsDailySeries([...report.daily, report.daily[0]], report.dateRange);
  assert.equal(duplicate[0].views, null);
  assert.equal(duplicate[0].coverage, 'Duplicate source rows');
  assert.deepEqual(analyticsDailySeries(report.daily, report.dateRange, 1).map(row => row.day), ['2026-10-03']);
  assert.deepEqual(analyticsDailySeries([], { start: '2026-02-30', end: '2026-03-02' }), []);
  const longRange = { start: '2005-01-01', end: '2026-10-03' };
  assert.equal(analyticsDailySeries(report.daily, longRange, 28).length, 28);
  assert.equal(analyticsDailySeries(report.daily, longRange, null).length, 5000);
});

test('private channel validation rejects malformed counts, dates, attribution and unknown fields', () => {
  assert.deepEqual(validateChannelAnalytics(channel()), channel());
  for (const alter of [
    report => { report.accessToken = 'private'; },
    report => { report.aggregate.views = -1; },
    report => { report.aggregate.subscribersGained = 0.5; },
    report => { report.dateRange.end = '2026-02-30'; },
    report => { report.daily.push(report.daily[0]); },
    report => { report.daily.pop(); },
    report => { report.channelId = 'UC0000000000000000000000'; },
    report => { report.coverage.startBasis = 'assumed'; },
  ]) {
    const report = channel(); alter(report);
    assert.throws(() => validateChannelAnalytics(report), /Invalid saved channel/);
  }
});

test('public Studio endpoint reads without authorization and denies unsupported methods', async () => {
  let reads = 0, authorizations = 0;
  const handler = createWorkshopDataHandler({
    authorize: async (_req, res) => { authorizations++; res.statusCode = 401; res.end('{"error":"sign_in_required"}'); return null; },
    loadInputs: async () => { reads++; return { snapshot: {}, social: { sources: [] }, origins: {} }; },
  });
  const readable = response(); await handler({ method: 'GET' }, readable);
  assert.equal(readable.statusCode, 200); assert.equal(reads, 1);
  const unsupported = response(); await handler({ method: 'POST' }, unsupported);
  assert.equal(unsupported.statusCode, 405); assert.equal(authorizations, 0); assert.equal(reads, 1);
});

test('private endpoint exposes only the validated cloud Shorts source and its original dates', async () => {
  for (const origin of ['cloud', 'bundled']) {
    const handler = createWorkshopDataHandler({
      authorize: async () => ({ id: 'approved' }),
      loadInputs: async () => ({
        snapshot: { videos: [], channelAnalytics: channel() },
        social: { sources: [shorts(), { id: 'instagram', privateMarker: 'EXCLUDED_SOCIAL' }] },
        origins: { youtube: 'cloud', 'youtube-shorts': origin }, storageStatus: 'cloud',
      }),
    });
    const res = response(); await handler({ method: 'GET' }, res);
    assert.equal(res.statusCode, 200);
    const { channelId, ...expected } = channel();
    assert.deepEqual(res.body.channelAnalytics, expected);
    assert.equal(res.body.shortsAnalytics?.capturedAt ?? null, origin === 'cloud' ? shorts().capturedAt : null);
    assert.doesNotMatch(JSON.stringify(res.body), /EXCLUDED_SOCIAL/);
    assert.match(res.headers['Cache-Control'], /no-store/);
  }
});

test('malformed channel data fails safely and public projection excludes private channel and Shorts reports', async () => {
  const malformed = { ...channel(), unexpected: 'RAW_PRIVATE_SENTINEL' };
  const handler = createWorkshopDataHandler({
    authorize: async () => ({ id: 'approved' }),
    loadInputs: async () => ({ snapshot: { channelAnalytics: malformed }, social: { sources: [] }, origins: {} }),
  });
  const res = response(); await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /RAW_PRIVATE_SENTINEL/);
  const report = buildPublicReport({ channelAnalytics: channel(), shortsAnalytics: shorts() });
  assert.equal(report.sources[0].metrics, null);
  assert.equal(report.sources[1].metrics, null);
  assert.doesNotMatch(JSON.stringify(report), /averageViewDuration|channel-created/);
});

test('overview render uses native channel totals, separate Shorts dates, and dated episode traffic', async () => {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', value: '', dataset: {},
      addEventListener() {}, focus() {} });
    return elements.get(selector);
  };
  element('#analytics-sort').value = 'views';
  element('#analytics-video').value = 'CWBBRExPJ0I';
  const context = vm.createContext({
    analyticsMetrics, analyticsDailySeries,
    document: { querySelector: element }, Intl, Date, Number, String, Map, Set,
  });
  const source = (await readFile(new URL('../workshop.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/\r?\n(?:checkTeamAccess|load)\(\);/g, '');
  vm.runInContext(source, context);
  context.fixture = {
    capturedAt: '2026-10-20T12:00:00Z', apiThrough: '2026-10-03', channelAnalytics: channel(), shortsAnalytics: shorts(),
    videos: [{ id: 'CWBBRExPJ0I', name: 'Fixture episode', title: 'A <test> title', publishedAt: '2026-10-01T12:00:00Z',
      apiAggregate: { ...values, views: 9876 }, daily: channel().daily,
      traffic: [{ insightTrafficSourceType: 'YT_SEARCH', views: 3, estimatedMinutesWatched: 30 }],
      trafficSource: { start: '2026-10-01', end: '2026-10-02', capturedAt: '2026-10-18T12:00:00Z' },
      refreshReports: { traffic: 'no-rows-retained-previous' } }],
  };
  vm.runInContext('data = fixture; initializeAnalytics();', context);
  assert.match(element('#channel-analytics').innerHTML, /Native channel aggregate/);
  assert.doesNotMatch(element('#channel-analytics').innerHTML, /9,876/);
  assert.match(element('#shorts-analytics').innerHTML, /19 Oct 2026/);
  assert.match(element('#episode-analytics-body').innerHTML, /9,876/);
  assert.match(element('#episode-analytics-body').innerHTML, /A &lt;test&gt; title/);
  assert.match(element('#episode-analytics-detail').innerHTML, /18 Oct 2026/);
  assert.match(element('#episode-analytics-detail').innerHTML, /Older traffic report retained/);
  assert.match(element('#episode-analytics-detail').innerHTML, /YT_SEARCH/);
  assert.doesNotMatch([...elements.values()].map(row => row.innerHTML).join(''), /NaN|undefined|Infinity/);
  vm.runInContext('data.channelAnalytics = null; data.shortsAnalytics = null; renderChannelAnalytics(); renderShortsAnalytics();', context);
  assert.match(element('#channel-analytics').innerHTML, /has not been collected yet/);
  assert.match(element('#shorts-analytics').innerHTML, /No saved Shorts report/);
});

test('Studio tabs open deep links and notebook navigation without discarding panel state', async () => {
  const ids = ['analytics', 'compare', 'packaging', 'metadata', 'notebook'];
  const panels = ids.map(id => ({ id, hidden: false, draftValue: id === 'notebook' ? 'unsaved hypothesis' : '' }));
  const links = ids.map(id => ({
    dataset: { studioTab: id }, attributes: {}, events: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, callback) { this.events[name] = callback; },
  }));
  const events = {};
  const location = { hash: '#packaging' };
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector === '[data-studio-panel]' ? panels : links },
    window: { addEventListener: (name, callback) => { events[name] = callback; } },
    location, history: { replaceState: (_state, _title, hash) => { location.hash = hash; } },
    Intl, Date, Number, String, Map, Set,
  });
  const source = (await readFile(new URL('../workshop.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/\r?\n(?:checkTeamAccess|load)\(\);/g, '');
  vm.runInContext(source, context);
  vm.runInContext('teamAccess = true; initializeStudioNavigation();', context);
  assert.deepEqual(panels.filter(panel => !panel.hidden).map(panel => panel.id), ['packaging']);
  assert.equal(links[2].attributes['aria-current'], 'location');
  let prevented = false;
  links[4].events.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(location.hash, '#notebook');
  assert.deepEqual(panels.filter(panel => !panel.hidden).map(panel => panel.id), ['notebook']);
  assert.equal(panels[4].draftValue, 'unsaved hypothesis');
  assert.equal(links[2].attributes['aria-current'], undefined);
  location.hash = '#unknown';
  events.hashchange();
  assert.deepEqual(panels.filter(panel => !panel.hidden).map(panel => panel.id), ['analytics']);
  vm.runInContext("selectStudioSection('notebook');", context);
  assert.equal(panels[4].hidden, false);
  assert.equal(panels[4].draftValue, 'unsaved hypothesis');
  vm.runInContext("teamAccess = false; selectStudioSection('notebook');", context);
  assert.equal(panels[4].hidden, true);
  assert.equal(panels[0].hidden, false);
});
