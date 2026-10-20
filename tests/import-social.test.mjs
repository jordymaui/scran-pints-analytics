import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSocialImport } from '../lib/social-schema.mjs';
import { importSocial } from '../scripts/import-social.mjs';

function source(id = 'instagram') {
  return {
    id,
    label: id,
    accountLabel: 'Test account',
    status: 'snapshot',
    capturedAt: '2026-10-20T10:00:00Z',
    dateRange: { start: '2026-10-01', end: '2026-10-19', timezone: 'Europe/London' },
    scope: 'Test fixture with period counts; not real channel performance.',
    provenance: { kind: 'platform-export', label: 'Native platform export' },
    metrics: { views: 20, engagedViews: null, watchHours: 0.5, likes: 1, comments: 0, shares: null, followers: 5, subscribersNet: -1 },
    daily: [{ day: '2026-10-02', views: 20 }, { day: '2026-10-01', views: null }],
    content: [],
  };
}

function document(...sources) { return { schemaVersion: 1, sources }; }

function content(id = 'sample') {
  return {
    id, title: 'Test content', url: 'https://www.instagram.com/reel/Abc_123/',
    publishedAt: '2026-10-01T12:00:00Z', thumbnail: null,
    views: 20, likes: 1, comments: 0, shares: null,
  };
}

test('preserves unavailable values, true zero and negative net changes, and sorts days', () => {
  const result = validateSocialImport(document(source()));
  assert.equal(result.sources[0].metrics.shares, null);
  assert.equal(result.sources[0].metrics.comments, 0);
  assert.equal(result.sources[0].metrics.subscribersNet, -1);
  assert.equal(result.sources[0].metrics.watchHours, 0.5);
  assert.deepEqual(result.sources[0].daily.map(row => row.day), ['2026-10-01', '2026-10-02']);
});

test('rejects unknown fields and potential credentials without echoing their contents', () => {
  const fixture = source();
  fixture.accessToken = 'secret-value-not-to-log';
  assert.throws(() => validateSocialImport(document(fixture)), error => {
    assert.match(error.message, /unsupported field/);
    assert.doesNotMatch(error.message, /secret-value-not-to-log/);
    return true;
  });
  const credential = source();
  credential.provenance.label = 'Bearer fake-secret-not-to-log';
  assert.throws(() => validateSocialImport(document(credential)), error => {
    assert.match(error.message, /credential/);
    assert.doesNotMatch(error.message, /fake-secret-not-to-log/);
    return true;
  });
  const localPath = source();
  localPath.provenance.label = 'C:\\Private\\exports\\report.json';
  assert.throws(() => validateSocialImport(document(localPath)), /local file path/);
});

test('rejects unsupported source ids, live claims and wrong metric types', () => {
  assert.throws(() => validateSocialImport(document(source('youtube'))), /not a supported source/);
  const live = source();
  live.status = 'live';
  assert.throws(() => validateSocialImport(document(live)), /must be snapshot/);
  for (const bad of [-1, Infinity, NaN, '20', 1.5]) {
    const fixture = source();
    fixture.metrics.views = bad;
    assert.throws(() => validateSocialImport(document(fixture)));
  }
  const missing = source();
  delete missing.metrics.engagedViews;
  assert.throws(() => validateSocialImport(document(missing)), /is required/);
});

test('rejects impossible dates, reversed windows, unknown zones and duplicate rows', () => {
  const invalidDay = source();
  invalidDay.daily[0].day = '2026-02-30';
  assert.throws(() => validateSocialImport(document(invalidDay)), /real date/);
  const reversed = source();
  reversed.dateRange.start = '2026-10-21';
  assert.throws(() => validateSocialImport(document(reversed)), /on or before/);
  const outOfRange = source();
  outOfRange.daily[0].day = '2026-09-30';
  assert.throws(() => validateSocialImport(document(outOfRange)), /inside the declared/);
  const zone = source();
  zone.dateRange.timezone = 'Mars/Olympus';
  assert.throws(() => validateSocialImport(document(zone)), /recognized IANA/);
  const duplicateDay = source();
  duplicateDay.daily.push({ ...duplicateDay.daily[0] });
  assert.throws(() => validateSocialImport(document(duplicateDay)), /duplicates another day/);
  assert.throws(() => validateSocialImport(document(source(), source())), /duplicates another source/);
  const duplicateContent = source();
  duplicateContent.content = [content(), content()];
  assert.throws(() => validateSocialImport(document(duplicateContent)), /duplicates another content/);
});

test('accepts canonical platform links and rejects unrelated hosts, credentials and redirect links', () => {
  for (const [id, url] of [
    ['instagram', 'https://www.instagram.com/reel/Abc_123/'],
    ['tiktok', 'https://www.tiktok.com/@test_account/video/123456789'],
    ['youtube-shorts', 'https://www.youtube.com/shorts/a4uUoOby5G0'],
    ['youtube-shorts', 'https://www.youtube.com/watch?v=a4uUoOby5G0'],
    ['youtube-shorts', 'https://youtu.be/a4uUoOby5G0'],
  ]) {
    const fixture = source(id);
    fixture.content = [{ ...content(), url }];
    assert.equal(validateSocialImport(document(fixture)).sources[0].content[0].url, url);
  }
  for (const url of [
    'http://www.instagram.com/reel/abc/',
    'https://instagram.com.evil.example/reel/abc/',
    'https://secret@www.instagram.com/reel/abc/',
    'https://www.instagram.com/reel/abc/?access_token=secret',
    'https://www.instagram.com/redirect?url=https://example.com',
    'javascript:alert(1)',
  ]) {
    const fixture = source();
    fixture.content = [{ ...content(), url }];
    assert.throws(() => validateSocialImport(document(fixture)));
  }
});

async function tempFixture(t) {
  // The Windows app sandbox's redirected system temp directory denies rename.
  // Use this repository's ignored private test area to exercise real publication.
  const testRoot = fileURLToPath(new URL('../.private/import-tests/', import.meta.url));
  await mkdir(testRoot, { recursive: true });
  const dir = await mkdtemp(join(testRoot, 'scran-social-test-'));
  t.after(() => {
    const target = resolve(dir);
    assert.equal(dirname(target).toLowerCase(), resolve(testRoot).toLowerCase());
    assert.ok(basename(target).startsWith('scran-social-test-'));
    return rm(target, { recursive: true, force: true });
  });
  const inputPath = join(dir, 'incoming.json');
  const outputPath = join(dir, 'public', 'social.json');
  const archiveDir = join(dir, 'private', 'archive');
  await mkdir(join(dir, 'public'));
  return { dir, inputPath, outputPath, archiveDir };
}

test('dry run makes no writes or archives', async t => {
  const paths = await tempFixture(t);
  const original = `${JSON.stringify(document(source('tiktok')))}\n`;
  await writeFile(paths.outputPath, original);
  await writeFile(paths.inputPath, JSON.stringify(document(source())));
  const result = await importSocial(paths);
  assert.equal(result.written, false);
  assert.equal(result.archived, false);
  assert.deepEqual(result.retainedSourceIds, ['tiktok']);
  assert.equal(await readFile(paths.outputPath, 'utf8'), original);
  await assert.rejects(readdir(paths.archiveDir), { code: 'ENOENT' });
});

test('write archives exact prior bytes and retains unmentioned platforms', async t => {
  const paths = await tempFixture(t);
  const original = `\uFEFF${JSON.stringify(document(source('tiktok')), null, 4)}\r\n`;
  await writeFile(paths.outputPath, original);
  await writeFile(paths.inputPath, JSON.stringify(document(source())));
  const result = await importSocial({ ...paths, write: true });
  assert.equal(result.written, true);
  assert.equal(result.archived, true);
  const output = JSON.parse(await readFile(paths.outputPath, 'utf8'));
  assert.deepEqual(output.sources.map(row => row.id), ['instagram', 'tiktok']);
  const archives = await readdir(paths.archiveDir);
  assert.equal(archives.length, 1);
  assert.equal(await readFile(join(paths.archiveDir, archives[0]), 'utf8'), original);
  const again = await importSocial({ ...paths, write: true });
  assert.equal(again.written, false);
  assert.equal((await readdir(paths.archiveDir)).length, 1);
});

test('a malformed import or malformed previous snapshot cannot overwrite existing data', async t => {
  const paths = await tempFixture(t);
  await writeFile(paths.outputPath, '{ private-invalid: true }');
  await writeFile(paths.inputPath, JSON.stringify(document(source())));
  await assert.rejects(importSocial({ ...paths, write: true }), /Existing snapshot could not be validated/);
  assert.equal(await readFile(paths.outputPath, 'utf8'), '{ private-invalid: true }');
  await writeFile(paths.outputPath, JSON.stringify(document(source('tiktok'))));
  const validPrevious = await readFile(paths.outputPath, 'utf8');
  const fixture = source();
  fixture.metrics.views = -50;
  await writeFile(paths.inputPath, JSON.stringify(document(fixture)));
  await assert.rejects(importSocial({ ...paths, write: true }), /non-negative/);
  assert.equal(await readFile(paths.outputPath, 'utf8'), validPrevious);
  await assert.rejects(readdir(paths.archiveDir), { code: 'ENOENT' });
});

test('an archive failure leaves the existing snapshot untouched', async t => {
  const paths = await tempFixture(t);
  const original = JSON.stringify(document(source('tiktok')));
  await writeFile(paths.outputPath, original);
  await writeFile(paths.inputPath, JSON.stringify(document(source())));
  await mkdir(join(paths.dir, 'private'));
  await writeFile(paths.archiveDir, 'not a directory');
  await assert.rejects(importSocial({ ...paths, write: true }));
  assert.equal(await readFile(paths.outputPath, 'utf8'), original);
  assert.deepEqual(await readdir(join(paths.dir, 'public')), ['social.json']);
});

test('a concurrent import lock prevents lost updates', async t => {
  const paths = await tempFixture(t);
  const original = JSON.stringify(document(source('tiktok')));
  await writeFile(paths.outputPath, original);
  await writeFile(paths.inputPath, JSON.stringify(document(source())));
  await writeFile(`${paths.outputPath}.lock`, '');
  await assert.rejects(importSocial({ ...paths, write: true }), /Another import is running/);
  assert.equal(await readFile(paths.outputPath, 'utf8'), original);
  await assert.rejects(readdir(paths.archiveDir), { code: 'ENOENT' });
});
