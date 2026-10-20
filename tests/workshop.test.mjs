import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { windowMetrics, groupTests, metadataAudit, validateNotebook, mergeNotebookChanges } from '../lib/workshop-model.mjs';

const snapshot = JSON.parse(await readFile(new URL('../data.json', import.meta.url), 'utf8'));
const row = (day, views = 10) => ({ day, views, estimatedMinutesWatched: 60, subscribersGained: 2, subscribersLost: 1 });

test('same-age windows anchor to publication date, not first available observation', () => {
  const video = { publishedAt: '2026-09-01T23:00:00Z', daily: [row('2026-09-02'), row('2026-09-03'), row('2026-09-04')] };
  const result = windowMetrics(video, 3);
  assert.equal(result.complete, false);
  assert.equal(result.start, '2026-09-01');
  assert.equal(result.end, '2026-09-03');
  assert.equal(result.present, 2);
  assert.equal(result.views, undefined);
});

test('complete windows sum exact source rows and exclude later dates', () => {
  const video = { publishedAt: '2026-09-01T15:00:00Z', daily: [row('2026-09-03', 30), row('2026-09-01', 10), row('2026-09-02', 20), row('2026-09-04', 1000)] };
  const result = windowMetrics(video, 3);
  assert.equal(result.complete, true);
  assert.equal(result.views, 60);
  assert.equal(result.watchHours, 3);
  assert.equal(result.subscribersNet, 3);
});

test('duplicate rows invalidate a calendar window instead of double-counting', () => {
  const video = { publishedAt: '2026-09-01', daily: [row('2026-09-01'), row('2026-09-01'), row('2026-09-02'), row('2026-09-03')] };
  assert.equal(windowMetrics(video, 3).complete, false);
  assert.equal(windowMetrics(video, 3).reason, 'Duplicate source dates');
});

test('missing metric values remain unknown, while genuine zero stays zero', () => {
  const rows = [row('2026-09-01', 0), row('2026-09-02', 0), row('2026-09-03', 0)];
  rows[0].estimatedMinutesWatched = null;
  const result = windowMetrics({ publishedAt: '2026-09-01', daily: rows }, 3);
  assert.equal(result.views, 0);
  assert.equal(result.watchHours, null);
});

test('real snapshot matches its verified complete windows; Coventry stays incomplete', () => {
  for (const video of snapshot.videos) {
    for (const days of [3, 7]) {
      const result = windowMetrics(video, days);
      assert.equal(result.complete, video.windows[days].complete);
      if (result.complete) {
        for (const key of ['views', 'watchHours', 'subscribersNet']) assert.equal(result[key], video.windows[days][key]);
      } else assert.equal(result.views, undefined);
    }
  }
});

test('native test groups retain raw test IDs and never transfer earlier shares', () => {
  const groups = groupTests(snapshot.history);
  const early = groups.find(group => group.testId === 'fulham-2026-09-17');
  const revised = groups.find(group => group.testId === 'fulham-2026-09-19');
  const studio = groups.find(group => group.testId === 'nrVntdSPHgg-studio-visible');
  assert.equal(early.highestShare, 38.1);
  assert.equal(revised.highestShare, null);
  assert.equal(studio.highestShare, 44.6);
  assert.match(studio.status, /without a clear winner/);
  assert.equal(early.variants.length, 3);
  assert.equal(revised.variants.length, 3);
  assert.ok(groups.every(group => group.variants.every(variant => variant.status !== 'draft')));
});

test('metadata audit excludes drafts and explicitly marks uncollected fields', () => {
  const audit = metadataAudit({ title: 'A pint 🍺' }, { variants: [{ title: 'One', webThumbnail: 'assets/a.jpg' }, { title: 'One' }, { title: 'Draft', status: 'draft', webThumbnail: 'assets/b.jpg' }] });
  assert.equal(audit.characters, 8);
  assert.equal(audit.recoveredTitles, 1);
  assert.equal(audit.thumbnailCaptures, 1);
  assert.equal(audit.description, 'Not collected');
  assert.equal(audit.tags, 'Not collected');
});

test('notebook import rejects malformed data and strips unrecognised properties', () => {
  const entry = Object.fromEntries(['id', 'videoId', 'hypothesis', 'change', 'control', 'candidate', 'thumbnail', 'metric', 'decision', 'result', 'status', 'updatedAt'].map(key => [key, '']));
  Object.assign(entry, { id: 'example', status: 'draft', hypothesis: '<script>untrusted content</script>', extra: 'ignored' });
  const clean = validateNotebook({ schema: 'scran-workshop-notebook-v1', entries: [entry] });
  assert.equal(clean[0].hypothesis, entry.hypothesis);
  assert.equal(clean[0].extra, undefined);
  assert.throws(() => validateNotebook({ schema: 'wrong', entries: [] }));
  assert.throws(() => validateNotebook({ schema: 'scran-workshop-notebook-v1', entries: [entry, entry] }));
  assert.throws(() => validateNotebook({ schema: 'scran-workshop-notebook-v1', entries: [{ ...entry, status: 'published' }] }));
  assert.throws(() => validateNotebook({ schema: 'scran-workshop-notebook-v1', entries: [{ ...entry, metric: null }] }));
});

test('notebook rebase preserves concurrent edits and does not restore stale untouched rows', () => {
  const a = { id: 'a', hypothesis: 'old', updatedAt: '1' };
  const b = { id: 'b', hypothesis: 'old', updatedAt: '1' };
  const local = [{ ...a, hypothesis: 'my edit', updatedAt: '2' }, b];
  const remote = [{ ...a, hypothesis: 'team edit', updatedAt: '3' }, { ...b, hypothesis: 'team changed other draft', updatedAt: '3' }];
  const merged = mergeNotebookChanges([a, b], local, remote, () => 'conflict-copy');
  assert.equal(merged.conflicts, 1);
  assert.deepEqual(merged.entries.find(entry => entry.id === 'a'), remote[0]);
  assert.deepEqual(merged.entries.find(entry => entry.id === 'b'), remote[1]);
  assert.equal(merged.entries.find(entry => entry.id === 'conflict-copy').hypothesis, 'my edit');
  assert.equal(merged.remappedIds.a, 'conflict-copy');
});

test('notebook rebase applies safe deletes and preserves remote changes against stale deletion', () => {
  const a = { id: 'a', hypothesis: 'old' };
  const b = { id: 'b', hypothesis: 'old' };
  const changed = { ...b, hypothesis: 'team edit' };
  const merged = mergeNotebookChanges([a, b], [], [a, changed], () => 'copy');
  assert.deepEqual(merged.entries, [changed]);
  assert.equal(merged.conflicts, 1);
  assert.deepEqual(mergeNotebookChanges([a], [a], [], () => 'copy').entries, []);
});

test('notebook import preserves differing IDs and deduplicates identical drafts', () => {
  const a = { id: 'a', hypothesis: 'same' };
  assert.deepEqual(mergeNotebookChanges([], [a], [a], () => 'copy').entries, [a]);
  const merged = mergeNotebookChanges([], [{ ...a, hypothesis: 'different' }], [a], () => 'copy');
  assert.equal(merged.entries.length, 2);
  assert.equal(merged.entries[1].id, 'copy');
  assert.throws(() => mergeNotebookChanges([], [{ ...a, hypothesis: 'different' }], [a], () => 'a'), /unique/);
});
