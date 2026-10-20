// Public reporting is an explicit projection. Never pass the private archive through.
const sum = (rows, key) => rows.reduce((total, row) => total + (Number.isFinite(row[key]) ? row[key] : 0), 0);
export const PLATFORM_IDS = ['youtube-longform', 'youtube-shorts', 'instagram', 'tiktok'];
const platforms = [
  { id: 'youtube-longform', label: 'YouTube', format: 'Full episodes', mark: 'YT', color: '#d52b30' },
  { id: 'youtube-shorts', label: 'YouTube Shorts', format: 'Short-form', mark: 'YS', color: '#b84a3b' },
  { id: 'instagram', label: 'Instagram', format: 'Reels & posts', mark: 'IG', color: '#9972a0' },
  { id: 'tiktok', label: 'TikTok', format: 'Short-form', mark: 'TK', color: '#39796d' }
];
export function publicYouTubeThumbnail(value) {
  if (typeof value !== 'string') return null;
  if (/^assets\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(value)) return '/' + value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['i.ytimg.com', 'i9.ytimg.com'].includes(url.hostname) &&
        !url.username && !url.password && !url.port && !url.hash &&
        /^\/vi(?:_webp)?\/[A-Za-z0-9_-]{11}\/[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/.test(url.pathname)) return url.href;
  } catch { /* Unsupported thumbnail locations are not published. */ }
  return null;
}

// Publish counts and coverage, never the raw discovery IDs or provider records.
export function youtubeCoverage(snapshot) {
  const included = snapshot.videos.length;
  const discovery = snapshot.youtubeRefresh?.discovery;
  if (!discovery) return {
    status: 'selected', includedVideoCount: included, observedAt: null,
    publicUploadsCount: null, confirmedLongformCount: null,
    unknownFormatCount: null, unreportedLongformCount: null, pendingPublicationCount: null,
  };
  const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const unknown = Array.isArray(discovery.unknownFormatIds) ? discovery.unknownFormatIds.length : null;
  const unreported = Array.isArray(discovery.unreportedLongformIds) ? discovery.unreportedLongformIds.length : null;
  const pending = Array.isArray(discovery.pendingPublicationIds) ? discovery.pendingPublicationIds.length : null;
  const complete = discovery.status === 'complete' && discovery.inventoryComplete === true &&
    discovery.includedLongformCount === included && discovery.confirmedLongformCount === included &&
    unknown === 0 && unreported === 0 && pending === 0;
  return {
    status: complete ? 'complete' : 'partial', includedVideoCount: included,
    observedAt: discovery.observedAt || snapshot.capturedAt,
    publicUploadsCount: safeCount(discovery.publicUploadsCount),
    confirmedLongformCount: safeCount(discovery.confirmedLongformCount),
    unknownFormatCount: unknown, unreportedLongformCount: unreported, pendingPublicationCount: pending,
  };
}
export function dateInPacific(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
export function calendarDays(start, end) {
  const days = [];
  for (let value = Date.parse(start + 'T00:00:00Z'); value <= Date.parse(end + 'T00:00:00Z'); value += 86400000) days.push(new Date(value).toISOString().slice(0, 10));
  return days;
}
export function buildDaily(videos, start, end) {
  const indexed = videos.map(video => ({
    name: video.name, publishedDay: dateInPacific(video.publishedAt),
    daily: new Map(video.daily.map(row => [row.day, row])),
  }));
  return calendarDays(start, end).map(day => {
    const expected = indexed.filter(v => v.publishedDay <= day);
    const rows = expected.map(v => v.daily.get(day));
    const complete = rows.every(Boolean);
    const known = rows.filter(Boolean);
    return { day, views: complete ? sum(known, 'views') : null, knownViews: sum(known, 'views'), complete, missing: expected.filter((_, i) => !rows[i]).map(v => v.name) };
  });
}
function buildHistoricalPublicReport(snapshot, social, campaignData) {
  const videos = snapshot.videos;
  const coverage = youtubeCoverage(snapshot);
  const scope = coverage.status === 'selected'
    ? `${videos.length} saved full episodes · selected content, not channel totals`
    : coverage.status === 'complete'
      ? `All ${videos.length} public long-form videos found in the channel's uploads at capture. Excludes Shorts, live streams, private, unlisted and deleted videos.`
      : `${videos.length} public long-form videos with available reports · partial coverage. Some discovered uploads are awaiting format classification, reporting data or the reporting cutoff.`;
  const start = videos.map(v => dateInPacific(v.publishedAt)).sort()[0];
  const metrics = {
    views: sum(videos.map(v => v.apiAggregate), 'views'),
    watchHours: sum(videos.map(v => v.apiAggregate), 'estimatedMinutesWatched') / 60,
    subscribersNet: sum(videos, 'subscribersNet'),
    likes: sum(videos.map(v => v.apiAggregate), 'likes'),
    comments: sum(videos.map(v => v.apiAggregate), 'comments'),
    shares: sum(videos.map(v => v.apiAggregate), 'shares'),
    followers: null,
    engagedViews: videos.every(v => Number.isFinite(v.apiAggregate.engagedViews)) ? sum(videos.map(v => v.apiAggregate), 'engagedViews') : null
  };
  const content = videos.map(v => ({
    id: v.id, platform: 'youtube-longform', name: v.name, title: v.title,
    packagingCapturedAt: v.packagingCapturedAt || snapshot.capturedAt,
    publishedAt: v.publishedAt, thumbnail: publicYouTubeThumbnail(v.thumb),
    thumbnailSource: v.thumb?.startsWith('assets/') ? 'saved-image' : publicYouTubeThumbnail(v.thumb) ? 'platform-url' : null,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`,
    views: v.apiAggregate.views, watchHours: v.apiAggregate.estimatedMinutesWatched / 60,
    subscribersNet: v.subscribersNet, likes: v.apiAggregate.likes,
    comments: v.apiAggregate.comments, shares: v.apiAggregate.shares,
    averageViewDuration: v.apiAggregate.averageViewDuration,
    averageViewPercentage: v.apiAggregate.averageViewPercentage,
    durationSeconds: v.durationSeconds,
    launchWindows: Object.fromEntries(['3', '7'].map(window => {
      const row = v.windows[window];
      return [window, { complete: row.complete, views: row.complete ? row.views : null, watchHours: row.complete ? row.watchHours : null }];
    }))
  }));
  const youtube = {
    ...platforms[0], status: 'snapshot', accountLabel: 'Scran & Pints',
    format: coverage.status === 'selected' ? platforms[0].format : 'Public long-form videos',
    scope, coverage,
    capturedAt: snapshot.capturedAt,
    dateRange: { start, end: snapshot.apiThrough, timezone: 'America/Los_Angeles' },
    provenance: { kind: 'official-api', label: coverage.status === 'selected' ? 'Saved YouTube Analytics API report' : 'YouTube uploads inventory and Analytics API reports' },
    metrics, daily: buildDaily(videos, start, snapshot.apiThrough), content
  };
  youtube.historical = true;
  youtube.provenance.label = 'Previously published historical YouTube snapshot';
  return composeReport(youtube, social, campaignData, [
    'This historical YouTube episode snapshot was previously published with the repository. Separately dated channel and Shorts performance is shown when available.',
    'Views are platform-reported plays, not unique people. View definitions differ by platform and format.',
    `Selected historical YouTube episode totals cover publication through ${snapshot.apiThrough}. They are not channel totals.`,
    'Missing data is unavailable, never zero. A daily reporting gap is shown as a gap.',
    'Sponsor exposure, conversions and return on investment require campaign attribution; channel performance is context only.',
  ]);
}

function composeReport(youtube, social, campaignData, definitions) {
  const metricKeys = ['views', 'engagedViews', 'watchHours', 'subscribersNet', 'likes', 'comments', 'shares', 'followers'];
  const sources = platforms.map(platform => {
    if (platform.id === 'youtube-longform') return youtube;
    if (platform.id === 'youtube-shorts') return {
      ...platform, status: youtube.counterScope === 'public-channel' ? 'included-in-channel' : 'not-connected',
      scope: youtube.counterScope === 'public-channel'
        ? 'Included in channel counters; separate public breakdown unavailable'
        : 'No public Shorts breakdown collected. The historical selected-episode report excludes Shorts',
      metrics: null, daily: [], content: [],
    };
    const imported = social.sources.find(source => source.id === platform.id);
    if (!imported) return { ...platform, status: 'not-connected', scope: 'No verified report imported', metrics: null, daily: [], content: [] };
    // Explicitly allowlist even after schema validation.
    return { ...platform, status: 'snapshot', accountLabel: imported.accountLabel, capturedAt: imported.capturedAt,
      dateRange: imported.dateRange, scope: imported.scope, provenance: imported.provenance,
      metrics: Object.fromEntries(metricKeys.map(key => [key, imported.metrics[key] ?? null])),
      daily: imported.daily.length ? calendarDays(imported.dateRange.start, imported.dateRange.end).map(day => {
        const row = imported.daily.find(record => record.day === day);
        return { day, views: row?.views ?? null, complete: Number.isFinite(row?.views), missing: Number.isFinite(row?.views) ? [] : ['daily record'] };
      }) : [],
      content: imported.content.map(row => ({ id: row.id, platform: platform.id, title: row.title, name: platform.label, url: row.url,
        thumbnail: row.thumbnail, publishedAt: row.publishedAt, views: row.views,
        likes: row.likes, comments: row.comments, shares: row.shares }))
    };
  });
  return { schemaVersion: 1, sources,
    campaigns: campaignData.campaigns.map(campaign => ({
      id: campaign.id, name: campaign.name, description: campaign.description,
      status: campaign.placements.length ? 'recorded-placements' : 'awaiting-attribution',
      placements: campaign.placements.map(p => ({ platform: p.platform, contentId: p.contentId, placement: p.placement, confirmedAt: p.confirmedAt, evidenceUrl: p.evidenceUrl }))
    })),
    definitions
  };
}

// Validate and copy the independent API-key result; unknown fields cannot enter
// the public projection through the private cloud payload.
export function validatePublicYouTubeReport(value) {
  const fail = () => { throw Error('Invalid public YouTube counters.'); };
  const keys = (object, allowed) => object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).every(key => allowed.includes(key));
  const integer = n => Number.isSafeInteger(n) && n >= 0;
  const counter = n => n === null || integer(n);
  const text = value => typeof value === 'string' && value.length <= 1000 && !/[\u0000-\u001f\u007f]/.test(value);
  const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  if (!keys(value, ['schemaVersion', 'capturedAt', 'channel', 'inventory', 'content']) ||
      value.schemaVersion !== 1 || !instant(value.capturedAt) ||
      !keys(value.channel, ['id', 'title', 'views', 'subscribers', 'videoCount']) ||
      value.channel.id !== 'UCAX4l1JUAymaMHVKiRFzK-A' || !text(value.channel.title) ||
      !integer(value.channel.views) || !counter(value.channel.subscribers) || !integer(value.channel.videoCount) ||
      !keys(value.inventory, ['complete', 'publicUploadsCount']) || typeof value.inventory.complete !== 'boolean' ||
      !Array.isArray(value.content) || value.content.length > 5000 ||
      value.inventory.publicUploadsCount !== value.content.length ||
      (value.inventory.complete && value.channel.videoCount !== value.content.length)) fail();
  const ids = new Set();
  const content = value.content.map(video => {
    if (!keys(video, ['id', 'title', 'url', 'publishedAt', 'thumbnail', 'views', 'likes', 'comments']) ||
        !/^[A-Za-z0-9_-]{11}$/.test(video.id || '') || ids.has(video.id) || !text(video.title) ||
        video.url !== `https://www.youtube.com/watch?v=${video.id}` || !instant(video.publishedAt) ||
        (video.thumbnail !== null && (!publicYouTubeThumbnail(video.thumbnail) || !video.thumbnail.startsWith('https://'))) ||
        !['views', 'likes', 'comments'].every(key => counter(video[key]))) fail();
    ids.add(video.id);
    return Object.fromEntries(['id', 'title', 'url', 'publishedAt', 'thumbnail', 'views', 'likes', 'comments'].map(key => [key, video[key]]));
  });
  return {
    schemaVersion: 1, capturedAt: value.capturedAt,
    channel: Object.fromEntries(['id', 'title', 'views', 'subscribers', 'videoCount'].map(key => [key, value.channel[key]])),
    inventory: { complete: value.inventory.complete, publicUploadsCount: content.length }, content,
  };
}

export function buildPublicReport(snapshot, social = { sources: [] }, campaignData = { campaigns: [] }, { allowHistoricalYouTube = false } = {}) {
  let publicReport = null;
  if (snapshot.publicReport) publicReport = validatePublicYouTubeReport(snapshot.publicReport);
  if (!publicReport && allowHistoricalYouTube) return buildHistoricalPublicReport(snapshot, social, campaignData);
  let youtube = {
    ...platforms[0], format: 'All formats', status: 'not-connected',
    scope: 'Public channel counters have not been collected.', metrics: null, daily: [], content: [],
  };
  if (publicReport) {
    const { channel, inventory, capturedAt } = publicReport;
    const day = capturedAt.slice(0, 10);
    youtube = {
      ...platforms[0], status: 'snapshot', format: 'All formats', accountLabel: channel.title,
      counterScope: 'public-channel', capturedAt, channelUrl: `https://www.youtube.com/channel/${channel.id}`,
      scope: 'YouTube public channel counters across all formats, including Shorts and live streams. Lifetime counters observed at capture; no period growth is inferred.',
      coverage: { status: inventory.complete ? 'complete' : 'partial', observedAt: capturedAt,
        includedVideoCount: inventory.publicUploadsCount, publicUploadsCount: channel.videoCount },
      dateRange: { start: day, end: day, timezone: 'UTC' },
      provenance: { kind: 'official-api', label: 'YouTube Data API · public resources collected with an API key' },
      metrics: { views: channel.views, followers: channel.subscribers, videoCount: channel.videoCount,
        watchHours: null, subscribersNet: null, likes: null, comments: null, shares: null, engagedViews: null },
      daily: [],
      content: publicReport.content.map(video => ({
        ...video, platform: 'youtube', name: 'YouTube public upload · all formats',
        packagingCapturedAt: capturedAt, thumbnailSource: video.thumbnail ? 'platform-url' : null,
        watchHours: null, subscribersNet: null, shares: null,
        averageViewDuration: null, averageViewPercentage: null, durationSeconds: null,
      })),
    };
  }
  return composeReport(youtube, social, campaignData, [
    'YouTube lifetime counters and public video metadata come from the YouTube Data API. Separately dated performance series publish selected channel and Shorts aggregate/daily metrics from YouTube Analytics.',
    'YouTube channel views include all formats, including Shorts and live streams. The per-video list is the public uploads returned at capture and can differ from channel totals.',
    'Lifetime counters are observations at capture. Daily performance represents activity on the stated Pacific reporting dates; missing dates remain unavailable.',
    'YouTube subscriber counts are rounded down to three significant figures by the platform. A hidden count is unavailable.',
    'Public performance includes available views, watch hours, likes, comments, shares and subscriber changes. Retention, audience breakdowns, private content details, credentials and workshop notes remain excluded.',
    'Shorts are a subset of all-format YouTube channel performance. Do not add the two together. Stored Shorts daily reports contain views only; other daily metrics are unavailable.',
    'Missing values are unavailable, never zero. Views are not unique people and are not deduplicated across platforms.',
    'Sponsor exposure, conversions and return on investment require campaign attribution; channel performance is context only.',
  ]);
}
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value !== 'number') text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
