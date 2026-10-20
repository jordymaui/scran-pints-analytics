# Connect and refresh YouTube online

The normal workflow is hosted on Vercel. No local process or manually copied refresh token is needed.

1. Enable YouTube Data API v3 and YouTube Analytics API in the existing Google Cloud project.
2. Add the exact authorised redirect URI `https://scran-pints-analytics.vercel.app/api/connections/youtube?action=callback` to its Web OAuth client. If the deployment origin changes, the registered URI must match `APP_ORIGIN` exactly, including the query string.
3. Add `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` to the server's Vercel environment. Configure team sign-in, the server-only Supabase storage key and the cloud schema as described in the deployment documentation.
4. Sign in to `/connections.html` with an allowlisted team Google account and choose **Connect YouTube**. Select the owner or Brand Account for Scran & Pints. The callback verifies channel `UCAX4l1JUAymaMHVKiRFzK-A` before saving anything.
5. Choose **Refresh episodes** and **Refresh Shorts** separately. Successful collections are saved to cloud storage and read by the dashboard; each report shows its own coverage and collection date. Existing reports remain available when a refresh fails.

The reporting grant uses signed state, PKCE and HttpOnly flow cookies and revalidates the team session on return. Only the refresh credential is stored in the server-only connection table; access tokens are not returned to the browser or persisted by this flow. The Data and Analytics scopes are read-only. An account with the wrong channel, missing offline access, missing reporting scopes or additional write scopes is rejected. Google sign-in for team identity is a separate flow. [Google server-side OAuth](https://developers.google.com/youtube/data/guides/auth/server-side-web-apps)

The Workshop notebook is also shared online through authenticated `/api/workshop-notebook`. Every save supplies the previously loaded version. A conflicting save receives HTTP 409; the page keeps its edits and can reload/merge, preserving different edits to the same experiment as separate drafts. Private notes are stored in Supabase, not committed to Git. JSON export remains available for an explicit backup; older browser drafts are imported only when the user selects that action.

## Selected episode collection

The executable collector refreshes the full episodes already listed in `data.json`. It currently handles up to 50 selected IDs. It does not discover or silently add videos. Every selected ID must belong to the authorised channel, remain public, and return `VIDEO_ON_DEMAND` in Analytics. A duration guess does not classify Shorts. [Content-type definitions](https://developers.google.com/youtube/analytics/dimensions#creatorContentType)

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

The date is an example; select the intended reporting cutoff each time. The collector derives the latest date actually returned for every selected video and uses that common date for the aggregate queries. It never labels the requested trailing date as collected coverage. Daily gaps stay gaps. YouTube dates are Pacific and can span 23 or 25 hours at daylight-saving changes. [Response availability](https://developers.google.com/youtube/analytics/reference/reports/query#parameters), [reporting dates](https://developers.google.com/youtube/analytics/dimensions#Time_Periods)

## What is collected

Each video gets its own report with `filters=video==VIDEO_ID` and `ids=channel==MINE`:

| Report | Dimensions | Metrics |
| --- | --- | --- |
| Daily activity | `day` | Views, estimated minutes watched, average view duration/percentage, likes, comments, shares, subscribers gained/lost |
| Aggregate activity | None | Same metric set as daily activity |
| Content verification | `creatorContentType` | Views, estimated minutes watched |
| Retention | `elapsedVideoTimeRatio` | Audience watch ratio, relative retention performance |
| Traffic sources | `insightTrafficSourceType` | Views, estimated minutes watched |

These are separate supported report combinations. Traffic sources deliberately exclude average view duration, which is not supported by the channel traffic-source report. Retention uses one video filter. No impressions, CTR, native test shares or revenue are invented from these reports. [Supported channel reports](https://developers.google.com/youtube/analytics/channel_reports)

`videos.list` separately supplies dated title, description, returned tags, thumbnail URLs, duration and public counters in `video.metadata`. Metadata is current at capture; public counters are not historic-window Analytics counts. A missing tags field is recorded as no returned tags and distinguished from an explicitly empty list. Thumbnail URLs are recorded, not downloaded; the image served at a URL may change later. The Workshop exposes these fields under Metadata. [Video resource fields](https://developers.google.com/youtube/data/reference/rest/v3/videos#snippet)

## Preservation and failure behaviour

The original title and local thumbnail remain together as the historical saved package. Existing history, test IDs, test shares, source dates and Studio cards are retained verbatim. Previous refreshed metadata is appended to `metadataHistory`. Analytics totals, daily rows and derived launch windows are refreshed separately.

An HTTP failure, malformed metric, missing selected video, ownership mismatch, uncertain content type, lost previously recorded date, or older returned coverage aborts the whole update. Empty retention or traffic reports preserve the older evidence with its source date and a visible warning; they do not become zero. Retention and traffic have a query end bound but no per-day completeness marker.

With `--write`, `.private/youtube-imports/` receives the exact pre-update `data.json` bytes plus a credential-free request manifest. A temporary file is renamed into place only after validation and a check that `data.json` has not changed during collection. A local lock prevents competing commits. If a process is interrupted, inspect the lock and confirm no sync process remains before manually removing `.private/youtube-sync.lock`.

This command does not publish a deployment, schedule a sync, or change any title, description, tag, thumbnail or test on YouTube.
