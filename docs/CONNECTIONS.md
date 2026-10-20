# Connecting the source reports

The deployed service refreshes reports on Vercel and stores connections, successful snapshots, history, and run status privately in Supabase. No running laptop or local script is required. Public reporting includes independently collected YouTube counters and selected owner-authorized Analytics. The existing published repository snapshot is a dated historical fallback. Read-only collectors support YouTube, Instagram Login and TikTok Display API. A prepared integration is not a verified account connection: Connections shows the actual stored grants and report dates. No platform credentials belong in this repository, a browser bundle, a public JSON file, or a sponsor link.

## Instagram and TikTok hosted setup

- Instagram supports a Creator or Business professional account. Create a Meta app for Instagram Login, set its exact callback to `https://scran-pints-analytics.vercel.app/api/connections/instagram`, and request only `instagram_business_basic` and `instagram_business_manage_insights`. Standard Access supports eligible accounts you own/manage and add to the app; other accounts require Advanced Access. Add `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET` and the configured `INSTAGRAM_API_VERSION` to Vercel server configuration. Use Connect Instagram from the team controls. The callback verifies `@scranpints`, saves the long-lived token privately and renews it server-side before expiry.
- TikTok permits individual app ownership. Use its [individual email signup](https://developers.tiktok.com/signup); the organization/mini-app verification path is separate. Add Login Kit and the read-only scopes `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`. Set the exact callback to `https://scran-pints-analytics.vercel.app/api/connections/tiktok` without query parameters. Configure the verified website, privacy and terms URLs. Sandbox access is for demonstrating the connection with a target account; production use requires TikTok's app review. Put the matching environment's `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` only in Vercel. Connect TikTok verifies the `scranpints` username and stores rotating grants in private storage.
- After the first successful collection, Instagram/TikTok appear on the public dashboard and YEET page. Each platform retains its own scope and dates. YEET's anonymous Refresh invokes fixed server-side reporting for configured Scran & Pints accounts, with per-provider leases and a five-minute cooldown. Account changes still require a team session.
- Instagram retrieves all returned media metadata, available lifetime counters, current followers, native account daily views (initial backfill limited to retained 90 days) and available follower demographic buckets. Missing/expired insights remain unavailable. Later runs preserve saved daily history with a seven-day overlap. TikTok Display supplies lifetime public-video counters and current followers, not daily history, watch time or demographics.

Official references: [Meta Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/), [Instagram insights](https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights/), [TikTok individual app ownership](https://developers.tiktok.com/docs/en/getting-started-create-an-app), [TikTok Display API](https://developers.tiktok.com/doc/display-api-get-started/).

The owner reports existing YouTube API access and has Viewstats Pro. The inspected main site's Google configuration supports identity sign-in; no YouTube reporting OAuth grant was found there. Reuse an existing Google project if available, then supply or obtain the actual channel authorization. Instagram and TikTok application setup starts from scratch. A signed-in browser or a Pro browser extension is not evidence that a server has API access.

## TikTok Studio imports

TikTok Studio supplements the connected Display API with separately dated reports. From Studio's Overview, Followers and Viewers tabs, choose the required period and download CSV. Extract the ZIP files and select `Overview.csv`, `FollowerHistory.csv` and `Viewers.csv` in Connections. `FollowerGender.csv` and `FollowerTopTerritories.csv` add follower demographics. Confirm the exact date windows shown by each report: exported day/month labels omit the year, and Overview/Followers can finish on a different date from Viewers.

Connections parses and previews the CSV files in the browser. Only a validated, selected report is sent to authenticated `POST /api/sync?source=tiktok` with operation `studio-import`; raw CSV files are not published. Native percentages and source dates are retained. Missing or `undefined` cells stay unavailable. Daily viewers are not summed into period unique viewers, and reported follower changes are not recalculated from follower stocks.

The Studio supplement is stored inside the existing private TikTok snapshot, under the same collection lease. Updating it preserves the Display API counters and their original collection timestamp. Subsequent API refreshes preserve the supplement, and the existing snapshot archive retains prior versions. Public Refresh updates the connected API counters; it does not fetch a fresh Studio export. Screen-captured Studio audience or traffic summaries retain their own dates and provenance.

## Connect and refresh online

1. Provision the private tables and functions from `supabase/provision.sql` in the existing Supabase project. Set the server environment in the existing Vercel project, using `.env.example` and the deployment documentation. Keep the Supabase server secret separate from the publishable Auth key.
2. Configure the team's Google sign-in and exact allowed email addresses. This protects the workspace; it does not itself authorize YouTube analytics.
3. Set `YOUTUBE_PUBLIC_API_KEY` to a server-only Google key restricted to YouTube Data API v3. Public channel counters can refresh before owner consent. Configure a Google OAuth web client with the deployed YouTube callback, then authorize the channel from the team's Connections screen. The provider grant is stored privately. Only read-only YouTube scopes are requested.
4. Create and obtain approval for the required TikTok and Meta applications. Authorization and reporting capabilities differ by product; the availability table below is the authority on what the implemented adapters collect. Creating an application is not the same as receiving reporting access.
5. Use **Refresh YouTube** when the public key is configured, or connect the owner to also refresh private Analytics. Other platforms require authorization. The browser sends a same-origin, team-authenticated `POST /api/sync?source=youtube` (or `youtube-shorts`, `instagram`, `tiktok`). It never sends platform tokens. Unconnected or incomplete integrations show a setup status and retain any previous successful report.

Vercel cron calls `GET /api/sync?source=...` with its `Authorization: Bearer CRON_SECRET` header. Generate a long random `CRON_SECRET` and store it only in the production server environment. Each source has its own daily job. The scheduled YouTube window ends three Pacific calendar days before execution to allow processing; Shorts requests the preceding 28 days, while private long-form video reports refresh from each video's publication date. Public Data API counters are a separate current observation, with no reporting-period or daily-growth claim. Returned coverage, not the requested end date, determines the displayed freshness.

| Source | Implemented refresh | Remaining dependency |
| --- | --- | --- |
| YouTube public channel | API-key `channels.list` native view/subscriber/video counters and paginated uploads with `videos.list` views, likes and comments | Server-only Data API key. Includes all formats; no duration-based Shorts classification, watch time or inferred daily growth. |
| YouTube private workshop | Paginated public upload discovery, authoritative content-type classification, metadata and supported activity, daily, traffic and retention reports | Approved read-only channel grant. Unclassified uploads, reports without usable data and uploads after the reporting cutoff remain explicit gaps; native Studio experiments stay separately dated evidence. |
| YouTube private Shorts | Paginated daily activity split by the API's exact `SHORTS` content type | Same channel grant; individual Short metadata is not yet collected. |
| TikTok Display | All returned public video counters and current followers; server refresh-token rotation | Approved app/scopes and owner consent. No watch-time, completion or native daily analytics from this product. |
| TikTok Accounts | Documented setup path for detailed owned-account insights | Separate access application, approved product/scopes, verified account response and adapter implementation. |
| Instagram Insights | All returned media metadata, available lifetime counters, native daily views and follower demographics | Creator/Business account, configured Meta app, matching API version, own-account access or approved scopes, and owner consent. |

Every run acquires a private lease; episodes and Shorts share the YouTube lease. A successful validated snapshot replaces the latest version atomically and archives the previous one. Failed collection, expired authorization, unavailable metrics, incomplete pagination, or an older result keeps the previous successful data. Safe run metadata records the outcome without raw provider error bodies or credentials. The cloud runtime rotates TikTok refresh tokens and persists replacements before requesting reports. [TikTok token lifecycle](https://developers.tiktok.com/docs/en/oauth-user-access-token-management).

Public YouTube reporting uses `channels.list` statistics directly, including all formats, and separately lists returned public uploads. Subscriber counts are rounded down to three significant figures by YouTube; hidden counts remain unavailable. Headline views are never recomputed from the video list, and no daily series or growth rate is invented from lifetime counters. A partial upload inventory does not change the native channel counter. Each video uses the current public title and official hosted thumbnail, which can subsequently change. [Channel statistics](https://developers.google.com/youtube/v3/docs/channels#statistics), [Video statistics](https://developers.google.com/youtube/v3/docs/videos#statistics), [Uploads pagination](https://developers.google.com/youtube/v3/docs/playlistItems/list).

The same cloud job independently attempts private Analytics only when a grant exists. Public success and private success retain separate capture times. Failure of one keeps its previous snapshot and does not discard the other successful result. The public API and exports never fall back to fresh authorized Analytics; without a valid public capture they show only the explicitly published historical repository baseline. Authorized Shorts reports never enter public output; the public Shorts tab explains that Shorts are already included in channel counters and a separate public breakdown is unavailable.

Within the private workshop, the five historical episode records remain the baseline until discovery succeeds. Discovery adds public videos classified by Analytics as `VIDEO_ON_DEMAND`, with incomplete format/report coverage explicitly recorded. Historical packaging evidence keeps its original capture date. This authorized detail is restricted to the authorizer and expressly approved team or agent access under [YouTube developer policies](https://developers.google.com/youtube/terms/developer-policies#e.-handling-youtube-data).

With Fluid Compute, Vercel Hobby supports a 300-second function duration and daily cron jobs; cron execution may be delayed within its scheduled hour. The service bounds total network work below that limit and uses a lease for duplicate/overlapping execution. Confirm the deployment's plan supports its commercial use and required refresh frequency. A schedule configuration does not prove a deployment or completed live run. [Function duration](https://vercel.com/docs/functions/configuring-functions/duration), [Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Cron behavior and security](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

## Optional developer collectors

These commands are for development and one-off validation. Production runs on Vercel and persists to Supabase.

Use Node 22 or later and set secrets only in the deployment's server environment or ignored `.env.local`. Never put token values on the command line.

| Environment variable | Purpose |
| --- | --- |
| `YOUTUBE_PUBLIC_API_KEY` | Server-only key restricted to YouTube Data API v3; public reporting requires no owner OAuth grant. |
| `YOUTUBE_ACCESS_TOKEN` | A current access token with `yt-analytics.readonly`; useful for a connection check. |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` | Alternative to the access token: the collector exchanges this existing grant for an access token on the server. |
| `YOUTUBE_CHANNEL_ID` | Optional channel ID; defaults to the authorized channel (`MINE`). |
| `YOUTUBE_ACCOUNT_LABEL` | Optional curated public account name. |
| `TIKTOK_ACCESS_TOKEN` | Current owner-authorized token with approved `user.info.basic`, `user.info.stats`, and `video.list` access. |
| `TIKTOK_ACCOUNT_LABEL` | Optional curated public account name; defaults to the API's display name. |

```sh
node --env-file-if-exists=.env.local scripts/sync-social.mjs --source youtube-shorts --start 2026-10-01 --end 2026-10-17
node --env-file-if-exists=.env.local scripts/sync-social.mjs --source tiktok
node --env-file-if-exists=.env.local scripts/sync-social.mjs --source all --start 2026-10-01 --end 2026-10-17 --write
node --test tests/collectors.test.mjs
```

These commands call only documented read/report endpoints, plus Google's token refresh endpoint where configured. The default collects and validates without changing files. Output contains connection status, windows, available metric names, and row counts; it contains no tokens or raw provider error bodies.

`--write` passes successful sources through the importer and archives their previous source snapshot. Failed, unconfigured, or blocked sources keep their previous data. The command exits nonzero when any requested source did not succeed, including a partial run. An absent Shorts report does not overwrite real prior data with invented zeros. Imported or collected authorized Shorts data stays excluded from public output.

The Shorts adapter pages through `day,creatorContentType` Analytics rows, locates fields by returned column names, selects only `SHORTS`, and sums additive metrics. It preserves missing dates and annotates requested versus returned coverage. It does not collect individual Short metadata or infer format from duration. TikTok pages through every returned public video, records current followers and lifetime counters, and emits no fabricated daily series or watch time. Its observation date must not be treated as a day of earned views.

Instagram uses the hosted Instagram Login collector described above. Without an authorized account it returns an explicit setup status; it does not fabricate an empty report.

The optional `sync-social.mjs` command accepts a current TikTok access token; token renewal is implemented in the cloud service, not this local command.

## What each connection can supply

| Source | Read-only collection route | Important distinction |
| --- | --- | --- |
| YouTube videos and Shorts | YouTube Data API for current metadata; Analytics API for period reports; Reporting API for thumbnail reach reports | Separate `VIDEO_ON_DEMAND`, `SHORTS`, and `LIVE_STREAM`. Do not add Shorts to an all-format YouTube total. |
| Instagram | Instagram Platform Insights for an owned professional account | Account insights and media insights have different metric compatibility, windows, and aggregation. Probe the granted API version rather than asking every media type for every metric. |
| TikTok, basic coverage | Display API, user-authorized | Public video views, likes, comments, shares, plus account counts. These are current counters, not historical daily analytics. |
| TikTok, deeper coverage | Approved Organic Accounts API in TikTok API for Business | Separate application/access route. Verify the actual approved account capabilities before promising watch time, completion, reach, or audience reports. |
| Viewstats Pro | Owner's research workspace and supported exports, if available | Useful for competitor, outlier, title, and thumbnail research. It is not the source of Scran & Pints' private watch-time/retention data or proof of native test results. |

## YouTube: reuse the existing read-only connection

1. Identify the existing Google Cloud project, authorized channel ID, OAuth client configuration, and the service that securely stores its refresh token. Check enabled YouTube Data, Analytics, and Reporting APIs without replacing an existing grant.
2. Use `https://www.googleapis.com/auth/yt-analytics.readonly` for user-activity reports. Where authenticated Data API metadata is needed, use `https://www.googleapis.com/auth/youtube.readonly`. Monetary scope is optional and unnecessary for the public/sponsor report. Do not request write scopes for this work.
3. Query the owned channel with `ids=channel==MINE`. Retrieve daily reports grouped by `day,creatorContentType`; use `views`, `engagedViews`, `estimatedMinutesWatched`, `averageViewDuration`, and `averageViewPercentage` in supported report combinations. Separate queries cover engagement/subscribers, traffic sources, demographics, and per-video retention; the API does not allow an arbitrary combination of every dimension and metric. [Channel reports](https://developers.google.com/youtube/analytics/channel_reports), [OAuth authorization](https://developers.google.com/youtube/reporting/guides/authorization).
4. Fetch current `snippet.title`, `snippet.description`, `snippet.tags`, `snippet.thumbnails`, `contentDetails.duration`, and video statistics through `videos.list`. The Data API exposes current metadata, not a full historical timeline of every title and thumbnail. Record your own approved packaging changes as dated workshop records; do not infer past variants from the current title. [Video resource](https://developers.google.com/youtube/data/reference/rest/v3/videos).
5. Create Reporting API jobs for `channel_reach_basic_a1` (date, channel, video) and, if needed, `channel_reach_combined_a1` (also traffic/device dimensions). These expose `video_thumbnail_impressions` and `video_thumbnail_impressions_ctr`. Preserve report IDs and revision dates during ingestion. CTR belongs to the whole reported video/cohort, not individual A/B variants. [Reach reports](https://developers.google.com/youtube/reporting/v1/reports/channel_reports#reach-reports).

Analytics reporting typically lags 48–72 hours, and the returned end date can be earlier than requested. Store the actual complete-through date; do not label the last two days as zero. Low-volume dimensions can be suppressed, and channel aggregates can include deleted videos that are absent from video-level reports. Parse returned column headers instead of relying on column order. Refresh or remove stored Data API resource metadata within the documented 30-day requirement. [Analytics data model](https://developers.google.com/youtube/analytics/data_model).

Views need a definition version. Shorts counting changed on 31 March 2025, and the August 2026 documentation aligns public views across all formats to playback beginning. Keep `views` and `engagedViews` separate and annotate comparisons spanning methodology changes. The current API definition of engaged views refers to playback continuing past the first frame or a deliberate click/tap to play. [Revision history](https://developers.google.com/youtube/analytics/revision_history), [Metric definitions](https://developers.google.com/youtube/analytics/metrics).

Native title/thumbnail tests require a separate evidence record. YouTube's help describes tests in Studio, with results based on watch-time share and possible inconclusive outcomes. No native test-results endpoint was found in the documented Data/Analytics interfaces reviewed here, so preserve owner-provided Studio results until a supported export/API is verified. Combined title/thumbnail tests establish evidence for the pairing; whole-video CTR cannot identify which element caused an improvement. Tests are unavailable for Shorts. [YouTube A/B testing](https://support.google.com/youtube/answer/16391400?hl=en).

## Instagram: professional account authorization

Use an owned Business or Creator account. Choose one login route and keep its token type, host, and permission set together:

- Instagram Login: `graph.instagram.com`, with `instagram_business_basic` and `instagram_business_manage_insights`.
- Facebook Login: `graph.facebook.com`, with `instagram_basic`, `instagram_manage_insights`, and the relevant Page access such as `pages_read_engagement`; verify the professional account's linked Page and any additional requirements for the specific grant.

Configure the redirect URL on the server, authorize the actual Scran & Pints account, and first test identity and one small insights request. Then query `/{instagram-account-id}/insights` and `/{instagram-media-id}/insights`. Standard/advanced access and review requirements depend on whether the app serves its own managed accounts or other users.

The adapter should discover compatible account/media fields for the pinned API version: views, reach, likes, comments, shares, saves, interactions, and available Reel watch-time fields. Keep media product types and organic/paid treatment explicit. Do not silently substitute obsolete `plays`/`impressions` names for `views`. Missing/suppressed metrics remain `null`; do not turn empty responses into zero. Store successful daily results for progression instead of assuming unlimited backfill.

Official references: [Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/), [Insights guide](https://developers.facebook.com/docs/instagram-platform/insights), [Media insights](https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights), [User insights](https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights/). Meta's reference pages rate-limited this documentation review on 20 October 2026; confirm the exact live metric/version matrix and permissions when the account is connected. These are setup requirements, not a claim that this project has an approved Meta application.

## TikTok: select the route with the required coverage

Display API is a workable first connection for public counters. It needs approved Login Kit/Display access, approved scopes, and the account owner's grant. Request `user.info.basic`, `video.list`, and `user.info.stats` for follower/statistical counts; request `user.info.profile` only if profile fields are needed. App approval does not replace the owner's consent. [Getting started](https://developers.tiktok.com/docs/en/display-api-get-started), [Scopes](https://developers.tiktok.com/docs/en/tiktok-api-scopes).

Collect `/v2/user/info/`, paginated `/v2/video/list/`, and `/v2/video/query/` for refreshes. Supported video counters include `view_count`, `like_count`, `comment_count`, and `share_count`; account statistics include `follower_count`. The documented Display video object has no watch-time, retention, completion, or demographics fields. Its cover image URL expires after six hours, so do not use it as a permanent thumbnail asset. [Video object](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-object), [User information](https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info), [Video listing](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-list).

Capture counters daily in private storage. A difference between snapshots is a measured counter change, potentially including revisions, deletions, or removals; it is not a native historical report. Do not claim a retrospective 28-day view total from today's lifetime video counters. Use a clearly scoped export until native period reporting is connected.

For the requested deeper reports, pursue the Organic Accounts API rather than treating Display as the finished integration. TikTok's current overview covers owned Business and Personal accounts and permits profile/post insight analysis. Since 20 March 2026, developers must complete its Accounts API access application before submitting a new app or requesting additional TikTok Accounts scopes. Request only the insight capabilities required here; moderation, publishing, and ad authorization are outside this project's collection scope. [Accounts API overview](https://business-api.tiktok.com/portal/docs/accounts-api-overview/v1.3).

TikTok's March 2025 DMA report says approved Accounts API developers can access data free of charge, subject to request limits, and that its Business Analytics metrics became available through the API on 6 January 2025. This establishes the richer product path; it does not grant this project access or establish coverage for a particular approved account. Hosting and any optional third-party tools have their own costs. [TikTok's report, pages 34–35](https://sf16-va.tiktokcdn.com/obj/eden-va2/uhsllrta/DMA/2025%20DMA/Bytedance%20DMA%20Compliance%20Report%20Public%20Overview_2025.pdf#page=35).

The official Business API collection demonstrates video fields including total/average time watched, reach, full-video-watched rate, and audience countries. Before implementing this adapter, verify the approved authentication flow, current endpoint version, pagination, reporting windows, latency, and the units/availability of each requested field using the account's real response. Store its product identifier separately from a Display grant; the token endpoints and scope models must not be interchanged. Keep rate/percentage values separate from additive totals in the model. [TikTok's Business video request](https://www.postman.com/tiktok/tiktok-api-for-business/request/7u65xdl/business-video-list), [Accounts guides](https://business-api.tiktok.com/gateway/docs/index?doc_id=1737565048641538&language=ENGLISH). Marketing/Ads reports are separate from organic content reporting.

## Viewstats Pro in the workshop

Use the existing subscription for outlier discovery, competitor examples, and packaging collections. Save a public video URL, capture date, observed title/thumbnail, and the research hypothesis in the workshop. Keep that evidence distinct from owned-channel API measurements and native Studio test results. The official materials reviewed describe research and ideation tools; they do not establish API access for this account or permission to reuse an extension's private endpoints. [Viewstats Pro](https://www.viewstats.com/pro-upgrade), [Collections and ideation](https://viewstats.zendesk.com/hc/en-us/articles/22967147770651-Collections-Ideation-Tool).

## Import an owner-reviewed snapshot now

Prepare a curated JSON file using `examples/social-import.example.json`. The example is an empty template, not channel performance, and is not loaded by the dashboard.

```sh
node scripts/import-social.mjs path/to/curated-report.json
node scripts/import-social.mjs path/to/curated-report.json --write
node --test tests/import-social.test.mjs
```

The first command validates without changing files. `--write` merges only the included platforms into `integrations/social.json`, retains other platforms, and archives the exact previous snapshot in ignored `.private/social-imports/` before replacement. Use the project's allowlisted local server/public build: never expose the repository root as a public file server.

Every source requires:

- `id`: `youtube-shorts`, `instagram`, or `tiktok`; `status` must be `snapshot`.
- Human-readable `label`, `accountLabel`, `scope`, and `provenance.label`, plus `provenance.kind` of `platform-export` or `official-api`. Labels are public descriptions, not raw export paths.
- `capturedAt` as an ISO timestamp and `dateRange` with inclusive `start`, `end`, and a real reporting timezone. Use the source report's timezone.
- The eight `metrics` keys in the example. Unknowns are `null`; an observed zero is `0`. Counts are safe integers; `watchHours` can be fractional and `subscribersNet` can be negative.
- `daily` entries with unique `day` and nullable `views`, within the source's window. Omitted dates remain missing; the importer does not invent points.
- `content` entries with unique `id`, public `title`, canonical HTTPS platform `url`, ISO `publishedAt`, `thumbnail: null`, and nullable `views`, `likes`, `comments`, `shares`.

Counts and daily/content data must describe the same declared reporting window. `followers` is the account count as of capture, not a period gain. Explain coverage in `scope`; do not manufacture totals from an incomplete content sample. No cross-platform total represents unique people. Never combine different reporting windows or an all-format YouTube total with its Shorts subset. The importer validates structure, URLs, dates, duplication, numeric values, and public-field boundaries; an owner still verifies the source figures and their meaning.

Do not pass a raw platform export directly to the importer. Unknown fields, credential-shaped values, local paths, remote thumbnails, and tracking URLs are rejected. Structural validation cannot recognize every possible secret in otherwise ordinary text, so all descriptive fields must be curated for publication.

## Data and provenance requirements

Keep the public model separate from a private collection service:

1. Private configuration stores platform, account/channel ID, provider app ID, enabled report capabilities, granted scopes, reporting timezone, and secret-store entries. Store no token in a public config. Reuse an existing YouTube project when available, but obtain a reporting grant separately from team identity sign-in.
2. Each adapter obtains a server-side access token, paginates supported read-only reports, respects rate limits, and records success/failure without logging token-bearing URLs or headers.
3. Private provenance records include provider/API version, endpoint/report type, query window, dimensions, original metric names/units, retrieval time, actual complete-through date, availability reason, native-versus-derived status, and metric-definition version. Keep raw responses and historical snapshots outside published assets.
4. The scheduled Vercel job refreshes each source, re-fetches recent delayed days, and publishes a validated allowlisted snapshot. Schedule frequency must reflect provider latency and quotas. A failed refresh keeps the last successful data and displays its age; it must not substitute demo values.
5. The public/YEET view reads approved aggregate metrics and content only. Internal workshop notes, credentials, private financial records, and unpublished packaging stay behind server-enforced access. Hiding a tab or using an obscure link is not access control.

Connection acceptance requires one real identity response, one real dated report per platform, a refresh-token round trip, a missing-permission failure, a stale-data case, and reconciliation with the native platform for the same window/timezone/metric definition. Only then describe that platform as connected; still label its data freshness precisely.
