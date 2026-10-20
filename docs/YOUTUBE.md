# Connect and refresh YouTube online

The normal workflow is hosted on Vercel. No local process or manually copied refresh token is needed.

1. Enable YouTube Data API v3 and YouTube Analytics API in the existing Google Cloud project.
2. Add the exact authorised redirect URI `https://scran-pints-analytics.vercel.app/api/connections/youtube?action=callback` to its Web OAuth client. If the deployment origin changes, the registered URI must match `APP_ORIGIN` exactly, including the query string.
3. Add `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` to the server's Vercel environment. Configure team sign-in, the server-only Supabase storage key and the cloud schema as described in the deployment documentation.
4. Sign in to `/connections.html` with an allowlisted team Google account and choose **Connect YouTube**. Select the owner or Brand Account for Scran & Pints. The callback verifies channel `UCAX4l1JUAymaMHVKiRFzK-A` before saving anything.
5. Choose **Refresh episodes** and **Refresh Shorts** separately. Successful authorised collections are saved to private cloud storage for the team Workshop; each report shows its own coverage and collection date. Existing reports remain available when a refresh fails. Public YouTube reporting uses a separate Data API collection and does not publish these OAuth Analytics reports.

The reporting grant uses signed state, PKCE and HttpOnly flow cookies and revalidates the team session on return. Only the refresh credential is stored in the server-only connection table; access tokens are not returned to the browser or persisted by this flow. The Data and Analytics scopes are read-only. An account with the wrong channel, missing offline access, missing reporting scopes or additional write scopes is rejected. Google sign-in for team identity is a separate flow. [Google server-side OAuth](https://developers.google.com/youtube/data/guides/auth/server-side-web-apps)

The Workshop notebook is also shared online through authenticated `/api/workshop-notebook`. Every save supplies the previously loaded version. A conflicting save receives HTTP 409; the page keeps its edits and can reload/merge, preserving different edits to the same experiment as separate drafts. Private notes are stored in Supabase, not committed to Git. JSON export remains available for an explicit backup; older browser drafts are imported only when the user selects that action.

## Public-upload discovery for the private Workshop

The collector discovers the authorised channel's uploads through `channels.list` and its uploads playlist, paginates `playlistItems.list`, and retrieves video metadata in batches of 50. It includes public uploads only. The original five episodes keep their saved titles, local images, Studio cards and complete packaging history. Newly discovered uploads receive their dated metadata and measured Analytics reports without invented episode numbers or historical test results. [Uploads playlist](https://developers.google.com/youtube/data/reference/rest/v3/channels#contentDetails.relatedPlaylists.uploads), [playlist pagination](https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/list)

Format comes from the Analytics `creatorContentType` dimension. Only an unambiguous `VIDEO_ON_DEMAND` result enters the full-episode view. Shorts, live streams and Stories are counted separately. Mixed, missing, `UNSPECIFIED` or unrecognised format results remain explicitly unclassified; duration, title and thumbnail shape never substitute for format evidence. Multi-video filters with a `video` dimension allow batched checks. [Content-type definitions](https://developers.google.com/youtube/analytics/dimensions#creatorContentType), [multi-video report filters](https://developers.google.com/youtube/analytics/reference/reports/query#filters)

`youtubeRefresh.discovery` records the public inventory count, confirmed and included full episodes, excluded formats, unclassified IDs, uploads awaiting report data and publications after the requested reporting cutoff. Coverage is labelled partial while those gaps remain. New uploads without daily or aggregate data are excluded visibly, not counted as zero. Format data begins in 2019; a video with no usable format activity may remain unclassified.

The current safeguards stop the entire collection above 5,000 inventoried uploads or 1,000 confirmed full episodes, on incomplete pagination, or when the hosted job deadline is exceeded. They retain the previous snapshot rather than claim a truncated inventory is complete. Larger catalogs require a resumable collection design before raising these limits.

## Reporting permissions

Google sign-in for the Workshop proves identity. It does not grant access to YouTube reporting. Enable YouTube Data API v3 and YouTube Analytics API in the existing Google Cloud project, then authorise the channel owner with **only**:

- `https://www.googleapis.com/auth/youtube.readonly`
- `https://www.googleapis.com/auth/yt-analytics.readonly`

The online consent flow stores its offline grant in the server-only Supabase connection table. `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` remain Vercel secrets. Do not put the refresh grant in a client form, static asset or Git.

No monetary or write scopes are needed. [Analytics authorisation](https://developers.google.com/youtube/analytics/reference/reports/query#authorization)

## Optional developer-only command

The same collector can be run as an explicit dry run during development. This is not required for the hosted workflow. For this command only, provide credentials via server-side environment variables:

```dotenv
YOUTUBE_CLIENT_ID=your-existing-google-oauth-client-id
YOUTUBE_CLIENT_SECRET=your-existing-google-oauth-client-secret
YOUTUBE_REFRESH_TOKEN=your-channel-owner-refresh-token
```

For a short manual session, `YOUTUBE_ACCESS_TOKEN` can be used instead and takes precedence. Never commit values or include them in an export.

### Run and review a local dry run

From the repository root, choose an explicit end before today's **Pacific** date:

```powershell
node --env-file-if-exists=.env.local scripts/sync-youtube.mjs --end 2026-10-19
```

This default dry run makes read-only API requests and prints a compact result. It does not write files. After reviewing that result, run a fresh collection with `--write`:

```powershell
node --env-file-if-exists=.env.local scripts/sync-youtube.mjs --end 2026-10-19 --write
npm test
npm run build
```

The date is an example; select the intended reporting cutoff each time. The collector derives its processed cutoff from the latest returned channel-level daily row using the exact activity metric set requested for each video. It then bounds per-video daily and aggregate queries by that date, recording `coverageBasis: channel-daily-same-metrics`. Channel values are used only as an availability signal and are never added to episode totals. A quiet video's missing latest-day row does not hold the entire report behind; its individual daily coverage and gaps remain visible. The requested trailing date is never presented as collected coverage. YouTube dates are Pacific and can span 23 or 25 hours at daylight-saving changes. [Response availability](https://developers.google.com/youtube/analytics/reference/reports/query#parameters), [reporting dates](https://developers.google.com/youtube/analytics/dimensions#Time_Periods)

## What is collected

Each included video's activity, retention and traffic reports use `filters=video==VIDEO_ID` and `ids=channel==MINE`. Format discovery uses explicit batches of video IDs; channel availability has no video filter:

| Report | Dimensions | Metrics |
| --- | --- | --- |
| Daily activity | `day` | Views, estimated minutes watched, average view duration/percentage, likes, comments, shares, subscribers gained/lost |
| Aggregate activity | None | Same metric set as daily activity |
| Channel availability | `day`, no video filter | Same metric set as daily activity; values used only to find the processed date |
| Content verification | `video,creatorContentType` for multi-ID batches; `creatorContentType` for one ID | Views, estimated minutes watched |
| Retention | `elapsedVideoTimeRatio` | Audience watch ratio, relative retention performance |
| Traffic sources | `insightTrafficSourceType` | Views, estimated minutes watched |

These are separate supported report combinations. Traffic sources deliberately exclude average view duration, which is not supported by the channel traffic-source report. Retention uses one video filter. No impressions, CTR, native test shares or revenue are invented from these reports. [Supported channel reports](https://developers.google.com/youtube/analytics/channel_reports)

`videos.list` separately supplies dated title, description, returned tags, thumbnail URLs, duration and public counters in `video.metadata`. Metadata is current at capture; public counters are not historic-window Analytics counts. A missing tags field is recorded as no returned tags and distinguished from an explicitly empty list. Thumbnail URLs are recorded, not downloaded; the image served at a URL may change later. The Workshop exposes these fields under Metadata. [Video resource fields](https://developers.google.com/youtube/data/reference/rest/v3/videos#snippet)

## Preservation and failure behaviour

The original title and local thumbnail remain together as the historical saved package. Existing history, test IDs, test shares, source dates and Studio cards are retained verbatim. Previous refreshed metadata is appended to `metadataHistory`. Analytics totals, daily rows and derived launch windows are refreshed separately. Discovered uploads use dated title metadata and official hosted thumbnail URLs, which can change after capture; missing Studio, native test and retention evidence remains unavailable.

An HTTP failure, malformed metric, ownership mismatch, lost previously recorded date or older returned coverage aborts the whole update. A previously included video disappearing from the uploads inventory, becoming unavailable or non-public, or losing its verified full-episode format also aborts the update for review. A newly discovered video's unknown format or missing reporting data instead becomes an explicit partial-coverage exclusion. Empty retention or traffic reports preserve older evidence where it exists, with its source date and a visible warning; a new upload's missing report remains unavailable. Retention and traffic have a query end bound but no per-day completeness marker.

With `--write`, `.private/youtube-imports/` receives the exact pre-update `data.json` bytes plus a credential-free request manifest. A temporary file is renamed into place only after validation and a check that `data.json` has not changed during collection. A local lock prevents competing commits. If a process is interrupted, inspect the lock and confirm no sync process remains before manually removing `.private/youtube-sync.lock`.

The optional command writes a development snapshot, not the hosted cloud report. Keep newly collected OAuth reports, including the refreshed `data.json`, out of commits to this public repository; production stores them in private Supabase tables. This command does not publish a deployment, schedule a sync, or change any title, description, tag, thumbnail or test on YouTube.
