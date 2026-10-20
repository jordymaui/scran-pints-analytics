import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { selectPeriod, summarizeMetric, chartSeries } from '../lib/dashboard-metrics.mjs';

const script = await readFile(new URL('../dashboard.js', import.meta.url), 'utf8');
const functions = script.slice(script.indexOf('function dashboardPeriod('), script.indexOf('function sidebar('));
const context = vm.createContext({
  selectPeriod, summarizeMetric, chartSeries, date: value => value,
  performance: value => value, selected: () => context.activeSource,
});
vm.runInContext(functions, context);
const selectDashboardPeriod = (...args) => context.dashboardPeriod(...args);
const source = () => ({
  dateRange: { start: '2026-08-28', end: '2026-10-17', timeZone: 'America/Los_Angeles' },
  daily: Array.from({ length: 51 }, (_, index) => ({
    date: new Date(Date.parse('2026-08-28') + index * 86_400_000).toISOString().slice(0, 10),
    views: 10, watchHours: 1, likes: 2, comments: 1, shares: 0, subscribersNet: 1,
  })),
});

test('90-day dashboard selection uses the available lifetime and states its actual coverage', () => {
  const period = selectDashboardPeriod(source(), '90d');
  assert.equal(period.start, '2026-08-28');
  assert.equal(period.end, '2026-10-17');
  assert.equal(period.rows.length, 51);
  assert.equal(period.complete, true);
  assert.deepEqual(summarizeMetric(period, 'views'), { value: 510, previous: null, deltaPercent: null, complete: true });
  context.period = period;
  assert.equal(context.periodCoverageNote(), 'Available history starts 2026-08-28; showing 51 days of the selected 90-day window.');
  assert.match(script, /period=dashboardPeriod\(performance\(s\),range,custom\)/);
});

test('clamping never fills a missing date within the declared source history', () => {
  const data = source();
  data.daily.splice(0, 1);
  const period = selectDashboardPeriod(data, '90d');
  assert.equal(period.start, '2026-08-28');
  assert.equal(period.rows[0].available, false);
  assert.equal(period.rows[0].views, null);
  assert.equal(period.complete, false);
  assert.equal(summarizeMetric(period, 'views').value, null);
});

test('covered presets, all available dates and explicit custom dates keep their existing semantics', () => {
  for (const [range, custom] of [['7d'], ['28d'], ['all'], ['custom', { start: '2026-08-01', end: '2026-10-17' }]]) {
    assert.deepEqual(selectDashboardPeriod(source(), range, custom), selectPeriod(source(), range, custom));
  }
  assert.deepEqual(selectDashboardPeriod(null, '90d'), selectPeriod(null, '90d'));
});

test('leading gaps keep native lifetime cards while cumulative reported values remain visible', () => {
  const data = source();
  data.daily.splice(0, 3);
  data.totals = { views: 510 };
  context.activeSource = data;
  context.period = selectDashboardPeriod(data, '90d');
  context.metric = 'views';
  context.cumulative = true;
  const summary = context.metricSummary('views');
  assert.equal(summary.value, 510);
  assert.equal(summary.aggregateOnly, true);
  assert.equal(summary.deltaPercent, null);
  const points = context.dashboardSeries(context.period.rows, 'views', true);
  assert.deepEqual(Array.from(points.slice(0, 4), point => point.value), [null, null, null, 10]);
  assert.equal(points.at(-1).value, 480);
  assert.equal(context.chartCoverageNote(), '48/51 days reported. Missing dates remain gaps. Cumulative reported values sum only the available days.');
});

test('partial custom dates show only reported values without a growth comparison', () => {
  const data = source();
  data.daily = data.daily.filter(row => row.date !== '2026-10-03');
  data.totals = { views: 999999 };
  context.activeSource = data;
  context.period = selectDashboardPeriod(data, 'custom', { start: '2026-10-01', end: '2026-10-14' });
  assert.equal(context.period.previousComplete, true);
  const summary = context.metricSummary('views');
  assert.equal(summary.value, 130);
  assert.equal(summary.reportedOnly, true);
  assert.equal(summary.reportedDays, 13);
  assert.equal(summary.expectedDays, 14);
  assert.equal(summary.complete, false);
  assert.equal(summary.previous, null);
  assert.equal(summary.deltaPercent, null);
  const points = context.dashboardSeries(context.period.rows, 'views', true);
  assert.deepEqual(Array.from(points.slice(0, 4), point => point.value), [10, 20, null, 30]);
  assert.equal(points.at(-1).value, 130);
});

test('partial metrics count finite reported days and never invent unsupported values', () => {
  const data = source();
  data.daily.at(-1).shares = null;
  context.activeSource = data;
  context.period = selectDashboardPeriod(data, '7d');
  assert.equal(context.metricSummary('views').value, 70);
  assert.equal(context.metricSummary('views').deltaPercent, 0);
  const summary = context.metricSummary('engagement');
  assert.equal(summary.value, 18);
  assert.equal(summary.reportedDays, 6);
  assert.equal(summary.expectedDays, 7);
  assert.equal(summary.deltaPercent, null);
  assert.equal(context.metricSummary('unsupported').value, null);
});
