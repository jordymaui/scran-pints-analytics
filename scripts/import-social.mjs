#!/usr/bin/env node
import { readFile, mkdir, writeFile, rename, unlink, stat, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SOCIAL_SOURCE_IDS, validateSocialImport } from '../lib/social-schema.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_OUTPUT = resolve(ROOT, 'integrations/social.json');
const DEFAULT_ARCHIVE = resolve(ROOT, '.private/social-imports');
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

async function readJson(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_IMPORT_BYTES) throw new Error('Import must be a JSON file of at most 8 MiB.');
  const raw = await readFile(path, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch {
    throw new Error('Import is not valid JSON. No data was written.');
  }
  return { raw, data: validateSocialImport(parsed) };
}

/**
 * Default is validation only. With write, replace the supplied platforms while
 * retaining others, preserve the exact prior file, then publish a completed file.
 */
export async function importSocial(options = {}) {
  if (!options.write) return importUnlocked(options);
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT;
  await mkdir(dirname(outputPath), { recursive: true });
  const lockPath = `${outputPath}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another import is running, or an interrupted import left a lock. Check it before retrying.');
    throw error;
  }
  try {
    return await importUnlocked(options);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function importUnlocked({
  inputPath,
  write = false,
  outputPath = DEFAULT_OUTPUT,
  archiveDir = DEFAULT_ARCHIVE,
} = {}) {
  if (!inputPath) throw new Error('Provide an input JSON file.');
  if (resolve(inputPath) === resolve(outputPath)) throw new Error('The import input must be separate from the published snapshot.');
  const incoming = await readJson(inputPath);
  if (!incoming.data.sources.length) throw new Error('An import must contain at least one source. It cannot clear the dashboard.');
  let previous = null;
  try { previous = await readJson(outputPath); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Existing snapshot could not be validated. ${error.message}`);
  }
  const byId = new Map((previous?.data.sources ?? []).map(source => [source.id, source]));
  for (const source of incoming.data.sources) byId.set(source.id, source);
  const merged = {
    schemaVersion: 1,
    sources: SOCIAL_SOURCE_IDS.filter(id => byId.has(id)).map(id => byId.get(id)),
  };
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;
  const changed = !previous || JSON.stringify(previous.data) !== JSON.stringify(merged);
  const result = {
    written: false,
    changed,
    importedSourceIds: incoming.data.sources.map(source => source.id),
    retainedSourceIds: (previous?.data.sources ?? []).filter(source => !incoming.data.sources.some(next => next.id === source.id)).map(source => source.id),
    archived: false,
    sourceCount: merged.sources.length,
  };
  if (!write || !changed) return result;
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (previous) {
      await mkdir(archiveDir, { recursive: true, mode: 0o700 });
      const archiveName = `social-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
      await writeFile(resolve(archiveDir, archiveName), previous.raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      result.archived = true;
    }
    try {
      await rename(temporaryPath, outputPath);
    } catch (error) {
      if (!previous || process.platform !== 'win32' || !['EPERM', 'EEXIST'].includes(error.code)) throw error;
      // Some Windows filesystems deny rename-over-existing. Preserve a local
      // recovery copy, publish the completed file, and restore on failure.
      const recoveryPath = `${outputPath}.${randomUUID()}.previous`;
      await rename(outputPath, recoveryPath);
      try {
        await rename(temporaryPath, outputPath);
      } catch (publishError) {
        await rename(recoveryPath, outputPath);
        throw publishError;
      }
      await unlink(recoveryPath);
    }
    result.written = true;
    return result;
  } finally {
    await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function args(argv) {
  let inputPath;
  let write = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--write') write = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg === '--input') {
      if (inputPath || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Use one --input file.');
      inputPath = argv[++index];
    } else if (arg.startsWith('-') || inputPath) throw new Error('Usage: node scripts/import-social.mjs input.json [--write]');
    else inputPath = arg;
  }
  return { inputPath, write };
}

async function main() {
  try {
    const options = args(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/import-social.mjs input.json [--write]\nDefault: validate and preview only.\n--write: archive the previous snapshot and merge imported platforms into integrations/social.json.\nOnly curated public-safe schema v1 JSON is accepted; never pass raw exports or credentials.');
      return;
    }
    const result = await importSocial(options);
    console.log(JSON.stringify({
      mode: options.write ? 'write' : 'dry-run',
      ...result,
      message: result.written ? 'Public snapshot updated. Existing platforms not included in the import were retained.'
        : !result.changed ? 'No changes; snapshot already matches.'
          : 'Valid import. No files changed. Review the public-safe values, then use --write to apply.',
    }, null, 2));
  } catch (error) {
    // Validation errors deliberately omit source field values and raw JSON.
    console.error(`Import failed: ${error.code ? 'Unable to read or write a required local file.' : error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
