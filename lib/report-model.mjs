// Public reporting is an explicit projection. Never pass the private archive through.
const sum = (rows, key) => rows.reduce((total, row) => total + (Number.isFinite(row[key]) ? row[key] : 0), 0);
export const PLATFORM_IDS = ['youtube-longform', 'youtube-shorts', 'instagram', 'tiktok'];
const platforms = [
  { id: 'youtube-longform', label: 'YouTube', format: 'Full episodes', mark: 'YT', color: '#d52b30' },
  { id: 'youtube-shorts', label: 'YouTube Shorts', format: 'Short-form', mark: 'YS', color: '#b84a3b' },
  { id: 'instagram', label: 'Instagram', format: 'Reels & posts', mark: 'IG', color: '#9972a0' },
  { id: 'tiktok', label: 'TikTok', format: 'Short-form', mark: 'TK', color: '#39796d' }
];
export function dateInPacific(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
export function calendarDays(start, end) {
  const days = [];
  for (let value = Date.parse(start + 'T00:00:00Z'); value <= Date.parse(end + 'T00:00:00Z'); value += 86400000) days.push(new Date(value).toISOString().slice(0, 10));
  return days;
}
export function buildDaily(videos, start, end) {
  return calendarDays(start, end).map(day => {
    const expected = videos.filter(v => dateInPacific(v.publishedAt) <= day);
    const rows = expected.map(v => v.daily.find(row => row.day === day));
    const complete = rows.every(Boolean);
    const known = rows.filter(Boolean);
    return { day, views: complete ? sum(known, 'views') : null, knownViews: sum(known, 'views'), complete, missing: expected.filter((_, i) => !rows[i]).map(v => v.name) };
  });
}
export function buildPublicReport(snapshot, social = { sources: [] }, campaignData = { campaigns: [] }) {
  const videos = snapshot.videos;
  const start = videos.map(v => dateInPacific(v.publishedAt)).sort()[0];
  const metrics = {
    views: sum(videos.map(v => v.apiAggregate), 'views'),
    watchHours: sum(videos.map(v => v.apiAggregate), 'estimatedMinutesWatched') / 60,
    subscribersNet: sum(videos, 'subscribersNet'),
    likes: sum(videos.map(v => v.apiAggregate), 'likes'),
    comments: sum(videos.map(v => v.apiAggregate), 'comments'),
    shares: sum(videos.map(v => v.apiAggregate), 'shares'),
    followers: null, engagedViews: null
  };
  const content = videos.map(v => ({
    id: v.id, platform: 'youtube-longform', name: v.name, title: v.title,
    packagingCapturedAt: v.packagingCapturedAt || snapshot.capturedAt,
    publishedAt: v.publishedAt, thumbnail: '/' + v.thumb.replace(/^\//, ''),
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
    scope: `${videos.length} saved full episodes · selected content, not channel totals`,
    capturedAt: snapshot.capturedAt,
    dateRange: { start, end: snapshot.apiThrough, timezone: 'America/Los_Angeles' },
    provenance: { kind: 'official-api', label: 'Saved YouTube Analytics API report' },
    metrics, daily: buildDaily(videos, start, snapshot.apiThrough), content
  };
  const sources = platforms.map(platform => {
    if (platform.id === 'youtube-longform') return youtube;
    const imported = social.sources.find(source => source.id === platform.id);
    if (!imported) return { ...platform, status: 'not-connected', scope: 'No verified report imported', metrics: null, daily: [], content: [] };
    // Explicitly allowlist even after schema validation.
    return { ...platform, status: 'snapshot', accountLabel: imported.accountLabel, capturedAt: imported.capturedAt,
      dateRange: imported.dateRange, scope: imported.scope, provenance: imported.provenance,
      metrics: Object.fromEntries(Object.keys(metrics).map(key => [key, imported.metrics[key] ?? null])),
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
    definitions: [
      'Views are platform-reported plays, not unique people. View definitions differ by platform and format.',
      `Selected YouTube episode totals cover publication through ${snapshot.apiThrough}. They are not channel totals.`,
      'Missing data is unavailable, never zero. A daily reporting gap is shown as a gap.',
      'Watch time and subscriber gains are reported by the platform. A net gain is not a total subscriber count.',
      'Sponsor exposure, conversions and return on investment require campaign attribution; channel performance is context only.'
    ]
  };
}
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value !== 'number') text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
