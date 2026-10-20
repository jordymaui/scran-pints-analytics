import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { sendStudioReport } from '../api/workshop-data.mjs';

const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } });
const report = { rows: Array.from({ length: 12000 }, (_, index) => ({ day: '2026-10-18', videoId: 'abcdefghijk', views: index, impressions: index * 4 })) };
test('large Studio reports are compressed without dropping or changing any row', () => {
  const res = response();
  sendStudioReport({ headers: { 'accept-encoding': 'gzip, deflate, br' } }, res, report);
  assert.equal(res.headers['Content-Encoding'], 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(res.body).toString()), report);
  assert.ok(res.body.length < Buffer.byteLength(JSON.stringify(report)) / 2);
  assert.match(res.headers.Vary, /Accept-Encoding/);
  assert.match(res.headers['Cache-Control'], /no-store/);
});
test('clients that omit or refuse gzip receive unchanged JSON', () => {
  for (const encoding of ['', 'br, gzip;q=0']) {
    const res = response();
    sendStudioReport({ headers: { 'accept-encoding': encoding } }, res, report);
    assert.equal(res.headers['Content-Encoding'], undefined);
    assert.deepEqual(JSON.parse(res.body), report);
  }
});
