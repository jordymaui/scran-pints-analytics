const $ = selector => document.querySelector(selector);
const sourceIds = ['youtube', 'youtube-shorts', 'instagram', 'tiktok'];
const sourceNames = { youtube: 'YouTube', 'youtube-shorts': 'YouTube Shorts', instagram: 'Instagram', tiktok: 'TikTok' };
const errors = {
  youtube_not_configured: 'YouTube reporting is not configured on the server yet. The Google app credentials need to be added before connecting.',
  storage_not_configured: 'Shared reporting storage is not configured yet.',
  auth_not_configured: 'Team sign-in is not configured yet.',
  consent_cancelled: 'Google consent was cancelled. No new reporting connection was saved.',
  connection_expired: 'That connection attempt expired or no longer matches this signed-in session. Start Connect YouTube again.',
  offline_grant_missing: 'Google did not return an offline reporting grant. Reconnect and approve the read-only permissions.',
  reporting_scopes_required: 'The returned permissions did not match the supported read-only reporting access. No connection was saved.',
  wrong_youtube_channel: 'That Google selection did not identify the Scran & Pints YouTube channel. Connect again and select the account or Brand Account that owns it.',
  channel_verification_failed: 'The channel could not be verified. The previous connection remains available.',
  google_unavailable: 'Google could not complete this connection. Try again shortly.',
  connection_save_failed: 'The reporting grant could not be saved. Try connecting again after shared storage is available.',
  connection_unavailable: 'The reporting connection is unavailable. Try again shortly.',
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
    if (source === 'instagram') help = connected ? 'A reporting grant is stored. Refresh availability still depends on the connected account and the Instagram integration.' : 'Meta app and professional-account reporting access still need setup. No Instagram connection has been recorded.';
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
  $('#reload-status').disabled = !!busySource || statusPending;
}

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
$('#connect-youtube').form.addEventListener('submit', event => {
  if (!teamAccess || $('#connect-youtube').disabled) event.preventDefault();
});
loadStatus({ showCallback: true });
loadTeamAccess();
