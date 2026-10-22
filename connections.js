import { normalizeTikTokStudioCSVs } from '/lib/tiktok-studio.mjs';
const $ = selector => document.querySelector(selector);
const sourceIds = ['youtube', 'youtube-shorts', 'instagram', 'tiktok'];
const sourceNames = { youtube: 'YouTube', 'youtube-shorts': 'YouTube Shorts', instagram: 'Instagram', tiktok: 'TikTok' };
const errors = {
  youtube_not_configured: 'YouTube reporting is not configured on the server yet. The Google app credentials need to be added before connecting.',
  storage_not_configured: 'Shared reporting storage is not configured yet.',
  auth_not_configured: 'Team sign-in is not configured yet.',
  consent_cancelled: 'Consent was cancelled. No new reporting connection was saved.',
  connection_expired: 'That connection attempt expired or no longer matches this signed-in session. Start the connection again.',
  offline_grant_missing: 'Google did not return an offline reporting grant. Reconnect and approve the read-only permissions.',
  reporting_scopes_required: 'The returned permissions did not match the supported read-only reporting access. No connection was saved.',
  wrong_youtube_channel: 'That Google selection did not identify the Scran & Pints YouTube channel. Connect again and select the account or Brand Account that owns it.',
  channel_verification_failed: 'The channel could not be verified. The previous connection remains available.',
  google_unavailable: 'Google could not complete this connection. Try again shortly.',
  connection_save_failed: 'The reporting grant could not be saved. Try connecting again after shared storage is available.',
  connection_unavailable: 'The reporting connection is unavailable. Try again shortly.',
  instagram_not_configured: 'Instagram app credentials need to be added to the hosted server before connecting.',
  instagram_grant_missing: 'Instagram did not return a usable reporting grant. The previous connection was kept.',
  instagram_scopes_required: 'Instagram needs the basic account and Insights read permissions. No new connection was saved.',
  wrong_instagram_account: 'Select the @scranpints Creator or Business account. No new connection was saved.',
  instagram_account_verification_failed: 'Instagram could not verify the account. The previous connection was kept.',
  instagram_unavailable: 'Instagram could not complete the connection. Try again shortly.',
  tiktok_not_configured: 'TikTok app credentials need to be added to the hosted server before connecting.',
  tiktok_connection_expired: 'That TikTok connection attempt expired. Start Connect TikTok again.',
  tiktok_grant_invalid: 'TikTok did not return a usable reporting grant. The previous connection was kept.',
  tiktok_reporting_scopes_required: 'TikTok needs the approved profile, statistics and video-list read permissions.',
  wrong_tiktok_account: 'Select the @scranpints TikTok account. No new connection was saved.',
  tiktok_account_verification_failed: 'TikTok could not verify the account. The previous connection was kept.',
  tiktok_connection_save_failed: 'The TikTok grant could not be saved. The previous connection was kept.',
  tiktok_consent_cancelled: 'TikTok consent was cancelled. No new connection was saved.',
  tiktok_unavailable: 'TikTok could not complete the connection. Try again shortly.',
};
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const formatDate = value => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not collected';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London', timeZoneName: 'short' }).format(new Date(value));
};
let current = null;
let busySource = null;
let statusPending = false;
let teamAccess = false;
let reviewedStudioReport = null;
let instagramManualCapture = null;
let instagramBrowser = null;
let browserPending = false;
let browserPollTimer = null;
let browserPollDeadline = 0;

function setTeamAccess(allowed) {
  teamAccess = allowed === true;
  document.querySelectorAll('[data-team-control]').forEach(element => { element.hidden = !teamAccess; });
  $('#team-controls-link').hidden = teamAccess;
  $('#team-sign-out').hidden = !teamAccess;
  if (!teamAccess) {
    clearTimeout(browserPollTimer);
    $('#instagram-browser-key').value = '';
    $('#instagram-browser-live').hidden = true;
    $('#instagram-browser-live').removeAttribute('href');
  }
  if (current) renderStatus();
}

async function loadTeamAccess() {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    const result = response.ok ? await response.json() : null;
    setTeamAccess(response.ok && result?.authenticated === true);
    if (teamAccess) await loadInstagramBrowser();
  } catch {
    setTeamAccess(false);
  }
}

function browserMessage(text, success = false) {
  const host = $('#instagram-browser-message');
  host.hidden = !text;
  host.textContent = text;
  host.classList.toggle('success', success);
}

export function instagramBrowserLiveUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'browserbase.com' || url.hostname.endsWith('.browserbase.com'))
      && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export async function instagramBrowserRequest(action = null, values = {}) {
  const response = await fetch('/api/connections/instagram-browser', {
    method: action ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    ...(action ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...values }) } : {}),
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  return { ok: response.ok, status: response.status, data };
}

function renderInstagramBrowser() {
  if (!teamAccess) return;
  const state = instagramBrowser?.state || 'not-configured';
  const labels = { 'not-configured': 'Setup needed', configured: 'Login needed', ready: 'Login verified', 'login-required': 'Login needed',
    connecting: 'Waiting for Instagram login', failed: 'Needs attention' };
  $('#instagram-browser-state').textContent = labels[state] || 'Status unavailable';
  $('#instagram-browser-state').className = `pill ${state === 'ready' ? 'connected' : 'pending'}`;
  $('#instagram-browser-details').innerHTML = [
    ['Browser configuration', instagramBrowser?.configured ? 'Saved privately' : 'Not configured'],
    ['Instagram login verified', instagramBrowser?.verifiedAt ? formatDate(instagramBrowser.verifiedAt) : 'Not verified'],
    ['Last successful scan', instagramBrowser?.lastScanAt ? formatDate(instagramBrowser.lastScanAt) : 'No browser scan saved yet'],
  ].map(([label, value]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`).join('');
  document.querySelectorAll('#instagram-browser-configure input,#instagram-browser-save').forEach(element => { element.disabled = browserPending; });
  $('#instagram-browser-start').disabled = browserPending || !instagramBrowser?.configured;
  $('#instagram-browser-check').disabled = browserPending;
  $('#instagram-browser-save').textContent = browserPending ? 'Working…' : 'Save browser configuration';
  if (state !== 'connecting') {
    $('#instagram-browser-live').hidden = true;
    $('#instagram-browser-live').removeAttribute('href');
  }
}

function pollInstagramBrowser() {
  clearTimeout(browserPollTimer);
  if (!teamAccess || instagramBrowser?.state !== 'connecting') return;
  if (!browserPollDeadline) browserPollDeadline = Date.now() + 600_000;
  if (Date.now() >= browserPollDeadline) {
    browserMessage('Login checking paused. Use Check browser status after completing Instagram sign-in.');
    return;
  }
  browserPollTimer = setTimeout(() => loadInstagramBrowser(), 5_000);
}

async function loadInstagramBrowser() {
  if (!teamAccess) return;
  try {
    const response = await instagramBrowserRequest();
    if ([401, 403].includes(response.status)) { setTeamAccess(false); return; }
    if (!response.ok || typeof response.data.configured !== 'boolean') throw Error('unavailable');
    const previous = instagramBrowser?.state;
    instagramBrowser = response.data;
    renderInstagramBrowser();
    if (instagramBrowser.state === 'ready' && previous !== 'ready') {
      browserPollDeadline = 0;
      browserMessage('Instagram login verified. Refresh Instagram to collect a dated cloud scan.', true);
      await loadStatus();
    } else if (instagramBrowser.state === 'failed') {
      browserMessage('The browser connection could not be verified. Open the cloud login again.');
    } else if (instagramBrowser.state === 'login-required' && previous === 'connecting') {
      browserMessage('Instagram sign-in is needed. Open the cloud login again.');
    }
    pollInstagramBrowser();
  } catch {
    browserMessage('Browser status could not be checked. Saved reports are unchanged.');
    pollInstagramBrowser();
  }
}

async function saveInstagramBrowser(event) {
  event.preventDefault();
  if (!teamAccess || browserPending || !$('#instagram-browser-configure').reportValidity()) return;
  browserPending = true; renderInstagramBrowser();
  const values = { apiKey: $('#instagram-browser-key').value.trim() };
  const projectId = $('#instagram-browser-project').value.trim();
  if (projectId) values.projectId = projectId;
  $('#instagram-browser-key').value = '';
  try {
    const response = await instagramBrowserRequest('configure', values);
    if ([401, 403].includes(response.status)) { setTeamAccess(false); return; }
    if (!response.ok) throw Error('unavailable');
    browserMessage('Browser configuration saved. Open the cloud Instagram login to connect @scranpints.', true);
    await loadInstagramBrowser();
    await loadStatus();
  } catch { browserMessage('Browser configuration could not be saved. Check the key and try again.'); }
  finally { values.apiKey = ''; browserPending = false; renderInstagramBrowser(); }
}

async function startInstagramBrowser() {
  if (!teamAccess || browserPending || !instagramBrowser?.configured) return;
  browserPending = true; renderInstagramBrowser();
  try {
    const response = await instagramBrowserRequest('start');
    if ([401, 403].includes(response.status)) { setTeamAccess(false); return; }
    const liveUrl = instagramBrowserLiveUrl(response.data.liveViewUrl);
    if (!response.ok || !liveUrl) throw Error('unavailable');
    instagramBrowser = { ...instagramBrowser, state: 'connecting', sessionExpiresAt: response.data.expiresAt };
    const link = $('#instagram-browser-live');
    link.href = liveUrl; link.hidden = false;
    window.open(liveUrl, '_blank', 'noopener,noreferrer');
    browserMessage('Complete Instagram sign-in in the private cloud tab. This page checks when it is ready.');
    const expires = Date.parse(response.data.expiresAt);
    browserPollDeadline = Math.min(Date.now() + 600_000, Number.isFinite(expires) ? expires : Infinity);
    pollInstagramBrowser();
  } catch { browserMessage('The cloud login could not be opened. Check the browser configuration and try again.'); }
  finally { browserPending = false; renderInstagramBrowser(); }
}

function message(text, success = false) {
  $('#connection-message').hidden = false;
  $('#connection-message').textContent = text;
  $('#connection-message').classList.toggle('success', success);
}
function instagramCapturedReport(source){const capture=source?.id==='instagram'?source.manualCapture:null;if(!['manual-browser-inspection','browser-sweep'].includes(capture?.method)||!Array.isArray(capture.windows))return null;const window=capture.windows.find(row=>row.periodDays===90)||[...capture.windows].sort((a,b)=>b.periodDays-a.periodDays)[0];return window?{capture,window,manualOnly:source.provenance?.kind==='manual-browser',browserSweep:capture.method==='browser-sweep'}:null;}
function renderStatus() {
  const platforms = new Map(current.platforms.map(platform => [platform.id, platform]));
  for (const source of sourceIds) {
    const platform = platforms.get(source) || {};
    const card = $(`[data-source="${source}"]`);
    const status = card.querySelector('[data-field="status"]');
    const connected = platform.connected === true;
    const manual = source === 'instagram' ? instagramManualCapture : null;
    const browserMode = source === 'instagram' && platform.mode === 'browser-sweep';
    const publicReady = source === 'youtube' && current.setup?.youtubePublic === true;
    const verified = current.configured === true;
    status.textContent = browserMode ? connected ? 'Browser scans ready' : manual ? 'Saved capture · login needed' : 'Browser login needed' : manual ? connected ? 'API connected · native capture saved' : 'Native capture available' : !verified ? 'Status unavailable' : connected ? 'Connected' : publicReady ? 'Public counters ready' : 'Setup needed';
    status.className = `pill ${manual || verified && (connected || publicReady) ? 'connected' : 'pending'}`;
    const lastSync = platform.lastSync;
    const syncLabel = !lastSync ? 'No run recorded' : lastSync.status === 'ready' ? lastSync.errorCode === 'partial_refresh' ? 'Saved with gaps' : 'Completed' :
      { failed: 'Failed · previous data kept', blocked: 'Setup blocked', busy: 'Already running', 'not-connected': 'Not connected' }[lastSync.status] || 'Needs attention';
    card.querySelector('[data-field="details"]').innerHTML = [
      [browserMode ? 'Browser connection' : manual ? 'API connection' : 'Reporting connection', !verified ? 'Could not be checked' : connected ? platform.connectedAt ? `Saved ${formatDate(platform.connectedAt)}` : 'Ready' : 'Not connected'],
      ...(manual ? [[manual.browserSweep ? 'Cloud scan captured' : 'Native report captured', formatDate(manual.capture.capturedAt)], [`Instagram views · Last ${manual.window.periodDays} days`, new Intl.NumberFormat('en-GB').format(manual.window.instagramViews)], ['Followers at capture', new Intl.NumberFormat('en-GB').format(manual.capture.followers)]] : []),
      ...(source === 'youtube' ? [['Public counters', publicReady ? 'Public API configured' : 'Public API key needed']] : []),
      [browserMode ? 'Latest saved cloud scan' : manual ? 'Latest saved API collection' : 'Latest saved collection', browserMode ? manual?.browserSweep ? formatDate(manual.capture.capturedAt) : 'No browser scan saved yet' : manual?.manualOnly ? 'Not collected through API' : !verified ? 'Could not be checked' : platform.hasSnapshot ? formatDate(platform.capturedAt) : 'No cloud collection yet'],
      ['Last refresh', !verified ? 'Could not be checked' : `${syncLabel}${lastSync?.completedAt ? ` · ${formatDate(lastSync.completedAt)}` : ''}`],
    ].map(([label, value]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`).join('');
    let help;
    if (source === 'youtube') help = connected ? 'The channel owner has connected YouTube Analytics. Channel, episode and packaging reports keep their own source dates.' : publicReady ? 'Public channel counters are available. An owner connection is needed for watch time, retention and other YouTube Analytics reports.' : 'YouTube reporting has not been configured yet.';
    if (source === 'youtube-shorts') help = connected ? 'Shorts reporting uses the channel’s YouTube connection. Views and engaged views are reported separately.' : 'A YouTube owner connection is needed to collect a separate Shorts Analytics report.';
    if (source === 'instagram') help = browserMode ? connected ? 'Hosted browser access is verified. Refresh starts a cloud scan of available Instagram and collab Insights; each successful capture keeps its own date.' : 'Cloud Instagram sign-in is needed before a new scan can run. The latest saved capture remains available.' : manual ? `Native Insights captured ${formatDate(manual.capture.capturedAt)} are available on the dashboard and YEET. ${!verified ? 'The API connection status could not be verified.' : connected ? 'The separate API connection can collect its available reports.' : 'The API is not connected.'} ${manual.browserSweep ? 'This dated cloud scan remains until a newer successful scan is saved.' : 'Refresh does not update this manual capture; the team records a new capture to advance it.'}` : connected ? 'The account is connected. A refresh collects available media counters, daily views and follower demographics.' : 'The team can connect hosted browser scans or available Meta API reporting.';
    if (source === 'tiktok') help = connected ? 'A reporting grant is stored. A refresh collects the counters the connected app is allowed to read.' : 'A TikTok developer app, approved scopes and account authorisation still need setup. No TikTok connection has been recorded.';
    card.querySelector('[data-field="help"]').textContent = verified || manual ? help : 'Connection status could not be verified. Previously collected reports remain available.';
    const button = card.querySelector('[data-sync]');
    button.disabled = !teamAccess || !verified || (!connected && !publicReady) || !!busySource || statusPending;
    button.textContent = busySource === source ? 'Collecting report…' : {
      youtube: 'Refresh YouTube', 'youtube-shorts': 'Refresh Shorts', instagram: 'Refresh Instagram', tiktok: 'Refresh TikTok',
    }[source];
  }
  $('#connect-youtube').disabled = !teamAccess || !current.configured || !current.setup?.youtubeOAuth || !!busySource || statusPending;
  $('#connect-youtube').textContent = platforms.get('youtube')?.connected ? 'Reconnect YouTube ↗' : 'Connect YouTube ↗';
  for (const id of ['instagram', 'tiktok']) {
    const connect = $(`#connect-${id}`);
    connect.disabled = !teamAccess || !current.configured || !current.setup?.[`${id}OAuth`] || !!busySource || statusPending;
    connect.textContent = id === 'instagram' ? `${platforms.get(id)?.mode === 'official-api' && platforms.get(id)?.connected ? 'Reconnect' : 'Connect'} Meta API ↗` : `${platforms.get(id)?.connected ? 'Reconnect' : 'Connect'} ${sourceNames[id]} ↗`;
  }
  $('#reload-status').disabled = !!busySource || statusPending;
  document.querySelectorAll('#studio-import-form input,#studio-import-review').forEach(input => { input.disabled = !teamAccess || !!busySource || statusPending; });
  $('#studio-import-save').disabled = !teamAccess || !reviewedStudioReport || !!busySource || statusPending;
}

const studioImportErrors = {
  invalid_studio_report: 'The report could not be validated. Check the selected CSV files and their date windows.',
  tiktok_snapshot_required: 'Refresh the connected TikTok account before importing its Studio report.',
  studio_import_stale: 'A newer Studio report is already saved. The existing report was kept.',
  newer_snapshot_exists: 'TikTok reporting changed during this import. Review the latest data before retrying.',
  sync_in_progress: 'TikTok is already refreshing. Wait for it to finish, then publish this reviewed report.',
  payload_too_large: 'The prepared report is larger than the 2 MB import limit.',
  sync_unavailable: 'Shared reporting storage is unavailable. The previous report was kept.',
};
function studioImportMessage(text, success = false) {
  const element = $('#studio-import-message');
  element.hidden = false; element.textContent = text; element.classList.toggle('success', success);
}
function clearStudioReview() {
  reviewedStudioReport = null;
  $('#studio-import-preview').hidden = true;
  $('#studio-import-publish').hidden = true;
  $('#studio-import-save').disabled = true;
}
function previewStudioReport(report) {
  const performance = report.performance;
  const metric = value => Number.isFinite(value) ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value) : 'Unavailable';
  const windowLabel = range => `${range.start} → ${range.end}`;
  const metrics = [['Views', performance.totals.views], ['Profile views', performance.totals.profileViews],
    ['Likes', performance.totals.likes], ['Comments', performance.totals.comments], ['Shares', performance.totals.shares], ['Net followers', performance.totals.netFollowers]];
  $('#studio-import-preview').innerHTML = `<h3>Review @${escapeHTML(report.accountUsername)}</h3><div class="studio-import-preview-stats">${metrics.map(([label, value]) => `<div><span>${label}</span><strong>${metric(value)}</strong></div>`).join('')}</div><dl><div><dt>Export downloaded</dt><dd>${escapeHTML(performance.capturedAt.slice(0, 10))}</dd></div><div><dt>Overview and followers</dt><dd>${escapeHTML(windowLabel(performance.seriesRanges.overview))}</dd></div><div><dt>Viewers</dt><dd>${escapeHTML(windowLabel(performance.seriesRanges.viewers))}</dd></div><div><dt>Daily report rows</dt><dd>${performance.daily.length}</dd></div><div><dt>Follower breakdowns in this import</dt><dd>${report.audience.some(entry => entry.population === 'followers') ? 'Included where exported' : 'Not included'}</dd></div></dl><p>Daily viewer counts are not added into a unique audience total. Missing values and &lt;1% thresholds are preserved.</p>`;
  $('#studio-import-preview').hidden = false;
  $('#studio-import-publish').hidden = false;
}

export function studioCaptureTimestamp(day, time, importedAt) {
  const capture = `${day}T${time.length === 5 ? `${time}:00` : time}Z`;
  const timestamp = Date.parse(capture);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(capture) || !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== day || timestamp > Date.parse(importedAt)) {
    throw Error('Enter the actual export download date and UTC time, no later than now.');
  }
  return new Date(timestamp).toISOString();
}

export async function publishStudioImport(report, request = fetch) {
  const body = JSON.stringify({ operation: 'studio-import', report });
  if (new TextEncoder().encode(body).byteLength > 2_000_000) throw Error(studioImportErrors.payload_too_large);
  const response = await request('/api/sync?source=tiktok', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  return { ok: response.ok, status: response.status, result };
}

$('#studio-import-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!teamAccess || busySource || !$('#studio-import-form').reportValidity()) return;
  clearStudioReview();
  busySource = 'studio-review'; renderStatus();
  try {
    const selected = [...$('#studio-import-files').files];
    if (selected.reduce((sum, file) => sum + file.size, 0) > 2_000_000) throw Error('Choose CSV exports totalling less than 2 MB.');
    const files = await Promise.all(selected.map(async file => ({ name: file.name, text: await file.text() })));
    const importedAt = new Date().toISOString();
    const capturedAt = studioCaptureTimestamp($('#studio-capture-date').value, $('#studio-capture-time').value, importedAt);
    reviewedStudioReport = normalizeTikTokStudioCSVs({ files, capturedAt, importedAt, accountUsername: 'scranpints',
      overviewRange: { start: $('#studio-overview-start').value, end: $('#studio-overview-end').value, timezone: null },
      viewersRange: { start: $('#studio-viewers-start').value, end: $('#studio-viewers-end').value, timezone: null } });
    previewStudioReport(reviewedStudioReport);
    studioImportMessage('Review the dates and totals below before publishing.');
  } catch (error) { studioImportMessage(error?.message || 'The CSV report could not be read.'); }
  finally { busySource = null; renderStatus(); }
});
const importFormOpenedAt = new Date().toISOString();
$('#studio-capture-date').value = importFormOpenedAt.slice(0, 10);
$('#studio-capture-date').max = importFormOpenedAt.slice(0, 10);
$('#studio-capture-time').value = importFormOpenedAt.slice(11, 19);
document.querySelectorAll('#studio-import-form input').forEach(input => input.addEventListener('change', clearStudioReview));
$('#studio-import-save').addEventListener('click', async () => {
  if (!teamAccess || !reviewedStudioReport || busySource) return;
  busySource = 'studio-import'; renderStatus();
  studioImportMessage('Saving the reviewed Studio report…');
  try {
    const response = await publishStudioImport(reviewedStudioReport);
    if ([401, 403].includes(response.status)) { setTeamAccess(false); studioImportMessage('Team sign-in expired. The reviewed report has not been published.'); return; }
    if (response.ok && response.result.status === 'imported') {
      studioImportMessage('Studio report published. Its dated charts and audience data are now available on the dashboard and YEET.', true);
      clearStudioReview();
    } else studioImportMessage(studioImportErrors[response.result.error || response.result.errorCode] || 'The report could not be saved. The previous report was kept.');
  } catch (error) { studioImportMessage(error?.message || 'The save could not be confirmed. Check the dashboard before retrying.'); }
  finally { busySource = null; await loadStatus(); renderStatus(); }
});

async function loadStatus({ showCallback = false } = {}) {
  if (statusPending) return;
  statusPending = true;
  if (current) renderStatus();
  try {
    const [statusResult, reportResult] = await Promise.allSettled([
      fetch('/api/connection-status', { credentials: 'same-origin', cache: 'no-store' }),
      fetch('/api/report', { credentials: 'omit', cache: 'no-store' }),
    ]);
    const reportResponse = reportResult.status === 'fulfilled' ? reportResult.value : null;
    if (reportResponse?.ok) {
      try { const report = await reportResponse.json(); instagramManualCapture = report.schemaVersion === 1 && Array.isArray(report.sources) ? instagramCapturedReport(report.sources.find(source => source.id === 'instagram')) : null; }
      catch { /* A failed public report read never changes API connection state. */ }
    }
    if (statusResult.status !== 'fulfilled') throw Error('Connection status unavailable');
    const response = statusResult.value;
    const result = await response.json();
    if (!response.ok || typeof result.configured !== 'boolean' || !Array.isArray(result.platforms)) throw Error('unavailable');
    current = result;
    $('#connection-state').hidden = true;
    $('#connection-content').hidden = false;
    if (showCallback) {
      const params = new URLSearchParams(location.search);
      const error = params.get('error');
      if (error) message(errors[error] || 'The connection could not complete. Start a new connection attempt.');
      else if (params.get('connected') === 'youtube' && result.platforms.some(p => p.id === 'youtube' && p.connected === true)) {
        message('The Scran & Pints YouTube reporting connection is saved. YouTube and Shorts reports can now be refreshed.', true);
      }
      else if (['instagram', 'tiktok'].includes(params.get('connected')) && result.platforms.some(p => p.id === params.get('connected') && p.connected === true)) {
        message(`${sourceNames[params.get('connected')]} is connected. Refresh its report to add the latest available numbers to the dashboard and YEET.`, true);
      }
      if (error || params.has('connected')) history.replaceState(null, '', '/connections.html');
    }
  } catch {
    if (!current && instagramManualCapture) { current = { configured: false, setup: {}, platforms: [] }; $('#connection-state').hidden = true; $('#connection-content').hidden = false; }
    if (current) message('Connection status could not be refreshed. Check again before starting a collection.');
    else {
      $('#connection-state').hidden = false;
      $('#connection-state').innerHTML = '<strong>Connection status is unavailable.</strong><p>The reporting service could not be reached. Saved analytics remain available from the dashboard and Studio.</p><button class="button secondary" id="retry-connections" type="button">Try again</button>';
      $('#retry-connections').addEventListener('click', () => loadStatus({ showCallback: true }));
    }
  } finally {
    statusPending = false;
    if (current) renderStatus();
  }
}

async function sync(source) {
  if (!teamAccess || !current?.configured || statusPending || !sourceIds.includes(source) || busySource || !(current?.platforms.some(p => p.id === source && p.connected === true) ||
      source === 'youtube' && current?.setup?.youtubePublic === true)) return;
  busySource = source;
  renderStatus();
  message(`Collecting ${sourceNames[source]}. This can take a little while; the existing report stays available until a successful collection is saved.`);
  try {
    const response = await fetch(`/api/sync?source=${encodeURIComponent(source)}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 || response.status === 403) {
      setTeamAccess(false);
      message('Team controls have signed out. The saved report is unchanged.');
      return;
    }
    const result = await response.json();
    if (response.ok && result.status === 'ready') {
      const parts = result.components ? ` Public counters: ${result.components.public.status}. YouTube Analytics: ${result.components.analytics.status}.` : '';
      message(`${sourceNames[source]} collection saved.${parts} Open the dashboard or workshop to inspect each report's capture date.`, true);
    } else {
      const text = {
        busy: 'A report using this connection is already running. Check status shortly.',
        'not-connected': 'No usable reporting connection is available. Connect the account first.',
        blocked: 'This integration needs further account or app setup before it can collect a report.',
        failed: 'The collection could not complete. The previous saved report has been kept.',
      }[result.status] || 'The refresh could not complete. Check the connection and try again.';
      message(text);
    }
  } catch { message('The refresh response was interrupted. Check status before retrying; the server may still be collecting.'); }
  finally {
    busySource = null;
    await loadStatus();
    if (current) renderStatus();
  }
}
$('#reload-status').addEventListener('click', () => { loadStatus(); if (teamAccess) loadInstagramBrowser(); });
$('#instagram-browser-configure').addEventListener('submit', saveInstagramBrowser);
$('#instagram-browser-start').addEventListener('click', startInstagramBrowser);
$('#instagram-browser-check').addEventListener('click', () => { browserPollDeadline = 0; loadInstagramBrowser(); });
document.querySelectorAll('[data-sync]').forEach(button => button.addEventListener('click', () => sync(button.dataset.sync)));
for (const id of ['youtube', 'instagram', 'tiktok']) {
  $(`#connect-${id}`).form.addEventListener('submit', event => {
    if (!teamAccess || $(`#connect-${id}`).disabled) event.preventDefault();
  });
}
loadStatus({ showCallback: true });
loadTeamAccess();
