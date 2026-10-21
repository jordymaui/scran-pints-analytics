import { buildAllSocialAnalytics } from '/lib/sponsor-aggregate.mjs';

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const number = value => Number.isFinite(value) ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value) : '—';
const compact = value => Number.isFinite(value) ? new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
const date = value => validDay(value?.slice(0, 10)) ? new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${value.slice(0, 10)}T12:00:00Z`)) : 'Date unavailable';
const shortDate = value => validDay(value) ? new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', timeZone: 'UTC',
}).format(new Date(`${value}T12:00:00Z`)) : '—';
const addDays = (value, amount) => new Date(Date.parse(`${value}T12:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
const rangeLabel = range => range?.start && range?.end ? `${date(range.start)} – ${date(range.end)}` : 'Dates unavailable';

// Calendar windows remain equal. Missing native rows never become invented zeroes.
export function comparePeriods(performance, days, key) {
  if (!validDay(performance?.dateRange?.end) || ![7, 14, 28, 90, 365].includes(days)) return null;
  const end = performance.dateRange.end, start = addDays(end, 1 - days);
  const previousEnd = addDays(start, -1), previousStart = addDays(start, -days);
  const rows = new Map((performance.daily || []).map(row => [row.date, row]));
  const sum = first => {
    const values = Array.from({ length: days }, (_, index) => rows.get(addDays(first, index))?.[key]);
    const reported = values.filter(Number.isFinite);
    return { value: reported.length ? reported.reduce((total, value) => total + value, 0) : null,
      days: reported.length, complete: reported.length === days };
  };
  const current = sum(start), previous = sum(previousStart);
  const complete = current.complete && previous.complete && previousStart >= performance.dateRange.start;
  const change = complete ? current.value - previous.value : null;
  return { current, previous, complete, change, start, end, previousStart, previousEnd,
    percent: complete && previous.value !== 0 ? change / Math.abs(previous.value) * 100 : null };
}

export function cumulativeViews(performance) {
  let total = 0;
  return [...(performance?.daily || [])].filter(row => validDay(row.date)).sort((a, b) => a.date.localeCompare(b.date))
    .map(row => ({ date: row.date, value: Number.isFinite(row.views) ? (total += row.views) : null }));
}

// Native viewer percentages retain their original denominator and rounding.
export function audienceGroups(rows, dimension) {
  const result = new Map();
  for (const row of rows || []) {
    if (typeof row[dimension] !== 'string' || !Number.isFinite(row.viewerPercentage)) continue;
    result.set(row[dimension], (result.get(row[dimension]) || 0) + row.viewerPercentage);
  }
  return [...result].map(([key, value]) => ({ key, value }));
}

const socialPlatforms = [
  { id: 'youtube-longform', label: 'YouTube', detail: 'All formats · includes Shorts' },
  { id: 'instagram', label: 'Instagram', detail: 'Reels & posts' },
  { id: 'tiktok', label: 'TikTok', detail: 'Public videos' },
];
function platformLogo(id) {
  if (id === 'footyscran') return '<img class="yeet-platform-logo yeet-footyscran-logo" src="/assets/platforms/footyscran.jpg" width="24" height="24" alt="" aria-hidden="true">';
  const platform = { 'youtube-longform': 'youtube', youtube: 'youtube', instagram: 'instagram', tiktok: 'tiktok' }[id];
  if (platform) return `<img class="yeet-platform-logo" src="/assets/platforms/${platform}.svg" width="24" height="24" alt="" aria-hidden="true">`;
  return id === 'all' ? '<svg class="yeet-all-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' : '';
}
export function sponsorSources(value) {
  return socialPlatforms.map(platform => ({ ...platform,
    source: value?.sources?.find(item => item.id === platform.id) || null }));
}
export function collaborationSummary(capture) {
  const posts = capture?.posts || [];
  const summarize = entries => {
    const counted = entries.filter(post => Number.isFinite(post.views) && ['exact', 'rounded'].includes(post.viewsPrecision));
    const roundedPosts = counted.filter(post => post.viewsPrecision === 'rounded').length;
    const complete = entries.length > 0 && counted.length === entries.length;
    return { observedPosts: entries.length, countedPosts: counted.length, roundedPosts,
      exactPosts: counted.length - roundedPosts, missingPosts: entries.length - counted.length,
      complete, approximate: roundedPosts > 0,
      totalViews: complete ? counted.reduce((sum, post) => sum + post.views, 0) : null };
  };
  return { ...summarize(posts), groups: {
    collaboration: summarize(posts.filter(post => post.relationship !== 'campaign-post')),
    'campaign-post': summarize(posts.filter(post => post.relationship === 'campaign-post')),
  } };
}
export function sourcePerformance(value) {
  if (value?.id === 'tiktok' && value.studioSupplement?.performance) {
    const studio = value.studioSupplement.performance;
    return { ...studio, studio: true,
      daily: studio.daily.map(row => ({ ...row, subscribersNet: row.netFollowers ?? null })),
    };
  }
  if (value?.performance) return value.performance;
  if (!value?.dateRange || !Array.isArray(value.daily) || !value.daily.some(row => Number.isFinite(row.views))) return null;
  return { capturedAt: value.capturedAt,
    dateRange: { start: value.dateRange.start, end: value.dateRange.end, timeZone: value.dateRange.timezone },
    // Social public-content totals and account daily views have different
    // scopes. Never reuse lifetime counters as native period aggregates.
    totals: {}, daily: value.daily.map(row => ({ date: row.date || row.day,
      ...Object.fromEntries(['views', 'watchHours', 'likes', 'comments', 'shares', 'subscribersNet']
        .map(key => [key, Number.isFinite(row[key]) ? row[key] : null])) })),
  };
}
const studioMetricDefinitions = [
  ['views', 'Views'], ['profileViews', 'Profile views'], ['likes', 'Likes'], ['comments', 'Comments'],
  ['shares', 'Shares'], ['netFollowers', 'Net followers'], ['followers', 'Followers'],
  ['totalViewers', 'Viewers'], ['newViewers', 'New viewers'], ['returningViewers', 'Returning viewers'],
];
export function metricPerformance(performance, key = 'views') {
  if (!performance) return null;
  const family = ['followers', 'netFollowers', 'subscribersNet'].includes(key) ? 'followers'
    : ['totalViewers', 'newViewers', 'returningViewers'].includes(key) ? 'viewers' : 'overview';
  const dateRange = performance.seriesRanges?.[family] || performance.dateRange;
  return { ...performance, dateRange, daily: performance.daily.filter(row => row.date >= dateRange.start && row.date <= dateRange.end) };
}
export function trendPoints(performance, key = 'views', days = null, cumulative = false) {
  if (!performance?.dateRange) return [];
  const end = performance.dateRange.end, start = days ? addDays(end, 1 - days) : performance.dateRange.start;
  let total = 0;
  return [...performance.daily].filter(row => row.date >= start && row.date <= end).sort((a, b) => a.date.localeCompare(b.date))
    .map(row => ({ date: row.date, value: Number.isFinite(row[key]) ? cumulative ? (total += row[key]) : row[key] : null }));
}
export function hasSourceSnapshot(value) {
  return value?.status === 'snapshot' && Boolean(value.metrics || value.performance);
}
export function audienceShares(rows) {
  const valid = (rows || []).filter(row => typeof row.label === 'string' && Number.isFinite(row.count) && row.count >= 0);
  const total = valid.reduce((sum, row) => sum + row.count, 0);
  return total > 0 ? valid.map(row => ({ ...row, share: row.count / total * 100 })) : [];
}
export function studioPercentage(row) {
  const threshold = row?.percentage === null && Number.isFinite(row?.lessThan);
  const value = threshold ? row.lessThan : row?.percentage;
  return { label: Number.isFinite(value) ? `${threshold ? '<' : ''}${number(value)}%` : 'Unavailable',
    width: Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0, threshold };
}
function studioPercentageBars(rows, label = value => value) {
  return `<div class="yeet-horizontal-bars">${rows.map(row => {
    const formatted = studioPercentage(row);
    return `<div class="yeet-bar-row"><div><span>${escapeHTML(label(row.label))}</span><strong>${escapeHTML(formatted.label)}</strong></div><div class="yeet-bar-track ${formatted.threshold ? 'is-threshold' : ''}" aria-hidden="true"><i style="width:${formatted.width}%"></i></div></div>`;
  }).join('')}</div>`;
}
function sourceName(value) { return socialPlatforms.find(platform => platform.id === value?.id)?.label || 'This platform'; }
function viewScope(value) {
  if (value?.manualCapture?.windows?.length) return `${[...value.manualCapture.windows].sort((a, b) => b.periodDays - a.periodDays)[0].label} · manual capture`;
  if (value?.counterScope === 'public-channel') return 'Lifetime channel views';
  if (value?.counterScope === 'public-content-lifetime' || value?.id === 'tiktok' &&
      value?.provenance?.label === 'TikTok Display API v2 — public video lifetime counters') return 'Lifetime views · reported posts';
  return value?.dateRange ? `Reported views · ${shortDate(value.dateRange.start)} – ${shortDate(value.dateRange.end)}` : 'Views unavailable';
}
function sourceSummary() {
  return `<div class="yeet-social-summary" aria-label="Connected social performance">${sponsorSources(report).map(platform => {
    const available = hasSourceSnapshot(platform.source);
    const observedViews = platform.source?.manualCapture?.windows?.length
      ? [...platform.source.manualCapture.windows].sort((a, b) => b.periodDays - a.periodDays)[0].views : platform.source?.metrics?.views;
    return `<button type="button" class="yeet-social-card ${platform.id === selectedSource ? 'selected' : ''}" data-yeet-source="${platform.id}" aria-pressed="${platform.id === selectedSource}"><span class="yeet-social-heading"><span class="yeet-platform-mark" aria-hidden="true">${platformLogo(platform.id)}</span><strong>${platform.label}</strong><span class="yeet-connection-state ${available ? 'connected' : ''}">${available ? 'Report saved' : 'Pending'}</span></span>${available ? `<span class="yeet-social-views">${compact(observedViews)} <small>views</small></span><span class="yeet-social-detail">${escapeHTML(viewScope(platform.source))}</span><span class="yeet-social-followers">${compact(platform.source.metrics?.followers)} ${platform.id === 'youtube-longform' ? 'subscribers' : 'followers'} · ${escapeHTML(date(platform.source.capturedAt))}</span>` : `<span class="yeet-social-pending">Connection pending</span><span class="yeet-social-detail">${platform.detail}</span>`}</button>`;
  }).join('')}</div>`;
}
function sourceTabs() {
  return `<div class="yeet-platform-tabs" role="group" aria-label="Select reporting platform">${[{ id: 'all', label: 'All socials' }, ...socialPlatforms, { id: 'footyscran', label: 'FootyScran' }].map(platform => `<button type="button" data-yeet-source="${platform.id}" aria-pressed="${platform.id === selectedSource}">${platformLogo(platform.id)}<span>${platform.label}</span></button>`).join('')}</div>`;
}

const icons = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  videos: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4Z"/>',
  studio: '<path d="m14 3 7 7-11 11H3v-7Z"/><path d="m11 6 7 7M5 16l3 3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z"/>',
};
const icon = key => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[key]}</svg>`;
function sidebar() {
  return `<aside class="sidebar"><a class="brand" href="/" aria-label="Scran and Pints overview"><img src="/assets/optimized/3f526c1560f0-480.webp" width="128" height="58" alt="Scran & Pints"></a><div class="workspace-label">ANALYTICS</div><nav aria-label="Main navigation">${[
    ['overview', 'Overview', '/'], ['videos', 'Videos', '/?page=videos'], ['studio', 'Studio', '/workshop.html'],
  ].map(([key, label, href]) => `<a class="nav-item" href="${href}" title="${label}">${icon(key)}<span>${label}</span></a>`).join('')}<a class="nav-item active" href="/sponsor.html" aria-current="page" aria-label="YEET" title="YEET"><span class="yeet-nav-mark"><img src="/assets/yeet-logo.svg" width="72" height="20" alt="YEET"></span></a></nav><div class="sidebar-bottom"><a class="nav-item" href="/connections.html" title="Connections">${icon('settings')}<span>Connections</span></a><a href="https://scranpints.com" target="_blank" rel="noreferrer">scranpints.com ↗</a></div></aside>`;
}

function metricCard(label, value, note, unit = '') {
  return `<div class="yeet-stat"><span>${label}</span><strong title="${escapeHTML(number(value))}">${compact(value)}${unit && Number.isFinite(value) ? `<small>${unit}</small>` : ''}</strong><p>${escapeHTML(note)}</p></div>`;
}

function cumulativeChart(performance, { metric = 'views', days = null, cumulative = true } = {}) {
  const rows = trendPoints(performance, metric, days, cumulative), finite = rows.filter(row => Number.isFinite(row.value));
  const metricLabel = studioMetricDefinitions.find(([key]) => key === metric)?.[1] || 'Views';
  if (!finite.length) return `<div class="yeet-no-data">${metricLabel} have not been returned for these dates.</div>`;
  const sidebarWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar')) || 0;
  const pageWidth = document.querySelector('.yeet-page')?.clientWidth || window.innerWidth - sidebarWidth;
  const width = Math.max(270, Math.min(1300, pageWidth - 80));
  const height = 255, left = width < 400 ? 43 : 57, right = 15, top = 18, bottom = 37;
  const first = Date.parse(finite[0].date), last = Date.parse(finite.at(-1).date), min = Math.min(0, ...finite.map(row => row.value)), max = Math.max(1, ...finite.map(row => row.value));
  const x = day => left + (Date.parse(day) - first) / Math.max(86_400_000, last - first) * (width - left - right);
  const y = value => top + (1 - (value - min) / (max - min)) * (height - top - bottom);
  const groups = []; let group = [];
  for (const row of rows) {
    if (!Number.isFinite(row.value) || group.length && Date.parse(row.date) - Date.parse(group.at(-1).date) > 86_400_000) {
      if (group.length) groups.push(group); group = [];
    }
    if (Number.isFinite(row.value)) group.push(row);
  }
  if (group.length) groups.push(group);
  const labels = [0, Math.floor((finite.length - 1) / 2), finite.length - 1].filter((value, index, values) => values.indexOf(value) === index);
  return `<div class="yeet-chart-wrap"><svg class="yeet-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="yeet-views-title yeet-views-description"><title id="yeet-views-title">${cumulative ? 'Cumulative ' : 'Daily '}${escapeHTML(sourceName(source()))} ${metricLabel.toLowerCase()}</title><desc id="yeet-views-description">${number(finite.at(-1).value)} ${metricLabel.toLowerCase()} at the final point, across ${finite.length} reported days, ${date(finite[0].date)} to ${date(finite.at(-1).date)}. Missing dates remain gaps.</desc>${[0, .25, .5, .75, 1].map(part => `<line x1="${left}" x2="${width - right}" y1="${y(min + (max - min) * part)}" y2="${y(min + (max - min) * part)}" class="yeet-grid-line"/><text x="${left - 10}" y="${y(min + (max - min) * part) + 4}" text-anchor="end">${compact(min + (max - min) * part)}</text>`).join('')}${groups.map(points => `<path class="yeet-chart-fill" d="M${x(points[0].date)},${y(0)} L${points.map(row => `${x(row.date)},${y(row.value)}`).join(' L')} L${x(points.at(-1).date)},${y(0)}Z"/><path class="yeet-chart-line" d="M${points.map(row => `${x(row.date)},${y(row.value)}`).join(' L')}"/>`).join('')}${finite.map(row => `<circle class="yeet-chart-point" cx="${x(row.date)}" cy="${y(row.value)}" r="5" tabindex="0" aria-label="${escapeHTML(date(row.date))}: ${number(row.value)} ${cumulative ? 'cumulative ' : ''}${metricLabel.toLowerCase()}"><title>${date(row.date)} · ${number(row.value)} ${metricLabel.toLowerCase()}</title></circle>`).join('')}${labels.map((index, order) => `<text x="${x(finite[index].date)}" y="${height - 9}" text-anchor="${order === 0 ? 'start' : order === labels.length - 1 ? 'end' : 'middle'}">${shortDate(finite[index].date)}</text>`).join('')}</svg></div>`;
}

function changeLabel(comparison, key) {
  if (!comparison.complete) return '<span class="yeet-change neutral">Comparison needs complete daily reports</span>';
  const { change, percent } = comparison;
  const followerMetric = key === 'subscribersNet' || key === 'netFollowers';
  const text = followerMetric || percent === null
    ? `${change > 0 ? '+' : ''}${number(change)}${followerMetric ? selectedSource === 'youtube-longform' ? ' subscribers' : ' followers' : change === 0 ? ' · no change' : ' vs previous'}`
    : `${percent > 0 ? '+' : ''}${number(percent)}%`;
  return `<span class="yeet-change ${change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral'}">${change > 0 ? '↗ ' : change < 0 ? '↘ ' : ''}${text}</span>`;
}

function growthCard(performance, days, key, label, unit = '') {
  const comparison = comparePeriods(performance, days, key);
  if (!comparison) return `<article class="yeet-growth-card"><h3>${label}</h3><p class="yeet-muted">Daily report unavailable.</p></article>`;
  const { current, previous } = comparison;
  const values = [current.value, previous.value].filter(Number.isFinite), negative = values.some(value => value < 0);
  const min = Math.min(0, ...values), max = Math.max(0, ...values), scale = Math.max(1, max - min);
  const zero = (0 - min) / scale * 100;
  const bar = (item, isCurrent) => {
    const position = Number.isFinite(item.value) ? (item.value - min) / scale * 100 : zero;
    return `<div class="yeet-comparison-row"><div><span>${isCurrent ? 'Latest' : 'Previous'}</span><strong>${number(item.value)}${unit && Number.isFinite(item.value) ? ` ${unit}` : ''}</strong></div><div class="yeet-comparison-track ${isCurrent ? 'current' : 'previous'}" aria-hidden="true"><i style="left:${Math.min(position, zero)}%;width:${Math.abs(position - zero)}%"></i>${negative ? `<b style="left:${zero}%"></b>` : ''}</div>${item.complete ? '' : `<small>${item.days}/${days} days reported</small>`}</div>`;
  };
  return `<article class="yeet-growth-card"><div class="yeet-growth-title"><h3>${label}</h3>${changeLabel(comparison, key)}</div>${bar(current, true)}${bar(previous, false)}</article>`;
}

function countryName(code) {
  if (code === 'ZZ') return 'Unknown';
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch { return code; }
}
function reportNote(entry) {
  if (!entry?.report) return 'Report not available yet.';
  return `${rangeLabel(entry.report.dateRange)}${String(entry.status).includes('retained') ? ' · previous saved report' : ''}`;
}
function countryChart(entry) {
  const rows = entry?.report?.rows || [];
  const total = rows.reduce((sum, row) => sum + row.views, 0);
  if (!rows.length || !total) return '<div class="yeet-no-data">Geographic data has not been returned for this report.</div>';
  const ranked = [...rows].sort((a, b) => b.views - a.views).slice(0, 8);
  return `<div class="yeet-horizontal-bars">${ranked.map(row => `<div class="yeet-bar-row"><div><span>${escapeHTML(countryName(row.country))}</span><strong>${number(row.views / total * 100)}%</strong></div><div class="yeet-bar-track" aria-hidden="true"><i style="width:${row.views / total * 100}%"></i></div></div>`).join('')}</div><p class="yeet-chart-note">Top ${ranked.length} of ${rows.length} reported countries · share of reported geographic views.</p>`;
}
function ageChart(entry) {
  const groups = audienceGroups(entry?.report?.rows, 'ageGroup').sort((a, b) => a.key.localeCompare(b.key));
  if (!groups.length) return '<div class="yeet-no-data">Age data has not been returned for this report.</div>';
  return `<div class="yeet-horizontal-bars">${groups.map(row => `<div class="yeet-bar-row"><div><span>${escapeHTML(row.key.replace(/^age/, '').replace(/^65-?$/, '65+').replace('-', '–'))}</span><strong>${number(row.value)}%</strong></div><div class="yeet-bar-track" aria-hidden="true"><i style="width:${Math.min(100, row.value)}%"></i></div></div>`).join('')}</div>`;
}
function genderChart(entry) {
  const groups = audienceGroups(entry?.report?.rows, 'gender').sort((a, b) => b.value - a.value);
  if (!groups.length) return '<div class="yeet-no-data">Gender data has not been returned for this report.</div>';
  const labels = { male: 'Male', female: 'Female', user_specified: 'User specified', genderUserSpecified: 'User specified' };
  return `<div class="yeet-gender-chart"><div class="yeet-gender-track" aria-hidden="true">${groups.map((row, index) => `<i class="yeet-gender-${index}" style="width:${Math.min(100, row.value)}%"></i>`).join('')}</div><div class="yeet-gender-legend">${groups.map((row, index) => `<div><i class="yeet-gender-${index}" aria-hidden="true"></i><span>${escapeHTML(labels[row.key] || row.key)}</span><strong>${number(row.value)}%</strong></div>`).join('')}</div></div>`;
}

// A public refresh has one fixed provider/account on the server. Joining an
// existing run waits for a new completion, rather than treating a saved report
// or an idle lease as proof that fresh YouTube data was collected.
export async function syncPublicYouTube({ request = fetch, now = Date.now,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  timeout = 285_000 } = {}) {
  const startedAt = now(), deadline = startedAt + timeout;
  const read = async method => {
    const remaining = deadline - now();
    if (remaining <= 0) throw Error('Refresh timed out');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, method === 'GET' ? 15_000 : timeout));
    try {
      const response = await request('/api/public-refresh', { method, cache: 'no-store', credentials: 'omit', signal: controller.signal });
      const result = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('Invalid refresh response');
      if (!response.ok && !['busy', 'recent', 'failed'].includes(result.status)) throw Error('Refresh failed');
      return result;
    } finally { clearTimeout(timer); }
  };
  const result = await read('POST');
  if (['refreshed', 'partial', 'recent', 'failed'].includes(result.status)) return result;
  if (result.status !== 'busy') throw Error('Invalid refresh response');
  let baseline = Date.parse(result.lastSync?.completedAt), retriedAfterIdle = false;
  while (now() < deadline) {
    await wait(Math.min(3_000, deadline - now()));
    const saved = await read('GET');
    if (typeof saved.running !== 'boolean') throw Error('Invalid refresh status');
    const completedAt = Date.parse(saved.lastSync?.completedAt);
    const advanced = Number.isFinite(completedAt) && (Number.isFinite(baseline)
      ? completedAt > baseline : completedAt >= startedAt);
    if (saved.running) continue;
    if (!advanced) {
      // Shorts uses the same provider lease but does not complete a channel
      // report. Once that lease is free, start the requested channel sync.
      if (!retriedAfterIdle) {
        retriedAfterIdle = true;
        const retried = await read('POST');
        if (['refreshed', 'partial', 'recent', 'failed'].includes(retried.status)) return retried;
        if (retried.status !== 'busy') throw Error('Invalid refresh response');
        const retriedBaseline = Date.parse(retried.lastSync?.completedAt);
        if (Number.isFinite(retriedBaseline)) baseline = retriedBaseline;
      }
      continue;
    }
    const status = saved.lastSync?.status === 'ready'
      ? saved.lastSync.errorCode === 'partial_refresh' ? 'partial' : 'refreshed' : 'failed';
    return { ...saved, status };
  }
  throw Error('Refresh timed out');
}

export async function syncPublicSocial({ request = fetch, now = Date.now,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), timeout = 285_000 } = {}) {
  const deadline = now() + timeout;
  const read = async method => {
    const remaining = deadline - now();
    if (remaining <= 0) throw Error('Refresh timed out');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(remaining, method === 'GET' ? 15_000 : timeout));
    try {
      const response = await request('/api/public-social-refresh', { method, cache: 'no-store', credentials: 'omit', signal: controller.signal });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body?.sources) || body.sources.some(entry => !['instagram', 'tiktok'].includes(entry.id))) throw Error('Social refresh unavailable');
      return body.sources;
    } finally { clearTimeout(timer); }
  };
  const entries = await read('POST');
  const pending = new Map(entries.filter(entry => entry.status === 'busy').map(entry => [entry.id, entry.capturedAt]));
  while (pending.size && now() < deadline) {
    await wait(Math.min(3_000, deadline - now()));
    const saved = await read('GET');
    for (const [id, baseline] of pending) {
      const entry = saved.find(value => value.id === id);
      if (!entry || entry.running) continue;
      const advanced = Number.isFinite(Date.parse(entry.capturedAt)) && (!baseline || Date.parse(entry.capturedAt) > Date.parse(baseline));
      if (entry.status !== 'failed' && entry.lastSyncStatus !== 'failed' && !advanced) continue;
      const index = entries.findIndex(value => value.id === id);
      entries[index] = entry.status === 'failed' || entry.lastSyncStatus === 'failed' ? { ...entry, status: 'failed' } : { ...entry, status: 'refreshed' };
      pending.delete(id);
    }
  }
  if (pending.size) throw Error('Social refresh timed out');
  return entries;
}

function retryTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return ` Try again after ${new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London', timeZoneName: 'short',
  }).format(new Date(value))}.`;
}

function refreshOutcome(result) {
  const completedAt = result.lastSync?.completedAt;
  const at = completedAt && Number.isFinite(Date.parse(completedAt)) ? ` at ${new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London', timeZoneName: 'short',
  }).format(new Date(completedAt))}` : '';
  if (result.status === 'refreshed') return { updated: true, message: `YouTube data updated${at}.` };
  if (result.status === 'partial') return { updated: true, message: `Available YouTube data updated${at}.` };
  if (result.status === 'recent' && (result.lastSyncStatus || result.lastSync?.status) === 'ready') return {
    updated: true, message: result.lastSync?.errorCode === 'partial_refresh'
      ? 'YouTube was refreshed recently. Available data loaded.'
      : 'YouTube was refreshed recently. Latest data loaded.',
  };
  return { updated: false, message: result.status === 'recent'
    ? `The last YouTube refresh failed. Saved data loaded.${retryTime(result.retryAt)}`
    : `YouTube could not be refreshed. Saved data is still shown.${retryTime(result.retryAt)}` };
}

let report = null, growthDays = 7, refreshing = false, refreshMessage = '', selectedSource = 'all';
let studioMetric = 'views', studioDays = 90, audiencePopulation = 'viewers';
let allPeriod = '7d', allMetric = 'views';
let instagramDays = 30;
const source = () => report?.sources?.find(item => item.id === selectedSource);
function renderRefresh() {
  const host = document.querySelector('#yeet-refresh');
  if (!host) return;
  host.innerHTML = `<button type="button" class="report-refresh-trigger ${refreshing ? 'is-refreshing' : ''}" aria-label="Refresh YEET report" aria-busy="${refreshing}" ${refreshing ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/></svg><span>${refreshing ? 'Syncing accounts…' : 'Refresh'}</span></button><span class="yeet-refresh-status" role="status" aria-live="polite">${escapeHTML(refreshMessage)}</span>`;
  host.querySelector('button').addEventListener('click', refreshReport);
}

async function refreshReport() {
  if (refreshing) return;
  refreshing = true;
  refreshMessage = '';
  renderRefresh();
  try {
    const [youtube, social] = await Promise.allSettled([syncPublicYouTube(), syncPublicSocial()]);
    const result = youtube.status === 'fulfilled' ? youtube.value : { status: 'failed' };
    const outcome = refreshOutcome(result);
    const socialEntries = social.status === 'fulfilled' ? social.value : [];
    const connected = socialEntries.filter(entry => entry.connected && entry.status !== 'not-connected');
    const socialFailures = connected.filter(entry => entry.status === 'failed' || entry.status === 'recent' && entry.lastSyncStatus === 'failed');
    const socialUpdated = connected.filter(entry => !socialFailures.includes(entry));
    let message = outcome.message;
    if (socialUpdated.length) message += ` ${socialUpdated.map(entry => entry.id === 'instagram' ? 'Instagram' : 'TikTok').join(' and ')} data loaded.`;
    if (socialFailures.length) message += ` ${socialFailures.map(entry => entry.id === 'instagram' ? 'Instagram' : 'TikTok').join(' and ')} refresh failed; saved data kept.`;
    if (social.status === 'rejected') message += ' Social refresh could not be confirmed.';
    try {
      const updated = await loadReport();
      report = updated;
      refreshMessage = message;
      render();
    } catch {
      refreshMessage = outcome.updated
        ? 'Accounts synced, but the report could not load. Your previous report is still shown.'
        : `Refresh failed. Your previous report is still shown.${retryTime(result.retryAt)}`;
    }
  } catch {
    refreshMessage = 'YouTube refresh could not be confirmed. Your previous report is still shown.';
  } finally {
    refreshing = false;
    renderRefresh();
    document.querySelector('#yeet-refresh button')?.focus({ preventScroll: true });
  }
}

async function loadReport() {
  const response = await fetch('/api/report', { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw Error('Report unavailable');
  const result = await response.json();
  if (result?.schemaVersion !== 1 || !Array.isArray(result.sources)) throw Error('Invalid report');
  return result;
}

function growthContent(performance) {
  if (performance?.studio) performance = metricPerformance(performance, 'views');
  if (!performance) return `<div class="yeet-section-heading"><div><span class="yeet-section-number">02</span><h2>Growth</h2></div></div><div class="yeet-panel yeet-availability"><h3>${escapeHTML(sourceName(source()))} daily history</h3><p>${hasSourceSnapshot(source()) ? 'This connection supplies current counters. Historical daily activity has not been returned.' : 'Growth charts will appear after this account is connected and daily reports are available.'}</p></div>`;
  const comparison = comparePeriods(performance, growthDays, 'views');
  const available = days => performance?.dateRange && addDays(performance.dateRange.end, 1 - days * 2) >= performance.dateRange.start;
  const metrics = performance?.studio ? studioMetricDefinitions.filter(([key]) => ['views', 'profileViews', 'likes', 'comments', 'shares', 'netFollowers'].includes(key) && performance.daily.some(row => Number.isFinite(row[key]))) : [['views', 'Views'], ['watchHours', 'Watch time', 'h'], ['subscribersNet', selectedSource === 'youtube-longform' ? 'Net subscribers' : 'Net followers']]
    .filter(([key]) => key === 'views' || performance.daily.some(row => Number.isFinite(row[key])));
  const periods = performance.studio ? [7, 28, 90, 365] : [7, 14, 28];
  return `<div class="yeet-section-heading"><div><span class="yeet-section-number">02</span><h2>Growth</h2></div><label><span class="sr-only">Growth comparison period</span><select id="yeet-growth-period">${periods.map(days => `<option value="${days}" ${growthDays === days ? 'selected' : ''} ${available(days) ? '' : 'disabled'}>Last ${days} days${!available(days) ? ' · more history needed' : ''}</option>`).join('')}</select></label></div><p class="yeet-section-description">${comparison ? `${shortDate(comparison.start)} – ${date(comparison.end)} compared with ${shortDate(comparison.previousStart)} – ${date(comparison.previousEnd)}` : 'Daily reports are needed to compare periods.'}</p><div class="yeet-growth-grid">${metrics.map(([key, label, unit]) => growthCard(performance.studio ? metricPerformance(performance, key) : performance, growthDays, key, label, unit)).join('')}</div><div class="yeet-period-legend"><span><i></i>Latest ${growthDays} days</span><span><i></i>Previous ${growthDays} days</span></div>`;
}

function studioHistoryContent(performance) {
  const available = studioMetricDefinitions.filter(([key]) => performance.daily.some(row => Number.isFinite(row[key])));
  if (!available.some(([key]) => key === studioMetric)) studioMetric = available[0]?.[0] || 'views';
  const selected = metricPerformance(performance, studioMetric), points = trendPoints(selected, studioMetric, studioDays);
  const finite = points.filter(row => Number.isFinite(row.value));
  const additive = ['views', 'profileViews', 'likes', 'comments', 'shares', 'netFollowers'].includes(studioMetric);
  const value = additive ? finite.reduce((sum, row) => sum + row.value, 0) : finite.at(-1)?.value;
  const shown = points.length ? { start: points[0].date, end: points.at(-1).date } : selected.dateRange;
  return `<article class="yeet-panel yeet-history-panel"><div class="yeet-panel-heading"><div><h3>TikTok Studio</h3><p>${rangeLabel(shown)} · timezone not specified by export</p></div><strong>${compact(finite.length ? value : null)}<small>${additive ? 'reported total' : 'latest reported day'}</small></strong></div><div class="yeet-studio-chart-controls"><label><span class="sr-only">TikTok Studio metric</span><select id="yeet-studio-metric">${available.map(([key, label]) => `<option value="${key}" ${key === studioMetric ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label><span class="sr-only">TikTok Studio graph period</span><select id="yeet-studio-period">${[7, 28, 90, 365].map(days => `<option value="${days}" ${days === studioDays ? 'selected' : ''}>Last ${days} days</option>`).join('')}</select></label></div><div id="yeet-history-chart">${cumulativeChart(selected, { metric: studioMetric, days: studioDays, cumulative: false })}</div><p class="yeet-chart-note">${finite.length} days with reported values. Missing values remain gaps. Daily viewer counts are not added into a period’s unique audience.</p></article>`;
}

function studioAudienceContent(supplement) {
  const entries = supplement.audience || [];
  const populations = [...new Set(entries.map(entry => entry.population))];
  if (!populations.length) return '';
  if (!populations.includes(audiencePopulation)) audiencePopulation = populations.includes('viewers') ? 'viewers' : populations[0];
  const selected = entries.filter(entry => entry.population === audiencePopulation).sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  const category = key => selected.find(entry => entry[key]?.length);
  const bars = key => {
    const entry = category(key);
    if (!entry) return '<p class="yeet-muted">This breakdown has not been returned.</p>';
    const rows = key === 'country' ? [...entry[key]].sort((a, b) => studioPercentage(b).width - studioPercentage(a).width).slice(0, 8) : entry[key];
    const caption = audiencePopulation === 'followers' ? `Current followers · captured ${date(entry.capturedAt)}` : rangeLabel(entry.dateRange);
    return `<p class="yeet-studio-audience-period">${escapeHTML(caption)}</p>${studioPercentageBars(rows, key === 'country' ? countryName : value => value)}`;
  };
  return `<div class="yeet-audience-toolbar"><label><span>Audience</span><select id="yeet-audience-population">${populations.map(value => `<option value="${value}" ${value === audiencePopulation ? 'selected' : ''}>${value === 'viewers' ? 'Viewers' : 'Followers'}</option>`).join('')}</select></label><span>TikTok Studio · manually imported</span></div><div class="yeet-audience-grid"><article class="yeet-panel yeet-country-panel"><div class="yeet-panel-heading"><h3>Top countries</h3></div>${bars('country')}</article><div class="yeet-demographic-panels"><article class="yeet-panel"><div class="yeet-panel-heading"><h3>Age</h3></div>${bars('age')}</article><article class="yeet-panel"><div class="yeet-panel-heading"><h3>Gender</h3></div>${bars('gender')}</article></div></div><p class="yeet-audience-note">${audiencePopulation === 'viewers' ? 'People who watched within the report’s own dates.' : 'Current follower composition at capture, not a cohort of followers gained during the date range.'} Native percentages are shown unchanged. &lt;1% remains a threshold.</p>`;
}

function studioTrafficContent(supplement) {
  const traffic = supplement.trafficSources;
  if (!traffic?.rows?.length) return '';
  return `<article class="yeet-panel yeet-studio-traffic"><div class="yeet-panel-heading"><div><h3>Traffic sources</h3><p>${escapeHTML(rangeLabel(traffic.dateRange))} · TikTok Studio</p></div></div>${studioPercentageBars(traffic.rows)}</article>`;
}

function allTimeContent(channel, performance) {
  const metrics = hasSourceSnapshot(channel) ? channel.metrics : null;
  const lifetime = channel?.counterScope === 'public-channel' || channel?.counterScope === 'public-content-lifetime' ||
    channel?.id === 'tiktok' && channel?.provenance?.label === 'TikTok Display API v2 — public video lifetime counters';
  const heading = lifetime || !metrics ? 'All-time performance' : 'Reported performance';
  const sectionHeading = `<div class="yeet-section-heading"><div><span class="yeet-section-number">01</span><h2 id="yeet-all-time">${heading}</h2></div></div>`;
  if (!metrics) return `${sectionHeading}<div class="yeet-panel yeet-availability"><h3>${escapeHTML(sourceName(channel))} connection pending</h3><p>Numbers will appear after the first successful account report.</p><a href="/connections.html">View connection status →</a></div>`;
  const youtube = channel.id === 'youtube-longform';
  const history = performance?.daily?.filter(row => Number.isFinite(row.views)) || [];
  const viewsLabel = channel.counterScope === 'public-channel' ? 'Lifetime views' : lifetime ? 'Public post views' : 'Reported views';
  const viewsNote = lifetime ? `Counters captured ${date(channel.capturedAt)}` : rangeLabel(channel.dateRange);
  const cards = metricCard(viewsLabel, metrics.views, viewsNote) +
    metricCard(youtube ? 'Subscribers' : 'Followers', metrics.followers, `Current total · ${date(channel.capturedAt)}`) +
    (youtube ? metricCard('Watch time', performance?.totals?.watchHours, performance ? rangeLabel(performance.dateRange) : 'Analytics report unavailable', 'h')
      : metricCard('Likes', metrics.likes, 'Across reported public posts')) +
    metricCard(youtube ? 'Public uploads' : 'Reported posts', youtube ? metrics.videoCount : channel.content?.length,
      youtube ? 'Full episodes + Shorts' : `Captured ${date(channel.capturedAt)}`);
  const historyPanel = performance?.studio ? studioHistoryContent(performance) : performance ? `<article class="yeet-panel yeet-history-panel"><div class="yeet-panel-heading"><div><h3>Views over time</h3><p>Cumulative reported daily activity${history.length ? ` · ${shortDate(history[0].date)} – ${date(history.at(-1).date)}` : ''}</p></div><strong>${compact(cumulativeViews(performance).filter(row => Number.isFinite(row.value)).at(-1)?.value)}<small>reported views</small></strong></div><div id="yeet-history-chart">${cumulativeChart(performance)}</div><p class="yeet-chart-note">${history.length} reported days · analytics through ${date(performance.dateRange.end)}. Current counters and daily activity have separate dates.</p></article>` : '';
  const manualNote = performance?.studio ? `<p class="yeet-studio-source-note">Video counters refresh automatically. TikTok Studio charts use a manual report captured ${date(performance.capturedAt)}. Refresh keeps that report until a newer Studio import is saved.</p>` : '';
  return `${sectionHeading}<div class="yeet-stats-grid">${cards}</div>${manualNote}${historyPanel}`;
}

function audienceContent(channel) {
  if (channel?.id === 'tiktok' && channel.studioSupplement) {
    const content = studioAudienceContent(channel.studioSupplement);
    if (content) return content + studioTrafficContent(channel.studioSupplement);
  }
  if (channel?.id === 'instagram' && channel.nativeAudience) return nativeAudienceContent(channel.nativeAudience);
  const audience = channel?.audience, label = sourceName(channel);
  if (!audience?.country?.report && !audience?.demographics?.report) return `<div class="yeet-panel yeet-availability"><h3>${escapeHTML(label)} demographics</h3><p>${hasSourceSnapshot(channel) ? 'An audience report has not been returned for this connection.' : 'Audience data will appear when this account is connected and the platform supplies it.'}</p></div>`;
  return `<div class="yeet-audience-grid"><article class="yeet-panel yeet-country-panel"><div class="yeet-panel-heading"><div><h3>Top countries</h3><p>${escapeHTML(reportNote(audience?.country))}</p></div></div>${countryChart(audience?.country)}</article><div class="yeet-demographic-panels"><article class="yeet-panel"><div class="yeet-panel-heading"><div><h3>Age</h3><p>${escapeHTML(reportNote(audience?.demographics))}</p></div></div>${ageChart(audience?.demographics)}</article><article class="yeet-panel"><div class="yeet-panel-heading"><div><h3>Gender</h3></div></div>${genderChart(audience?.demographics)}</article></div></div><p class="yeet-audience-note">Age and gender show ${escapeHTML(label)}’s reported viewer percentages. Small groups may be withheld; percentages may not total 100%.</p>`;
}

function nativeAudienceContent(audience) {
  const caption = `Reported followers · captured ${date(audience.capturedAt)}`;
  const labels = { M: 'Male', F: 'Female', U: 'Unspecified', male: 'Male', female: 'Female' };
  const bars = (rows, kind) => {
    let shares = audienceShares(rows);
    shares = kind === 'country' ? shares.sort((a, b) => b.count - a.count).slice(0, 8)
      : shares.sort((a, b) => a.label.localeCompare(b.label));
    if (!shares.length) return '<p class="yeet-muted">This breakdown has not been returned.</p>';
    return `<div class="yeet-horizontal-bars">${shares.map(row => `<div class="yeet-bar-row"><div><span>${escapeHTML(kind === 'country' ? countryName(row.label) : kind === 'gender' ? labels[row.label] || row.label : row.label.replace('-', '–'))}</span><strong title="${number(row.count)} reported followers">${number(row.share)}%</strong></div><div class="yeet-bar-track" aria-hidden="true"><i style="width:${row.share}%"></i></div></div>`).join('')}</div>`;
  };
  return `<div class="yeet-audience-grid"><article class="yeet-panel yeet-country-panel"><div class="yeet-panel-heading"><div><h3>Top countries</h3><p>${caption}</p></div></div>${bars(audience.country, 'country')}</article><div class="yeet-demographic-panels"><article class="yeet-panel"><div class="yeet-panel-heading"><div><h3>Age</h3><p>${caption}</p></div></div>${bars(audience.age, 'age')}</article><article class="yeet-panel"><div class="yeet-panel-heading"><div><h3>Gender</h3></div></div>${bars(audience.gender, 'gender')}</article></div></div><p class="yeet-audience-note">Share of reported Instagram followers within each breakdown. Small groups may be withheld. ${escapeHTML(audience.scope || '')}</p>`;
}

export function instagramPeriod(source, days = 30) {
  const windows = source?.manualCapture?.windows || [];
  return windows.find(window => window.periodDays === days) || windows[0] || null;
}

function instagramDistribution(title, rows, caption) {
  const colours = ['#db0b19', '#302a25', '#aaa091'];
  return `<article class="yeet-panel yeet-instagram-distribution"><div class="yeet-panel-heading"><div><h3>${title}</h3><p>${caption}</p></div></div><div class="yeet-instagram-share-bar" role="img" aria-label="${escapeHTML(rows.map(row => `${row.label}: ${number(row.percentage)}%`).join(', '))}">${rows.map((row, index) => `<i style="width:${row.percentage}%;background:${colours[index % colours.length]}"></i>`).join('')}</div><div class="yeet-instagram-share-legend">${rows.map((row, index) => `<div><i style="background:${colours[index % colours.length]}"></i><span>${escapeHTML(row.label)}</span><strong>${number(row.percentage)}%</strong></div>`).join('')}</div></article>`;
}

function instagramWindowBars(capture, key, title) {
  const windows = [...capture.windows].sort((a, b) => a.periodDays - b.periodDays);
  const max = Math.max(1, ...windows.map(window => window[key]));
  return `<article class="yeet-panel"><div class="yeet-panel-heading"><div><h3>${title}</h3><p>Native reporting windows · captured ${date(capture.capturedAt)}</p></div></div><div class="yeet-instagram-window-bars">${windows.map(window => `<div><span>${escapeHTML(window.label)}</span><div class="yeet-bar-track"><i style="width:${window[key] / max * 100}%;${window.periodDays === instagramDays ? '' : 'background:#b3a291'}"></i></div><strong>${number(window[key])}</strong></div>`).join('')}</div></article>`;
}

function instagramFollowerActivity(capture) {
  const activity = capture.followerActivity;
  if (!activity?.hours?.length) return '';
  const max = Math.max(1, ...activity.hours.map(row => row.followers));
  return `<article class="yeet-panel yeet-instagram-follower-activity"><div class="yeet-panel-heading"><div><h3>Follower activity by hour</h3><p>${activity.weekday ? `${escapeHTML(activity.weekday)} · ` : ''}captured ${date(capture.capturedAt)} · timezone not shown</p></div></div><div class="yeet-instagram-hour-bars">${activity.hours.map(row => `<div title="${String(row.hour).padStart(2, '0')}:00 · ${number(row.followers)} followers"><strong>${number(row.followers)}</strong><div><i style="height:${row.followers / max * 100}%"></i></div><span>${String(row.hour).padStart(2, '0')}:00</span></div>`).join('')}</div></article>`;
}

function renderInstagramCapture(channel) {
  const capture = channel.manualCapture, window = instagramPeriod(channel, instagramDays);
  if (!window) return;
  const captureNote = `Captured ${date(capture.capturedAt)} · exact reporting dates and timezone were not shown`;
  const profiles = [['Profile activity', window.profileActivity], ['Profile visits', window.profileVisits],
    ['External link taps', window.externalLinkTaps], ['Accounts engaged', window.accountsEngaged]];
  const profileCards = profiles.filter(([, value]) => Number.isFinite(value)).map(([label, value]) => metricCard(label, value, window.label)).join('');
  const reelContent = (capture.content || []).map((reel, index) => `<article class="yeet-panel yeet-instagram-reel"><div class="yeet-panel-heading"><div><h3>Captured Reel${capture.content.length > 1 ? ` ${index + 1}` : ''}</h3><p>Inspected ${date(reel.capturedAt)} · reporting window not shown</p></div><strong>${compact(reel.views)}<small>views</small></strong></div><div class="yeet-instagram-reel-stats">${[['Viewers', reel.viewers], ['Interactions', reel.interactions], ['Likes', reel.likes], ['Comments', reel.comments], ['Saves', reel.saves], ['Shares', reel.shares], ['Accounts engaged', reel.accountsEngaged], ['Profile activity', reel.profileActivity], ['Follows', reel.follows], ['Listed Reel interactions', reel.reelsInteractions]].filter(([, value]) => Number.isFinite(value)).map(([label, value]) => `<div><span>${label}</span><strong>${number(value)}</strong></div>`).join('')}</div><p class="yeet-chart-note">Headline interactions and listed component counters are separate native observations. This inspected Reel is a sample, not the full content catalogue.</p></article>`).join('');
  const discrepancy = window.instagramViews !== window.views && Number.isFinite(window.instagramViews)
    ? `<p class="yeet-chart-note">Instagram’s headline shows ${number(window.views)} views; its platform breakdown shows ${number(window.instagramViews)} Instagram views${Number.isFinite(window.facebookViews) ? ` and ${number(window.facebookViews)} Facebook views` : ''}. These separate observations are preserved.</p>` : '';
  document.querySelector('#workspace').innerHTML = `${sidebar()}<div class="app yeet-app"><header class="topbar"><div class="yeet-topbar-title"><div class="yeet-header-logo"><img src="/assets/yeet-logo.svg" width="1561" height="417" alt="YEET"></div><span>Performance report</span></div><div class="top-actions"><span id="yeet-refresh"></span></div></header><main id="main" class="yeet-page"><div class="yeet-page-heading"><div><p class="yeet-eyebrow">SCRAN & PINTS × YEET</p><h1>Instagram.</h1></div><span class="yeet-source-pill">@scranpints · captured Insights</span></div>${sourceSummary()}<div class="yeet-platform-heading">${sourceTabs()}<span>Native account Insights</span></div><section class="yeet-section" aria-labelledby="ig-performance"><div class="yeet-section-heading"><div><span class="yeet-section-number">01</span><h2 id="ig-performance">Account performance</h2></div><label><span class="sr-only">Instagram reporting period</span><select id="yeet-instagram-period">${[...capture.windows].sort((a, b) => a.periodDays - b.periodDays).map(period => `<option value="${period.periodDays}" ${window.periodDays === period.periodDays ? 'selected' : ''}>${escapeHTML(period.label)}</option>`).join('')}</select></label></div><p class="yeet-section-description">${escapeHTML(captureNote)}</p><div class="yeet-stats-grid">${metricCard('Views', window.views, window.label)}${metricCard('Interactions', window.interactions, window.label)}${metricCard('Viewers', window.viewers, window.label)}${metricCard('Followers', capture.followers, `Current total · ${date(capture.capturedAt)}`)}</div>${discrepancy}<div class="yeet-all-bottom-grid">${instagramWindowBars(capture, 'views', 'Views by reporting window')}${instagramWindowBars(capture, 'interactions', 'Interactions by reporting window')}</div><p class="yeet-chart-note">Reporting windows overlap. No daily values or growth percentages have been inferred from these totals. Refresh keeps this manual report until a newer capture is saved.</p></section><section class="yeet-section" aria-labelledby="ig-audience"><div class="yeet-section-heading"><div><span class="yeet-section-number">02</span><h2 id="ig-audience">Who watched & interacted</h2></div></div><div class="yeet-instagram-distributions">${instagramDistribution('Who watched', window.viewAudience, `${window.label} · share of views`)}${instagramDistribution('Content people watched', window.viewContentTypes, `${window.label} · share of views`)}${instagramDistribution('Who interacted', window.interactionAudience, `${window.label} · share of interactions`)}${instagramDistribution('Content people interacted with', window.interactionContentTypes, `${window.label} · share of interactions`)}</div><p class="yeet-audience-note">Follower status and content type are available for this capture. Age, gender and country were not supplied.</p></section><section class="yeet-section" aria-labelledby="ig-profile"><div class="yeet-section-heading"><div><span class="yeet-section-number">03</span><h2 id="ig-profile">Profile & content</h2></div></div><div class="yeet-stats-grid yeet-instagram-profile-grid">${profileCards}</div>${instagramFollowerActivity(capture)}${reelContent}</section><footer class="yeet-footer"><p>Instagram Insights · manual capture. Account period totals and inspected Reel counters have separate reporting scopes.</p><a href="https://scranpints.com" target="_blank" rel="noreferrer">scranpints.com ↗</a></footer></main></div>`;
  renderRefresh(); bindPlatformTabs();
  document.querySelector('#yeet-instagram-period').addEventListener('change', event => { instagramDays = Number(event.target.value); render(); });
  window.SPSelect?.refresh(document.querySelector('#workspace'));
}

const allPlatformColours = { 'youtube-longform': '#db0b19', youtube: '#db0b19', instagram: '#8a597e', tiktok: '#248b83' };
function allPlatformColour(id) { return allPlatformColours[id] || '#8c8172'; }

function allReportedChart(rows, platforms, metricLabel, cumulative = false) {
  if (!rows.some(row => Number.isFinite(row.total))) return '<div class="yeet-no-data">No daily values have been returned for this period.</div>';
  const sidebar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar')) || 0;
  const pageWidth = document.querySelector('.yeet-page')?.clientWidth || window.innerWidth - sidebar;
  const width = Math.max(270, Math.min(1300, pageWidth - 70)), height = 295;
  const left = width < 400 ? 43 : 58, right = 14, top = 18, bottom = 38;
  const layers = platforms.map(platform => ({ ...platform, points: [] }));
  const plotted = rows.map(row => {
    let positive = 0, negative = 0;
    layers.forEach(layer => {
      const value = row.values[layer.id];
      if (!Number.isFinite(value)) { layer.points.push({ date: row.date, value: null }); return; }
      const base = cumulative ? 0 : value < 0 ? negative : positive;
      layer.points.push({ date: row.date, value, lower: base, upper: base + value });
      if (value < 0) negative += value; else positive += value;
    });
    return { ...row, positive, negative };
  });
  const min = Math.min(0, ...plotted.map(row => row.negative)), max = Math.max(1, ...plotted.map(row => row.positive), ...rows.map(row => Number.isFinite(row.total) ? row.total : 0));
  const first = Date.parse(rows[0].date), last = Date.parse(rows.at(-1).date);
  const x = day => left + (Date.parse(day) - first) / Math.max(86_400_000, last - first) * (width - left - right);
  const y = value => top + (1 - (value - min) / (max - min)) * (height - top - bottom);
  const segments = points => {
    const result = []; let group = [];
    for (const point of points) {
      if (!Number.isFinite(point.value)) { if (group.length) result.push(group); group = []; }
      else group.push(point);
    }
    if (group.length) result.push(group);
    return result;
  };
  const totalPoints = rows.map(row => ({ date: row.date, value: row.total }));
  const indexes = [0, Math.floor((rows.length - 1) / 2), rows.length - 1].filter((value, index, values) => values.indexOf(value) === index);
  return `<svg class="yeet-all-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="all-chart-title all-chart-description"><title id="all-chart-title">${cumulative ? 'Cumulative reported' : 'Combined reported'} ${metricLabel.toLowerCase()} ${cumulative ? 'over available history' : 'by day'}</title><desc id="all-chart-description">${cumulative ? 'Cumulative reported lines' : 'Stacked reported activity'} from ${platforms.map(platform => escapeHTML(platform.label)).join(' and ')}, ${date(rows[0].date)} to ${date(rows.at(-1).date)}. Missing source values remain unavailable.</desc>${[0, .25, .5, .75, 1].map(part => {
    const value = min + (max - min) * part;
    return `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" class="yeet-grid-line"/><text x="${left - 10}" y="${y(value) + 4}" text-anchor="end">${compact(value)}</text>`;
  }).join('')}${layers.map(layer => segments(layer.points).map(group => `<path fill="${allPlatformColour(layer.id)}" fill-opacity="${cumulative ? '.12' : '.7'}" d="M${group.map(point => `${x(point.date)},${y(point.upper)}`).join(' L')} L${[...group].reverse().map(point => `${x(point.date)},${y(point.lower)}`).join(' L')}Z"/>${cumulative ? `<path fill="none" stroke="${allPlatformColour(layer.id)}" stroke-width="2" d="M${group.map(point => `${x(point.date)},${y(point.value)}`).join(' L')}"/>` : ''}`).join('')).join('')}${segments(totalPoints).map(group => `<path d="M${group.map(point => `${x(point.date)},${y(point.value)}`).join(' L')}" class="yeet-all-total-line" ${cumulative ? 'stroke-dasharray="6 4"' : ''}/>`).join('')}${rows.map(row => `<rect x="${x(row.date) - Math.max(3, (width - left - right) / rows.length / 2)}" y="${top}" width="${Math.max(6, (width - left -right) / rows.length)}" height="${height - top - bottom}" class="yeet-all-chart-hit"><title>${date(row.date)} · ${number(row.total)} total ${metricLabel.toLowerCase()}${platforms.map(platform => ` · ${platform.label}: ${number(row.values[platform.id])}`).join('')}</title></rect>`).join('')}${indexes.map((index, order) => `<text x="${x(rows[index].date)}" y="${height - 10}" text-anchor="${order === 0 ? 'start' : order === indexes.length - 1 ? 'end' : 'middle'}">${shortDate(rows[index].date)}</text>`).join('')}</svg>`;
}

export function allSocialChartRows(performance, platforms, metric, cumulative = false) {
  let reported = 0;
  const sums = Object.fromEntries(platforms.map(platform => [platform.id, 0]));
  return performance.daily.map(row => {
    const reportedValue = row[metric === 'views' ? 'reportedViews' : 'reportedEngagement'];
    const values = Object.fromEntries(platforms.map(platform => {
      const value = row.byPlatform?.[platform.id]?.[metric];
      if (!Number.isFinite(value)) return [platform.id, null];
      sums[platform.id] += value;
      return [platform.id, cumulative ? sums[platform.id] : value];
    }));
    if (Number.isFinite(reportedValue)) reported += reportedValue;
    return { date: row.date, total: cumulative ? Number.isFinite(reportedValue) ? reported : null : row[metric], values };
  });
}

function allMixChart(platforms, valueKey, total, label) {
  let offset = 0;
  const arcs = platforms.filter(platform => Number.isFinite(platform[valueKey]) && platform[valueKey] > 0).map(platform => {
    const share = total > 0 ? platform[valueKey] / total * 100 : 0, start = offset;
    offset += share;
    return `<circle cx="70" cy="70" r="52" fill="none" stroke="${allPlatformColour(platform.id)}" stroke-width="14" pathLength="100" stroke-dasharray="${share} ${100 - share}" stroke-dashoffset="${-start}" transform="rotate(-90 70 70)"/>`;
  });
  return `<div class="yeet-all-mix"><svg viewBox="0 0 140 140" role="img" aria-label="${escapeHTML(label)} by platform"><circle cx="70" cy="70" r="52" fill="none" stroke="#eadfce" stroke-width="14"/>${arcs.join('')}<text x="70" y="68" text-anchor="middle" class="yeet-all-donut-value">${compact(total)}</text><text x="70" y="85" text-anchor="middle" class="yeet-all-donut-label">${escapeHTML(label)}</text></svg><div class="yeet-all-mix-legend">${platforms.map(platform => `<div><i style="background:${allPlatformColour(platform.id)}"></i><span class="yeet-platform-label">${platformLogo(platform.id)}${escapeHTML(platform.label)}</span><strong>${compact(platform[valueKey])}</strong><small>${total > 0 && Number.isFinite(platform[valueKey]) ? `${number(platform[valueKey] / total * 100)}%` : 'Unavailable'}</small></div>`).join('')}</div></div>`;
}

function allComparison(comparison) {
  if (!comparison?.complete) return '';
  const value = comparison.percent;
  if (!Number.isFinite(value)) return '';
  return `<small class="yeet-change ${value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral'}">${value > 0 ? '↗ +' : value < 0 ? '↘ ' : ''}${number(value)}% vs previous period</small>`;
}

function allAudienceProfile(category, estimateLabel) {
  const rows = category?.rows || [];
  return `<article class="yeet-panel"><div class="yeet-panel-heading"><div><h3>${escapeHTML(category?.label || 'Audience')}</h3></div><span class="yeet-all-estimate">${estimateLabel}</span></div>${rows.length ? studioPercentageBars(rows) : '<p class="yeet-all-no-audience">No comparable viewer profile has been returned.</p>'}<p class="yeet-all-profile-note">${escapeHTML(category?.note || '')}</p><div class="yeet-all-source-legend">${(category?.byPlatform || []).map(platform => `<span><i style="background:${allPlatformColour(platform.id)}"></i>${escapeHTML(platform.label)} · ${escapeHTML(rangeLabel(platform.dateRange))}</span>`).join('')}</div></article>`;
}

function allCountryProfile(category) {
  const rows = (category?.rows || []).slice(0, 8);
  return `<article class="yeet-panel yeet-country-panel"><div class="yeet-panel-heading"><div><h3>${escapeHTML(category?.label || 'Top countries')}</h3></div></div>${rows.length ? `<div class="yeet-all-audience-bars">${rows.map(row => `<div class="yeet-all-audience-row"><div><span>${escapeHTML(countryName(row.label))}</span></div><div class="yeet-all-audience-tracks">${row.values.map(value => {
    const formatted = studioPercentage(value);
    return `<div class="yeet-all-country-series"><div><i style="background:${allPlatformColour(value.id)}"></i><span>${escapeHTML(value.label)}</span><strong>${escapeHTML(formatted.label)}</strong></div><div class="yeet-all-audience-track ${formatted.threshold ? 'is-threshold' : ''}"><i style="width:${formatted.width}%;background:${allPlatformColour(value.id)}" title="${escapeHTML(`${value.label}: ${formatted.label}${value.unit ? ` ${value.unit}` : ''}`)}"></i></div></div>`;
  }).join('')}</div></div>`).join('')}</div>` : '<p class="yeet-all-no-audience">Geographic reports are not available yet.</p>'}<p class="yeet-all-profile-note">${escapeHTML(category?.note || '')}</p><div class="yeet-all-source-legend">${(category?.byPlatform || []).map(platform => `<span><i style="background:${allPlatformColour(platform.id)}"></i>${escapeHTML(platform.label)} · ${escapeHTML(rangeLabel(platform.dateRange))}</span>`).join('')}</div></article>`;
}

function capturedInstagramPanel(model) {
  const days = allPeriod === '7d' ? 7 : allPeriod === '30d' ? 30 : 90;
  const captured = model.manualPeriods?.find(period => period.id === 'instagram' && period.periodDays === days);
  if (!captured) return '';
  const nativeDifference = Number.isFinite(captured.nativeTotalViews) && captured.nativeTotalViews !== captured.views
    ? ` Native headline: ${number(captured.nativeTotalViews)} views; Instagram-only breakdown: ${number(captured.views)}.` : '';
  return `<article class="yeet-panel yeet-instagram-captured-panel"><div class="yeet-panel-heading"><div><h3>Instagram · ${escapeHTML(captured.periodLabel)}</h3><p>Native Insights captured ${date(captured.capturedAt)}</p></div><span class="yeet-all-estimate">Captured period</span></div><div class="yeet-instagram-captured-stats"><div><strong>${compact(captured.views)}</strong><span>Instagram views</span></div><div><strong>${compact(captured.interactions)}</strong><span>interactions</span></div><div><strong>${compact(captured.viewers)}</strong><span>viewers</span></div><div><strong>${compact(captured.profileVisits)}</strong><span>profile visits</span></div></div><p class="yeet-chart-note">${escapeHTML(captured.scopeNote || 'The exact reporting dates and timezone were not shown. This period is separate from the aligned daily graph.')}${escapeHTML(nativeDifference)} Refresh keeps this capture until a newer native report is saved.</p><button type="button" class="text-button" data-yeet-source="instagram">View all Instagram Insights →</button></article>`;
}

function reportedHistoryPanel(history) {
  if (!history?.platforms?.length) return '';
  const max = Math.max(1, ...history.platforms.map(platform => Number.isFinite(platform.views) ? platform.views : 0));
  return `<article class="yeet-panel yeet-reported-history"><div class="yeet-panel-heading"><div><h3>Reported views by platform</h3><p>Each platform’s available native history</p></div></div><div class="yeet-reported-history-bars">${history.platforms.map(platform => `<div><div><span>${platformLogo(platform.id)}${escapeHTML(platform.label)}</span><strong>${compact(platform.views)}</strong></div><div class="yeet-bar-track" aria-hidden="true"><i style="width:${Number.isFinite(platform.views) ? platform.views / max * 100 : 0}%;background:${allPlatformColour(platform.id)}"></i></div><small>${escapeHTML(platform.scopeLabel)}${platform.dateRange?.start && platform.dateRange?.end ? ` · ${escapeHTML(rangeLabel(platform.dateRange))}` : ''}${platform.capturedAt ? ` · captured ${date(platform.capturedAt)}` : ''}</small></div>`).join('')}</div><p class="yeet-chart-note">${escapeHTML(history.coverageNote)}</p></article>`;
}

function collaborationPost(post, index, maxViews) {
  const known = Number.isFinite(post.views) && ['exact', 'rounded'].includes(post.viewsPrecision);
  const rounded = post.viewsPrecision === 'rounded';
  const title = post.title || `FootyScran post ${index + 1}`;
  const relationship = post.relationship === 'campaign-post' ? 'FootyScran post' : 'Collab post';
  const url = /^https:\/\/www\.instagram\.com\/(?:reel|p)\/[A-Za-z0-9_-]+\/?$/.test(post.url || '') ? post.url : null;
  const metrics = [['Likes', post.likes], ['Comments', post.comments], ['Shares', post.shares], ['Saves', post.saves]]
    .filter(([, value]) => Number.isFinite(value));
  return `<article class="yeet-panel yeet-collab-post"><div class="yeet-collab-post-heading"><span class="yeet-collab-index">${String(index + 1).padStart(2, '0')}</span><h3>${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noreferrer">${escapeHTML(title)} <span aria-hidden="true">↗</span></a>` : escapeHTML(title)}</h3></div><span class="yeet-collab-relationship">${relationship}</span><div class="yeet-collab-post-views"><strong${known ? ` title="${rounded ? 'Approximately ' : ''}${number(post.views)} views"` : ''}>${known ? `${rounded ? '≈' : ''}${compact(post.views)}` : 'Not captured'}</strong><span>${known ? `${rounded ? 'Rounded profile' : 'Exact captured'} views` : 'View count unavailable'}</span></div>${known ? `<div class="yeet-collab-bar" aria-hidden="true"><i style="width:${post.views / maxViews * 100}%"></i></div>` : ''}${metrics.length ? `<dl class="yeet-collab-post-metrics">${metrics.map(([label, value]) => `<div><dt>${label}</dt><dd>${number(value)}</dd></div>`).join('')}</dl>` : ''}<p class="yeet-collab-post-date">Captured ${escapeHTML(date(post.capturedAt))}${post.publishedAt ? ` · published ${escapeHTML(date(post.publishedAt))}` : ''}</p></article>`;
}

function collaborationBreakdown(summary) {
  const groups = [['collaboration', 'Collab posts'], ['campaign-post', 'FootyScran-only posts']];
  const max = Math.max(1, ...groups.map(([key]) => summary.groups[key].totalViews || 0));
  return `<article class="yeet-panel yeet-collab-breakdown"><div class="yeet-panel-heading"><div><h3>Views by post type</h3><p>Observed posts · public all-time counters</p></div></div><div class="yeet-collab-breakdown-bars">${groups.map(([key, label]) => {
    const group = summary.groups[key];
    const value = group.complete ? `${group.approximate ? '≈' : ''}${compact(group.totalViews)}`
      : group.observedPosts ? 'Incomplete' : 'Not captured';
    return `<div><div><span>${label}<small>${number(group.observedPosts)} ${group.observedPosts === 1 ? 'post' : 'posts'}</small></span><strong${group.complete ? ` title="${group.approximate ? 'Approximately ' : ''}${number(group.totalViews)} views"` : ''}>${value}</strong></div>${group.complete ? `<div class="yeet-collab-bar" aria-hidden="true"><i style="width:${group.totalViews / max * 100}%"></i></div>` : `<p class="yeet-chart-note">${group.observedPosts ? `${number(group.countedPosts)} of ${number(group.observedPosts)} post counts captured` : 'No observed posts in this group'}</p>`}</div>`;
  }).join('')}</div></article>`;
}

function renderFootyScran() {
  const capture = report?.sources?.find(item => item.id === 'instagram')?.manualCapture?.collaborations;
  const summary = collaborationSummary(capture);
  const posts = [...(capture?.posts || [])].sort((a, b) => (Number.isFinite(b.views) ? b.views : -1) - (Number.isFinite(a.views) ? a.views : -1));
  const maxViews = Math.max(1, ...posts.map(post => Number.isFinite(post.views) ? post.views : 0));
  const total = summary.complete ? `${summary.approximate ? '≈' : ''}${compact(summary.totalViews)}` : 'Incomplete';
  const coverage = `${number(summary.countedPosts)} of ${number(summary.observedPosts)} observed posts have captured view counts`;
  const content = posts.length ? `<div class="yeet-collab-stats"><article class="yeet-stat"><span>FootyScran post views</span><strong${summary.complete ? ` title="${summary.approximate ? 'Approximately ' : ''}${number(summary.totalViews)} views"` : ''}>${total}</strong><p>${summary.complete ? `${summary.approximate ? 'Approximate total · includes rounded counts' : 'Exact total'} · observed posts only` : coverage}</p></article>${metricCard('Observed posts', summary.observedPosts, 'Campaign and collaboration posts')}${metricCard('Counts captured', summary.countedPosts, `${summary.exactPosts} exact · ${summary.roundedPosts} rounded`)}</div><p class="yeet-collab-coverage">${escapeHTML(coverage)}. This is the observed post list, not a confirmed complete partnership inventory.</p>${collaborationBreakdown(summary)}<div class="yeet-collab-posts">${posts.map((post, index) => collaborationPost(post, index, maxViews)).join('')}</div>` : '<article class="yeet-panel yeet-availability"><h3>FootyScran reporting is being captured</h3><p>Observed posts and their public counters will appear here when a capture is saved.</p></article>';
  document.querySelector('#workspace').innerHTML = `${sidebar()}<div class="app yeet-app"><header class="topbar"><div class="yeet-topbar-title"><div class="yeet-header-logo"><img src="/assets/yeet-logo.svg" width="1561" height="417" alt="YEET"></div><span>Performance report</span></div><div class="top-actions"><span id="yeet-refresh"></span></div></header><main id="main" class="yeet-page"><div class="yeet-page-heading"><div><p class="yeet-eyebrow">SCRAN & PINTS × YEET</p><h1>FootyScran.</h1></div><span class="yeet-source-pill">${platformLogo('instagram')}Public Reel counters · all time</span></div><div class="yeet-platform-heading">${sourceTabs()}<span>FootyScran distribution</span></div><section class="yeet-section" aria-labelledby="yeet-collabs"><div class="yeet-section-heading"><div><span class="yeet-section-number">01</span><h2 id="yeet-collabs">FootyScran post performance</h2></div>${capture ? `<span class="yeet-collab-capture">List captured ${escapeHTML(date(capture.capturedAt))}</span>` : ''}</div><p class="yeet-section-description">@footyscran × @scranpints</p>${content}<p class="yeet-chart-note">Public Reel counters · all time. The Instagram/Facebook split was not supplied. Overlap with account reporting may exist, so these counters stay separate from All socials. Views are plays, not additional or unique people. Refresh keeps this manual capture until a newer one is saved.</p></section><footer class="yeet-footer"><p>FootyScran campaign and collaboration posts · individual counters retain their own capture dates.</p><a href="https://www.instagram.com/footyscran/" target="_blank" rel="noreferrer">@footyscran ↗</a></footer></main></div>`;
  renderRefresh(); bindPlatformTabs();
}

function renderAllSocials() {
  const model = buildAllSocialAnalytics(report, allPeriod);
  const { headlines, performance, engagement, platforms: allPlatforms, audience, coverage } = model;
  const history = model.reportedHistory || { views: headlines.views, engagement: headlines.engagement, platforms: [], coverageNote: '' };
  const platforms = allPlatforms.filter(platform => platform.available !== false &&
    (Number.isFinite(platform.periodViews) || Number.isFinite(platform.periodEngagement)));
  const metricLabel = allMetric === 'views' ? 'Views' : 'Engagement';
  const rows = allSocialChartRows(performance, platforms, allMetric, allPeriod === 'all');
  const periodViews = platforms.reduce((sum, platform) => sum + (Number.isFinite(platform.periodViews) ? platform.periodViews : 0), 0);
  const reactions = [['Likes', engagement.likes], ['Comments', engagement.comments], ['Shares', engagement.shares]];
  const reactionMax = Math.max(1, ...reactions.map(([, value]) => Number.isFinite(value) ? value : 0));
  const labels = coverage.included.join(' + ');
  const panel = `<section class="yeet-panel yeet-all-performance"><div class="yeet-all-panel-heading"><div><h2>Performance over time</h2><p>${escapeHTML(rangeLabel(performance.dateRange))}</p></div><div class="yeet-all-period-value"><div><strong>${compact(performance.totals.views)}</strong><span>reported views</span>${allComparison(performance.comparison?.views)}</div><div><strong>${compact(performance.totals.engagement)}</strong><span>recorded engagement</span>${allComparison(performance.comparison?.engagement)}</div></div></div><div class="yeet-all-controls"><div class="yeet-all-range" role="group" aria-label="All socials reporting period">${[['7d', '7D'], ['30d', '30D'], ['all', 'ALL TIME']].map(([value, label]) => `<button type="button" data-all-period="${value}" aria-pressed="${allPeriod === value}">${label}</button>`).join('')}</div><div class="segmented" role="group" aria-label="All socials graph metric">${[['views', 'Views'], ['engagement', 'Engagement']].map(([value, label]) => `<button type="button" data-all-metric="${value}" aria-pressed="${allMetric === value}">${label}</button>`).join('')}</div></div><div id="yeet-all-history-chart">${allReportedChart(rows, platforms, metricLabel, allPeriod === 'all')}</div><div class="yeet-all-chart-legend">${platforms.map(platform => `<span><i style="background:${allPlatformColour(platform.id)}"></i>${platformLogo(platform.id)}${escapeHTML(platform.label)}</span>`).join('')}<span><i style="background:var(--ink)"></i>Combined${allPeriod === 'all' ? ' · reported' : ''}</span></div><p class="yeet-chart-note">${escapeHTML(coverage.chartNote)}${coverage.noDaily?.length ? ` ${escapeHTML(coverage.noDaily.join(', '))}: daily reports not yet available.` : ''}</p></section>`;
  const engagementPanels = `<div class="yeet-all-bottom-grid"><article class="yeet-panel"><div class="yeet-panel-heading"><div><h3>Views by platform</h3><p>Reported activity in the selected dates</p></div></div>${allMixChart(platforms, 'periodViews', periodViews, 'views')}</article><article class="yeet-panel"><div class="yeet-panel-heading"><div><h3>How people engaged</h3><p>${escapeHTML(rangeLabel(performance.dateRange))}</p></div><strong>${compact(engagement.total)}<small>interactions</small></strong></div><div class="yeet-all-interactions">${reactions.map(([label, value]) => `<div class="yeet-all-reaction-row"><div><span>${label}</span><strong>${compact(value)}</strong></div><div class="yeet-all-reaction-track" aria-hidden="true"><i style="width:${Number.isFinite(value) ? Math.max(0, value) / reactionMax * 100 : 0}%;background:var(--red)"></i></div></div>`).join('')}</div><p class="yeet-chart-note">${escapeHTML(coverage.engagementNote)}</p></article></div>`;
  document.querySelector('#workspace').innerHTML = `${sidebar()}<div class="app yeet-app"><header class="topbar"><div class="yeet-topbar-title"><div class="yeet-header-logo"><img src="/assets/yeet-logo.svg" width="1561" height="417" alt="YEET"></div><span>Performance report</span></div><div class="top-actions"><span id="yeet-refresh"></span></div></header><main id="main" class="yeet-page"><div class="yeet-page-heading"><div><p class="yeet-eyebrow">SCRAN & PINTS × YEET</p><h1>All socials.</h1></div><span class="yeet-source-pill">${escapeHTML(labels)}</span></div><div class="yeet-platform-heading">${sourceTabs()}<span>Combined performance</span></div><section class="yeet-section" aria-labelledby="yeet-all-time"><div class="yeet-section-heading"><div><span class="yeet-section-number">01</span><h2 id="yeet-all-time">Reported history</h2></div></div><div class="yeet-stats-grid yeet-all-headlines">${metricCard('Reported views', history.views, 'Available native history · reporting windows differ')}${metricCard('Account followers', headlines.followers, 'Combined accounts · not unique people')}${metricCard('Recorded actions', history.engagement, 'Native interactions and engagement')}${metricCard('Verified public uploads', headlines.uploads, (coverage.uploadSources || []).join(' + ') + ' counts only')}</div><p class="yeet-all-coverage">${escapeHTML(allPlatforms.filter(platform => platform.available).map(platform => `${platform.label}: captured ${date(platform.capturedAt)}`).join(' · '))}.${coverage.missing.length ? ` ${escapeHTML(coverage.missing.join(', '))} awaiting data.` : ''}</p>${reportedHistoryPanel(history)}${panel}${capturedInstagramPanel(model)}</section><section class="yeet-section" aria-labelledby="yeet-all-engagement"><div class="yeet-section-heading"><div><span class="yeet-section-number">02</span><h2 id="yeet-all-engagement">Views & engagement</h2></div></div>${engagementPanels}</section><section class="yeet-section" aria-labelledby="yeet-audience"><div class="yeet-section-heading"><div><span class="yeet-section-number">03</span><h2 id="yeet-audience">${escapeHTML(audience.label)}</h2></div></div><p class="yeet-all-profile-note">${escapeHTML(audience.note)}</p><div class="yeet-all-audience-grid">${allCountryProfile(audience.country)}<div class="yeet-all-audience-side">${allAudienceProfile(audience.age, 'Adults · channel average')}${allAudienceProfile(audience.gender, 'Channel average')}</div></div></section><footer class="yeet-footer"><p>${escapeHTML(coverage.note)} Public lifetime counters: ${compact(headlines.views)} views${coverage.counterSources?.length ? ` · ${escapeHTML(coverage.counterSources.join(' + '))}` : ''}. ${escapeHTML(coverage.counterNote)}</p><a href="https://scranpints.com" target="_blank" rel="noreferrer">scranpints.com ↗</a></footer></main></div>`;
  renderRefresh(); bindPlatformTabs();
  document.querySelectorAll('[data-all-period]').forEach(button => button.addEventListener('click', () => { allPeriod = button.dataset.allPeriod; render(); }));
  document.querySelectorAll('[data-all-metric]').forEach(button => button.addEventListener('click', () => { allMetric = button.dataset.allMetric; render(); }));
}

function render() {
  if (selectedSource === 'all') { renderAllSocials(); return; }
  if (selectedSource === 'footyscran') { renderFootyScran(); return; }
  if (selectedSource === 'instagram' && source()?.manualCapture) { renderInstagramCapture(source()); return; }
  const channel = source() || { id: selectedSource }, performance = sourcePerformance(channel);
  const platform = socialPlatforms.find(item => item.id === selectedSource);
  document.querySelector('#workspace').innerHTML = `${sidebar()}<div class="app yeet-app"><header class="topbar"><div class="yeet-topbar-title"><div class="yeet-header-logo"><img src="/assets/yeet-logo.svg" width="1561" height="417" alt="YEET"></div><span>Performance report</span></div><div class="top-actions"><span id="yeet-refresh"></span></div></header><main id="main" class="yeet-page"><div class="yeet-page-heading"><div><p class="yeet-eyebrow">SCRAN & PINTS × YEET</p><h1>The numbers.</h1></div><span class="yeet-source-pill">YouTube · Instagram · TikTok</span></div>${sourceSummary()}<div class="yeet-platform-heading">${sourceTabs()}<span>${escapeHTML(platform.detail)}</span></div><section aria-labelledby="yeet-all-time" class="yeet-section">${allTimeContent(channel, performance)}</section><section id="yeet-growth" class="yeet-section" aria-label="Growth">${growthContent(performance)}</section><section class="yeet-section" aria-labelledby="yeet-audience"><div class="yeet-section-heading"><div><span class="yeet-section-number">03</span><h2 id="yeet-audience">Audience</h2></div></div>${audienceContent(channel)}</section><footer class="yeet-footer"><p>Each platform shows its own reporting coverage. YouTube includes Shorts; views and followers are not unique people across accounts.</p><a href="https://scranpints.com" target="_blank" rel="noreferrer">scranpints.com ↗</a></footer></main></div>`;
  renderRefresh(); bindGrowth();
  document.querySelector('#yeet-studio-metric')?.addEventListener('change', event => { studioMetric = event.target.value; render(); });
  document.querySelector('#yeet-studio-period')?.addEventListener('change', event => { studioDays = Number(event.target.value); render(); });
  document.querySelector('#yeet-audience-population')?.addEventListener('change', event => { audiencePopulation = event.target.value; render(); });
  bindPlatformTabs();
  window.SPSelect?.refresh(document.querySelector('#workspace'));
}

function bindPlatformTabs() {
  document.querySelectorAll('[data-yeet-source]').forEach(button => button.addEventListener('click', () => {
    selectedSource = button.dataset.yeetSource;
    if (!(source()?.studioSupplement ? [7, 28, 90, 365] : [7, 14, 28]).includes(growthDays)) growthDays = 7;
    render();
    document.querySelector('.yeet-platform-tabs button[aria-pressed="true"]')?.focus({ preventScroll: true });
  }));
}

function bindGrowth() {
  document.querySelector('#yeet-growth-period')?.addEventListener('change', event => {
    growthDays = Number(event.target.value);
    if (source()?.studioSupplement) { render(); return; }
    const section = document.querySelector('#yeet-growth');
    section.innerHTML = growthContent(sourcePerformance(source()));
    bindGrowth(); window.SPSelect?.refresh(section);
  });
}

try { report = await loadReport(); render(); }
catch {
  document.querySelector('#workspace').innerHTML = `${sidebar()}<div class="app"><main id="main"><section class="panel empty" role="alert"><h1>Report could not be loaded</h1><p>Please try again.</p><button class="control" id="yeet-retry">Retry</button></section></main></div>`;
  document.querySelector('#yeet-retry').addEventListener('click', () => location.reload());
}
let resizeFrame;
window.addEventListener('resize', () => {
  clearTimeout(resizeFrame);
  resizeFrame = setTimeout(() => {
    if (report && selectedSource === 'all') { renderAllSocials(); return; }
    const chart = document.querySelector('#yeet-history-chart'), performance = sourcePerformance(source());
    if (chart && report) chart.innerHTML = performance?.studio
      ? cumulativeChart(metricPerformance(performance, studioMetric), { metric: studioMetric, days: studioDays, cumulative: false })
      : cumulativeChart(performance);
  }, 120);
});
