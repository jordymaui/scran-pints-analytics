import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPublicReport, buildDaily, csvCell, dateInPacific } from '../lib/report-model.mjs';
const raw = JSON.parse(fs.readFileSync(new URL('../data.json', import.meta.url)));
test('public projection preserves recorded totals and missing-platform states', () => {
  const report = buildPublicReport(raw);
  assert.equal(report.sources[0].metrics.views, raw.videos.reduce((n,v)=>n+v.apiAggregate.views,0));
  assert.equal(report.sources[0].metrics.watchHours, raw.videos.reduce((n,v)=>n+v.apiAggregate.estimatedMinutesWatched,0)/60);
  assert.equal(report.sources[0].metrics.subscribersNet, raw.videos.reduce((n,v)=>n+v.subscribersNet,0));
  assert.equal(report.sources[0].content.length, raw.videos.length);
  assert.ok(report.sources.slice(1).every(p => p.metrics === null && p.status === 'not-connected'));
});
test('public export excludes internal test evidence, source paths and drafts', () => {
  const value = JSON.stringify(buildPublicReport(raw));
  for (const text of ['openclaw', '/Users/', 'testId', 'thumbnailPath', 'watchTimeSharePct', 'webEvidence', 'history-']) assert.equal(value.includes(text), false, text);
});
test('missing episode day is not silently filled with zero or shown as a complete total', () => {
  const row = buildDaily([
    {name:'Fulham',publishedAt:'2026-09-16T16:30:00Z',daily:[]},
    {name:'Hull',publishedAt:'2026-09-02T16:00:00Z',daily:[{day:'2026-09-29',views:20}]}
  ],'2026-09-29','2026-09-29')[0];
  assert.equal(row.views, null);
  assert.equal(row.complete, false);
  assert.deepEqual(row.missing, ['Fulham']);
  assert.ok(row.knownViews > 0);
});
test('daily coverage starts at publication in Pacific time, not UTC', () => {
  assert.equal(dateInPacific('2026-09-02T01:00:00Z'), '2026-09-01');
  const daily = buildDaily([{ name: 'Late', publishedAt: '2026-09-02T01:00:00Z', daily: [] }], '2026-09-01', '2026-09-02');
  assert.equal(daily[0].complete, false);
});
test('incomplete equal-age windows remain unavailable', () => {
  const snapshot=structuredClone(raw);
  snapshot.videos[0].windows['3']={complete:false,views:null,watchHours:null};
  const row = buildPublicReport(snapshot).sources[0].content[0];
  assert.equal(row.launchWindows['3'].complete, false);
  assert.equal(row.launchWindows['3'].views, null);
});
test('advancing analytics capture date does not redate historical title and thumbnail',()=>{
  const snapshot=structuredClone(raw);
  snapshot.videos[0].packagingCapturedAt='2026-10-04T14:11:35Z';
  snapshot.capturedAt='2026-10-20T10:00:00Z';
  const row=buildPublicReport(snapshot).sources[0].content[0];
  assert.equal(row.packagingCapturedAt,'2026-10-04T14:11:35Z');
});
test('CSV export escapes quotes and spreadsheet formula payloads', () => {
  assert.equal(csvCell('=cmd()'), '"\'=cmd()"');
  assert.equal(csvCell('A "title"'), '"A ""title"""');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(-5), '"-5"');
});
