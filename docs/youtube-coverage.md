# YouTube reporting coverage

The dashboard combines native YouTube API reports with dated evidence captured from YouTube Studio. Coverage means the fields and reporting windows described below. It does not mean every metric, experiment or historical edit visible anywhere in Studio.

The collector uses the existing `youtube.readonly` and `yt-analytics.readonly` grants. It reads reports and metadata, and can create a nonmonetary Reporting API job that schedules daily thumbnail reach files. It does not change titles, thumbnails, tests, publication settings or other channel settings. Public Data API counters use the separate server-side API key. Credentials and provider error bodies are not included in reporting responses.

## Channel and public counters

| Source | Collected fields | Date meaning |
| --- | --- | --- |
| Public Data API channel statistics | Views, public subscriber count, public video count | Native lifetime counters observed at the capture time. Subscriber counts are rounded by YouTube. |
| Public Data API upload statistics | Views, likes and comments for verified public uploads | Native lifetime counters observed at the capture time; unavailable fields remain unavailable. |
| YouTube Analytics channel aggregate and daily reports | Views, estimated minutes watched, average view duration, average percentage viewed, likes, comments, shares, subscribers gained and lost | Native channel reports, without video filters. Channel totals include all formats and are not calculated by adding the episode or Shorts tables. |
| YouTube Analytics Shorts aggregate and daily reports | Views, engaged views, watch hours, likes, comments, shares, subscribers gained, lost and net | Native reports for the Shorts content type. Net subscribers are gained minus lost; watch hours are estimated minutes watched divided by 60. |

The public counter timeline records actual observations collected by this dashboard. It cannot reconstruct earlier lifetime counters before the first saved observation. The historical Analytics series is a separate source.

Shorts views and engaged views have different definitions. Since 31 March 2025, Shorts views count starts and replays without a minimum watch-time requirement; engaged views retain the measure of viewers who stayed past the initial seconds. Do not treat these as interchangeable measures or add Shorts totals to an all-format channel total. See the official [metrics definitions](https://developers.google.com/youtube/analytics/metrics) and [Data API revision history](https://developers.google.com/youtube/data/revision_history).

## Channel breakdowns

Each breakdown keeps its own attempted range, actual capture timestamp, returned rows and collection status.

| Report | Dimensions | Native metrics |
| --- | --- | --- |
| Traffic sources | Traffic-source type | Views, estimated minutes watched |
| Countries | Country | Views, estimated minutes watched |
| Devices | Device type | Views, estimated minutes watched |
| Subscription status | Subscribed status | Views, estimated minutes watched |
| Content format | Creator content type | Views, estimated minutes watched |
| Audience demographics | Age group and gender | Viewer percentage |
| Operating systems | Operating system | Views, estimated minutes watched |
| Playback locations | Playback-location type | Views, estimated minutes watched |
| YouTube products | YouTube product | Views, estimated minutes watched |
| Live or on demand | Live/on-demand playback | Views, estimated minutes watched |
| Sharing services | Sharing service | Shares |
| Search terms | Traffic-source detail, filtered to YouTube Search | Views, estimated minutes watched; top 25 returned rows |
| External sources | Traffic-source detail, filtered to external URLs | Views, estimated minutes watched; top 25 returned rows |
| Suggested videos | Traffic-source detail, filtered to related videos | Views, estimated minutes watched; top 25 returned rows |
| Additional daily engagement | Day | Engaged views, dislikes, videos added to and removed from playlists, YouTube Premium views and estimated Premium minutes watched |
| Daily cards | Day | Card impressions, clicks and click rate; teaser impressions, clicks and click rate |

The source-detail reports are ranked lists, not complete inventories of every search term or referrer. Audience reports may omit data because of YouTube's availability or privacy thresholds. Empty rows do not establish a zero audience.

These combinations are listed in the official [channel report tables](https://developers.google.com/youtube/analytics/channel_reports). Revenue and advertising reports require a separate monetary scope and eligible channel status; they are not requested by this integration.

## Per-upload reporting

The collector checks the uploads playlist and any retained, validated same-channel public inventory against current `videos.list` metadata. Only uploads currently verified as public and owned by the connected channel enter the public upload ledger. Private, unlisted, deleted and unavailable uploads are excluded. The verified count is compared with YouTube's native public video count; a mismatch is reported as incomplete inventory.

The ledger includes verified public long-form videos, Shorts, live content and uploads whose format remains unspecified. Format comes from YouTube's reported content type, never a duration guess. Existing episode comparisons remain a separate long-form view.

| Per-upload report | Fields |
| --- | --- |
| Aggregate and daily activity | Views, engaged views, estimated minutes watched, average view duration, average percentage viewed, likes, dislikes, comments, shares, subscribers gained and lost, videos added to and removed from playlists |
| Retention | Elapsed-video-time ratio, audience watch ratio and relative retention performance. A separate optional request supplies started watching, stopped watching and total segment impressions; unavailable segment fields remain null. |
| Traffic | Traffic-source type, views and estimated minutes watched |
| Current observed metadata | Title, description, tags, publication time, duration when supplied, and official thumbnail URL |
| Observed metadata history | Earlier saved title, description, tags and thumbnail URL observations with their original capture timestamps |

Video-filtered subscriber metrics are attributable to the video watch page and must not be presented as the entire channel's subscription activity. Audience watch ratios and average percentage viewed can exceed 100% because of repeated viewing. Native signed likes adjustments are preserved.

Aggregate, daily and traffic reports are collected in bounded batches, with pagination. When YouTube rejects a multi-upload daily query, the collector retries each affected upload separately, except for authorization or rate-limit failures. Retention uses one video per request, as required by YouTube. Traffic batches also respect the documented queried-video-count × date-count limit of 50,000. Safety limits fail explicitly or retain earlier reports; the collector does not silently slice a report and call it complete. See [query filtering and pagination](https://developers.google.com/youtube/analytics/reference/reports/query) and the [traffic and retention report constraints](https://developers.google.com/youtube/analytics/channel_reports).

## Thumbnail reach from the Reporting API

The bulk collector uses `channel_reach_basic_a1`: daily thumbnail impressions and native thumbnail impressions CTR for each video. These are whole-video measurements, not A/B variant measurements. The Reporting API is a separate Google Cloud service and must be enabled in the connected project's configuration. The existing `yt-analytics.readonly` scope is sufficient. See the official [reach report definition](https://developers.google.com/youtube/reporting/v1/reports/channel_reports#reach-reports) and [authorization requirements](https://developers.google.com/youtube/reporting/guides/authorization).

The integration reuses an existing matching job or creates one when the refresh requests report scheduling. A newly scheduled job does not immediately provide data: Google's guide currently allows up to 48 hours for the first daily report. Initial historical backfill covers the preceding 30 days and can take several days. Generated historical files are downloadable for 30 days; normal daily files for 60 days. Previously imported observations remain dated in the saved report. Older history that Google has not supplied is unavailable. See the [bulk reporting workflow and backfill rules](https://developers.google.com/youtube/reporting/v1/reports/).

Each file keeps its report period, generation time and import time. A newer backfill replaces the entire corresponding period, including a valid empty file. Downloads are limited to 90 files per refresh with at most four concurrent requests; remaining files are explicitly marked pending. Failed downloads retain earlier valid reports. The saved manifest is bounded to 3,660 daily periods and 200,000 public rows; exceeding a safety limit is reported rather than silently dropping history.

Only rows for the expected channel and currently verified public upload IDs are published. Raw CSVs, download URLs, job IDs and credentials are excluded from public output. Daily dates follow Pacific time, including daylight saving changes. Native CTR is retained as a ratio in storage and exports, and multiplied by 100 for percentage display. The 20 October 2026 import confirmed the scale: Hull returned 32 impressions and 0.15625 CTR for 17 October, corresponding to 5 clicks and 15.625%. The UI does not infer an aggregate CTR from a simple mean of daily values. See Google's [metric definition](https://developers.google.com/youtube/reporting/v1/reports/metrics#video_thumbnail_impressions_ctr).

This is still a defined reporting inventory, not every available API family. End-screen and subtitle-use bulk reports, playlist-specific reports, concurrent live-viewer reports and additional reach dimensions are not collected by the current implementation. These are accessible report families rather than evidence that the APIs cannot supply them. See the [Reporting API channel catalog](https://developers.google.com/youtube/reporting/v1/reports/channel_reports) and [Analytics channel catalog](https://developers.google.com/youtube/analytics/channel_reports).

## Dates, processing and partial results

- Requests reach today's Pacific calendar date. YouTube processing may stop earlier; the unfiltered channel daily report establishes the processed cutoff for the core metric set.
- Channel history starts at a valid returned channel-creation date. If unavailable or inconsistent, the fallback is the earliest verified public upload. A fallback is labelled and does not establish coverage before that date.
- Optional reports retain their own query ranges and captures. Their requested end date does not prove that every optional metric is processed through that date.
- An omitted day remains a gap. A returned zero remains zero. An upload published after the processed cutoff remains in the catalog with an explicit unavailable report.
- Failed or empty optional reports retain any earlier valid report and its original source dates. The latest attempt is shown separately. Missing previously saved daily observations are treated as coverage loss.
- Current public lifetime counters, processed Analytics reports and manually captured Studio evidence can have different capture dates. One successful refresh does not make all three sources current.

YouTube documents that a report can end at the latest date for which all requested metrics are available, and that recent daily rows can be absent. See [reports.query](https://developers.google.com/youtube/analytics/reference/reports/query).

## Native tests and historical packaging

The Data API supplies current metadata, not an edit log. The Analytics and bulk reach reports above do not expose native Studio A/B test rounds, every historical title/thumbnail pairing, variant-level impressions or variant-level CTR. Whole-video thumbnail reach is collected through the separate bulk workflow above; its historical availability does not establish coverage for all Studio reach, unique-viewer or returning-viewer reports.

Native A/B evidence is captured from the visible Studio report: variant title and thumbnail pairing, watch-time share when shown, run dates, status and Studio's stated result. A largest share alone is not labelled a winner. For a combined title-and-thumbnail test, the evidence applies to that pairing; it cannot isolate the effect of the title from the image.

Saved earlier rounds remain separate from revised or later rounds. An unfinished observation is not overwritten with results from another test. Exact switch times, missing test rounds and unavailable shares are not inferred. Studio-displayed times retain a timezone caveat where Studio does not identify one.

Automated metadata history begins with observations actually saved by the dashboard. A saved thumbnail URL records the URL observed at that time; it does not prove that the image bytes remain unchanged. Independently archived native-test images and screenshots are identified as such. See the [video metadata resource](https://developers.google.com/youtube/data/reference/rest/v3/videos) and [YouTube's native A/B testing guidance](https://support.google.com/youtube/answer/16391400).

Actual collected upload counts, successful report counts and source dates should be read from the latest verified refresh. They are deliberately not fixed in this document.
