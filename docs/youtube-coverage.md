# YouTube reporting coverage

The dashboard combines native YouTube API reports with dated evidence captured from YouTube Studio. Coverage means the fields and reporting windows described below. It does not mean every metric, experiment or historical edit visible anywhere in Studio.

The collector uses the existing `youtube.readonly` and `yt-analytics.readonly` grants. It only reads reports and metadata. It does not change titles, thumbnails, tests, publication settings or other channel settings. Public Data API counters use the separate server-side API key. Credentials and provider error bodies are not included in reporting responses.

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
| Retention | Elapsed-video-time ratio, audience watch ratio, relative retention performance, started watching, stopped watching and total segment impressions |
| Traffic | Traffic-source type, views and estimated minutes watched |
| Current observed metadata | Title, description, tags, publication time, duration when supplied, and official thumbnail URL |
| Observed metadata history | Earlier saved title, description, tags and thumbnail URL observations with their original capture timestamps |

Video-filtered subscriber metrics are attributable to the video watch page and must not be presented as the entire channel's subscription activity. Audience watch ratios and average percentage viewed can exceed 100% because of repeated viewing. Native signed likes adjustments are preserved.

Aggregate, daily and traffic reports are collected in bounded batches, with pagination. Retention uses one video per request, as required by YouTube. Traffic batches also respect the documented queried-video-count × date-count limit of 50,000. Safety limits fail explicitly or retain earlier reports; the collector does not silently slice a report and call it complete. See [query filtering and pagination](https://developers.google.com/youtube/analytics/reference/reports/query) and the [traffic and retention report constraints](https://developers.google.com/youtube/analytics/channel_reports).

## Dates, processing and partial results

- Requests reach today's Pacific calendar date. YouTube processing may stop earlier; the unfiltered channel daily report establishes the processed cutoff for the core metric set.
- Channel history starts at a valid returned channel-creation date. If unavailable or inconsistent, the fallback is the earliest verified public upload. A fallback is labelled and does not establish coverage before that date.
- Optional reports retain their own query ranges and captures. Their requested end date does not prove that every optional metric is processed through that date.
- An omitted day remains a gap. A returned zero remains zero. An upload published after the processed cutoff remains in the catalog with an explicit unavailable report.
- Failed or empty optional reports retain any earlier valid report and its original source dates. The latest attempt is shown separately. Missing previously saved daily observations are treated as coverage loss.
- Current public lifetime counters, processed Analytics reports and manually captured Studio evidence can have different capture dates. One successful refresh does not make all three sources current.

YouTube documents that a report can end at the latest date for which all requested metrics are available, and that recent daily rows can be absent. See [reports.query](https://developers.google.com/youtube/analytics/reference/reports/query).

## Native tests and historical packaging

The Data API supplies current metadata, not an edit log. The Analytics API reports above do not expose native Studio A/B test rounds, every historical title/thumbnail pairing, variant-level impressions or variant-level CTR. This integration also does not claim API coverage for all Studio reach, unique-viewer or returning-viewer reports.

Native A/B evidence is captured from the visible Studio report: variant title and thumbnail pairing, watch-time share when shown, run dates, status and Studio's stated result. A largest share alone is not labelled a winner. For a combined title-and-thumbnail test, the evidence applies to that pairing; it cannot isolate the effect of the title from the image.

Saved earlier rounds remain separate from revised or later rounds. An unfinished observation is not overwritten with results from another test. Exact switch times, missing test rounds and unavailable shares are not inferred. Studio-displayed times retain a timezone caveat where Studio does not identify one.

Automated metadata history begins with observations actually saved by the dashboard. A saved thumbnail URL records the URL observed at that time; it does not prove that the image bytes remain unchanged. Independently archived native-test images and screenshots are identified as such. See the [video metadata resource](https://developers.google.com/youtube/data/reference/rest/v3/videos) and [YouTube's native A/B testing guidance](https://support.google.com/youtube/answer/16391400).

Actual collected upload counts, successful report counts and source dates should be read from the latest verified refresh. They are deliberately not fixed in this document.
