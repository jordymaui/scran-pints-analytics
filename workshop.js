import { windowMetrics, groupTests, metadataAudit, validateNotebook, mergeNotebookChanges, workshopThumbnail, workshopPackage, analyticsMetrics, analyticsDailySeries } from '/lib/workshop-model.mjs';
import { csvCell } from '/lib/report-model.mjs';
import { createReportRefresh } from '/refresh.js';
import { mountUploadAnalytics } from '/upload-analytics.js';

const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits }).format(value) : 'Not collected';
const percent = value => typeof value === 'number' && Number.isFinite(value) ? `${number(value, 1)}%` : 'Not collected';
const date = value => {
  if (!value) return 'Date not recorded';
  const stamp = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
  const parsed = stamp ? new Date(`${stamp}T12:00:00Z`) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(parsed) : String(value);
};
const asset = value => workshopThumbnail(value) || '';
const storageKey = 'scran-pints-workshop-notebook-v1';
let data;
let tests = [];
let entries = [];
let notebookVersion = null;
let notebookBase = [];
let notebookBusy = false;
let notebookNeedsReload = false;
let notebookDirty = false;
let formBaseline = '';
let windowDays = 3;
let teamAccess = false;
let studioReady = false;
let notebookBound = false;
const reportRefresh = createReportRefresh({
  getCoverage: () => [
    ...(data?.channelAnalytics ? [{ label: 'Channel Analytics · all formats', ...data.channelAnalytics.dateRange, capturedAt: data.channelAnalytics.capturedAt }] : []),
    ...(data?.shortsAnalytics ? [{ label: 'YouTube Shorts Analytics', ...data.shortsAnalytics.dateRange, capturedAt: data.shortsAnalytics.capturedAt }] : []),
    ...(data?.apiThrough ? [{ label: `${data.videos.length} included episodes`, end: data.apiThrough, capturedAt: data.capturedAt }] : []),
  ],
  reloadReport: reloadStudioReporting,
  onTeamAccess: allowed => { teamAccess = allowed; updateTeamControls(); },
});

function updateTeamControls() {
  document.body.classList.toggle('team-access', teamAccess);
  $('#team-sign-out').hidden = !teamAccess;
  $('#team-controls-link').hidden = teamAccess;
  if (studioReady && teamAccess && !notebookBound) {
    notebookBound = true;
    bindNotebook();
    loadNotebook();
    if (location.hash === '#notebook') selectStudioSection('notebook', false);
  }
}
async function checkTeamAccess() {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    teamAccess = response.ok && (await response.json()).authenticated === true;
  } catch { teamAccess = false; }
  updateTeamControls();
}

function download(filename, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function historyFor(id) { return data.history?.videos?.find(video => video.videoId === id); }
function videoFor(id) { return data.videos.find(video => video.id === id); }
function imageHTML(path, caption, evidence = false) {
  const url = asset(path);
  if (!url) return '<div class="missing-image">Image not recovered<br>See the saved evidence notes.</div>';
  return `<button class="image-button" type="button" data-preview="${escapeHTML(url)}" data-caption="${escapeHTML(caption)}" aria-label="${escapeHTML(`Enlarge ${evidence ? 'saved screenshot for' : 'thumbnail paired with'} ${caption}`)}"><img loading="lazy" src="${escapeHTML(url)}" alt="${escapeHTML(evidence ? `Saved test screenshot: ${caption}` : `Thumbnail paired with: ${caption}`)}"></button>${evidence ? '<p>Original test screenshot · separate thumbnail not recovered</p>' : ''}`;
}

const analyticsFields = [
  ['views', 'Views', 0], ['watchHours', 'Watch hours', 1],
  ['averageViewDuration', 'Avg. view seconds', 1], ['averageViewPercentage', 'Avg. % watched', 1],
  ['likes', 'Likes', 0], ['comments', 'Comments', 0], ['shares', 'Shares', 0],
  ['subscribersGained', 'Subscribers gained', 0], ['subscribersLost', 'Subscribers lost', 0],
  ['subscribersNet', 'Net subscribers', 0],
];
const shortsFields = [
  ['views', 'Views', 0], ['engagedViews', 'Engaged views', 0], ['watchHours', 'Watch hours', 1],
  ['likes', 'Likes', 0], ['comments', 'Comments', 0], ['shares', 'Shares', 0],
  ['subscribersGained', 'Subscribers gained', 0], ['subscribersLost', 'Subscribers lost', 0], ['subscribersNet', 'Net subscribers', 0],
];
let shortsMetric = 'views', shortsLimit = 28;
const channelBreakdownViews = {
  traffic: { label: 'Traffic sources', dimensions: [['insightTrafficSourceType', 'Traffic source']],
    note: 'How viewers reached the channel’s videos, using YouTube’s native source categories.' },
  country: { label: 'Countries', dimensions: [['country', 'Country']],
    note: 'Country describes the location reported for the activity. ZZ means the country is unknown.' },
  device: { label: 'Devices', dimensions: [['deviceType', 'Device']],
    note: 'Views and watch time by YouTube device category; these are not unique viewer counts.' },
  subscribed: { label: 'Subscriber status', dimensions: [['subscribedStatus', 'Subscriber status']],
    note: 'Subscription status is measured when the activity happened. This is not a list or count of current subscribers.' },
  format: { label: 'Content formats', dimensions: [['creatorContentType', 'Format']],
    note: 'YouTube’s native content classification, including Shorts and live streams where returned. Format reporting is available from 1 January 2019.' },
  demographics: { label: 'Age & gender', dimensions: [['ageGroup', 'Age group'], ['gender', 'Gender']],
    note: 'Native viewer percentages describe the logged-in audience represented by YouTube’s demographic report. Missing groups are unavailable; percentages are not converted into viewer counts.' },
};
const metricValue = (metrics, [key, , digits]) => key === 'averageViewPercentage' ? percent(metrics[key]) : number(metrics[key], digits);
const episodeTitle = video => video.metadata?.title || video.title || video.name;
function episodeRange(video) {
  return {
    start: video.analyticsSource?.start || video.reportingPublishedDate ||
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(video.publishedAt)),
    end: video.analyticsSource?.end || data.apiThrough,
    timezone: video.analyticsSource?.timezone || 'America/Los_Angeles',
  };
}
function reportDates(report) {
  const range = report.dateRange;
  return `${date(range.start)} – ${date(range.end)} · ${range.timezone} · collected ${date(report.capturedAt)}`;
}
function metricLedger(metrics, fields = analyticsFields) {
  return `<dl class="analytics-metrics">${fields.map(field => `<div><dt>${escapeHTML(field[1])}</dt><dd>${escapeHTML(metricValue(metrics, field))}</dd></div>`).join('')}</dl>`;
}
function analyticsTrend(rows, range, label, key, limit = 28, isShorts = false) {
  const fields = isShorts ? shortsFields : analyticsFields;
  const chartField = isShorts ? shortsFields.find(field => field[0] === shortsMetric) || shortsFields[0] : analyticsFields[0];
  const [chartKey, chartLabel, chartDigits] = chartField;
  const nativeRows = isShorts ? rows.map(row => ({ ...row,
    estimatedMinutesWatched: Number.isFinite(row.watchHours) ? row.watchHours * 60 : null,
  })) : rows;
  const series = analyticsDailySeries(nativeRows, range, limit);
  if (isShorts) {
    const originals = new Map();
    for (const row of rows) originals.set(row.day, originals.has(row.day) ? null : row);
    for (const row of series) {
      const original = originals.get(row.day);
      row.engagedViews = Number.isFinite(original?.engagedViews) ? original.engagedViews : null;
      if (Number.isFinite(original?.subscribersNet)) row.subscribersNet = original.subscribersNet;
    }
  }
  if (!series.length) return '<p class="empty">No dated daily report was collected.</p>';
  const present = series.filter(row => Number.isFinite(row[chartKey]));
  const minimum = Math.min(0, ...present.map(row => row[chartKey]));
  const maximum = Math.max(1, ...present.map(row => row[chartKey]));
  const x = index => 62 + (series.length === 1 ? .5 : index / (series.length - 1)) * 790;
  const y = value => 205 - (value - minimum) / (maximum - minimum) * 170;
  const segments = [];
  let points = [];
  series.forEach((row, index) => {
    if (!Number.isFinite(row[chartKey])) { if (points.length) segments.push(points); points = []; }
    else points.push([x(index), y(row[chartKey]), row]);
  });
  if (points.length) segments.push(points);
  const grid = [minimum, (minimum + maximum) / 2, maximum].map(value => `<line x1="62" x2="852" y1="${y(value)}" y2="${y(value)}" stroke="#e5e3db"/><text x="50" y="${y(value) + 4}" text-anchor="end">${number(value, chartDigits)}</text>`).join('');
  const chart = present.length ? `<svg viewBox="0 0 900 245" role="img" aria-labelledby="${key}-title ${key}-description"><title id="${key}-title">${escapeHTML(label)} daily ${escapeHTML(chartLabel.toLowerCase())}</title><desc id="${key}-description">Returned daily ${escapeHTML(chartLabel.toLowerCase())} from ${series[0].day} to ${series.at(-1).day}. Missing dates are gaps. Exact values follow.</desc>${grid}${segments.map(segment => `<polygon points="${segment[0][0]},${y(0)} ${segment.map(point => point.slice(0, 2).join(',')).join(' ')} ${segment.at(-1)[0]},${y(0)}" fill="#c53529" opacity=".06"/><polyline points="${segment.map(point => point.slice(0, 2).join(',')).join(' ')}" fill="none" stroke="#c53529" stroke-width="2.5"/>`).join('')}${series.length <= 90 ? segments.flat().map(([cx, cy, row]) => `<circle cx="${cx}" cy="${cy}" r="3" fill="#c53529"><title>${row.day}: ${number(row[chartKey], chartDigits)} ${escapeHTML(chartLabel.toLowerCase())}</title></circle>`).join('') : ''}<text x="62" y="235">${escapeHTML(date(series[0].day))}</text><text x="852" y="235" text-anchor="end">${escapeHTML(date(series.at(-1).day))}</text></svg>` : `<p class="empty">No ${escapeHTML(chartLabel.toLowerCase())} were returned for these dates.</p>`;
  return `<div class="chart-panel analytics-trend"><div class="section-heading compact"><h4>${escapeHTML(label)} · daily ${escapeHTML(chartLabel.toLowerCase())}</h4>${isShorts ? `<label>Metric<select data-trend-metric="shorts">${shortsFields.map(([value, title]) => `<option value="${value}" ${value === shortsMetric ? 'selected' : ''}>${title}</option>`).join('')}</select></label>` : ''}<label>Chart dates<select data-trend-range="${key}"><option value="7" ${limit === 7 ? 'selected' : ''}>Last 7 dates</option><option value="28" ${limit === 28 ? 'selected' : ''}>Last 28 dates</option><option value="all" ${limit === null ? 'selected' : ''}>All dates · up to 5,000</option></select></label></div>${chart}<p class="note chart-coverage">${present.length} / ${series.length} dates have ${escapeHTML(chartLabel.toLowerCase())} · gaps are unavailable. ${limit === null && series[0].day > range.start ? 'Showing the latest 5,000 dates. ' : ''}Cards retain their stated full window.</p><details class="analytics-daily"><summary>Daily values &amp; coverage</summary><p class="note">The date selector changes this chart and table only. Missing dates and uncollected metric fields are not zero.</p><div class="table-scroll" tabindex="0" role="region" aria-label="${escapeHTML(label)} daily values"><table><thead><tr><th scope="col">Date</th>${fields.map(field => `<th scope="col">${escapeHTML(field[1])}</th>`).join('')}<th scope="col">Coverage</th></tr></thead><tbody>${series.map(row => `<tr><td>${row.day}</td>${fields.map(field => `<td class="metric">${escapeHTML(metricValue(row, field))}</td>`).join('')}<td>${row.coverage}</td></tr>`).join('')}</tbody></table></div></details></div>`;
}
function renderChannelAnalytics() {
  const report = data.channelAnalytics;
  const fallbackStart = report?.coverage?.startBasis === 'earliest-known-public-upload';
  const headlineKeys = ['views', 'watchHours', 'subscribersNet', 'averageViewDuration', 'averageViewPercentage', 'likes'];
  const headlineFields = headlineKeys.map(key => analyticsFields.find(field => field[0] === key));
  const otherFields = analyticsFields.filter(field => !headlineKeys.includes(field[0]));
  const core = report ? `<article class="analytics-report channel-overview"><div class="section-heading compact"><h3>Channel · all formats</h3><span class="pill">YouTube Analytics</span></div><p class="note report-date">${escapeHTML(reportDates(report))}</p>${metricLedger(analyticsMetrics(report.aggregate), headlineFields)}<div id="channel-trend">${analyticsTrend(report.daily, report.dateRange, 'Channel', 'channel')}</div><details class="report-details"><summary>More metrics &amp; source details</summary>${metricLedger(analyticsMetrics(report.aggregate), otherFields)}<p class="note">Native channel aggregate and daily reports from the YouTube Analytics API. ${fallbackStart ? 'Coverage starts at the earliest known public upload; earlier channel history is excluded.' : 'Coverage starts at the channel creation date.'} Includes all formats and may include activity outside the public upload list. Channel totals and average values are supplied directly; episode and Shorts figures are not added to them.</p></details></article>`
    : '<div class="notice quiet"><strong>Channel Analytics has not been collected yet.</strong><p>After the channel owner connects YouTube reporting, refresh YouTube in Connections. The saved episode evidence remains available below.</p></div>';
  $('#channel-analytics').innerHTML = `${core}<article class="analytics-report channel-breakdowns"><div class="section-heading compact"><h3>Audience &amp; traffic</h3><label>Breakdown<select id="channel-breakdown">${Object.entries(channelBreakdownViews).map(([id, view]) => `<option value="${id}">${escapeHTML(view.label)}</option>`).join('')}</select></label></div><div id="channel-breakdown-detail" aria-live="polite"></div></article>`;
  renderChannelBreakdown();
}
function breakdownDimension(value, key) {
  if (key === 'country') {
    if (value === 'ZZ') return 'Unknown country (ZZ)';
    try { return `${new Intl.DisplayNames(['en-GB'], { type: 'region' }).of(value)} (${value})`; } catch { return value; }
  }
  const names = {
    VIDEO_ON_DEMAND: 'Full videos', SHORTS: 'Shorts', LIVE_STREAM: 'Live streams',
    STORY: 'Stories', UNSPECIFIED: 'Unspecified', SUBSCRIBED: 'Subscribed', UNSUBSCRIBED: 'Not subscribed',
  };
  return names[value] || value;
}
function renderChannelBreakdown() {
  const selected = $('#channel-breakdown').value;
  const id = Object.hasOwn(channelBreakdownViews, selected) ? selected : 'traffic';
  const view = channelBreakdownViews[id];
  const entry = data.channelBreakdowns?.[id];
  if (!entry) {
    $('#channel-breakdown-detail').innerHTML = `<p class="empty">No valid saved ${escapeHTML(view.label.toLowerCase())} report is available. Refresh YouTube in <a href="/connections.html">Connections</a> to collect it.</p><p class="note">${escapeHTML(view.note)}</p>`;
    return;
  }
  const statuses = {
    collected: 'Collected successfully.',
    'no-rows': 'The latest refresh returned no rows. This report is unavailable, not zero.',
    failed: 'The latest refresh could not collect this report.',
    'no-rows-retained': 'The latest refresh returned no rows. Showing the earlier report with its original dates.',
    'failed-retained': 'The latest refresh could not collect this report. Showing the earlier report with its original dates.',
  };
  const attempt = `<p class="note">${escapeHTML(statuses[entry.status] || 'Report unavailable.')} Latest attempt: ${escapeHTML(date(entry.attemptedAt))}, requested ${escapeHTML(date(entry.attemptedRange.start))} – ${escapeHTML(date(entry.attemptedRange.end))} · ${escapeHTML(entry.attemptedRange.timezone)}.</p>`;
  if (!entry.report) {
    $('#channel-breakdown-detail').innerHTML = `${attempt}<p class="empty">No saved rows are available for this breakdown.</p><p class="note">${escapeHTML(view.note)}</p>`;
    return;
  }
  const report = entry.report;
  const demographic = id === 'demographics';
  const rows = [...report.rows].sort((a, b) => (demographic ? b.viewerPercentage - a.viewerPercentage : b.views - a.views));
  const table = `<div class="table-scroll breakdown-table" tabindex="0" role="region" aria-label="${escapeHTML(view.label)}"><table><thead><tr>${view.dimensions.map(([, label]) => `<th scope="col">${escapeHTML(label)}</th>`).join('')}${demographic ? '<th scope="col">Viewer percentage</th>' : '<th scope="col">Views</th><th scope="col">Watch hours</th>'}</tr></thead><tbody>${rows.map(row => `<tr>${view.dimensions.map(([key]) => `<td>${escapeHTML(breakdownDimension(row[key], key))}</td>`).join('')}${demographic ? `<td class="metric">${percent(row.viewerPercentage)}</td>` : `<td class="metric">${number(row.views)}</td><td class="metric">${number(row.estimatedMinutesWatched / 60, 1)}</td>`}</tr>`).join('')}</tbody></table></div>`;
  $('#channel-breakdown-detail').innerHTML = `${attempt}<p class="note"><strong>${escapeHTML(reportDates(report))}</strong> · YouTube Analytics API</p>${table}<p class="note">${escapeHTML(view.note)} Reports may omit categories and do not provide their own daily completeness marker. The displayed range is the requested report window; rows are not added to or used to replace the channel total.</p>`;
}
function renderShortsAnalytics() {
  const report = data.shortsAnalytics;
  if (!report) {
    $('#shorts-analytics').innerHTML = '<div class="notice quiet"><strong>No saved Shorts report is available.</strong><p>Shorts reporting status is available in Connections. No Shorts figures are inferred from the public channel counter or the episode catalog.</p></div>';
    return;
  }
  const limitedRows = report.daily.some(row => shortsFields.some(([field]) => !Number.isFinite(row[field])));
  $('#shorts-analytics').innerHTML = `<article class="analytics-report"><div class="section-heading compact"><h3>YouTube Shorts</h3><span class="pill">YouTube Analytics</span></div><p class="note">${escapeHTML(reportDates(report))}</p>${metricLedger(report.metrics, shortsFields)}<p class="note">Source: ${escapeHTML(report.provenance?.label || 'YouTube Analytics API')}. ${escapeHTML(report.scope)}</p><p class="note">Shorts totals sum returned daily Shorts rows. Views and engaged views are separate source metrics. ${limitedRows ? 'Some saved daily fields were not collected and remain unavailable. ' : ''}Choose a metric to inspect its daily trend. Individually collected reports appear in Uploads with their own coverage.</p><div id="shorts-trend">${analyticsTrend(report.daily, report.dateRange, 'Shorts', 'shorts', shortsLimit, true)}</div></article>`;
}
function episodeAnalyticsRows() {
  const query = $('#analytics-search').value.trim().toLocaleLowerCase();
  const sort = $('#analytics-sort').value;
  return data.videos.filter(video => `${video.name} ${episodeTitle(video)}`.toLocaleLowerCase().includes(query))
    .map(video => ({ video, metrics: analyticsMetrics(video.apiAggregate) }))
    .sort((a, b) => sort === 'publishedAt' ? b.video.publishedAt.localeCompare(a.video.publishedAt) :
      (b.metrics[sort] ?? -Infinity) - (a.metrics[sort] ?? -Infinity));
}
function renderEpisodeAnalytics() {
  $('#episode-analytics-body').innerHTML = episodeAnalyticsRows().map(({ video, metrics }) => {
    const range = episodeRange(video);
    return `<tr><th scope="row"><a href="https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}" target="_blank" rel="noopener noreferrer">${escapeHTML(episodeTitle(video))} ↗</a><small>${escapeHTML(video.name)} · published ${escapeHTML(date(video.publishedAt))}</small><small>${escapeHTML(date(range.start))} – ${escapeHTML(date(range.end))}<br>Collected ${escapeHTML(date(video.analyticsSource?.capturedAt || data.capturedAt))}</small></th>${analyticsFields.map(field => `<td class="metric">${escapeHTML(metricValue(metrics, field))}</td>`).join('')}</tr>`;
  }).join('') || '<tr><td colspan="11">No included episode matches this search.</td></tr>';
}
function renderEpisodeAnalyticsDetail() {
  const video = videoFor($('#analytics-video').value);
  if (!video) return;
  const rows = [...(video.traffic || [])].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  const source = video.trafficSource;
  const capture = source?.capturedAt || data.capturedAt;
  const end = source?.end || data.apiThrough;
  const traffic = rows.length ? `<div class="table-scroll" tabindex="0" role="region" aria-label="Episode traffic sources"><table><thead><tr><th scope="col">YouTube traffic source</th><th scope="col">Views</th><th scope="col">Watch hours</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHTML(row.insightTrafficSourceType)}</td><td class="metric">${number(row.views)}</td><td class="metric">${number(Number.isFinite(row.estimatedMinutesWatched) ? row.estimatedMinutesWatched / 60 : null, 1)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No traffic-source rows were collected for this episode.</p>';
  $('#episode-analytics-detail').innerHTML = `<div id="episode-trend">${analyticsTrend(video.daily, episodeRange(video), video.name, 'episode')}</div><article class="analytics-report"><h4>How viewers found this episode</h4>${rows.length ? `<p class="note">YouTube Analytics API · ${escapeHTML(date(source?.start || episodeRange(video).start))} – ${escapeHTML(date(end))} · collected ${escapeHTML(date(capture))}. ${video.refreshReports?.traffic === 'no-rows-retained-previous' ? 'Older traffic report retained because the latest refresh returned no rows.' : ''} Traffic reports can omit or suppress detail and do not provide their own daily completeness marker.</p>` : ''}${traffic}</article>`;
}
function initializeAnalytics() {
  renderChannelAnalytics();
  renderShortsAnalytics();
  $('#episode-analytics-note').textContent = `${data.videos.length} included full episodes. Each native aggregate covers that video's own publication-to-cutoff window in Pacific time; different video ages are not a controlled comparison. Video-filtered subscriber gains/losses cover watch-page attribution and are not channel totals. Missing values are not collected.`;
  $('#analytics-video').innerHTML = data.videos.map(video => `<option value="${escapeHTML(video.id)}">${escapeHTML(video.name)}</option>`).join('');
  renderEpisodeAnalytics();
  renderEpisodeAnalyticsDetail();
  $('#analytics-search').addEventListener('input', renderEpisodeAnalytics);
  $('#analytics-sort').addEventListener('change', renderEpisodeAnalytics);
  $('#analytics-video').addEventListener('change', renderEpisodeAnalyticsDetail);
  $('#analytics').addEventListener('change', event => {
    if (event.target.id === 'channel-breakdown') { renderChannelBreakdown(); return; }
    if (event.target.dataset.trendMetric === 'shorts') {
      shortsMetric = shortsFields.some(([field]) => field === event.target.value) ? event.target.value : 'views';
      $('#shorts-trend').innerHTML = analyticsTrend(data.shortsAnalytics.daily, data.shortsAnalytics.dateRange, 'Shorts', 'shorts', shortsLimit, true);
      document.querySelector('[data-trend-metric="shorts"]')?.focus();
      return;
    }
    const key = event.target.dataset.trendRange;
    if (!key) return;
    const limit = event.target.value === 'all' ? null : Number(event.target.value);
    if (key === 'channel') $('#channel-trend').innerHTML = analyticsTrend(data.channelAnalytics.daily, data.channelAnalytics.dateRange, 'Channel', key, limit);
    if (key === 'shorts') {
      shortsLimit = limit;
      $('#shorts-trend').innerHTML = analyticsTrend(data.shortsAnalytics.daily, data.shortsAnalytics.dateRange, 'Shorts', key, limit, true);
    }
    if (key === 'episode') {
      const video = videoFor($('#analytics-video').value);
      $('#episode-trend').innerHTML = analyticsTrend(video.daily, episodeRange(video), video.name, key, limit);
    }
    document.querySelector(`[data-trend-range="${key}"]`)?.focus();
  });
  $('#export-episode-analytics').addEventListener('click', () => {
    const rows = [['video_id', 'title', 'start', 'end', 'captured_at', ...analyticsFields.map(field => field[0])],
      ...episodeAnalyticsRows().map(({ video, metrics }) => {
        const range = episodeRange(video);
        return [video.id, episodeTitle(video), range.start, range.end, video.analyticsSource?.capturedAt || data.capturedAt, ...analyticsFields.map(field => metrics[field[0]])];
      })];
    download('scran-pints-episode-analytics.csv', rows.map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  });
}

function renderSummary() {
  const complete = data.videos.filter(video => windowMetrics(video, 3).complete).length;
  const missingMetadata = ['description', 'tags'].filter(field => data.videos.some(video => video.metadata?.[field] == null)).length;
  $('#summary-strip').innerHTML = [
    [data.videos.length, 'MAIN VIDEOS', 'YouTube long form in this snapshot'],
    [complete, 'COMPARABLE STARTS', 'Complete first 3 calendar dates'],
    [tests.length, 'SAVED TEST GROUPS', 'Original IDs and captures retained'],
    [missingMetadata, 'METADATA FIELD GAPS', missingMetadata ? 'Some descriptions / tags not collected' : 'Descriptions & tags have dated captures']
  ].map(([value, label, detail]) => `<div><small>${label}</small><strong>${escapeHTML(value)}</strong><span>${detail}</span></div>`).join('');
  const discovery = data.youtubeRefresh?.discovery;
  $('#discovery-note').textContent = discovery
    ? `Upload inventory checked ${date(discovery.observedAt)}. ${discovery.includedLongformCount} of ${discovery.confirmedLongformCount} confirmed full-length uploads included from ${discovery.publicUploadsCount} public uploads. ${discovery.excludedShortsCount} Shorts and ${discovery.excludedLiveCount} live streams stay outside this view.${discovery.excludedOtherCount ? ` ${discovery.excludedOtherCount} other confirmed formats excluded.` : ''}${discovery.unknownFormatIds?.length ? ` Format not yet verified: ${discovery.unknownFormatIds.join(', ')}.` : ''}${discovery.unreportedLongformIds?.length ? ` Reporting not yet available: ${discovery.unreportedLongformIds.join(', ')}.` : ''}${discovery.pendingPublicationIds?.length ? ` Published after the reporting cutoff: ${discovery.pendingPublicationIds.join(', ')}.` : ''} Missing rows remain unavailable.`
    : `This saved catalog contains ${data.videos.length} selected full episodes. A complete channel upload inventory has not been collected yet. Connect YouTube and refresh episodes to discover other public full-length uploads.`;
}

function comparisonRows() {
  const sort = $('#comparison-sort').value;
  return data.videos.map(video => ({ video, metrics: windowMetrics(video, windowDays) })).sort((a, b) => {
    if (sort === 'episode') return (a.video.episode ?? 0) - (b.video.episode ?? 0);
    const av = a.metrics.complete && typeof a.metrics[sort] === 'number' ? a.metrics[sort] : -Infinity;
    const bv = b.metrics.complete && typeof b.metrics[sort] === 'number' ? b.metrics[sort] : -Infinity;
    return bv - av;
  });
}

function renderComparison() {
  const rows = comparisonRows();
  const missing = rows.filter(row => !row.metrics.complete).map(row => row.video.name);
  $('#window-note').textContent = `Publication date + the next ${windowDays - 1} calendar dates. First date may be partial; not an exact ${windowDays * 24}-hour comparison. API export through ${date(data.apiThrough)}.${missing.length ? ` Incomplete: ${missing.join(', ')}.` : ''}`;
  $('#comparison-body').innerHTML = rows.map(({ video, metrics }) => {
    const packaging = workshopPackage(video, data.capturedAt);
    return `<tr><td><div class="episode-row">${packaging.thumbnail ? `<img src="${escapeHTML(packaging.thumbnail)}" alt="" loading="lazy">` : ''}<div><strong>${escapeHTML(video.name)}</strong>${video.name !== packaging.title ? `<small>${escapeHTML(packaging.title)}</small>` : ''}<small>Title captured ${escapeHTML(date(packaging.capturedAt))}${packaging.hostedImage ? ' · hosted image may change' : ''}</small></div></div></td>${['views', 'watchHours', 'subscribersNet'].map(key => `<td class="metric ${!metrics.complete ? 'unavailable' : ''}">${metrics.complete ? number(metrics[key], key === 'watchHours' ? 1 : 0) : 'Incomplete'}</td>`).join('')}<td><small>${escapeHTML(date(metrics.start))}<br>to ${escapeHTML(date(metrics.end))}</small>${!metrics.complete ? `<small>${escapeHTML(metrics.reason)}</small>` : ''}</td></tr>`;
  }).join('');
}

function studioCard(video, index) {
  const studio = video.studio || {};
  const packaging = workshopPackage(video, data.capturedAt);
  const image = packaging.thumbnail;
  const values = [
    ['Whole-video CTR', percent(studio.ctrPct)],
    ['Impressions · rounded', studio.impressionsDisplay || 'Not collected'],
    ['Watch hours · rounded', studio.engagement?.watchHoursDisplay || 'Not collected'],
    ['Average watch', studio.engagement?.averageViewDuration || 'Not collected'],
    ['Average % watched', percent(studio.retention?.averagePercentageViewed)],
    ['Watching at ~30 sec', percent(studio.retention?.intro30sPct)]
  ];
  const api = video.apiAggregate || {};
  const freshApi = video.analyticsSource ? `<section class="api-refresh"><span class="pill">Collected API totals</span><dl>${[['Views', number(api.views)], ['Watch hours', number(api.estimatedMinutesWatched == null ? null : api.estimatedMinutesWatched / 60, 1)], ['Avg. view seconds', number(api.averageViewDuration, 1)], ['Avg. % watched', percent(api.averageViewPercentage)], ['Net subscribers', number(video.subscribersNet)], ['Shares', number(api.shares)]].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHTML(value)}</dd></div>`).join('')}</dl><p class="note">Publication to ${escapeHTML(date(video.analyticsSource.end))} · collected ${escapeHTML(date(video.analyticsSource.capturedAt))}. Whole-video results across all packaging. Current metadata appears in the Metadata section.</p></section>` : '';
  const studioSection = packaging.hasStudio ? `<span class="pill">${video.analyticsSource ? 'Historical Studio snapshot' : 'Whole-video Studio totals'}</span><dl>${values.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHTML(value)}</dd></div>`).join('')}</dl><p class="note">Since published · captured ${escapeHTML(date(studio.capturedAt || data.studioCapturedAt))}. Published ${escapeHTML(date(video.publishedAt))}. These totals cover different video ages and every title/image used.</p>` :
    '<p class="notice quiet">No historical Studio snapshot has been collected for this upload. CTR and impressions remain unavailable here.</p>';
  return `<article class="video-card"><div class="video-card-head">${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(`Thumbnail for ${video.name}`)}" loading="lazy">` : ''}<div><span class="eyebrow">VIDEO ${index === 0 ? 'A' : 'B'} / ${escapeHTML(video.name)}</span><p>${escapeHTML(packaging.title)}</p></div></div><p class="note">Title captured ${escapeHTML(date(packaging.capturedAt))}. ${packaging.hostedImage ? 'YouTube hosts this thumbnail URL; the served image may change after capture.' : 'The local image and title are the historical saved package.'}</p>${freshApi}${studioSection}<a href="https://studio.youtube.com/video/${encodeURIComponent(video.id)}/analytics" target="_blank" rel="noopener noreferrer">Open video analytics in Studio ↗</a></article>`;
}

function renderRetention(videos) {
  const series = videos.map(video => ({ video, points: (video.retention || []).filter(point => Number.isFinite(point.elapsedVideoTimeRatio) && Number.isFinite(point.audienceWatchRatio) && point.elapsedVideoTimeRatio >= 0 && point.elapsedVideoTimeRatio <= 1 && point.audienceWatchRatio >= 0).sort((a, b) => a.elapsedVideoTimeRatio - b.elapsedVideoTimeRatio) }));
  if (!series.some(item => item.points.length)) {
    $('#retention-chart').innerHTML = '<p class="empty">No retention curve was collected for these episodes.</p>';
    return;
  }
  const max = Math.max(1, ...series.flatMap(item => item.points.map(point => point.audienceWatchRatio)));
  const top = Math.ceil(max * 4) / 4;
  const x = ratio => 54 + ratio * 840;
  const y = ratio => 235 - ratio / top * 200;
  const grid = Array.from({ length: 5 }, (_, i) => i * top / 4).map(value => `<line x1="54" x2="894" y1="${y(value)}" y2="${y(value)}" stroke="#e5e3db"/><text x="43" y="${y(value) + 4}" text-anchor="end">${number(value * 100)}%</text>`).join('');
  const labels = [0, .25, .5, .75, 1].map(value => `<text x="${x(value)}" y="258" text-anchor="middle">${value * 100}%</text>`).join('');
  const paths = series.map((item, i) => `<polyline fill="none" stroke="${i ? '#222522' : '#c53529'}" stroke-width="3" ${i ? 'stroke-dasharray="8 5"' : ''} points="${item.points.map(point => `${x(point.elapsedVideoTimeRatio).toFixed(2)},${y(point.audienceWatchRatio).toFixed(2)}`).join(' ')}"/>`).join('');
  const samples = series.map(({ video, points }) => `${escapeHTML(video.name)}: ${points.length && video.retentionNear30Seconds?.audienceWatchRatio != null ? `${percent(video.retentionNear30Seconds.audienceWatchRatio * 100)} at ${number(video.retentionNear30Seconds.sampledSeconds, 1)}s` : 'no near-30-second sample collected'}`).join(' · ');
  const sources = series.map(({ video, points }) => points.length ? `${escapeHTML(video.name)}: curve captured ${escapeHTML(date(video.retentionSource?.capturedAt || data.capturedAt))}; queried through ${escapeHTML(date(video.retentionSource?.end || data.apiThrough))}${video.refreshReports?.retention === 'no-rows-retained-previous' ? ' · older curve retained because refresh returned no rows' : ''}` : `${escapeHTML(video.name)}: retention curve unavailable`).join(' · ');
  $('#retention-chart').innerHTML = `<svg viewBox="0 0 930 285" role="img" aria-labelledby="retention-title retention-description"><title id="retention-title">Audience retention: ${escapeHTML(videos.map(video => video.name).join(' compared with '))}</title><desc id="retention-description">Audience watch ratio over percentage through each video. Source: saved YouTube API retention export. These curves are not first ${windowDays} date results.</desc>${grid}${labels}${paths}<text x="474" y="280" text-anchor="middle">PROGRESS THROUGH VIDEO</text></svg><div class="chart-legend">${series.map(item => `<span><i aria-hidden="true"></i>${escapeHTML(item.video.name)}${!item.points.length ? ' · no curve collected' : ''}</span>`).join('')}</div><p class="note">API sample near 30 seconds: ${samples}. Studio’s 30-second card uses its own capture and may differ.</p><p class="note">${sources}. Retention reports do not return a daily completeness marker.</p>`;
}

function renderHeadToHead() {
  const videos = [videoFor($('#video-a').value), videoFor($('#video-b').value)];
  $('#video-cards').innerHTML = videos.map(studioCard).join('');
  renderRetention(videos);
  $('#comparison-prompt').innerHTML = `<p><strong>Comparison notes</strong>${videos[0].id === videos[1].id ? 'Choose two different episodes to compare.' : `Compare ${escapeHTML(videos[0].name)} and ${escapeHTML(videos[1].name)}. Note differences in the opening, title and thumbnail. Audience, video age and distribution can also affect performance.`}</p><button id="start-pair-experiment" class="button" type="button">Draft a test ↗</button>`;
  $('#start-pair-experiment').addEventListener('click', () => {
    newExperiment(videos[0].id);
    $('#experiment-control').value = `${videos.map(video => { const pair = workshopPackage(video, data.capturedAt); return `${video.name}: ${pair.title}\nTitle captured ${date(pair.capturedAt)}${pair.hostedImage ? '; hosted thumbnail may change' : '; saved local thumbnail'}`; }).join('\nCompared with\n')}\nAPI through ${date(data.apiThrough)}; whole-video observations, not a controlled experiment.`;
    selectStudioSection('notebook');
    $('#notebook').scrollIntoView({ behavior: 'smooth' });
    $('#experiment-hypothesis').focus({ preventScroll: true });
  });
}

function pairCard(variant, group) {
  const share = variant.metrics?.watchTimeSharePct;
  const hasShare = typeof share === 'number' && Number.isFinite(share);
  const highest = hasShare && share === group?.highestShare;
  const title = variant.title || 'Title pairing not recovered';
  const caveats = variant.caveats || [];
  const sources = variant.sources || [];
  return `<article class="pair-card">${imageHTML(variant.webThumbnail || variant.webEvidence, title, !variant.webThumbnail && !!variant.webEvidence)}<span class="record-status">${escapeHTML(variant.status === 'current' ? 'LATEST SAVED OBSERVATION' : variant.testId ? (group?.type === 'title-only' ? 'RECOVERED TITLE VARIANT' : 'RECOVERED TEST PAIR') : 'HISTORICAL CAPTURE')}</span><h4>${escapeHTML(title)}</h4>${group ? `<div class="share ${highest ? 'highest' : ''}">${hasShare ? percent(share) : '—'}<small>${hasShare ? 'test watch-time share' : 'share not collected'}</small></div>${highest ? '<p>Highest recorded share in this group · not proof of a winner</p>' : ''}` : ''}<p>Observed: ${escapeHTML(variant.observedAt ? date(variant.observedAt) : 'Date not recorded')}</p>${variant.thumbnailDescription ? `<p>${escapeHTML(variant.thumbnailDescription)}</p>` : ''}<details><summary>Capture details &amp; evidence</summary><p>Record: ${escapeHTML(variant.variantId)}<br>Original capture date: ${escapeHTML(variant.observedAt || 'Not recorded')}</p>${variant.window ? `<p>${escapeHTML(variant.window)}</p>` : ''}${asset(variant.webEvidence) ? `<p><a href="${escapeHTML(asset(variant.webEvidence))}" target="_blank" rel="noopener noreferrer">Open saved screenshot ↗</a></p>` : ''}${caveats.length ? `<ul>${caveats.map(note => `<li>${escapeHTML(note)}</li>`).join('')}</ul>` : ''}${sources.length ? `<p>Original source references</p><ul>${sources.map(source => `<li>${escapeHTML(source)}</li>`).join('')}</ul>` : ''}</details></article>`;
}

function renderPackaging() {
  const episode = $('#packaging-video').value;
  const scope = $('#packaging-scope').value;
  const query = $('#packaging-search').value.trim().toLocaleLowerCase();
  const matchesTitle = variant => (variant.title || '').toLocaleLowerCase().includes(query);
  if (scope === 'history') {
    const histories = (data.history?.videos || []).filter(video => episode === 'all' || video.videoId === episode).map(video => ({ ...video, captures: (video.variants || []).filter(variant => variant.status !== 'draft' && matchesTitle(variant)).sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt))) })).filter(video => video.captures.length);
    $('#packaging-count').textContent = `${histories.reduce((count, video) => count + video.captures.length, 0)} recovered captures. Repeated captures remain visible; drafts are excluded.`;
    $('#packaging-results').innerHTML = histories.length ? histories.map(video => `<details class="history-block" ${episode !== 'all' || query ? 'open' : ''}><summary>${escapeHTML(video.episode)} · ${video.captures.length} captures</summary><div class="pair-grid">${video.captures.map(variant => pairCard(variant, null)).join('')}</div><div class="round-footer note">${(video.missingHistory || []).map(escapeHTML).join('<br>')}</div></details>`).join('') : '<p class="empty">No recovered captures match these filters.</p>';
    return;
  }
  let visible = tests.filter(group => (episode === 'all' || group.videoId === episode) && group.variants.length);
  if (scope === 'latest') {
    const latest = new Map();
    for (const group of visible) {
      const previous = latest.get(group.videoId);
      if (!previous || String(group.observedAt) > String(previous.observedAt)) latest.set(group.videoId, group);
    }
    visible = [...latest.values()];
  }
  visible = visible.filter(group => !query || group.variants.some(matchesTitle));
  $('#packaging-count').textContent = `${visible.length} test groups shown. A matching title keeps its whole comparison group visible. ${scope === 'latest' ? 'Choose every saved test round for earlier and revised captures.' : 'Groups retain their original IDs; related captures may describe the same underlying test.'}`;
  $('#packaging-results').innerHTML = visible.length ? visible.map(group => `<article class="test-round"><div class="round-header"><div><span class="eyebrow">${escapeHTML(group.episode)} / ${escapeHTML(group.testId)}</span><h3>${escapeHTML(group.result || (group.status?.includes('without a clear winner') ? 'No clear winner' : 'Saved test evidence'))}</h3><p>${escapeHTML(group.status || 'Final status not recorded')}<br>${escapeHTML(group.window || 'Exact run dates not recorded')}<br>Captured ${escapeHTML(date(group.observedAt))}</p></div><span class="pill">${group.type === 'title-only' ? 'TITLE-ONLY TEST' : group.type === 'thumbnail-only' ? 'THUMBNAIL-ONLY TEST' : 'PAIRING RESULTS ONLY'}</span></div><div class="pair-grid">${group.variants.map(variant => pairCard(variant, group)).join('')}</div><div class="round-footer"><button class="text-button" type="button" data-draft-test="${escapeHTML(group.testId)}">Use this evidence in a draft ↗</button></div></article>`).join('') : '<p class="empty">No recovered native test matches these filters. Current API metadata is not a native test result. Choose capture history to inspect any saved evidence for this upload.</p>';
}

function renderMetadata() {
  const collected = data.videos.filter(video => video.metadata?.capturedAt).length;
  $('#metadata-intro').textContent = collected ? `${collected} of ${data.videos.length} episodes have dated YouTube Data API metadata. These current title, description and tag captures are separate from older test results and Studio cards. A character count is not an SEO score.` : 'Title length and recovered packaging are available now. Descriptions and tags have not been collected. Collection dates will appear when a verified YouTube refresh supplies them.';
  $('#metadata-body').innerHTML = data.videos.map(video => {
    const audit = metadataAudit(video, historyFor(video.id));
    const thumbnailUrl = workshopThumbnail(video.metadata?.thumbnail?.url);
    const description = audit.descriptionText === null ? '<span class="unavailable">Not collected</span>' : `<details class="metadata-detail"><summary>${escapeHTML(audit.description)}</summary><p>${escapeHTML(audit.descriptionText || 'Description was empty at this capture.')}</p></details>`;
    const tags = audit.tagList === null ? '<span class="unavailable">Not collected</span>' : `<details class="metadata-detail"><summary>${escapeHTML(audit.tags)}</summary><p>${escapeHTML(audit.tagList.length ? audit.tagList.join(' · ') : video.metadata.tagsFieldReturned ? 'The returned tag list was empty.' : 'The API returned no tags field.')}</p></details>`;
    return `<tr><td><strong>${escapeHTML(video.name)}</strong><small>${escapeHTML(audit.title)}</small>${audit.capturedAt ? `<small>Metadata captured ${escapeHTML(date(audit.capturedAt))}</small>${thumbnailUrl ? `<a class="metadata-thumb" href="${escapeHTML(thumbnailUrl)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHTML(thumbnailUrl)}" loading="lazy" alt="${escapeHTML(`Thumbnail URL returned with ${audit.title}`)}"></a><small>URL observed at capture; hosted image can change.</small>` : ''}` : '<small>Title from the historical saved package</small>'}</td><td>${audit.characters}<small>${audit.words} words</small></td><td>${audit.recoveredTitles}</td><td>${audit.thumbnailCaptures}<small>Historical saved captures</small></td><td>${description}</td><td>${tags}</td></tr>`;
  }).join('');
}

function notebookPayload() { return { schema: 'scran-workshop-notebook-v1', exportedAt: new Date().toISOString(), entries }; }
function setNotebookStatus(message) { $('#notebook-status').textContent = message; }
const formFields = ['videoId', 'status', 'hypothesis', 'change', 'control', 'candidate', 'thumbnail', 'metric', 'decision', 'result'];
function formValues() { return Object.fromEntries(formFields.map(field => [field, String($('#experiment-form').elements.namedItem(field).value || '').trim()])); }
function applyFormEntry(entry) {
  if (!entry) { newExperiment(); return; }
  $('#experiment-id').value = entry.id;
  for (const field of formFields) {
    const input = $('#experiment-form').elements.namedItem(field);
    if (field === 'videoId' && ![...input.options].some(option => option.value === entry.videoId)) input.add(new Option(`Imported episode: ${entry.videoId}`, entry.videoId));
    input.value = entry[field];
  }
  window.SPSelect?.refresh($('#experiment-form'));
  $('#form-title').textContent = 'Edit team draft';
  formBaseline = JSON.stringify(formValues());
}
function setNotebookBusy(value) {
  notebookBusy = value;
  document.querySelectorAll('#notebook button, #import-notebook, #experiment-form input, #experiment-form select, #experiment-form textarea').forEach(button => {
    if (button.id !== 'export-notebook') button.disabled = value;
  });
}
function notebookResponse(payload) {
  if (!Number.isSafeInteger(payload?.version) || payload.version < 0) throw Error('Invalid team notebook version.');
  return { ...payload, drafts: validateNotebook({ schema: 'scran-workshop-notebook-v1', entries: payload.drafts }) };
}
async function persistNotebook() {
  if (!teamAccess) return false;
  notebookDirty = true;
  if (notebookBusy) return false;
  if (notebookVersion === null || notebookNeedsReload) {
    setNotebookStatus('This change is in the page only. Reload team notes to reconcile the latest version, then save. Export JSON before closing to keep a copy.');
    return false;
  }
  setNotebookBusy(true);
  setNotebookStatus('Saving the team notebook…');
  try {
    const response = await fetch('/api/workshop-notebook', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drafts: entries, expectedVersion: notebookVersion }),
    });
    if (response.status === 409) {
      notebookNeedsReload = true;
      setNotebookStatus('Someone saved a newer team version. Your changes are still in this page. Choose Reload team notes to preserve both versions, review them, then save again.');
      return false;
    }
    if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? 'Your team session needs sign-in again.' : 'Cloud storage did not confirm this save.');
    const saved = notebookResponse(await response.json());
    notebookVersion = saved.version;
    entries = saved.drafts;
    notebookBase = structuredClone(entries);
    notebookDirty = false;
    $('#notebook-connection').textContent = `Team version ${notebookVersion} · saved ${date(saved.updatedAt)}.`;
    setNotebookStatus('Saved to the shared team notebook.');
    return true;
  } catch (error) {
    notebookNeedsReload = true;
    setNotebookStatus(`${error.message} Your changes remain in this page. Export JSON before closing, then reload team notes before retrying.`);
    return false;
  } finally { setNotebookBusy(false); renderNotebook(); }
}

async function loadNotebook() {
  if (!teamAccess) return;
  if (notebookBusy) return;
  // Capture unsaved form edits before rebasing, so reloading cannot overwrite
  // another person's changes with a stale form or discard this person's text.
  if (formBaseline && JSON.stringify(formValues()) !== formBaseline) {
    const values = formValues();
    const id = $('#experiment-id').value || crypto.randomUUID();
    if (entries.length >= 200 && !entries.some(entry => entry.id === id)) {
      setNotebookStatus('Save or export the current form before reloading: the notebook already has 200 experiments.'); return;
    }
    entries = [...entries.filter(entry => entry.id !== id), { ...values, id, updatedAt: new Date().toISOString() }];
    $('#experiment-id').value = id;
    notebookDirty = true;
    formBaseline = JSON.stringify(values);
  }
  setNotebookBusy(true);
  try {
    const response = await fetch('/api/workshop-notebook', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? 'Sign in again to load shared notes.' : 'Shared notebook storage is unavailable.');
    const latest = notebookResponse(await response.json());
    const merged = mergeNotebookChanges(notebookBase, entries, latest.drafts, () => crypto.randomUUID());
    notebookVersion = latest.version;
    notebookBase = structuredClone(latest.drafts);
    entries = merged.entries;
    const editingId = $('#experiment-id').value;
    if (editingId) applyFormEntry(entries.find(entry => entry.id === (merged.remappedIds[editingId] || editingId)));
    notebookNeedsReload = false;
    notebookDirty = JSON.stringify(entries) !== JSON.stringify(notebookBase);
    $('#notebook-connection').textContent = `Team version ${notebookVersion}${latest.updatedAt ? ` · saved ${date(latest.updatedAt)}` : ' · no experiments saved yet'}.`;
    setNotebookStatus(merged.conflicts ? `${merged.conflicts} conflicting edits preserved for review. Your changed drafts remain separate where needed. Review and save the merged team notebook.` :
      notebookDirty ? 'Latest team notes loaded; your page changes were preserved. Save to share the merged notebook.' : 'Shared team notebook loaded.');
  } catch (error) {
    $('#notebook-connection').textContent = 'Shared notes could not be loaded.';
    notebookNeedsReload = true;
    setNotebookStatus(`${error.message} Drafts you write remain in this page until a save is confirmed. Export JSON before closing.`);
  } finally {
    setNotebookBusy(false);
    renderNotebook();
    try { $('#import-browser-notebook').hidden = !localStorage.getItem(storageKey); } catch { /* Older browser notes are optional. */ }
  }
}

function renderNotebook() {
  $('#save-notebook').disabled = notebookBusy || !notebookDirty;
  $('#draft-count').textContent = entries.length;
  $('#saved-experiments').innerHTML = entries.length ? [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(entry => `<article class="saved-experiment"><span class="pill">${escapeHTML(entry.status)}</span><h4>${escapeHTML(videoFor(entry.videoId)?.name || 'Unmatched episode')} / ${escapeHTML(entry.change)}</h4><p>${escapeHTML(entry.hypothesis)}</p>${entry.result ? `<p><strong>Recorded observation:</strong> ${escapeHTML(entry.result)}</p>` : '<p class="note">No measured result recorded yet.</p>'}<p class="note">Edited ${escapeHTML(date(entry.updatedAt))} · ${notebookDirty ? 'page copy has changes to save' : 'shared team draft'}</p><div class="draft-actions"><button class="text-button" type="button" data-edit="${escapeHTML(entry.id)}">Edit draft ↗</button><button class="text-button" type="button" data-delete="${escapeHTML(entry.id)}">Remove draft</button></div></article>`).join('') : '<p class="empty">No experiments loaded yet. Start with one question you can test.</p>';
}

function newExperiment(videoId) {
  $('#experiment-form').reset();
  $('#experiment-id').value = '';
  $('#form-title').textContent = 'Plan the next test';
  if (videoId) $('#experiment-video').value = videoId;
  window.SPSelect?.refresh($('#experiment-form'));
  formBaseline = JSON.stringify(formValues());
  setNotebookStatus('New draft · save to share with the team. Nothing is sent to YouTube.');
}

function editExperiment(id) {
  const entry = entries.find(item => item.id === id);
  if (!entry) return;
  applyFormEntry(entry);
  $('#experiment-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#experiment-hypothesis').focus({ preventScroll: true });
  setNotebookStatus('Editing a saved draft. Save to keep your changes.');
}

function bindNotebook() {
  formBaseline = JSON.stringify(formValues());
  $('#save-notebook').addEventListener('click', persistNotebook);
  $('#reload-notebook').addEventListener('click', loadNotebook);
  $('#new-experiment').addEventListener('click', () => newExperiment());
  $('#experiment-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (notebookBusy) return;
    const form = new FormData(event.currentTarget);
    const id = $('#experiment-id').value || crypto.randomUUID();
    if (!entries.some(entry => entry.id === id) && entries.length >= 200) {
      setNotebookStatus('This notebook has 200 experiments. Export and remove an old draft before adding another.');
      return;
    }
    const entry = { id, updatedAt: new Date().toISOString() };
    for (const field of ['videoId', 'status', 'hypothesis', 'change', 'control', 'candidate', 'thumbnail', 'metric', 'decision', 'result']) entry[field] = String(form.get(field) || '').trim();
    if (!entry.hypothesis || !entry.metric || !entry.decision) {
      setNotebookStatus('Add a hypothesis, measurement window and decision rule before saving.');
      return;
    }
    entries = [...entries.filter(item => item.id !== id), entry];
    $('#experiment-id').value = id;
    $('#form-title').textContent = 'Edit team draft';
    formBaseline = JSON.stringify(formValues());
    await persistNotebook();
    renderNotebook();
  });
  $('#export-notebook').addEventListener('click', () => {
    download(`scran-pints-experiments-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(notebookPayload(), null, 2), 'application/json');
    setNotebookStatus('Exported the page’s experiments, including changes awaiting a cloud save. Unsaved form edits are not included.');
  });
  $('#import-notebook').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error('Choose a notebook smaller than 2 MB.');
      await importEntries(validateNotebook(JSON.parse(await file.text())));
    } catch (error) {
      setNotebookStatus(`Import failed: ${error.message}`);
    } finally { event.target.value = ''; }
  });
  $('#import-browser-notebook').addEventListener('click', async () => {
    try { await importEntries(validateNotebook(JSON.parse(localStorage.getItem(storageKey)))); }
    catch (error) { setNotebookStatus(`Older browser drafts could not be imported: ${error.message}`); }
  });
  $('#saved-experiments').addEventListener('click', async event => {
    if (notebookBusy) return;
    const edit = event.target.closest('[data-edit]');
    const remove = event.target.closest('[data-delete]');
    if (edit) editExperiment(edit.dataset.edit);
    if (remove) {
      const entry = entries.find(item => item.id === remove.dataset.delete);
      if (entry && window.confirm('Remove this draft from the shared team notebook? Export a copy first if you want to keep it.')) {
        entries = entries.filter(item => item.id !== entry.id);
        if ($('#experiment-id').value === entry.id) newExperiment();
        await persistNotebook();
        renderNotebook();
      }
    }
  });
  window.addEventListener('beforeunload', event => {
    if (notebookDirty || JSON.stringify(formValues()) !== formBaseline) { event.preventDefault(); event.returnValue = ''; }
  });
}

async function importEntries(imported) {
  if (notebookBusy) return;
  const merged = mergeNotebookChanges([], imported, entries, () => crypto.randomUUID());
  entries = merged.entries;
  const saved = await persistNotebook();
  renderNotebook();
  if (saved) setNotebookStatus(`Imported ${imported.length} experiments into the team notebook. ${merged.conflicts ? `${merged.conflicts} differing versions preserved as separate drafts.` : 'Identical existing drafts kept once.'}`);
}

const studioSections = new Set(['analytics', 'uploads', 'compare', 'packaging', 'metadata', 'notebook']);
function selectStudioSection(requested, updateUrl = true) {
  const selected = studioSections.has(requested) && (requested !== 'notebook' || teamAccess) ? requested : 'analytics';
  document.querySelectorAll('[data-studio-panel]').forEach(panel => { panel.hidden = panel.id !== selected; });
  document.querySelectorAll('[data-studio-tab]').forEach(link => {
    if (link.dataset.studioTab === selected) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  if (updateUrl) history.replaceState(null, '', `#${selected}`);
  return selected;
}
function initializeStudioNavigation() {
  selectStudioSection(location.hash.slice(1), false);
  document.querySelectorAll('[data-studio-tab]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    selectStudioSection(link.dataset.studioTab);
  }));
  window.addEventListener('hashchange', () => selectStudioSection(location.hash.slice(1), false));
}

function reportingStamp() {
  $('#source-stamp').textContent = `Through ${date(data.apiThrough)} · Updated ${date(data.capturedAt)}`;
  $('#method-dates').textContent = `Saved reporting evidence · API through ${date(data.apiThrough)} · collected ${date(data.capturedAt)} · historical Studio cards ${date(data.studioCapturedAt)}`;
}
function renderUploadAnalytics() {
  mountUploadAnalytics($('#upload-analytics'), { uploadAnalytics: data.uploadAnalytics, channelBreakdowns: data.channelBreakdowns });
}
async function reloadStudioReporting() {
  const response = await fetch('/api/workshop-data', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw Error('Studio reporting unavailable');
  const updated = await response.json();
  if (!Array.isArray(updated.videos) || !updated.videos.length) throw Error('No included episodes returned');
  data = updated;
  if (!studioReady) { initialize(); return; }
  tests = groupTests(data.history);
  const options = data.videos.map(video => `<option value="${escapeHTML(video.id)}">${escapeHTML(video.name)}</option>`).join('');
  for (const selector of ['#video-a', '#video-b', '#analytics-video', '#packaging-video']) {
    const select = $(selector), value = select.value;
    select.innerHTML = (selector === '#packaging-video' ? '<option value="all">All episodes</option>' : '') + options;
    if ([...select.options].some(option => option.value === value)) select.value = value;
  }
  // Add newly discovered uploads without rewriting an unsaved notebook form.
  for (const video of data.videos) {
    if (![...$('#experiment-video').options].some(option => option.value === video.id)) {
      $('#experiment-video').add(new Option(video.name, video.id));
    }
  }
  const breakdown = $('#channel-breakdown')?.value;
  renderChannelAnalytics();
  if ([...$('#channel-breakdown').options].some(option => option.value === breakdown)) $('#channel-breakdown').value = breakdown;
  renderChannelBreakdown();
  renderShortsAnalytics();
  renderEpisodeAnalytics();
  renderEpisodeAnalyticsDetail();
  renderSummary();
  renderComparison();
  renderHeadToHead();
  renderPackaging();
  renderMetadata();
  renderUploadAnalytics();
  reportingStamp();
  window.SPSelect?.refresh();
}

function initialize() {
  tests = groupTests(data.history);
  const options = data.videos.map(video => `<option value="${escapeHTML(video.id)}">${escapeHTML(video.name)}</option>`).join('');
  for (const selector of ['#video-a', '#video-b', '#experiment-video']) $(selector).innerHTML = options;
  $('#packaging-video').insertAdjacentHTML('beforeend', options);
  $('#video-b').value = data.videos[Math.min(2, data.videos.length - 1)].id;
  window.SPSelect?.refresh();
  reportingStamp();
  initializeAnalytics();
  renderUploadAnalytics();
  renderSummary();
  renderComparison();
  renderHeadToHead();
  renderPackaging();
  renderMetadata();
  document.querySelectorAll('input[name="window"]').forEach(input => input.addEventListener('change', () => {
    windowDays = Number(input.value);
    renderComparison();
    renderRetention([videoFor($('#video-a').value), videoFor($('#video-b').value)]);
  }));
  $('#comparison-sort').addEventListener('change', renderComparison);
  for (const selector of ['#video-a', '#video-b']) $(selector).addEventListener('change', renderHeadToHead);
  for (const selector of ['#packaging-video', '#packaging-scope']) $(selector).addEventListener('change', renderPackaging);
  $('#packaging-search').addEventListener('input', renderPackaging);
  $('#export-comparison').addEventListener('click', () => {
    const csvValue = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = [['Episode', 'Video ID', 'Calendar dates', 'Start', 'End', 'Complete', 'Views', 'Watch hours', 'Net subscribers', 'API through'], ...comparisonRows().map(({ video, metrics }) => [video.name, video.id, windowDays, metrics.start, metrics.end, metrics.complete, metrics.views, metrics.watchHours, metrics.subscribersNet, data.apiThrough])];
    download(`scran-pints-first-${windowDays}-dates.csv`, rows.map(row => row.map(csvValue).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  });
  document.addEventListener('click', event => {
    const image = event.target.closest('[data-preview]');
    if (image) {
      $('#preview-image').src = image.dataset.preview;
      $('#preview-image').alt = image.dataset.caption;
      $('#preview-caption').textContent = image.dataset.caption;
      $('#image-dialog').showModal();
    }
    const draft = event.target.closest('[data-draft-test]');
    if (draft) {
      const group = tests.find(item => item.testId === draft.dataset.draftTest);
      if (!group) return;
      newExperiment(group.videoId);
      $('#experiment-change').value = group.type === 'title-only' ? 'Title only' : group.type === 'thumbnail-only' ? 'Thumbnail only' : 'Title + thumbnail pairing';
      window.SPSelect?.refresh($('#experiment-change'));
      $('#experiment-control').value = `${group.episode} / ${group.testId}\n${group.window || 'Exact run dates not recorded'}\nCaptured ${group.observedAt || 'date not recorded'}\n${group.status || group.result || 'No result recorded'}\n${group.variants.map(variant => `${variant.title || 'Title unknown'}: ${percent(variant.metrics?.watchTimeSharePct)} watch-time share`).join('\n')}`;
      $('#experiment-metric').value = group.type === 'title-only' ? 'Native title-only test with its shared thumbnail held fixed. Keep the full test dates and final status; unavailable shares remain unavailable. Do not infer variant CTR or a winner from the visible default.' : 'Native test watch-time share for the whole title/image pairing. Keep the full test dates and final status. Do not infer variant CTR or attribute the result to one element.';
      selectStudioSection('notebook');
      $('#notebook').scrollIntoView({ behavior: 'smooth' });
      $('#experiment-hypothesis').focus({ preventScroll: true });
    }
  });
  $('#close-image').addEventListener('click', () => $('#image-dialog').close());
  $('#image-dialog').addEventListener('click', event => { if (event.target === $('#image-dialog')) $('#image-dialog').close(); });
  initializeStudioNavigation();
  studioReady = true;
  updateTeamControls();
  $('#load-state').hidden = true;
  $('#workshop-content').hidden = false;
  reportRefresh.mount($('[data-report-refresh]'));
}

async function load() {
  try {
    const response = await fetch('/api/workshop-data', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(`The data service returned ${response.status}.`);
    data = await response.json();
    if (!Array.isArray(data.videos) || !data.videos.length) throw new Error('No video records were returned.');
    initialize();
  } catch (error) {
    $('#source-stamp').textContent = 'Saved evidence is currently unavailable';
    $('#load-state').setAttribute('role', 'alert');
    $('#load-state').innerHTML = `<strong>Studio could not load the saved report.</strong><br>${escapeHTML(error.message)}<p>Please try again when the reporting service is available.</p><button type="button" class="button" id="retry-load">Try again</button>`;
    $('#retry-load').addEventListener('click', load);
    reportRefresh.mount($('[data-report-refresh]'));
  }
}
checkTeamAccess();
load();
