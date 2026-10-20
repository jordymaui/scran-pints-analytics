const $ = selector => document.querySelector(selector);
const sourceIds = ['youtube', 'youtube-shorts', 'instagram', 'tiktok'];
const sourceNames = { youtube: 'YouTube', 'youtube-shorts': 'Private YouTube Shorts', instagram: 'Instagram', tiktok: 'TikTok' };
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
    status.textContent = connected ? 'Connected' : publicReady ? 'Public counters ready' : 'Setup needed';
    status.className = `pill ${connected || publicReady ? 'connected' : 'pending'}`;
    const lastSync = platform.lastSync;
    const syncLabel = !lastSync ? 'No run recorded' : lastSync.status === 'ready' ? lastSync.errorCode === 'partial_refresh' ? 'Partly completed · previous capture kept' : 'Completed' :
      { failed: 'Failed · previous data kept', blocked: 'Setup blocked', busy: 'Already running', 'not-connected': 'Not connected' }[lastSync.status] || 'Needs attention';
    card.querySelector('[data-field="details"]').innerHTML = [
      ['Private reporting grant', connected ? `Saved ${formatDate(platform.connectedAt)}` : 'No reporting grant saved'],
      ...(source === 'youtube' ? [['Public counters', publicReady ? 'Public API configured' : 'Public API key needed']] : []),
      ['Latest saved collection', platform.hasSnapshot ? formatDate(platform.capturedAt) : 'No cloud collection yet'],
      ['Last refresh', `${syncLabel}${lastSync?.completedAt ? ` · ${formatDate(lastSync.completedAt)}` : ''}`],
    ].map(([label, value]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`).join('');
    let help;
    if (source === 'youtube') help = `${publicReady ? 'Public channel counters can refresh now without account consent. ' : 'The public API key is not configured. '} ${connected ? 'The same refresh also updates the private long-form workshop. Each report keeps its own capture date.' : 'Connect the owning Google account to enable private watch-time, retention and long-form reports.'}`;
    if (source === 'youtube-shorts') help = 'Shorts are included in the public channel counters; a separate public breakdown is unavailable. This button collects an authorized private Shorts report using the YouTube grant.';
    if (source === 'instagram') help = connected ? 'A reporting grant is stored. Refresh availability still depends on the connected account and the Instagram integration.' : 'Meta app and professional-account reporting access still need setup. No Instagram connection has been recorded.';
    if (source === 'tiktok') help = connected ? 'A reporting grant is stored. A refresh collects the counters the connected app is allowed to read.' : 'A TikTok developer app, approved scopes and account authorisation still need setup. No TikTok connection has been recorded.';
    card.querySelector('[data-field="help"]').textContent = help;
    const button = card.querySelector('[data-sync]');
    button.disabled = (!connected && !publicReady) || !!busySource || statusPending;
    button.textContent = busySource === source ? 'Collecting report…' : {
      youtube: 'Refresh YouTube', 'youtube-shorts': 'Refresh private Shorts', instagram: 'Refresh Instagram', tiktok: 'Refresh TikTok',
    }[source];
  }
  $('#connect-youtube').disabled = !current.configured || !current.setup?.youtubeOAuth || !!busySource || statusPending;
  $('#connect-youtube').textContent = platforms.get('youtube')?.connected ? 'Reconnect YouTube ↗' : 'Connect YouTube ↗';
  $('#reload-status').disabled = !!busySource || statusPending;
}

async function loadStatus({ showCallback = false } = {}) {
  if (statusPending) return;
  statusPending = true;
  if (current) renderStatus();
  try {
    const response = await fetch('/api/connection-status', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 || response.status === 403) {
      current = null;
      $('#connection-content').hidden = true;
      $('#connection-state').hidden = false;
      $('#connection-state').innerHTML = '<strong>The reporting desk is for the team.</strong><p>Sign in with an authorised team account to view connections and collect reports.</p><a class="button" href="/login.html">Sign in with Google ↗</a>';
      return;
    }
    const result = await response.json();
    if (!response.ok || result.configured !== true || !Array.isArray(result.platforms)) throw Error('unavailable');
    current = result;
    $('#connection-state').hidden = true;
    $('#connection-content').hidden = false;
    if (showCallback) {
      const params = new URLSearchParams(location.search);
      const error = params.get('error');
      if (error) message(errors[error] || 'The connection could not complete. Start a new connection attempt.');
      else if (params.get('connected') === 'youtube' && result.platforms.some(p => p.id === 'youtube' && p.connected === true)) {
        message('The Scran & Pints YouTube reporting connection is saved. Refresh episodes or Shorts to collect the latest available reports.', true);
      }
      if (error || params.has('connected')) history.replaceState(null, '', '/connections.html');
    }
  } catch {
    if (current) message('Connection status could not be refreshed. Check again before starting a collection.');
    else {
      $('#connection-state').hidden = false;
      $('#connection-state').innerHTML = '<strong>The reporting desk is not ready yet.</strong><p>Team authentication and shared reporting storage must be configured on the server. No connection status could be verified.</p><button class="button secondary" id="retry-connections" type="button">Try again</button>';
      $('#retry-connections').addEventListener('click', () => loadStatus({ showCallback: true }));
    }
  } finally {
    statusPending = false;
    if (current) renderStatus();
  }
}

async function sync(source) {
  if (!sourceIds.includes(source) || busySource || !(current?.platforms.some(p => p.id === source && p.connected === true) ||
      source === 'youtube' && current?.setup?.youtubePublic === true)) return;
  busySource = source;
  renderStatus();
  message(`Collecting ${sourceNames[source]}. This can take a little while; the existing report stays available until a successful collection is saved.`);
  try {
    const response = await fetch(`/api/sync?source=${encodeURIComponent(source)}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 || response.status === 403) {
      message('Your team session needs sign-in again. The saved report is unchanged.');
      return;
    }
    const result = await response.json();
    if (response.ok && result.status === 'ready') {
      const parts = result.components ? ` Public counters: ${result.components.public.status}. Private Analytics: ${result.components.analytics.status}.` : '';
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
loadStatus({ showCallback: true });
