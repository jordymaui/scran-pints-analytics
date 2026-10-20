import { readFile, writeFile, copyFile, mkdir, readdir, lstat, realpath, rm } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPublicReport, publicYouTubeThumbnail } from '../lib/report-model.mjs';
import { validateSocialImport } from '../lib/social-schema.mjs';
import { validateCampaigns } from '../lib/campaign-schema.mjs';
import { studioThumbnailAssets } from '../lib/studio-projection.mjs';
export { validateCampaigns } from '../lib/campaign-schema.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PUBLIC_OUTPUT = resolve(ROOT, 'public-dist');
export const PUBLIC_FILES = Object.freeze([
  'index.html', 'sponsor.html', 'dashboard.js', 'dashboard.css', 'brand-tokens.css',
  'controls.js', 'controls.css', 'date-picker.js', 'date-picker.css',
  'refresh.js', 'refresh.css',
  'thumbnail-preview.js',
  'sponsor.js', 'sponsor.css', 'assets/yeet-logo.svg',
  'upload-analytics.js', 'upload-analytics.css',
  'workshop.html', 'workshop.js', 'workshop.css',
  'login.html', 'login.js', 'login.css', 'favicon.png',
  'connections.html', 'connections.js', 'connections.css',
  'privacy.html', 'terms.html', 'notice.css',
  'tiktokppn2P5Ler3fSSZQl38BwTa98y3fnkLNF.txt',
  'lib/report-model.mjs', 'lib/workshop-model.mjs', 'lib/dashboard-metrics.mjs',
  'lib/tiktok-studio.mjs',
  'assets/scran-pints-logo.png', 'assets/optimized/3f526c1560f0-480.webp',
]);
async function safeSource(name) {
  if (!name || /[%\\\u0000-\u001f?#:]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe public asset path.');
  const source = resolve(ROOT, name);
  const rel = relative(ROOT, source);
  if (rel.startsWith('..') || isAbsolute(rel) || (await lstat(source)).isSymbolicLink()) throw new Error('Public assets must be regular repository files.');
  const canonical = await realpath(source);
  const canonicalRelative = relative(await realpath(ROOT), canonical);
  if (canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) throw new Error('Public asset escapes the repository.');
  return source;
}

export async function buildPublicOutput() {
  const [snapshot, socialRaw, campaignsRaw] = await Promise.all([
    readFile(resolve(ROOT, 'data.json'), 'utf8').then(JSON.parse),
    readFile(resolve(ROOT, 'integrations/social.json'), 'utf8').then(JSON.parse),
    readFile(resolve(ROOT, 'integrations/campaigns.json'), 'utf8').then(JSON.parse),
  ]);
  const social = validateSocialImport(socialRaw);
  const campaigns = validateCampaigns(campaignsRaw, snapshot, social);
  const report = buildPublicReport(snapshot, social, campaigns, { allowHistoricalYouTube: true });
  const files = new Set(PUBLIC_FILES);
  for (const asset of studioThumbnailAssets(snapshot)) files.add(asset);
  for (const video of snapshot.videos) {
    if (video.thumb == null && video.discoveredAt) continue;
    if (!publicYouTubeThumbnail(video.thumb)) throw new Error('Public thumbnail must be a saved episode image or official YouTube image URL.');
    if (video.thumb.startsWith('assets/')) files.add(video.thumb);
  }
  for (const entry of await readdir(resolve(ROOT, 'fonts'), { withFileTypes: true })) {
    if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.(?:woff2?|ttf|otf)$/.test(entry.name)) throw new Error('Unexpected file in public fonts.');
    files.add(`fonts/${entry.name}`);
  }
  // Validate every input before replacing the generated output.
  const sources = await Promise.all([...files].map(async name => [name, await safeSource(name)]));
  const repository = await realpath(ROOT);
  if (resolve(PUBLIC_OUTPUT) !== resolve(repository, 'public-dist') || relative(repository, PUBLIC_OUTPUT) !== 'public-dist') {
    throw new Error('Refusing to replace an output directory outside the repository.');
  }
  try {
    const existing = await lstat(PUBLIC_OUTPUT);
    if (!existing.isDirectory() || existing.isSymbolicLink() || await realpath(PUBLIC_OUTPUT) !== PUBLIC_OUTPUT) throw new Error('Unsafe generated output directory.');
    await rm(PUBLIC_OUTPUT, { recursive: true, force: false });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(PUBLIC_OUTPUT);
  for (const [name, source] of sources) {
    const target = resolve(PUBLIC_OUTPUT, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await writeFile(resolve(PUBLIC_OUTPUT, 'public-report.json'), `${JSON.stringify(report)}\n`);
  return { files: files.size + 1, sources: report.sources.length, output: PUBLIC_OUTPUT };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await buildPublicOutput();
    console.log(`Built ${result.files} public files in public-dist; private archive excluded.`);
  } catch (error) {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
