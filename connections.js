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

function setTeamAccess(allowed) {
  teamAccess = allowed === true;
  document.querySelectorAll('[data-team-control]').forEach(element => { element.hidden = !teamAccess; });
  $('#team-controls-link').hidden = teamAccess;
  $('#team-sign-out').hidden = !teamAccess;
  if (current) renderStatus();
}

async function loadTeamAccess() {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    const result = response.ok ? await response.json() : null;
    setTeamAccess(response.ok && result?.authenticated === true);
  } catch {
    setTeamAccess(false);
  }
}

function message(text, success = false) {
  $('#connection-message').hidden = false;
  $('#connection-message').textContent = text;
  $('#connection-message').classList.toggle('success', success);
}
function renderStatus() {
  const platforms = new Map(current.platforms.map(platform => [platform.id, platform]));
  for (const source of sourceIds) {
    const platform = platforms.get(source) || {};
    const card = $(`[data-source="${source}"]`);
    const status = card.querySelector('[data-field="status"]');
    const connected = platform.connected === true;
    const publicReady = source === 'youtube' && current.setup?.youtubePublic === true;
    const verified = current.configured === true;
    status.textContent = !verified ? 'Status unavailable' : connected ? 'Connected' : publicReady ? 'Public counters ready' : 'Setup needed';
    status.className = `pill ${verified && (connected || publicReady) ? 'connected' : 'pending'}`;
    const lastSync = platform.lastSync;
    const syncLabel = !lastSync ? 'No run recorded' : lastSync.status === 'ready' ? lastSync.errorCode === 'partial_refresh' ? 'Saved with gaps' : 'Completed' :
      { failed: 'Failed · previous data kept', blocked: 'Setup blocked', busy: 'Already running', 'not-connected': 'Not connected' }[lastSync.status] || 'Needs attention';
    card.querySelector('[data-field="details"]').innerHTML = [
      ['Reporting connection', !verified ? 'Could not be checked' : connected ? `Saved ${formatDate(platform.connectedAt)}` : 'Not connected'],
      ...(source === 'youtube' ? [['Public counters', publicReady ? 'Public API configured' : 'Public API key needed']] : []),
      ['Latest saved collection', !verified ? 'Could not be checked' : platform.hasSnapshot ? formatDate(platform.capturedAt) : 'No cloud collection yet'],
      ['Last refresh', !verified ? 'Could not be checked' : `${syncLabel}${lastSync?.completedAt ? ` · ${formatDate(lastSync.completedAt)}` : ''}`],
    ].map(([label, value]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`).join('');
    let help;
    if (source === 'youtube') help = connected ? 'The channel owner has connected YouTube Analytics. Channel, episode and packaging reports keep their own source dates.' : publicReady ? 'Public channel counters are available. An owner connection is needed for watch time, retention and other YouTube Analytics reports.' : 'YouTube reporting has not been configured yet.';
    if (source === 'youtube-shorts') help = connected ? 'Shorts reporting uses the channel’s YouTube connection. Views and engaged views are reported separately.' : 'A YouTube owner connection is needed to collect a separate Shorts Analytics report.';
    if (source === 'instagram') help = connected ? 'The account is connected. A refresh collects available media counters, daily views and follower demographics.' : 'A Creator account works too. The Meta app must be configured before the owner can approve read-only reporting.';
    if (source === 'tiktok') help = connected ? 'A reporting grant is stored. A refresh collects the counters the connected app is allowed to read.' : 'A TikTok developer app, approved scopes and account authorisation still need setup. No TikTok connection has been recorded.';
    card.querySelector('[data-field="help"]').textContent = verified ? help : 'Connection status could not be verified. Previously collected reports remain available.';
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
    connect.textContent = `${platforms.get(id)?.connected ? 'Reconnect' : 'Connect'} ${sourceNames[id]} ↗`;
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
    const response = await fetch('/api/connection-status', { credentials: 'same-origin', cache: 'no-store' });
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
$('#reload-status').addEventListener('click', () => loadStatus());
document.querySelectorAll('[data-sync]').forEach(button => button.addEventListener('click', () => sync(button.dataset.sync)));
for (const id of ['youtube', 'instagram', 'tiktok']) {
  $(`#connect-${id}`).form.addEventListener('submit', event => {
    if (!teamAccess || $(`#connect-${id}`).disabled) event.preventDefault();
  });
}
loadStatus({ showCallback: true });
loadTeamAccess();
