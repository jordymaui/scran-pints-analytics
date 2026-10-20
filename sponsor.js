import { createReportRefresh } from '/refresh.js';

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
  return `<div class="yeet-chart-wrap"><svg class="yeet-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="yeet-views-title yeet-views-description"><title id="yeet-views-title">Cumulative YouTube views</title><desc id="yeet-views-description">${number(finite.at(-1).value)} views across ${finite.length} reported days, ${date(finite[0].date)} to ${date(finite.at(-1).date)}. Missing dates remain gaps.</desc>${[0, .25, .5, .75, 1].map(part => `<line x1="${left}" x2="${width - right}" y1="${y(max * part)}" y2="${y(max * part)}" class="yeet-grid-line"/><text x="${left - 10}" y="${y(max * part) + 4}" text-anchor="end">${compact(max * part)}</text>`).join('')}${groups.map(points => `<path class="yeet-chart-fill" d="M${x(points[0].date)},${y(0)} L${points.map(row => `${x(row.date)},${y(row.value)}`).join(' L')} L${x(points.at(-1).date)},${y(0)}Z"/><path class="yeet-chart-line" d="M${points.map(row => `${x(row.date)},${y(row.value)}`).join(' L')}"/>`).join('')}${finite.map(row => `<circle class="yeet-chart-point" cx="${x(row.date)}" cy="${y(row.value)}" r="5" tabindex="0" aria-label="${escapeHTML(date(row.date))}: ${number(row.value)} cumulative views"><title>${date(row.date)} · ${number(row.value)} views</title></circle>`).join('')}${labels.map((index, order) => `<text x="${x(finite[index].date)}" y="${height - 9}" text-anchor="${order === 0 ? 'start' : order === labels.length - 1 ? 'end' : 'middle'}">${shortDate(finite[index].date)}</text>`).join('')}</svg></div>`;
}

function changeLabel(comparison, key) {
  if (!comparison.complete) return '<span class="yeet-change neutral">Comparison needs complete daily reports</span>';
  const { change, percent } = comparison;
  const text = key === 'subscribersNet' || percent === null
    ? `${change > 0 ? '+' : ''}${number(change)}${key === 'subscribersNet' ? ' subscribers' : change === 0 ? ' · no change' : ' vs previous'}`
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
  if (!rows.length || !total) return '<div class="yeet-no-data">YouTube has not returned geographic data for this report.</div>';
  const ranked = [...rows].sort((a, b) => b.views - a.views).slice(0, 8);
  return `<div class="yeet-horizontal-bars">${ranked.map(row => `<div class="yeet-bar-row"><div><span>${escapeHTML(countryName(row.country))}</span><strong>${number(row.views / total * 100)}%</strong></div><div class="yeet-bar-track" aria-hidden="true"><i style="width:${row.views / total * 100}%"></i></div></div>`).join('')}</div><p class="yeet-chart-note">Top ${ranked.length} of ${rows.length} reported countries · share of reported geographic views.</p>`;
}
function ageChart(entry) {
  const groups = audienceGroups(entry?.report?.rows, 'ageGroup').sort((a, b) => a.key.localeCompare(b.key));
  if (!groups.length) return '<div class="yeet-no-data">YouTube has not returned age data for this report.</div>';
  return `<div class="yeet-horizontal-bars">${groups.map(row => `<div class="yeet-bar-row"><div><span>${escapeHTML(row.key.replace(/^age/, '').replace(/^65-?$/, '65+').replace('-', '–'))}</span><strong>${number(row.value)}%</strong></div><div class="yeet-bar-track" aria-hidden="true"><i style="width:${Math.min(100, row.value)}%"></i></div></div>`).join('')}</div>`;
}
function genderChart(entry) {
  const groups = audienceGroups(entry?.report?.rows, 'gender').sort((a, b) => b.value - a.value);
  if (!groups.length) return '<div class="yeet-no-data">YouTube has not returned gender data for this report.</div>';
  const labels = { male: 'Male', female: 'Female', user_specified: 'User specified', genderUserSpecified: 'User specified' };
  return `<div class="yeet-gender-chart"><div class="yeet-gender-track" aria-hidden="true">${groups.map((row, index) => `<i class="yeet-gender-${index}" style="width:${Math.min(100, row.value)}%"></i>`).join('')}</div><div class="yeet-gender-legend">${groups.map((row, index) => `<div><i class="yeet-gender-${index}" aria-hidden="true"></i><span>${escapeHTML(labels[row.key] || row.key)}</span><strong>${number(row.value)}%</strong></div>`).join('')}</div></div>`;
}

let report = null, growthDays = 7;
const source = () => report?.sources?.find(item => item.id === 'youtube-longform');
const reportRefresh = createReportRefresh({
  getCoverage: () => {
    const channel = source(), performance = channel?.performance;
    return [...(performance ? [{ label: 'YouTube Analytics · all formats', ...performance.dateRange, capturedAt: performance.capturedAt }] : []),
      ...(channel?.counterScope === 'public-channel' ? [{ label: 'YouTube public counters', kind: 'counters', capturedAt: channel.capturedAt }] : [])];
  },
  reloadReport: async () => { const updated = await loadReport(); report = updated; render(); },
});

async function loadReport() {
  const response = await fetch('/api/report', { cache: 'no-store' });
  if (!response.ok) throw Error('Report unavailable');
  const result = await response.json();
  if (result?.schemaVersion !== 1 || !Array.isArray(result.sources)) throw Error('Invalid report');
  return result;
}

function growthContent(performance) {
  const comparison = comparePeriods(performance, growthDays, 'views');
  const available = days => performance?.dateRange && addDays(performance.dateRange.end, 1 - days * 2) >= performance.dateRange.start;
  return `<div class="yeet-section-heading"><div><span class="yeet-section-number">02</span><h2>Growth</h2></div><label><span class="sr-only">Growth comparison period</span><select id="yeet-growth-period">${[7, 14, 28].map(days => `<option value="${days}" ${growthDays === days ? 'selected' : ''} ${available(days) ? '' : 'disabled'}>Last ${days} days${available(days) ? '' : ' · more history needed'}</option>`).join('')}</select></label></div><p class="yeet-section-description">${comparison ? `${shortDate(comparison.start)} – ${date(comparison.end)} compared with ${shortDate(comparison.previousStart)} – ${date(comparison.previousEnd)}` : 'Daily reports are needed to compare periods.'}</p><div class="yeet-growth-grid">${[['views', 'Views'], ['watchHours', 'Watch time', 'h'], ['subscribersNet', 'Net subscribers']].map(([key, label, unit]) => growthCard(performance, growthDays, key, label, unit)).join('')}</div><div class="yeet-period-legend"><span><i></i>Latest ${growthDays} days</span><span><i></i>Previous ${growthDays} days</span></div>`;
}

function render() {
  const channel = source(), performance = channel?.performance, publicCounters = channel?.counterScope === 'public-channel' ? channel.metrics : null;
  const audience = channel?.audience, history = performance?.daily?.filter(row => Number.isFinite(row.views)) || [];
  document.querySelector('#workspace').innerHTML = `${sidebar()}<div class="app yeet-app"><header class="topbar"><div class="yeet-topbar-title"><div class="yeet-header-logo"><img src="/assets/yeet-logo.svg" width="1561" height="417" alt="YEET"></div><span>Performance report</span></div><div class="top-actions"><span id="yeet-refresh"></span></div></header><main id="main" class="yeet-page"><div class="yeet-page-heading"><div><p class="yeet-eyebrow">SCRAN & PINTS × YEET</p><h1>The numbers.</h1></div><span class="yeet-source-pill"><span class="yt-mark" aria-hidden="true">▶</span>YouTube · all formats</span></div><section aria-labelledby="yeet-all-time" class="yeet-section"><div class="yeet-section-heading"><div><span class="yeet-section-number">01</span><h2 id="yeet-all-time">All-time performance</h2></div></div><div class="yeet-stats-grid">${metricCard('Lifetime views', publicCounters?.views, `Public counter · ${date(channel?.capturedAt)}`)}${metricCard('Subscribers', publicCounters?.followers, `Current total · ${date(channel?.capturedAt)}`)}${metricCard('Watch time', performance?.totals?.watchHours, performance ? rangeLabel(performance.dateRange) : 'Analytics report unavailable', 'h')}${metricCard('Public uploads', publicCounters?.videoCount, 'Full episodes + Shorts')}</div><article class="yeet-panel yeet-history-panel"><div class="yeet-panel-heading"><div><h3>Views over time</h3><p>Cumulative reported views${history.length ? ` · ${shortDate(history[0].date)} – ${date(history.at(-1).date)}` : ''}</p></div><strong>${compact(cumulativeViews(performance).filter(row => Number.isFinite(row.value)).at(-1)?.value)}<small>reported views</small></strong></div><div id="yeet-history-chart">${cumulativeChart(performance)}</div><p class="yeet-chart-note">${history.length ? `${history.length} reported days. ` : ''}Analytics through ${date(performance?.dateRange?.end)}; current public counters are shown above.</p></article></section><section id="yeet-growth" class="yeet-section" aria-label="Growth">${growthContent(performance)}</section><section class="yeet-section" aria-labelledby="yeet-audience"><div class="yeet-section-heading"><div><span class="yeet-section-number">03</span><h2 id="yeet-audience">Audience</h2></div></div><div class="yeet-audience-grid"><article class="yeet-panel yeet-country-panel"><div class="yeet-panel-heading"><div><h3>Top countries</h3><p>${escapeHTML(reportNote(audience?.country))}</p></div></div>${countryChart(audience?.country)}</article><div class="yeet-demographic-panels"><article class="yeet-panel"><div class="yeet-panel-heading"><div><h3>Age</h3><p>${escapeHTML(reportNote(audience?.demographics))}</p></div></div>${ageChart(audience?.demographics)}</article><article class="yeet-panel"><div class="yeet-panel-heading"><div><h3>Gender</h3></div></div>${genderChart(audience?.demographics)}</article></div></div><p class="yeet-audience-note">Age and gender show YouTube’s reported viewer percentages. Small groups may be withheld; percentages may not total 100%.</p></section><footer class="yeet-footer"><p>Channel performance across YouTube and Shorts. These figures are not attributed to individual YEET placements.</p><a href="https://scranpints.com" target="_blank" rel="noreferrer">scranpints.com ↗</a></footer></main></div>`;
  reportRefresh.mount(document.querySelector('#yeet-refresh'));
  bindGrowth();
  window.SPSelect?.refresh(document.querySelector('#workspace'));
}

function bindGrowth() {
  document.querySelector('#yeet-growth-period')?.addEventListener('change', event => {
    growthDays = Number(event.target.value);
    const section = document.querySelector('#yeet-growth');
    section.innerHTML = growthContent(source()?.performance);
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
  resizeFrame = setTimeout(() => { const chart = document.querySelector('#yeet-history-chart'); if (chart && report) chart.innerHTML = cumulativeChart(source()?.performance); }, 120);
});
