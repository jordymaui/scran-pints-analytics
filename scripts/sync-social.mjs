#!/usr/bin/env node
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { collectSocial } from '../lib/collectors.mjs';
import { importSocial } from './import-social.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export async function syncSocial({
  write = false, sources, env = process.env, fetchImpl = fetch, start, end, capturedAt,
  outputPath = resolve(ROOT, 'integrations/social.json'),
  privateDir = resolve(ROOT, '.private'),
} = {}) {
  const result = await collectSocial({ sources, env, fetchImpl, start, end, capturedAt });
  const summary = {
    mode: write ? 'write' : 'dry-run',
    statuses: result.statuses,
    collected: result.document.sources.map(source => ({
      id: source.id, capturedAt: source.capturedAt, dateRange: source.dateRange,
      availableMetrics: Object.keys(source.metrics).filter(key => source.metrics[key] !== null),
      dailyRows: source.daily.length, contentRows: source.content.length,
    })),
    written: false,
  };
  if (!write || !result.document.sources.length) return summary;
  // This file contains only validated public data, never provider responses/tokens.
  const stagingDir = resolve(privateDir, 'sync-staging');
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const inputPath = resolve(stagingDir, `social-${randomUUID()}.json`);
  try {
    await writeFile(inputPath, `${JSON.stringify(result.document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const imported = await importSocial({
      inputPath, outputPath, write: true,
      archiveDir: resolve(privateDir, 'social-imports'),
    });
    return { ...summary, written: imported.written, archived: imported.archived, retainedSourceIds: imported.retainedSourceIds };
  } finally {
    await unlink(inputPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function parseArgs(argv) {
  const result = {};
  const values = { '--source': 'source', '--start': 'start', '--end': 'end' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--write') result.write = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else if (Object.hasOwn(values, arg) && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      const key = values[arg];
      if (result[key]) throw new Error('Do not repeat command options.');
      result[key] = argv[++index];
    } else throw new Error('Use --source youtube-shorts|instagram|tiktok|all, --start, --end, and optional --write.');
  }
  const source = result.source || 'all';
  if (!['all', 'youtube-shorts', 'instagram', 'tiktok'].includes(source)) throw new Error('Unsupported source.');
  delete result.source;
  if (source !== 'all') result.sources = [source];
  return result;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node --env-file-if-exists=.env.local scripts/sync-social.mjs --source youtube-shorts|instagram|tiktok|all --start YYYY-MM-DD --end YYYY-MM-DD [--write]\nYouTube requires an explicit reporting window. TikTok collects current lifetime counters.\nDefault: read-only collection and validation; no files changed. --write publishes successful sources and retains failed sources.\nCredentials are read only from server environment variables; never pass them as command arguments.');
      return;
    }
    const result = await syncSocial(options);
    console.log(JSON.stringify(result, null, 2));
    if (result.statuses.some(status => status.status !== 'ready')) process.exitCode = 1;
  } catch {
    // Do not echo native fetch/file errors, provider payloads or command input.
    console.error('Sync could not finish. Check server configuration, command options, and private-file access. Existing valid sources were retained.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
