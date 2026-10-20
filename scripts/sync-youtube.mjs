import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectYouTubeEpisodes, commitYouTubeRefresh } from '../lib/youtube-sync.mjs';
import { CollectionError } from '../lib/collectors.mjs';

const help = `Discover public channel uploads and refresh verified full episodes for the
private Workshop using read-only YouTube Data and Analytics APIs.

Usage:
  node --env-file-if-exists=.env.local scripts/sync-youtube.mjs --end YYYY-MM-DD
  node --env-file-if-exists=.env.local scripts/sync-youtube.mjs --end YYYY-MM-DD --write

Default: collect, validate and print a summary; do not change data.json.
--write: archive exact previous bytes and evidence in .private/youtube-imports,
         then atomically replace data.json. No YouTube settings are changed.

End dates must precede today's Pacific date. Actual coverage comes from returned
channel daily activity using the same metric set as each video report.
Shorts/live formats stay separate; unknown formats and unavailable new reports
remain explicit coverage gaps. Existing packaging and Studio history is retained.
Safeguards: 5,000 inventoried uploads; 1,000 confirmed full episodes.
Keep freshly collected OAuth reports out of this public repository's commits.
See docs/YOUTUBE.md for required scopes and the normal hosted workflow.
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
    console.log(`${write ? 'Validated' : 'Dry run validated'} ${result.snapshot.videos.length} public, Analytics-confirmed full episodes for the private Workshop.`);
    const discovery = result.snapshot.youtubeRefresh.discovery;
    console.log(`Discovery ${discovery.status}: ${discovery.publicUploadsCount} public uploads; ${discovery.confirmedLongformCount} confirmed full episodes; ${discovery.includedLongformCount} included.`);
    console.log(`Excluded formats: ${discovery.excludedShortsCount} Shorts, ${discovery.excludedLiveCount} live, ${discovery.excludedOtherCount} other. Gaps: ${discovery.unknownFormatIds.length} unknown format, ${discovery.unreportedLongformIds.length} awaiting reports, ${discovery.pendingPublicationIds.length} after cutoff.`);
    console.log(`Channel activity establishes the processed cutoff ${result.snapshot.apiThrough} (requested ${end}); individual video gaps stay missing. Metadata captured ${result.snapshot.capturedAt}.`);
    console.log('Titles, descriptions, tags and thumbnail URLs were collected separately from historical packaging and Studio evidence.');
    for (const warning of result.warnings) console.log(`Note: ${warning}`);
    if (write) {
      await commitYouTubeRefresh({ root, originalBytes, result });
      console.log('Saved data.json. Exact previous bytes and collection evidence are archived in .private/youtube-imports.');
      console.log('Run npm test and npm run build to validate application boundaries. Do not commit this fresh OAuth reporting snapshot to the public repository.');
    } else {
      console.log('No files changed. Run again with --write to archive and apply a freshly validated collection.');
    }
  } catch (error) {
    // Google bodies, fetch errors, request URLs and credentials are never logged.
    console.error(error instanceof CollectionError ? `${error.code}: ${error.message}` : 'Refresh did not finish cleanly during local file processing. Inspect data.json and the local archive before retrying; no remote YouTube settings were changed.');
    process.exitCode = 1;
  }
}
