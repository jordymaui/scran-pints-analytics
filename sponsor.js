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
  if (!validDay(performance?.dateRange?.end) || ![7, 14, 28].includes(days)) return null;
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
  { id: 'youtube-longform', label: 'YouTube', detail: 'All formats · includes Shorts', mark: '▶' },
  { id: 'instagram', label: 'Instagram', detail: 'Reels & posts', mark: 'IG' },
  { id: 'tiktok', label: 'TikTok', detail: 'Public videos', mark: 'TK' },
];
export function sponsorSources(value) {
  return socialPlatforms.map(platform => ({ ...platform,
    source: value?.sources?.find(item => item.id === platform.id) || null }));
}
export function sourcePerformance(value) {
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
export function hasSourceSnapshot(value) {
  return value?.status === 'snapshot' && Boolean(value.metrics || value.performance);
}
export function audienceShares(rows) {
  const valid = (rows || []).filter(row => typeof row.label === 'string' && Number.isFinite(row.count) && row.count >= 0);
  const total = valid.reduce((sum, row) => sum + row.count, 0);
  return total > 0 ? valid.map(row => ({ ...row, share: row.count / total * 100 })) : [];
}
function sourceName(value) { return socialPlatforms.find(platform => platform.id === value?.id)?.label || 'This platform'; }
function viewScope(value) {
  if (value?.counterScope === 'public-channel') return 'Lifetime channel views';
  if (value?.counterScope === 'public-content-lifetime' || value?.id === 'tiktok' &&
      value?.provenance?.label === 'TikTok Display API v2 — public video lifetime counters') return 'Lifetime views · reported posts';
  return value?.dateRange ? `Reported views · ${shortDate(value.dateRange.start)} – ${shortDate(value.dateRange.end)}` : 'Views unavailable';
}
function sourceSummary() {
  return `<div class="yeet-social-summary" aria-label="Connected social performance">${sponsorSources(report).map(platform => {
    const available = hasSourceSnapshot(platform.source);
    return `<button type="button" class="yeet-social-card ${platform.id === selectedSource ? 'selected' : ''}" data-yeet-source="${platform.id}" aria-pressed="${platform.id === selectedSource}"><span class="yeet-social-heading"><span class="yeet-platform-mark ${platform.id === 'youtube-longform' ? 'youtube' : platform.id}" aria-hidden="true">${platform.mark}</span><strong>${platform.label}</strong><span class="yeet-connection-state ${available ? 'connected' : ''}">${available ? 'Report saved' : 'Pending'}</span></span>${available ? `<span class="yeet-social-views">${compact(platform.source.metrics?.views)} <small>views</small></span><span class="yeet-social-detail">${escapeHTML(viewScope(platform.source))}</span><span class="yeet-social-followers">${compact(platform.source.metrics?.followers)} ${platform.id === 'youtube-longform' ? 'subscribers' : 'followers'} · ${escapeHTML(date(platform.source.capturedAt))}</span>` : `<span class="yeet-social-pending">Connection pending</span><span class="yeet-social-detail">${platform.detail}</span>`}</button>`;
  }).join('')}</div>`;
}
function sourceTabs() {
  return `<div class="yeet-platform-tabs" role="group" aria-label="Select reporting platform">${socialPlatforms.map(platform => `<button type="button" data-yeet-source="${platform.id}" aria-pressed="${platform.id === selectedSource}">${platform.label}</button>`).join('')}</div>`;
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

function cumulativeChart(performance) {
  const rows = cumulativeViews(performance), finite = rows.filter(row => Number.isFinite(row.value));
  if (!finite.length) return '<div class="yeet-no-data">The daily views report is not available yet.</div>';
  const sidebarWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar')) || 0;
  const pageWidth = document.querySelector('.yeet-page')?.clientWidth || window.innerWidth - sidebarWidth;
  const width = Math.max(270, Math.min(1300, pageWidth - 80));
  const height = 255, left = width < 400 ? 43 : 57, right = 15, top = 18, bottom = 37;
  const first = Date.parse(finite[0].date), last = Date.parse(finite.at(-1).date), max = Math.max(1, ...finite.map(row => row.value));
  const x = day => left + (Date.parse(day) - first) / Math.max(86_400_000, last - first) * (width - left - right);
  const y = value => top + (1 - value / max) * (height - top - bottom);
  const groups = []; let group = [];
  for (const row of rows) {
    if (!Number.isFinite(row.value) || group.length && Date.parse(row.date) - Date.parse(group.at(-1).date) > 86_400_000) {
      if (group.length) groups.push(group); group = [];
    }
    if (Number.isFinite(row.value)) group.push(row);
  }
  if (group.length) groups.push(group);
  const labels = [0, Math.floor((finite.length - 1) / 2), finite.length - 1].filter((value, index, values) => values.indexOf(value) === index);
  return `<div class="yeet-chart-wrap"><svg class="yeet-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="yeet-views-title yeet-views-description"><title id="yeet-views-title">Cumulative ${escapeHTML(sourceName(source()))} views</title><desc id="yeet-views-description">${number(finite.at(-1).value)} views across ${finite.length} reported days, ${date(finite[0].date)} to ${date(finite.at(-1).date)}. Missing dates remain gaps.</desc>${[0, .25, .5, .75, 1].map(part => `<line x1="${left}" x2="${width - right}" y1="${y(max * part)}" y2="${y(max * part)}" class="yeet-grid-line"/><text x="${left - 10}" y="${y(max * part) + 4}" text-anchor="end">${compact(max * part)}</text>`).join('')}${groups.map(points => `<path class="yeet-chart-fill" d="M${x(points[0].date)},${y(0)} L${points.map(row => `${x(row.date)},${y(row.value)}`).join(' L')} L${x(points.at(-1).date)},${y(0)}Z"/><path class="yeet-chart-line" d="M${points.map(row => `${x(row.date)},${y(row.value)}`).join(' L')}"/>`).join('')}${finite.map(row => `<circle class="yeet-chart-point" cx="${x(row.date)}" cy="${y(row.value)}" r="5" tabindex="0" aria-label="${escapeHTML(date(row.date))}: ${number(row.value)} cumulative views"><title>${date(row.date)} · ${number(row.value)} views</title></circle>`).join('')}${labels.map((index, order) => `<text x="${x(finite[index].date)}" y="${height - 9}" text-anchor="${order === 0 ? 'start' : order === labels.length - 1 ? 'end' : 'middle'}">${shortDate(finite[index].date)}</text>`).join('')}</svg></div>`;
}

function changeLabel(comparison, key) {
  if (!comparison.complete) return '<span class="yeet-change neutral">Comparison needs complete daily reports</span>';
  const { change, percent } = comparison;
  const text = key === 'subscribersNet' || percent === null
    ? `${change > 0 ? '+' : ''}${number(change)}${key === 'subscribersNet' ? selectedSource === 'youtube-longform' ? ' subscribers' : ' followers' : change === 0 ? ' · no change' : ' vs previous'}`
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

let report = null, growthDays = 7, refreshing = false, refreshMessage = '', selectedSource = 'youtube-longform';
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
  if (!performance) return `<div class="yeet-section-heading"><div><span class="yeet-section-number">02</span><h2>Growth</h2></div></div><div class="yeet-panel yeet-availability"><h3>${escapeHTML(sourceName(source()))} daily history</h3><p>${hasSourceSnapshot(source()) ? 'This connection supplies current counters. Historical daily activity has not been returned.' : 'Growth charts will appear after this account is connected and daily reports are available.'}</p></div>`;
  const comparison = comparePeriods(performance, growthDays, 'views');
  const available = days => performance?.dateRange && addDays(performance.dateRange.end, 1 - days * 2) >= performance.dateRange.start;
  const metrics = [['views', 'Views'], ['watchHours', 'Watch time', 'h'], ['subscribersNet', selectedSource === 'youtube-longform' ? 'Net subscribers' : 'Net followers']]
    .filter(([key]) => key === 'views' || performance.daily.some(row => Number.isFinite(row[key])));
  return `<div class="yeet-section-heading"><div><span class="yeet-section-number">02</span><h2>Growth</h2></div><label><span class="sr-only">Growth comparison period</span><select id="yeet-growth-period">${[7, 14, 28].map(days => `<option value="${days}" ${growthDays === days ? 'selected' : ''} ${available(days) ? '' : 'disabled'}>Last ${days} days${available(days) ? '' : ' · more history needed'}</option>`).join('')}</select></label></div><p class="yeet-section-description">${comparison ? `${shortDate(comparison.start)} – ${date(comparison.end)} compared with ${shortDate(comparison.previousStart)} – ${date(comparison.previousEnd)}` : 'Daily reports are needed to compare periods.'}</p><div class="yeet-growth-grid">${metrics.map(([key, label, unit]) => growthCard(performance, growthDays, key, label, unit)).join('')}</div><div class="yeet-period-legend"><span><i></i>Latest ${growthDays} days</span><span><i></i>Previous ${growthDays} days</span></div>`;
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
  const historyPanel = performance ? `<article class="yeet-panel yeet-history-panel"><div class="yeet-panel-heading"><div><h3>Views over time</h3><p>Cumulative reported daily activity${history.length ? ` · ${shortDate(history[0].date)} – ${date(history.at(-1).date)}` : ''}</p></div><strong>${compact(cumulativeViews(performance).filter(row => Number.isFinite(row.value)).at(-1)?.value)}<small>reported views</small></strong></div><div id="yeet-history-chart">${cumulativeChart(performance)}</div><p class="yeet-chart-note">${history.length} reported days · analytics through ${date(performance.dateRange.end)}. Current counters and daily activity have separate dates.</p></article>` : '';
  return `${sectionHeading}<div class="yeet-stats-grid">${cards}</div>${historyPanel}`;
}

function audienceContent(channel) {
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

function render() {
  const channel = source() || { id: selectedSource }, performance = sourcePerformance(channel);
  const platform = socialPlatforms.find(item => item.id === selectedSource);
  document.querySelector('#workspace').innerHTML = `${sidebar()}<div class="app yeet-app"><header class="topbar"><div class="yeet-topbar-title"><div class="yeet-header-logo"><img src="/assets/yeet-logo.svg" width="1561" height="417" alt="YEET"></div><span>Performance report</span></div><div class="top-actions"><span id="yeet-refresh"></span></div></header><main id="main" class="yeet-page"><div class="yeet-page-heading"><div><p class="yeet-eyebrow">SCRAN & PINTS × YEET</p><h1>The numbers.</h1></div><span class="yeet-source-pill">YouTube · Instagram · TikTok</span></div>${sourceSummary()}<div class="yeet-platform-heading">${sourceTabs()}<span>${escapeHTML(platform.detail)}</span></div><section aria-labelledby="yeet-all-time" class="yeet-section">${allTimeContent(channel, performance)}</section><section id="yeet-growth" class="yeet-section" aria-label="Growth">${growthContent(performance)}</section><section class="yeet-section" aria-labelledby="yeet-audience"><div class="yeet-section-heading"><div><span class="yeet-section-number">03</span><h2 id="yeet-audience">Audience</h2></div></div>${audienceContent(channel)}</section><footer class="yeet-footer"><p>Each platform shows its own reporting coverage. YouTube includes Shorts; views and followers are not unique people across accounts.</p><a href="https://scranpints.com" target="_blank" rel="noreferrer">scranpints.com ↗</a></footer></main></div>`;
  renderRefresh(); bindGrowth();
  document.querySelectorAll('[data-yeet-source]').forEach(button => button.addEventListener('click', () => {
    selectedSource = button.dataset.yeetSource;
    render();
    document.querySelector('.yeet-platform-tabs button[aria-pressed="true"]')?.focus({ preventScroll: true });
  }));
  window.SPSelect?.refresh(document.querySelector('#workspace'));
}

function bindGrowth() {
  document.querySelector('#yeet-growth-period')?.addEventListener('change', event => {
    growthDays = Number(event.target.value);
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
  resizeFrame = setTimeout(() => { const chart = document.querySelector('#yeet-history-chart'); if (chart && report) chart.innerHTML = cumulativeChart(sourcePerformance(source())); }, 120);
});
