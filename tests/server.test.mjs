import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { startServer, PRIVATE_ROOT_FILES } from '../scripts/serve.mjs';
import { buildPublicOutput, validateCampaigns, ROOT, PUBLIC_OUTPUT } from '../scripts/build.mjs';
import { studioThumbnailAssets } from '../lib/studio-projection.mjs';

let server;
let origin;
let snapshot;
const social = { schemaVersion: 1, sources: [] };
const authKeys = ['APP_ORIGIN', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'WORKSHOP_ALLOWED_EMAILS', 'NODE_ENV', 'VERCEL'];
let savedEnv;

before(async () => {
  savedEnv = Object.fromEntries(authKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    APP_ORIGIN: 'http://localhost:5186', SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', WORKSHOP_ALLOWED_EMAILS: 'approved@example.test', NODE_ENV: 'test',
  });
  delete process.env.VERCEL;
  delete process.env.SUPABASE_SECRET_KEY;
  snapshot = JSON.parse(await readFile(resolve(ROOT, 'data.json'), 'utf8'));
  await buildPublicOutput();
  server = await startServer({ port: 0, build: false });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(done => server.close(done));
  if (savedEnv) for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(path));
    else result.push(relative(PUBLIC_OUTPUT, path).replaceAll('\\', '/'));
  }
  return result;
}

test('public build contains reviewed Studio thumbnails, but no archive, screenshots or configuration', async () => {
  const files = await filesIn(PUBLIC_OUTPUT);
  const thumbnails = new Set(studioThumbnailAssets(snapshot));
  for (const expected of ['index.html', 'sponsor.html', 'workshop.html', 'login.html', 'connections.html', 'public-report.json', 'lib/sponsor-aggregate.mjs', 'lib/instagram-studio.mjs']) assert.ok(files.includes(expected));
  for (const file of files) {
    assert.doesNotMatch(file, /(?:^|\/)(?:\.env|\.git|\.private|api|integrations|tests|scripts)(?:\/|\.|$)/);
    if (!thumbnails.has(file)) assert.doesNotMatch(file, /history|evidence|ab-tests|image-index|image-assets/);
    assert.equal(PRIVATE_ROOT_FILES.has(file), false, `Private file leaked: ${file}`);
  }
  const report = JSON.parse(await readFile(resolve(PUBLIC_OUTPUT, 'public-report.json'), 'utf8'));
  assert.equal(report.sources[0].metrics.views, snapshot.videos.reduce((sum, video) => sum + video.apiAggregate.views, 0));
  assert.equal(report.sources[0].content.length, snapshot.videos.length);
  assert.doesNotMatch(JSON.stringify(report), /thumbnailPath|webEvidence|variantId|watchTimeSharePct|rocky-brain|openclaw|sb_secret_|user_metadata/);
  const campaigns = JSON.parse(await readFile(resolve(ROOT, 'integrations/campaigns.json'), 'utf8'));
  assert.equal(report.campaigns.length, campaigns.campaigns.length);
  for (const campaign of report.campaigns) {
    assert.equal(campaign.placements.length, campaigns.campaigns.find(row => row.id === campaign.id).placements.length);
  }
});

test('HTTP public pages, current thumbnail and report remain readable without a session', async () => {
  for (const path of ['/', '/sponsor.html', '/workshop.html', '/login.html', '/connections.html', '/api/report', '/api/workshop-data', '/api/connection-status', '/public-report.json', '/lib/sponsor-aggregate.mjs', '/lib/instagram-studio.mjs', '/assets/history-CWBBRExPJ0I-p1.jpg', `/${snapshot.videos[0].thumb}`]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal((await fetch(origin + '/public-report.json')).headers.get('cache-control'), 'no-store');
  const online = await fetch(origin + '/api/report');
  assert.match(online.headers.get('cache-control'), /no-store/);
  assert.equal((await online.json()).storageStatus, 'not-configured');
});

test('HTTP private pages redirect and private data/assets refuse unauthenticated access without caching', async () => {
  for (const path of ['/review-room.html', '/title-table.html', '/thumbnail-lab.html', '/winners-losers.html', '/leaderboard.html']) {
    const response = await fetch(origin + path, { redirect: 'manual' });
    assert.equal(response.status, 303, path);
    assert.match(response.headers.get('location'), /^\/login\.html\?error=/);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
  for (const path of ['/data.json', '/api/workshop-notebook', '/image-index.json', '/image-assets.js', '/app.js', '/assets/evidence-nrVntdSPHgg-p2.jpg']) {
    const response = await fetch(origin + path, { redirect: 'manual' });
    assert.equal(response.status, 401, path);
    assert.equal((await response.json()).error, 'sign_in_required');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
  }
});

test('HTTP root source files and traversal cannot escape the public build', async () => {
  for (const path of ['/.env.local', '/.git/config', '/lib/auth.mjs', '/lib/cloud-store.mjs', '/supabase/provision.sql', '/scripts/build.mjs', '/README.md', '/integrations/campaigns.json', '/integrations/instagram-studio.json', '/docs/YEET.md', '/lib/youtube-oauth.mjs', '/lib/instagram-oauth.mjs', '/lib/tiktok-oauth.mjs', '/lib/instagram-collector.mjs', '/public-dist/index.html', '/assets/%252e%252e/data.json', '/%5c..%5c.env.local']) {
    const response = await fetch(origin + path, { redirect: 'manual' });
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error, 'not_found');
  }
  const polluted = await fetch(origin + '/api/private?path=data.json&path=.env.local');
  assert.equal(polluted.status, 404);
});

test('HTTP auth methods enforce same-origin POST and missing configuration fails closed', async () => {
  const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(response.status, 403);
  const get = await fetch(origin + '/api/auth/login', { redirect: 'manual' });
  assert.equal(get.status, 405);
  const saved = process.env.WORKSHOP_ALLOWED_EMAILS;
  process.env.WORKSHOP_ALLOWED_EMAILS = '';
  try {
    const denied = await fetch(origin + '/api/auth/session');
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).error, 'auth_not_configured');
    assert.equal((await fetch(origin + '/api/workshop-data')).status, 200);
  } finally { process.env.WORKSHOP_ALLOWED_EMAILS = saved; }
});

function campaign(placement = {}) {
  const video = snapshot.videos[0];
  return { schemaVersion: 1, campaigns: [{
    id: 'yeet', name: 'YEET', description: 'Confirmed partnership content.',
    placements: [{ platform: 'youtube-longform', contentId: video.id, placement: 'Confirmed on-screen sponsor mention',
      confirmedAt: '2026-10-20T12:00:00Z', evidenceUrl: `https://www.youtube.com/watch?v=${video.id}`, ...placement }],
  }] };
}
test('campaign export accepts only confirmed known content with official evidence', () => {
  assert.equal(validateCampaigns(campaign(), snapshot, social).campaigns[0].placements.length, 1);
  for (const placement of [
    { platform: 'unknown' }, { contentId: 'missing-content' },
    { confirmedAt: '' }, { confirmedAt: '2026-02-30T12:00:00Z' },
    { evidenceUrl: 'javascript:alert(1)' }, { evidenceUrl: 'http://www.youtube.com/watch?v=' + snapshot.videos[0].id },
    { evidenceUrl: 'https://youtube.com.evil.example/watch?v=' + snapshot.videos[0].id },
    { evidenceUrl: 'https://www.youtube.com/watch?v=another-video' },
    { evidenceUrl: 'https://www.youtube.com/watch?v=' + snapshot.videos[0].id + '&access_token=secret' },
    { placement: '<img src=x>' }, { placement: 'access_token=private' }, { placement: 'C:\\private\\source.json' },
    { secret: 'unexpected field' },
  ]) assert.throws(() => validateCampaigns(campaign(placement), snapshot, social));
  const duplicate = campaign();
  duplicate.campaigns[0].placements.push({ ...duplicate.campaigns[0].placements[0] });
  assert.throws(() => validateCampaigns(duplicate, snapshot, social), /double-count/);
});

test('Vercel publishes only public-dist and explicitly routes every legacy entry through authentication', async () => {
  const vercel = JSON.parse(await readFile(resolve(ROOT, 'vercel.json'), 'utf8'));
  assert.equal(vercel.outputDirectory, 'public-dist');
  assert.equal(vercel.buildCommand, 'npm run build');
  for (const name of PRIVATE_ROOT_FILES) {
    const route = vercel.rewrites.find(route => route.source === `/${name}`);
    assert.equal(route?.destination, `/api/private?path=${name}`);
  }
  assert.equal(vercel.rewrites.find(route => route.source === '/assets/:path*')?.destination, '/api/private?path=assets/:path*');
  assert.ok(vercel.functions['api/private.mjs'].includeFiles.includes('data.json'));
  assert.ok(vercel.functions['api/private.mjs'].includeFiles.includes('assets/**'));
  assert.ok(vercel.functions['api/workshop-data.mjs'].includeFiles.includes('data.json'));
});
