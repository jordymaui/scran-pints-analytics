import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../sponsor.js', import.meta.url), 'utf8'))
  .split('const icons =')[0].replace(/^import .*\n/gm, '').replace(/^export /gm, '');
const context = vm.createContext({ Intl, Date });
vm.runInContext(source, context);
const plain = value => JSON.parse(JSON.stringify(value));
const sequence = Array.from({ length: 28 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 9, index + 1)).toISOString().slice(0, 10),
  views: index < 14 ? 10 : 20, watchHours: 2, subscribersNet: index < 14 ? -1 : 1,
}));
const performance = { dateRange: { start: '2026-10-01', end: '2026-10-28' }, daily: sequence };

test('YEET growth compares equal adjacent periods ending at the actual processed date', () => {
  const result = context.comparePeriods(performance, 14, 'views');
  assert.equal(result.start, '2026-10-15');
  assert.equal(result.end, '2026-10-28');
  assert.equal(result.previousStart, '2026-10-01');
  assert.equal(result.previousEnd, '2026-10-14');
  assert.equal(result.current.value, 280);
  assert.equal(result.previous.value, 140);
  assert.equal(result.percent, 100);
});

test('missing daily rows preserve reported values and suppress growth claims', () => {
  const result = context.comparePeriods({ ...performance, daily: sequence.filter(row => row.date !== '2026-10-21') }, 14, 'views');
  assert.equal(result.current.value, 260);
  assert.equal(result.current.days, 13);
  assert.equal(result.complete, false);
  assert.equal(result.change, null);
  assert.equal(result.percent, null);
});

test('zero baselines never generate Infinity and subscriber changes retain signs', () => {
  const zero = context.comparePeriods({ ...performance, daily: sequence.map((row, index) => ({ ...row, views: index < 14 ? 0 : 20 })) }, 14, 'views');
  assert.equal(zero.complete, true);
  assert.equal(zero.percent, null);
  assert.equal(zero.change, 280);
  const subscribers = context.comparePeriods(performance, 14, 'subscribersNet');
  assert.equal(subscribers.previous.value, -14);
  assert.equal(subscribers.current.value, 14);
  assert.equal(subscribers.change, 28);
});

test('cumulative views keep later valid points after a missing native value', () => {
  assert.deepEqual(plain(context.cumulativeViews({ daily: [
    { date: '2026-10-01', views: 5 }, { date: '2026-10-02', views: null }, { date: '2026-10-03', views: 7 },
  ] })), [{ date: '2026-10-01', value: 5 }, { date: '2026-10-02', value: null }, { date: '2026-10-03', value: 12 }]);
});

test('audience groups add native percentages without normalising withheld groups', () => {
  const rows = [
    { ageGroup: 'age18-24', gender: 'male', viewerPercentage: 20 },
    { ageGroup: 'age18-24', gender: 'female', viewerPercentage: 10 },
    { ageGroup: 'age25-34', gender: 'male', viewerPercentage: 40 },
  ];
  assert.deepEqual(plain(context.audienceGroups(rows, 'ageGroup')), [{ key: 'age18-24', value: 30 }, { key: 'age25-34', value: 40 }]);
  assert.deepEqual(plain(context.audienceGroups(rows, 'gender')), [{ key: 'male', value: 60 }, { key: 'female', value: 10 }]);
});
