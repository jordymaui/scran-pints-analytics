import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPeriod, summarizeMetric, chartSeries } from '../lib/dashboard-metrics.mjs';

const row = (date, values = {}) => ({
  date, views: 10, watchHours: 0.5, likes: 2, comments: 1, shares: 1, subscribersNet: -1, ...values,
});
const sequence = (start, count, values = {}) => Array.from({ length: count }, (_, index) =>
  row(new Date(Date.parse(start) + index * 86_400_000).toISOString().slice(0, 10), values));
const performance = (daily, start = daily[0]?.date, end = daily.at(-1)?.date) => ({
  capturedAt: '2026-10-20T12:00:00.000Z',
  dateRange: { start, end, timeZone: 'America/Los_Angeles' }, daily,
  totals: { views: 999999 }, // A larger all-time total must not override a selected window.
});

test('preset windows end at the last returned date with equal preceding calendar windows', () => {
  const source = performance(sequence('2026-07-01', 110), '2026-07-01', '2026-10-20');
  for (const [range, count] of [['7d', 7], ['28d', 28], ['90d', 90]]) {
    const selected = selectPeriod(source, range);
    assert.equal(selected.end, '2026-10-18');
    assert.equal(selected.rows.length, count);
    assert.equal(selected.previousRows.length, count);
    assert.equal(selected.previousRows.at(-1).date, new Date(Date.parse(selected.start) - 86_400_000).toISOString().slice(0, 10));
    assert.equal(selected.complete, true);
  }
  const selected = selectPeriod(source);
  assert.deepEqual(summarizeMetric(selected, 'views'), { value: 280, previous: 280, deltaPercent: 0, complete: true });
});

test('missing dates remain gaps while native zero values are complete observations', () => {
  const source = performance([row('2026-10-01', { views: 0 }), row('2026-10-03', { views: 0 })]);
  const selected = selectPeriod(source, 'all');
  assert.equal(selected.complete, false);
  assert.equal(selected.rows[0].available, true);
  assert.equal(selected.rows[0].views, 0);
  assert.equal(selected.rows[1].available, false);
  assert.equal(selected.rows[1].views, null);
  assert.deepEqual(summarizeMetric(selected, 'views'), { value: null, previous: null, deltaPercent: null, complete: false });
  const zero = selectPeriod(performance(sequence('2026-10-01', 14, { views: 0 })), '7d');
  assert.deepEqual(summarizeMetric(zero, 'views'), { value: 0, previous: 0, deltaPercent: null, complete: true });
});

test('metric completeness is independent and engagement needs every component', () => {
  const daily = sequence('2026-10-01', 14);
  daily.at(-1).shares = null;
  const selected = selectPeriod(performance(daily), '7d');
  assert.equal(selected.complete, true);
  assert.equal(summarizeMetric(selected, 'views').value, 70);
  assert.equal(summarizeMetric(selected, 'shares').value, null);
  assert.equal(summarizeMetric(selected, 'engagement').value, null);
  assert.equal(summarizeMetric(selected, 'engagement').previous, 28);
  daily.at(-1).shares = 0;
  const repaired = selectPeriod(performance(daily), '7d');
  assert.equal(summarizeMetric(repaired, 'engagement').value, 27);
  assert.equal(summarizeMetric(repaired, 'subscribersNet').value, -7);
  assert.equal(summarizeMetric(repaired, 'subscribersNet').deltaPercent, null);
});

test('comparisons require full previous coverage and a positive nonzero baseline', () => {
  const daily = [...sequence('2026-10-01', 7, { views: 10 }), ...sequence('2026-10-08', 7, { views: 15 })];
  assert.equal(summarizeMetric(selectPeriod(performance(daily), '7d'), 'views').deltaPercent, 50);
  daily.shift();
  const selected = selectPeriod(performance(daily, '2026-10-01'), '7d');
  assert.equal(selected.previousComplete, false);
  assert.deepEqual(summarizeMetric(selected, 'views'), { value: 105, previous: null, deltaPercent: null, complete: true });
});

test('all and custom keep declared coverage honest and cap future end dates', () => {
  const source = performance(sequence('2026-10-02', 8), '2026-10-01', '2026-10-19');
  const all = selectPeriod(source, 'all');
  assert.equal(all.start, '2026-10-01');
  assert.equal(all.end, '2026-10-09');
  assert.equal(all.complete, false);
  const custom = selectPeriod(source, 'custom', { start: '2026-10-05', end: '2026-10-30' });
  assert.equal(custom.end, '2026-10-09');
  assert.equal(custom.rows.length, 5);
  assert.equal(custom.complete, true);
  assert.equal(custom.previousComplete, false);
  const short = selectPeriod(source, '28d');
  assert.equal(short.rows.length, 28);
  assert.equal(short.complete, false);
});

test('calendar arithmetic respects leap days and does not convert source dates across DST', () => {
  const leap = selectPeriod(performance(sequence('2024-02-26', 7)), '7d');
  assert.deepEqual(leap.rows.map(value => value.date), [
    '2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02', '2024-03-03',
  ]);
  const dst = selectPeriod(performance(sequence('2026-03-05', 7)), '7d');
  assert.equal(dst.rows.length, 7);
  assert.equal(dst.rows[3].date, '2026-03-08');
});

test('duplicate dates cannot inflate sums, and input rows are never mutated', () => {
  const daily = [...sequence('2026-10-01', 7), row('2026-10-04')].reverse();
  const source = performance(daily, '2026-10-01', '2026-10-07');
  const original = structuredClone(source);
  const selected = selectPeriod(source, '7d');
  assert.equal(selected.complete, false);
  assert.equal(selected.rows[3].available, false);
  assert.equal(summarizeMetric(selected, 'views').value, null);
  assert.deepEqual(source, original);
});

test('charts insert calendar gaps and cumulative totals stay unknown after the first gap', () => {
  const rows = [row('2026-10-03', { views: 30 }), row('2026-10-01', { views: 10 })];
  assert.deepEqual(chartSeries(rows, 'views'), [
    { date: '2026-10-01', value: 10 }, { date: '2026-10-02', value: null }, { date: '2026-10-03', value: 30 },
  ]);
  assert.deepEqual(chartSeries(rows, 'views', true), [
    { date: '2026-10-01', value: 10 }, { date: '2026-10-02', value: null }, { date: '2026-10-03', value: null },
  ]);
  assert.deepEqual(chartSeries(sequence('2026-10-01', 3, { views: 0 }), 'views', true).map(point => point.value), [0, 0, 0]);
  assert.equal(chartSeries([row('2026-10-01', { likes: -1 })], 'engagement')[0].value, 1);
  assert.equal(chartSeries([row('2026-10-01', { shares: null })], 'engagement')[0].value, null);
});

test('invalid dates, unsupported metrics, nonfinite values and empty input fail without invented totals', () => {
  for (const source of [null, {}, performance([]), performance([row('2026-02-30')])]) {
    assert.deepEqual(selectPeriod(source), { start: null, end: null, rows: [], previousRows: [], complete: false, previousComplete: false });
  }
  const source = performance(sequence('2026-10-01', 7, { views: NaN }));
  assert.equal(summarizeMetric(selectPeriod(source, '7d'), 'views').value, null);
  assert.equal(summarizeMetric(selectPeriod(source, '7d'), 'unknownMetric').value, null);
  assert.deepEqual(chartSeries(source.daily, 'unknownMetric').map(point => point.value), Array(7).fill(null));
  for (const custom of [{ start: '2026-02-30', end: '2026-10-01' }, { start: '2026-10-10', end: '2026-10-01' }]) {
    assert.equal(selectPeriod(source, 'custom', custom).complete, false);
  }
  assert.deepEqual(chartSeries([], 'views'), []);
});
