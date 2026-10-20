import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectYouTubeEpisodes, commitYouTubeRefresh } from '../lib/youtube-sync.mjs';
import { CollectionError } from '../lib/collectors.mjs';

const help = `Refresh the existing selected full episodes using read-only YouTube APIs.

Usage:
  node --env-file-if-exists=.env.local scripts/sync-youtube.mjs --end YYYY-MM-DD
  node --env-file-if-exists=.env.local scripts/sync-youtube.mjs --end YYYY-MM-DD --write

Default: collect, validate and print a summary; do not change data.json.
--write: archive exact previous bytes and evidence in .private/youtube-imports,
         then atomically replace data.json. No YouTube settings are changed.

End dates must precede today's Pacific date. Actual coverage comes from returned
daily rows, not the requested end. See docs/YOUTUBE.md for required scopes.
`;
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(help);
} else {
  try {
    let end;
    let write = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--end' && !end && args[i + 1] && !args[i + 1].startsWith('--')) end = args[++i];
      else if (args[i] === '--write' && !write) write = true;
      else throw new CollectionError('configuration', 'Unknown or repeated argument. Run with --help for usage.');
    }
    if (!end) throw new CollectionError('configuration', 'An explicit --end YYYY-MM-DD is required. Run with --help for usage.');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const originalBytes = await readFile(new URL('../data.json', import.meta.url));
    const result = await collectYouTubeEpisodes({ snapshot: JSON.parse(originalBytes.toString('utf8')), end });
    console.log(`${write ? 'Validated' : 'Dry run validated'} ${result.snapshot.videos.length} selected full episodes.`);
    console.log(`Analytics through ${result.snapshot.apiThrough} (requested ${end}); metadata captured ${result.snapshot.capturedAt}.`);
    console.log('Titles, descriptions, tags and thumbnail URLs were collected separately from historical packaging and Studio evidence.');
    for (const warning of result.warnings) console.log(`Note: ${warning}`);
    if (write) {
      await commitYouTubeRefresh({ root, originalBytes, result });
      console.log('Saved data.json. Exact previous bytes and collection evidence are archived in .private/youtube-imports.');
      console.log('Run npm test and npm run build to validate the refreshed public projection.');
    } else {
      console.log('No files changed. Run again with --write to archive and apply a freshly validated collection.');
    }
  } catch (error) {
    // Google bodies, fetch errors, request URLs and credentials are never logged.
    console.error(error instanceof CollectionError ? `${error.code}: ${error.message}` : 'Refresh did not finish cleanly during local file processing. Inspect data.json and the local archive before retrying; no remote YouTube settings were changed.');
    process.exitCode = 1;
  }
}
