import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadPublicReport, readBundledInputs } from '../lib/cloud-report.mjs';
import { instagramNativeFixture } from './fixtures/instagram-native.mjs';

const wrapper = capture => ({ schemaVersion: 1, id: 'instagram', kind: 'instagram-native-capture',
  capturedAt: capture.capturedAt, manualCapture: capture });

test('hosted reports read a reviewed private Instagram capture without manufacturing an OAuth grant', async () => {
  const bundled = await readBundledInputs();
  const capture = instagramNativeFixture();
  let writes = 0;
  const report = await loadPublicReport({ bundled, storeFactory: () => ({
    loadSnapshot: async source => source === 'instagram' ? { payload: wrapper(capture), capturedAt: capture.capturedAt } : null,
    getStatuses: async () => [{ id: 'instagram', connected: false,
      lastSync: { status: 'not-connected', errorCode: 'authorization-required', completedAt: '2026-01-15T07:00:00Z' } }],
    saveSnapshot: async () => { writes++; },
  }) });
  const instagram = report.sources.find(row => row.id === 'instagram');
  assert.equal(instagram.status, 'snapshot');
  assert.equal(instagram.snapshotOrigin, 'manual-capture');
  assert.equal(instagram.provenance.kind, 'manual-browser');
  assert.equal(instagram.metrics.followers, capture.followers);
  assert.equal(instagram.metrics.views, null);
  assert.equal(instagram.manualCapture.windows[2].instagramViews, capture.windows[2].instagramViews);
  assert.equal(instagram.syncStatus.status, 'not-connected');
  assert.equal(writes, 0);
  assert.doesNotMatch(JSON.stringify(report), /User avatar|accessToken|refreshToken|account-30-days/);
});

test('private capture payloads are absent from repository inputs and static deployment includes', async () => {
  const bundled = await readBundledInputs();
  assert.equal(bundled.instagramCapture, undefined);
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const path of ['api/report.mjs', 'api/workshop-data.mjs']) {
    assert.equal(config.functions[path].includeFiles.includes('instagram-studio.json'), false);
  }
});

test('unavailable private storage cannot be replaced with invented bundled Instagram evidence', async () => {
  const report = await loadPublicReport({ storeFactory: () => { throw Object.assign(Error('unavailable'), { code: 'unavailable' }); } });
  assert.equal(report.storageStatus, 'unavailable');
  const instagram = report.sources.find(row => row.id === 'instagram');
  assert.equal(instagram.status, 'not-connected');
  assert.equal(instagram.manualCapture, undefined);
});

test('malformed private wrappers and mismatched capture dates cannot publish arbitrary fields', async () => {
  const capture = instagramNativeFixture();
  for (const payload of [{ ...wrapper(capture), refreshToken: 'PRIVATE_TEST_ONLY' },
    { ...wrapper(capture), capturedAt: '2026-01-16T12:00:00Z' }]) {
    const report = await loadPublicReport({ storeFactory: () => ({
      loadSnapshot: async source => source === 'instagram' ? { payload, capturedAt: capture.capturedAt } : null,
      getStatuses: async () => [],
    }) });
    assert.equal(report.storageStatus, 'unavailable');
    assert.equal(report.sources.find(row => row.id === 'instagram').manualCapture, undefined);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TEST_ONLY/);
  }
});

