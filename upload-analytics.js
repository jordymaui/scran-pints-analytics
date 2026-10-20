// The API has already selected public upload metadata and reporting fields.
// This module never requests credentials or writes channel/account settings.
import { youtubeThumbnailPreview } from './thumbnail-preview.js';
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const number = value => numeric(value) ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 }).format(value) : 'Unavailable';
const FORMATS = {
  VIDEO_ON_DEMAND: 'Video', SHORTS: 'Short', LIVE_STREAM: 'Live stream', STORY: 'Story', UNSPECIFIED: 'Unclassified',
};
const METRICS = {
  views: 'Views', engagedViews: 'Engaged views', estimatedMinutesWatched: 'Watch time (minutes)',
  averageViewDuration: 'Average view duration (seconds)', averageViewPercentage: 'Average viewed (%)',
  likes: 'Likes', dislikes: 'Dislikes', comments: 'Comments', shares: 'Shares',
  subscribersGained: 'Subscribers gained', subscribersLost: 'Subscribers lost',
  videosAddedToPlaylists: 'Playlist additions', videosRemovedFromPlaylists: 'Playlist removals',
  audienceWatchRatio: 'Audience watch ratio', relativeRetentionPerformance: 'Relative retention (0–1)',
  startedWatching: 'Started watching', stoppedWatching: 'Stopped watching',
  totalSegmentImpressions: 'Segment impressions', viewerPercentage: 'Viewers (%)',
  redViews: 'Premium views', estimatedRedMinutesWatched: 'Premium watch time (minutes)',
  cardImpressions: 'Card impressions', cardClicks: 'Card clicks', cardClickRate: 'Card click rate (0–1)',
  cardTeaserImpressions: 'Card teaser impressions', cardTeaserClicks: 'Card teaser clicks',
  cardTeaserClickRate: 'Card teaser click rate (0–1)',
  impressions: 'Thumbnail impressions', impressionsCtr: 'Impressions CTR (%)',
};
const DIMENSIONS = {
  day: 'Date', elapsedVideoTimeRatio: 'Video position (0–1)', insightTrafficSourceType: 'Traffic source',
  insightTrafficSourceDetail: 'Source detail', country: 'Country', deviceType: 'Device',
  subscribedStatus: 'Subscription status', creatorContentType: 'Content format', ageGroup: 'Age group',
  gender: 'Gender', operatingSystem: 'Operating system', insightPlaybackLocationType: 'Playback location',
  youtubeProduct: 'YouTube product', liveOrOnDemand: 'Live or on demand', sharingService: 'Sharing service',
  videoId: 'Video ID', uploadsReported: 'Uploads with rows', reportGeneratedAt: 'Report generated (UTC)',
  capturedAt: 'Imported (UTC)',
};
const CHANNEL_REPORTS = {
  traffic: 'Traffic sources', country: 'Countries', device: 'Devices', subscribed: 'Subscription status',
  format: 'Content formats', demographics: 'Audience demographics', operatingSystem: 'Operating systems',
  playbackLocation: 'Playback locations', youtubeProduct: 'YouTube products', liveOrOnDemand: 'Live or on demand',
  sharing: 'Sharing services', searchTerms: 'YouTube search terms', externalSources: 'External sources',
  suggestedVideos: 'Suggested videos', engagement: 'Additional engagement', cards: 'Cards',
};
const REPORTS = { daily: 'Daily history', retention: 'Retention', traffic: 'Traffic sources', reach: 'Thumbnail reach' };
const PAGE_SIZE = 100;
const instances = new WeakMap();
let instanceNumber = 0;
const label = key => METRICS[key] || DIMENSIONS[key] || key;
export const formatUploadMetric = (key, value) =>
  key === 'impressionsCtr' && numeric(value) ? `${number(value * 100)}%` : number(value);
const stamp = value => value ? String(value).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC') : 'Not recorded';
const rangeText = range => range?.start && range?.end
  ? `${range.start} to ${range.end} · ${range.timezone || 'America/Los_Angeles'}` : 'Reporting dates unavailable';
const rowsOf = entry => Array.isArray(entry?.report?.rows) ? entry.report.rows : [];
const safeId = value => /^[A-Za-z0-9_-]{11}$/.test(value || '');
function thumbnail(video) {
  try {
    const url = new URL(video.thumbnail);
    return safeId(video.id) && url.protocol === 'https:' && url.hostname === 'i.ytimg.com' &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      new RegExp(`^/vi(?:_webp)?/${video.id}/[A-Za-z0-9_-]+\\.(jpg|webp|png)$`).test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export function filterUploads(videos, { search = '', format = 'all', sort = 'views' } = {}) {
  const query = search.trim().toLocaleLowerCase('en-GB');
  return videos.filter(video => (format === 'all' || video.creatorContentType === format) &&
    (!query || `${video.title} ${video.id}`.toLocaleLowerCase('en-GB').includes(query)))
    .sort((a, b) => {
      if (sort === 'published') return String(b.publishedAt).localeCompare(String(a.publishedAt)) || a.id.localeCompare(b.id);
      if (sort === 'title') return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
      const av = rowsOf(a.aggregate)[0]?.[sort], bv = rowsOf(b.aggregate)[0]?.[sort];
      return (numeric(av) && numeric(bv) ? bv - av : numeric(av) ? -1 : numeric(bv) ? 1 : 0) || a.id.localeCompare(b.id);
    });
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Titles, tags and source details can start with spreadsheet formulas.
  if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function csvRows(rows, columns) {
  return [columns, ...rows.map(row => columns.map(key => row[key]))].map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function reportRowsCsv(entry, identity = {}) {
  const rows = rowsOf(entry);
  const provenance = {
    ...identity, status: entry?.status || 'not-collected',
    capturedAt: entry?.report?.capturedAt ?? null,
    reportStart: entry?.report?.dateRange?.start ?? null, reportEnd: entry?.report?.dateRange?.end ?? null,
    timezone: entry?.report?.dateRange?.timezone ?? null, attemptedAt: entry?.attemptedAt ?? null,
    attemptedStart: entry?.attemptedRange?.start ?? null, attemptedEnd: entry?.attemptedRange?.end ?? null,
    errorCode: entry?.errorCode ?? null,
  };
  const fields = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const output = (rows.length ? rows : [{}]).map(row => ({ ...provenance, ...row }));
  return csvRows(output, [...Object.keys(provenance), ...fields.filter(key => !Object.hasOwn(provenance, key))]);
}

export function uploadTotalsCsv(videos) {
  const fields = [...new Set(videos.flatMap(video => Object.keys(rowsOf(video.aggregate)[0] || {})))];
  const rows = videos.map(video => ({
    videoId: video.id, title: video.title, format: video.creatorContentType, publishedAt: video.publishedAt,
    status: video.aggregate?.status || 'not-collected', capturedAt: video.aggregate?.report?.capturedAt ?? null,
    reportStart: video.aggregate?.report?.dateRange?.start ?? null,
    reportEnd: video.aggregate?.report?.dateRange?.end ?? null,
    timezone: video.aggregate?.report?.dateRange?.timezone ?? null,
    ...rowsOf(video.aggregate)[0],
  }));
  return csvRows(rows, ['videoId', 'title', 'format', 'publishedAt', 'status', 'capturedAt', 'reportStart', 'reportEnd', 'timezone', ...fields]);
}

export function uploadSeries(rows, key, dimension = 'day') {
  const points = rows.map(row => ({
    x: dimension === 'day' ? Date.parse(`${row.day}T00:00:00Z`) : row[dimension],
    y: row[key], source: row[dimension],
  })).filter(point => numeric(point.x) && numeric(point.y)).sort((a, b) => a.x - b.x);
  const segments = [];
  for (const point of points) {
    const last = segments.at(-1)?.at(-1);
    if (!last || (dimension === 'day' && point.x - last.x > 86400000)) segments.push([]);
    segments.at(-1).push(point);
  }
  return { points, segments };
}

// Keep each native video/day CTR ratio intact; convert only its displayed value.
// Channel impressions are additive; CTR is not averaged across videos or dates.
export function reachRows(bulkReach, videoId = null) {
  const unique = new Map();
  for (const row of Array.isArray(bulkReach?.daily) ? bulkReach.daily : []) {
    if (!row || !safeId(row.videoId) || (videoId && row.videoId !== videoId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) continue;
    const key = `${row.date}:${row.videoId}`;
    const previous = unique.get(key);
    const version = `${row.reportGeneratedAt || ''}|${row.capturedAt || ''}`;
    if (previous && version <= `${previous.reportGeneratedAt || ''}|${previous.capturedAt || ''}`) continue;
    unique.set(key, {
      day: row.date, videoId: row.videoId,
      impressions: numeric(row.impressions) && row.impressions >= 0 ? row.impressions : null,
      impressionsCtr: numeric(row.impressionsCtr) && row.impressionsCtr >= 0 && row.impressionsCtr <= 1
        ? row.impressionsCtr : null,
      reportGeneratedAt: row.reportGeneratedAt ?? null, capturedAt: row.capturedAt ?? null,
    });
  }
  return [...unique.values()].sort((a, b) => a.day.localeCompare(b.day) || a.videoId.localeCompare(b.videoId));
}

export function reachDailyTotals(bulkReach) {
  const days = new Map();
  for (const row of reachRows(bulkReach)) {
    const day = days.get(row.day) || { day: row.day, impressions: null, uploadsReported: 0 };
    if (numeric(row.impressions)) day.impressions = (day.impressions ?? 0) + row.impressions;
    day.uploadsReported++;
    days.set(row.day, day);
  }
  return [...days.values()];
}

export function reachRowsCsv(bulkReach, videoId = null) {
  const rows = reachRows(bulkReach, videoId).map(({ day, impressionsCtr, ...row }) => ({
    date: day, ...row, impressionsCtrRatio: impressionsCtr,
  }));
  return csvRows(rows, ['date', 'videoId', 'impressions', 'impressionsCtrRatio', 'reportGeneratedAt', 'capturedAt']);
}

function reachEntry(bulkReach, videoId = null) {
  const rows = videoId ? reachRows(bulkReach, videoId) : reachDailyTotals(bulkReach);
  return {
    report: {
      dateRange: rows.length ? {
        start: rows[0].day, end: rows.at(-1).day,
        timezone: bulkReach?.dateRange?.timezone || 'America/Los_Angeles',
      } : null,
      rows,
    },
  };
}

function reachNotice(bulkReach, rows, videoId = null) {
  const hasRows = rows.length > 0;
  const status = {
    ready: 'Reports imported', pending: 'Waiting for Google reports', partial: 'Reach collection incomplete',
    'not-configured': 'Reach reports not started',
  }[bulkReach?.status] || (bulkReach ? 'Reach reports not ready' : 'Reach reports not collected');
  return `<div class="ua-report-status" role="status"><strong>${escapeHTML(status)}</strong>
    ${bulkReach?.checkedAt ? `<span>Last checked ${escapeHTML(stamp(bulkReach.checkedAt))}</span>` : ''}
    ${numeric(bulkReach?.pendingReports) && bulkReach.pendingReports > 0 ? `<span>${number(bulkReach.pendingReports)} reports waiting to import</span>` : ''}</div>
    ${hasRows ? `<p class="ua-note">Reported dates: ${escapeHTML(rangeText(reachEntry(bulkReach, videoId).report.dateRange))}. ${videoId ? 'CTR is Google’s daily ratio shown as a percentage. CSV and JSON retain the native ratio. This is not a thumbnail test result.' : 'Impressions sum the available values for public uploads only. Select an upload below for its daily CTR.'} Missing dates and values are not filled with zeros.</p>` :
    `<p class="ua-empty">${videoId ? 'No thumbnail reach rows are stored for this upload.' : 'No thumbnail reach rows are stored yet.'} Google’s first report can take up to 48 hours. A new reporting job can backfill the preceding 30 days; older CTR is not reconstructed.</p>`}
    ${!videoId && bulkReach?.dateRange ? `<p class="ua-note">Imported report coverage: ${escapeHTML(rangeText(bulkReach.dateRange))}. ${number(bulkReach.availableDates?.length)} daily reports imported, including reports with no public upload rows.</p>` : ''}
    ${hasRows && bulkReach?.status !== 'ready' ? '<p class="ua-note">Available reports keep their original dates while later reports are pending or unavailable.</p>' : ''}`;
}

function statusText(entry) {
  const statuses = {
    collected: 'Collected', 'no-rows': 'No rows returned', failed: 'Report unavailable',
    'failed-retained': 'Refresh failed · earlier report retained',
    'no-rows-retained': 'No new rows · earlier report retained',
  };
  return statuses[entry?.status] || 'Not yet collected';
}
function reportNotice(entry) {
  const report = entry?.report;
  return `<div class="ua-report-status"><strong>${escapeHTML(statusText(entry))}</strong>
    ${report ? `<span>${escapeHTML(rangeText(report.dateRange))}</span><span>Captured ${escapeHTML(stamp(report.capturedAt))}</span>` : ''}
    ${entry?.attemptedAt && entry.status !== 'collected' ? `<span>Last attempted ${escapeHTML(stamp(entry.attemptedAt))} · ${escapeHTML(rangeText(entry.attemptedRange))}</span>` : ''}
    ${entry?.errorCode === 'coverage-loss' ? '<span>The previous report is retained because returned history was incomplete.</span>' : ''}
    </div>${report ? '<p class="ua-note">The end date is the requested report boundary. YouTube may still be processing recent dates. Missing rows are not zero; native averages are not added together.</p>' : '<p class="ua-note">No values have been substituted for unavailable reporting data.</p>'}`;
}

function chart(entry, metric, dimension = 'day') {
  const { points, segments } = uploadSeries(rowsOf(entry), metric, dimension);
  if (!points.length) return '<p class="ua-empty">No numeric rows are available for this metric.</p>';
  const width = 850, height = 280, left = 72, top = 24, right = 22, bottom = 44;
  const minimum = Math.min(0, ...points.map(point => point.y));
  const maximum = Math.max(0, ...points.map(point => point.y)) || (minimum === 0 ? 1 : 0);
  const span = maximum - minimum;
  const first = points[0].x, last = points.at(-1).x;
  const x = value => last === first ? width / 2 : left + (value - first) / (last - first) * (width - left - right);
  const y = value => top + (maximum - value) / span * (height - top - bottom);
  const ticks = [0, 0.5, 1].map(part => maximum - span * part);
  const xLabel = point => dimension === 'day' ? point.source : `${number(point.source * 100)}%`;
  return `<svg class="ua-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(label(metric))} ${dimension === 'day' ? 'by date' : 'by position in video'}. ${points.length} returned rows; exact values in the table below.">
    ${ticks.map(value => `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left - 12}" y="${y(value) + 4}" text-anchor="end">${escapeHTML(formatUploadMetric(metric, value))}</text>`).join('')}
    ${segments.map(segment => `<polyline points="${segment.map(point => `${x(point.x)},${y(point.y)}`).join(' ')}"/>`).join('')}
    ${points.map(point => `<circle cx="${x(point.x)}" cy="${y(point.y)}" r="${points.length > 150 ? 2 : 3}"><title>${escapeHTML(xLabel(point))}: ${escapeHTML(formatUploadMetric(metric, point.y))}</title></circle>`).join('')}
    <text x="${left}" y="${height - 13}">${escapeHTML(xLabel(points[0]))}</text>
    ${points.length > 1 ? `<text x="${width - right}" y="${height - 13}" text-anchor="end">${escapeHTML(xLabel(points.at(-1)))}</text>` : ''}
    </svg><p class="ua-note">${points.length} returned ${dimension === 'day' ? 'days. Gaps remain gaps' : 'video positions'}. Exact native values follow.</p>`;
}

function rowTable(entry, page, kind) {
  const rows = rowsOf(entry);
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  page = Math.min(Math.max(0, page), pages - 1);
  const selected = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return `<div class="ua-table-scroll" tabindex="0" role="region" aria-label="Exact report values">
    <table><caption class="ua-sr-only">Native report rows · ${escapeHTML(rangeText(entry.report.dateRange))}</caption>
    <thead><tr>${columns.map(key => `<th scope="col">${escapeHTML(label(key))}</th>`).join('')}</tr></thead>
    <tbody>${selected.map(row => `<tr>${columns.map((key, index) =>
      `<${index ? 'td' : 'th scope="row"'}>${escapeHTML(numeric(row[key]) ? formatUploadMetric(key, row[key]) : row[key] ?? 'Unavailable')}</${index ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="ua-pagination"><span>Rows ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, rows.length)} of ${rows.length}</span>
    ${pages > 1 ? `<button class="button secondary" type="button" data-action="page" data-kind="${kind}" data-step="-1" ${page === 0 ? 'disabled' : ''}>Previous rows</button>
    <button class="button secondary" type="button" data-action="page" data-kind="${kind}" data-step="1" ${page === pages - 1 ? 'disabled' : ''}>Next rows</button>` : ''}
    <span>CSV includes every returned row.</span></div>`;
}
const options = (values, selected) => Object.entries(values).map(([value, text]) =>
  `<option value="${escapeHTML(value)}"${value === selected ? ' selected' : ''}>${escapeHTML(text)}</option>`).join('');

function saveFile(filename, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountUploadAnalytics(container, { uploadAnalytics = null, channelBreakdowns = null, bulkReach = null } = {}) {
  if (!container) return;
  instances.get(container)?.abort();
  const abort = new AbortController();
  instances.set(container, abort);
  const prefix = `ua-${++instanceNumber}`;
  const videos = Array.isArray(uploadAnalytics?.videos) ? uploadAnalytics.videos : [];
  const availableChannel = Object.fromEntries(Object.entries(CHANNEL_REPORTS).filter(([key]) => channelBreakdowns?.[key]));
  const state = {
    search: '', format: 'all', sort: 'views', selected: null, report: 'daily', metric: 'views', page: 0,
    channel: Object.keys(availableChannel)[0] || '', channelMetric: 'views', channelPage: 0, reachPage: 0,
  };
  const $ = selector => container.querySelector(selector);
  function refreshSelects(target = container) { globalThis.SPSelect?.refresh(target); }
  function current() { return videos.find(video => video.id === state.selected); }
  function focusControl(action) {
    const select = $(`[data-action="${action}"]`);
    (select?.closest('.sp-select')?.querySelector('.sp-select-button') || select)?.focus();
  }
  container.classList.add('upload-analytics');
  const coverage = uploadAnalytics?.coverage;
  container.innerHTML = `<div class="ua-heading"><div><p class="eyebrow">The full upload catalog</p><h2>Every upload, in detail</h2>
    <p class="ua-note">Search public uploads, compare native period totals and open each report’s full returned history.</p></div>
    <div class="ua-actions"><button class="button secondary" type="button" data-action="json">All reports JSON</button>
    <button class="button secondary" type="button" data-action="totals-csv" ${videos.length ? '' : 'disabled'}>All upload totals CSV</button></div></div>
    <section class="ua-reach" aria-labelledby="${prefix}-reach-heading"><div class="ua-heading">
    <div><p class="eyebrow">YouTube Reporting API</p><h3 id="${prefix}-reach-heading">Thumbnail reach</h3></div>
    <button class="button secondary" type="button" data-action="reach-csv" ${reachRows(bulkReach).length ? '' : 'disabled'}>Reach rows CSV</button></div>
    <div data-slot="reach"></div></section>
    ${videos.length ? `<div class="ua-coverage"><strong>${videos.length} verified public uploads</strong>
    <span>${coverage?.inventoryComplete ? 'Inventory matches the channel’s public upload count at capture.' :
      `Partial inventory${numeric(coverage?.channelPublicVideoCount) ? ` · channel reports ${coverage.channelPublicVideoCount} public uploads` : ' · native channel count unavailable'}.`}</span>
    <span>Requested history: ${escapeHTML(rangeText(uploadAnalytics.dateRange))}</span>
    <span>Snapshot: ${escapeHTML(stamp(uploadAnalytics.capturedAt))}</span></div>
    <div class="ua-controls"><label class="ua-search" for="${prefix}-search">Find an upload<input id="${prefix}-search" data-action="search" type="search" placeholder="Search title or video ID"></label>
    <label for="${prefix}-format">Format<select id="${prefix}-format" data-action="format">${options({ all: 'All formats', ...FORMATS }, 'all')}</select></label>
    <label for="${prefix}-sort">Sort by<select id="${prefix}-sort" data-action="sort">${options({ views: 'Period views', engagedViews: 'Engaged views', estimatedMinutesWatched: 'Watch time', published: 'Newest published', title: 'Title' }, state.sort)}</select></label></div>
    <p class="ua-note" data-slot="count" aria-live="polite"></p><div data-slot="catalog"></div><div data-slot="detail"></div>` :
    '<div class="ua-empty">The complete upload report has not been collected yet. Existing episode and channel reports remain in Analytics. An approved team member can use Refresh to collect the upload catalog.</div>'}
    ${Object.keys(availableChannel).length ? `<section class="ua-channel"><div class="ua-heading"><div><p class="eyebrow">Channel report library</p><h3>More ways to explore the channel</h3></div>
    <label for="${prefix}-channel">Report<select id="${prefix}-channel" data-action="channel">${options(availableChannel, state.channel)}</select></label></div>
    <div data-slot="channel"></div></section>` : ''}`;

  function renderCatalog() {
    if (!$('[data-slot="catalog"]')) return;
    const filtered = filterUploads(videos, state);
    $('[data-slot="count"]').textContent = `${filtered.length} of ${videos.length} uploads shown. Period metrics use each row’s report dates.`;
    $('[data-slot="catalog"]').innerHTML = filtered.length ? `<div class="ua-table-scroll ua-catalog" tabindex="0" role="region" aria-label="Public upload catalog"><table>
      <thead><tr><th scope="col">Upload</th><th scope="col">Format</th><th scope="col">Views</th><th scope="col">Engaged views</th><th scope="col">Watch time<br>(minutes)</th><th scope="col">Report dates / status</th></tr></thead>
      <tbody>${filtered.map(video => {
        const totals = rowsOf(video.aggregate)[0] || {};
        const image = youtubeThumbnailPreview(thumbnail(video), video.id);
        return `<tr${video.id === state.selected ? ' class="ua-selected"' : ''}><th scope="row"><button type="button" class="ua-video" data-action="video" data-id="${escapeHTML(video.id)}" aria-pressed="${video.id === state.selected}">
          ${image ? `<img src="${escapeHTML(image)}" data-youtube-video="${escapeHTML(video.id)}" alt="" loading="lazy">` : ''}<span>${escapeHTML(video.title)}<small>Published ${escapeHTML(video.publishedAt?.slice(0, 10))} · ${escapeHTML(video.id)}</small></span></button></th>
          <td>${escapeHTML(FORMATS[video.creatorContentType] || 'Unclassified')}</td><td>${number(totals.views)}</td><td>${number(totals.engagedViews)}</td><td>${number(totals.estimatedMinutesWatched)}</td>
          <td><span>${escapeHTML(statusText(video.aggregate))}</span><small>${escapeHTML(rangeText(video.aggregate?.report?.dateRange))}</small></td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="ua-empty">No uploads match these filters.</p>';
  }
  function metadata(video) {
    return `<details class="ua-metadata"><summary>Title, description, tags and saved packaging history</summary>
      <p class="ua-note">Metadata observed ${escapeHTML(stamp(video.metadataCapturedAt || uploadAnalytics.capturedAt))}. Saved observations show when packaging was captured, not its exact change time.</p>
      <h4>Current description</h4><p class="ua-description">${escapeHTML(video.description ?? 'Not collected')}</p>
      <h4>Current tags</h4><p>${escapeHTML(Array.isArray(video.tags) ? video.tags.join(' · ') || 'No tags returned' : 'Not collected')}</p>
      ${(video.metadataHistory || []).length ? `<h4>Saved observations (${video.metadataHistory.length})</h4>${video.metadataHistory.map(item => {
        const image = thumbnail({ ...video, thumbnail: item.thumbnail });
        return `<details><summary>${escapeHTML(stamp(item.capturedAt))} · ${escapeHTML(item.title)}</summary>
        ${image ? `<img class="ua-history-thumbnail" data-archived-thumbnail src="${escapeHTML(image)}" alt="Image from the stored thumbnail URL" loading="lazy"><p class="ua-note">This is the stored YouTube thumbnail URL. YouTube can update its image; it is not an archived image file.</p>` : ''}
        <p class="ua-description">${escapeHTML(item.description)}</p>
        <p>Tags: ${escapeHTML((item.tags || []).join(' · ') || 'No tags returned')}</p></details>`;
      }).join('')}` : '<p class="ua-note">No earlier packaging observations are stored.</p>'}
      </details>`;
  }
  function renderDetail() {
    const video = current(), host = $('[data-slot="detail"]');
    if (!host) return;
    if (!video) { host.innerHTML = '<p class="ua-note ua-select-prompt">Choose an upload to view every collected metric and its individual reports.</p>'; return; }
    const aggregate = rowsOf(video.aggregate)[0];
    host.innerHTML = `<article class="ua-detail"><div class="ua-heading"><div><p class="eyebrow">${escapeHTML(FORMATS[video.creatorContentType] || 'Unclassified')} · individual report</p>
      <h3 tabindex="-1" data-slot="video-heading">${escapeHTML(video.title)}</h3></div>
      ${safeId(video.id) ? `<a class="button secondary" href="https://www.youtube.com/watch?v=${video.id}" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>` : ''}</div>
      <p class="ua-note">Published ${escapeHTML(stamp(video.publishedAt))} · Duration ${numeric(video.durationSeconds) ? `${number(video.durationSeconds)} seconds` : 'unavailable'}</p>
      <h4>Native period totals and averages</h4>${reportNotice(video.aggregate)}
      ${aggregate ? `<dl class="ua-metrics">${Object.entries(aggregate).map(([key, value]) => `<div><dt>${escapeHTML(label(key))}</dt><dd>${number(value)}</dd></div>`).join('')}</dl>` : ''}
      ${metadata(video)}
      <div class="ua-controls ua-detail-controls"><label for="${prefix}-report">Individual report<select id="${prefix}-report" data-action="report">${options(REPORTS, state.report)}</select></label>
      <label for="${prefix}-metric" data-slot="metric-label">Metric<select id="${prefix}-metric" data-action="metric"></select></label>
      <button class="button secondary" type="button" data-action="report-csv">This report CSV</button></div><div data-slot="report"></div></article>`;
    renderReport();
    refreshSelects(host);
  }
  function renderReport() {
    const video = current();
    if (!video) return;
    const isReach = state.report === 'reach';
    const entry = isReach ? reachEntry(bulkReach, video.id) : video[state.report], rows = rowsOf(entry);
    const metrics = Object.keys(rows[0] || {}).filter(key => Object.hasOwn(METRICS, key));
    if (!metrics.includes(state.metric)) state.metric = metrics[0] || 'views';
    const select = $('[data-action="metric"]');
    select.innerHTML = options(Object.fromEntries(metrics.map(key => [key, label(key)])), state.metric);
    select.disabled = !metrics.length;
    $('[data-slot="metric-label"]').hidden = state.report === 'traffic';
    $('[data-slot="report"]').innerHTML = `${isReach ? reachNotice(bulkReach, rows, video.id) : reportNotice(entry)}
      ${rows.length && state.report !== 'traffic' ? chart(entry, state.metric, state.report === 'retention' ? 'elapsedVideoTimeRatio' : 'day') : ''}
      ${rowTable(entry, state.page, 'video')}`;
    refreshSelects(select);
  }
  function renderReach() {
    const entry = reachEntry(bulkReach), rows = rowsOf(entry);
    const nativeRows = reachRows(bulkReach);
    const uploads = new Set(nativeRows.map(row => row.videoId)).size;
    const impressions = rows.map(row => row.impressions).filter(numeric);
    $('[data-slot="reach"]').innerHTML = `${reachNotice(bulkReach, rows)}
      ${rows.length ? `<dl class="ua-metrics ua-reach-metrics">
      <div><dt>Reported thumbnail impressions</dt><dd>${number(impressions.length ? impressions.reduce((total, value) => total + value, 0) : null)}</dd></div>
      <div><dt>Public uploads with reach rows</dt><dd>${number(uploads)}</dd></div>
      <div><dt>Dates with public reach rows</dt><dd>${number(rows.length)}</dd></div></dl>
      ${chart(entry, 'impressions')}
      <details class="ua-reach-table"><summary>Daily impressions and coverage</summary>${rowTable(entry, state.reachPage, 'reach')}</details>` : ''}`;
  }
  function renderChannel() {
    const host = $('[data-slot="channel"]');
    if (!host) return;
    const entry = channelBreakdowns[state.channel], rows = rowsOf(entry);
    const metrics = Object.keys(rows[0] || {}).filter(key => Object.hasOwn(METRICS, key));
    if (!metrics.includes(state.channelMetric)) state.channelMetric = metrics[0] || 'views';
    host.innerHTML = `${reportNotice(entry)}<div class="ua-controls">
      ${rows[0]?.day ? `<label for="${prefix}-channel-metric">Metric<select id="${prefix}-channel-metric" data-action="channel-metric">${options(Object.fromEntries(metrics.map(key => [key, label(key)])), state.channelMetric)}</select></label>` : ''}
      <button class="button secondary" type="button" data-action="channel-csv">Channel report CSV</button></div>
      ${rows[0]?.day ? chart(entry, state.channelMetric) : ''}${rowTable(entry, state.channelPage, 'channel')}
      ${['searchTerms', 'externalSources', 'suggestedVideos'].includes(state.channel) ? '<p class="ua-note">This detailed source report requests the top 25 returned rows by views. It is not a complete list of every source.</p>' : ''}`;
    refreshSelects(host);
  }
  container.addEventListener('input', event => {
    if (event.target.dataset.action === 'search') { state.search = event.target.value; renderCatalog(); }
  }, { signal: abort.signal });
  container.addEventListener('change', event => {
    const action = event.target.dataset.action;
    if (action === 'format' || action === 'sort') { state[action] = event.target.value; renderCatalog(); }
    if (action === 'report') { state.report = event.target.value; state.page = 0; renderReport(); }
    if (action === 'metric') { state.metric = event.target.value; renderReport(); focusControl('metric'); }
    if (action === 'channel') { state.channel = event.target.value; state.channelPage = 0; renderChannel(); }
    if (action === 'channel-metric') { state.channelMetric = event.target.value; renderChannel(); focusControl('channel-metric'); }
  }, { signal: abort.signal });
  container.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button || !container.contains(button)) return;
    const action = button.dataset.action;
    if (action === 'video') {
      state.selected = button.dataset.id; state.page = 0;
      renderCatalog(); renderDetail(); $('[data-slot="video-heading"]')?.focus();
    }
    if (action === 'page') {
      const field = button.dataset.kind === 'channel' ? 'channelPage' : button.dataset.kind === 'reach' ? 'reachPage' : 'page';
      state[field] = Math.max(0, state[field] + Number(button.dataset.step));
      if (field === 'page') renderReport(); else if (field === 'reachPage') {
        renderReach(); $('[data-slot="reach"] details').open = true;
      } else renderChannel();
      $(`[data-slot="${field === 'page' ? 'report' : field === 'reachPage' ? 'reach' : 'channel'}"] .ua-table-scroll`)?.focus();
    }
    const video = current();
    if (action === 'json') saveFile('scran-pints-upload-reports.json',
      JSON.stringify({ exportedAt: new Date().toISOString(), uploadAnalytics, channelBreakdowns, bulkReach }, null, 2), 'application/json');
    if (action === 'totals-csv') saveFile('scran-pints-all-upload-totals.csv', uploadTotalsCsv(videos), 'text/csv;charset=utf-8');
    if (action === 'report-csv' && video) saveFile(`scran-pints-${video.id}-${state.report}.csv`,
      state.report === 'reach' ? reachRowsCsv(bulkReach, video.id) :
        reportRowsCsv(video[state.report], { videoId: video.id, title: video.title, reportType: state.report }), 'text/csv;charset=utf-8');
    if (action === 'reach-csv') saveFile('scran-pints-thumbnail-reach.csv', reachRowsCsv(bulkReach), 'text/csv;charset=utf-8');
    if (action === 'channel-csv') saveFile(`scran-pints-channel-${state.channel}.csv`,
      reportRowsCsv(channelBreakdowns[state.channel], { reportType: state.channel }), 'text/csv;charset=utf-8');
  }, { signal: abort.signal });
  renderCatalog(); renderChannel(); renderReach(); refreshSelects();
  return () => { abort.abort(); if (instances.get(container) === abort) instances.delete(container); };
}
