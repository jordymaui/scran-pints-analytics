// Shared reporting action. Provider requests stay on the authenticated server.
const sources = ['youtube', 'youtube-shorts', 'instagram', 'tiktok'];
const names = { youtube: 'YouTube', 'youtube-shorts': 'YouTube Shorts', instagram: 'Instagram', tiktok: 'TikTok' };
const intentKey = 'scran-pints-pending-refresh';
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const dayLabel = value => validDay(value) ? new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${value}T12:00:00Z`)) : null;
const captureLabel = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit',
    minute: '2-digit', timeZone: 'Europe/London', timeZoneName: 'short' }).format(new Date(value)) : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const refreshIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/></svg>';

function savedIntent() {
  try {
    const intent = JSON.parse(sessionStorage.getItem(intentKey));
    const destination = new URL(intent?.path, location.origin);
    if (!Number.isFinite(intent?.createdAt) || Date.now() - intent.createdAt > 30 * 60_000 ||
        Date.now() < intent.createdAt || destination.origin !== location.origin ||
        !['/', '/index.html', '/sponsor.html', '/workshop.html'].includes(destination.pathname)) return null;
    return { ...intent, path: destination.pathname + destination.search + destination.hash };
  } catch { return null; }
}
function clearIntent() {
  try { sessionStorage.removeItem(intentKey); } catch { /* Optional continuation only. */ }
}
function rememberIntent() {
  try { sessionStorage.setItem(intentKey, JSON.stringify({
    path: location.pathname + location.search + location.hash, createdAt: Date.now(),
  })); } catch { /* The user can press Refresh again after signing in. */ }
}

function outcome(result, responseOK) {
  if (!responseOK || result?.status !== 'ready') return {
    status: ['busy', 'blocked', 'failed', 'not-connected'].includes(result?.status) ? result.status : 'failed',
    detail: {
      busy: 'A collection is already running. The saved report remains available.',
      blocked: 'The provider or account setup needs attention in Connections.',
      'not-connected': 'No usable reporting connection was found.',
      failed: 'Collection failed. The previous successful report was kept.',
    }[result?.status] || 'The refresh could not be confirmed. Check Connections before retrying.',
  };
  const warnings = count(result.warningCount) || 0;
  const incompleteComponent = result.components && Object.values(result.components).some(component => component?.status !== 'ready');
  const uploadGaps = result.uploadCoverage && (result.uploadCoverage.inventoryComplete !== true ||
    Object.values(result.uploadCoverage.reports || {}).some(report => ['noRows', 'retained', 'failed'].some(key => count(report?.[key]) > 0)));
  const partial = warnings > 0 || result.errorCode === 'partial_refresh' || incompleteComponent ||
    uploadGaps || result.coverage && result.coverage.status !== 'complete';
  return { status: partial ? 'partial' : 'ready',
    detail: partial ? `Saved available reports.${warnings ? ` ${warnings} collection warning${warnings === 1 ? '' : 's'}.` : ''} Some coverage remains unavailable.` : 'Report saved.' };
}

function resultDetails(source, result) {
  if (!result) return [];
  const details = [];
  const end = dayLabel(result.window?.end);
  const start = dayLabel(result.window?.start);
  if (result.components) {
    const labels = { public: 'Public counters', analytics: 'YouTube Analytics' };
    for (const key of ['public', 'analytics']) {
      const component = result.components[key];
      if (!component) continue;
      const status = component.status === 'ready' ? 'collected' : component.status === 'failed'
        ? 'failed; earlier capture retained' : component.status === 'not-connected' ? 'not connected' : 'not configured';
      details.push(`${labels[key]}: ${status}${captureLabel(component.capturedAt) ? ` · capture ${captureLabel(component.capturedAt)}` : ''}.`);
    }
  }
  if (end && !String(result.window?.scope).includes('counters-at-capture')) {
    details.push(`${source === 'youtube' ? 'Channel Analytics' : names[source]}: ${start ? `${start} – ` : 'through '}${end}.`);
  }
  if (source === 'youtube' && result.coverage) {
    const coverage = result.coverage;
    const included = count(coverage.includedVideoCount), confirmed = count(coverage.confirmedLongformCount);
    if (included !== null) details.push(`${included}${confirmed !== null ? ` of ${confirmed} confirmed` : ' selected'} full episodes included${coverage.status === 'complete' ? '; public full-episode inventory complete' : '; inventory coverage incomplete'}.`);
    const gaps = [['unknownFormatCount', 'unverified formats'], ['unreportedLongformCount', 'episodes without reports'],
      ['pendingPublicationCount', 'uploads after the cutoff']].filter(([key]) => count(coverage[key]) > 0)
      .map(([key, label]) => `${coverage[key]} ${label}`);
    if (gaps.length) details.push(gaps.join(' · '));
  }
  if (source === 'youtube' && result.uploadCoverage) {
    const coverage = result.uploadCoverage;
    if (count(coverage.includedUploads) !== null) details.push(`All-format upload reporting: ${coverage.includedUploads}${count(coverage.publicUploadsCount) !== null ? ` of ${coverage.publicUploadsCount} public uploads` : ' uploads'}${coverage.inventoryComplete === true ? '; inventory complete' : '; inventory incomplete'}.`);
    for (const [key, label] of [['aggregate', 'Upload totals'], ['daily', 'Daily reports'], ['retention', 'Retention'], ['traffic', 'Traffic sources']]) {
      const report = coverage.reports?.[key];
      if (!report) continue;
      const values = [['collected', 'collected'], ['noRows', 'no rows returned'], ['retained', 'older reports retained'], ['failed', 'unavailable']]
        .filter(([field]) => count(report[field]) !== null).map(([field, text]) => `${report[field]} ${text}`);
      if (values.length) details.push(`${label}: ${values.join(' · ')}.`);
    }
  }
  return details;
}

export function createReportRefresh({ getCoverage = () => [], reloadReport, onTeamAccess = () => {} } = {}) {
  let host = null, trigger = null, busy = false, resumed = false;
  let rows = [], heading = 'Refresh reporting', message = '', signInNeeded = false, pageError = '';
  const dialog = document.createElement('dialog');
  dialog.id = 'report-refresh-dialog';
  dialog.className = 'report-refresh-panel';
  dialog.setAttribute('aria-labelledby', 'report-refresh-heading');
  dialog.innerHTML = `<div class="report-refresh-heading"><h2 id="report-refresh-heading">Refresh reporting</h2><button type="button" class="report-refresh-close" aria-label="Close refresh progress">×</button></div><p class="report-refresh-message" role="status" aria-live="polite"></p><div class="report-refresh-progress" hidden><progress max="1" value="0"></progress><span></span></div><ol class="report-refresh-sources"></ol><div class="report-refresh-coverage"></div><p class="report-refresh-note">Analytics can finish before today. Current counters and each report’s processed dates are shown separately.</p><p class="report-refresh-error" role="status" hidden></p><div class="report-refresh-actions"><a class="report-refresh-sign-in" href="/login.html" hidden>Sign in and refresh →</a><button type="button" class="report-refresh-again" hidden>Refresh again</button><a href="/connections.html">Connections ↗</a></div>`;
  document.body.appendChild(dialog);
  const find = selector => dialog.querySelector(selector);
  find('.report-refresh-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  } });
  dialog.addEventListener('close', () => {
    trigger?.setAttribute('aria-expanded', 'false');
    if (document.activeElement === document.body) trigger?.focus({ preventScroll: true });
  });
  find('.report-refresh-sign-in').addEventListener('click', rememberIntent);
  find('.report-refresh-again').addEventListener('click', () => start());
  window.addEventListener('beforeunload', event => {
    if (busy) { event.preventDefault(); event.returnValue = ''; }
  });

  function coverageHTML() {
    const coverage = getCoverage().filter(item => item && (dayLabel(item.end) || captureLabel(item.capturedAt)));
    return coverage.length ? `<h3>Saved data currently shown</h3><dl>${coverage.map(item =>
      `<div><dt>${escapeHTML(item.label)}</dt><dd>${item.kind === 'counters' ? `Counters captured ${escapeHTML(captureLabel(item.capturedAt) || 'date unavailable')}`
        : `${dayLabel(item.start) ? `${escapeHTML(dayLabel(item.start))} – ` : 'Through '}${escapeHTML(dayLabel(item.end) || 'date unavailable')}${captureLabel(item.capturedAt) ? `<small>Collected ${escapeHTML(captureLabel(item.capturedAt))}</small>` : ''}`}</dd></div>`).join('')}</dl>` : '<p>No dated saved report is available yet.</p>';
  }
  function render() {
    if (trigger?.isConnected) {
      trigger.classList.toggle('is-refreshing', busy);
      trigger.innerHTML = `${refreshIcon}<span>${busy ? 'Refreshing…' : 'Refresh'}</span>`;
      trigger.setAttribute('aria-label', busy ? 'Show reporting refresh progress' : 'Refresh all connected reporting sources');
    }
    find('h2').textContent = heading;
    find('.report-refresh-message').textContent = message;
    const queued = rows.filter(row => row.eligible);
    const done = queued.filter(row => !['waiting', 'running'].includes(row.status)).length;
    const progress = find('.report-refresh-progress');
    progress.hidden = !queued.length;
    progress.querySelector('progress').max = queued.length || 1;
    progress.querySelector('progress').value = done;
    progress.querySelector('span').textContent = `${done} of ${queued.length} connected sources finished`;
    const labels = { waiting: 'Waiting', running: 'Collecting', ready: 'Saved', partial: 'Saved with gaps',
      failed: 'Failed', busy: 'Already running', blocked: 'Setup needed', 'not-connected': 'Not connected',
      unknown: 'Response interrupted', skipped: 'Not started' };
    find('.report-refresh-sources').innerHTML = rows.map(row => `<li data-status="${row.status}"><div><strong>${names[row.source]}</strong><span>${labels[row.status]}</span></div><p>${escapeHTML(row.detail || '')}</p>${resultDetails(row.source, row.result).map(detail => `<small>${escapeHTML(detail)}</small>`).join('')}</li>`).join('');
    find('.report-refresh-coverage').innerHTML = coverageHTML();
    find('.report-refresh-error').hidden = !pageError;
    find('.report-refresh-error').textContent = pageError;
    find('.report-refresh-sign-in').hidden = !signInNeeded;
    find('.report-refresh-again').hidden = busy || signInNeeded || !rows.length;
  }
  function show() {
    window.SPSelect?.close();
    if (!dialog.open) dialog.showModal();
    trigger?.setAttribute('aria-expanded', 'true');
  }
  async function authenticated() {
    try {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401 || response.status === 403) { onTeamAccess(false); return false; }
      if (!response.ok) throw Error('Team sign-in could not be checked. Try again shortly.');
      const allowed = (await response.json()).authenticated === true;
      onTeamAccess(allowed);
      return allowed;
    } catch (error) { throw Error(error.message || 'Team sign-in could not be checked. Try again shortly.'); }
  }
  async function start({ verified = false } = {}) {
    if (busy) { show(); return; }
    busy = true; signInNeeded = false; rows = []; pageError = '';
    heading = 'Refreshing reporting'; message = 'Checking reporting connections…';
    render(); show();
    let attempted = false;
    try {
      if (!verified && !await authenticated()) {
        signInNeeded = true; heading = 'Sign in to refresh';
        message = 'Reports stay open to everyone. An approved team account can collect new data. Your refresh will continue after sign-in.';
        return;
      }
      clearIntent();
      const statusResponse = await fetch('/api/connection-status', { credentials: 'same-origin', cache: 'no-store' });
      const status = await statusResponse.json();
      if (!statusResponse.ok || status.configured !== true || !Array.isArray(status.platforms)) throw Error('Connection status is unavailable. Saved reports have not changed.');
      rows = sources.map(source => {
        const connected = status.platforms.some(platform => platform.id === source && platform.connected === true);
        const eligible = connected || source === 'youtube' && status.setup?.youtubePublic === true;
        return { source, eligible, status: eligible ? 'waiting' : 'not-connected',
          detail: eligible ? 'Queued for this refresh.' : 'No reporting connection is configured.' };
      });
      if (!rows.some(row => row.eligible)) {
        heading = 'No reporting connection'; message = 'Connect an account in Connections before collecting new reports.'; return;
      }
      let youtubePending = false;
      for (const row of rows.filter(item => item.eligible)) {
        if (row.source === 'youtube-shorts' && youtubePending) {
          row.status = 'skipped'; row.detail = 'YouTube may still be running. Check Connections before starting Shorts.'; render(); continue;
        }
        row.status = 'running'; row.detail = 'Collecting the available report. This can take several minutes.';
        message = `Collecting ${names[row.source]}. You can close this panel; collection continues while this tab stays open.`;
        render(); attempted = true;
        try {
          const response = await fetch(`/api/sync?source=${encodeURIComponent(row.source)}`, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
          });
          if (response.status === 401 || response.status === 403) {
            onTeamAccess(false); signInNeeded = true; row.status = 'skipped';
            row.detail = 'Team sign-in expired before this collection could start.';
            for (const pending of rows.filter(item => item.status === 'waiting')) {
              pending.status = 'skipped'; pending.detail = 'Sign in to continue the refresh.';
            }
            break;
          }
          const result = await response.json();
          row.result = result;
          Object.assign(row, outcome(result, response.ok));
          if (row.source === 'youtube' && row.status === 'busy') youtubePending = true;
        } catch {
          row.status = 'unknown'; row.detail = 'The response was interrupted. The server may still be collecting; check Connections before retrying.';
          if (row.source === 'youtube') youtubePending = true;
        }
        render();
      }
      const needsAttention = rows.some(row => row.eligible && row.status !== 'ready');
      heading = signInNeeded ? 'Sign in to continue' : needsAttention ? 'Refresh finished with gaps' : 'Connected sources refreshed';
      message = signInNeeded ? 'Your team session expired. Completed reports remain saved.' : needsAttention
        ? 'Review each source below. Any unavailable report keeps its previous successful capture.'
        : 'New reports have been saved. Their actual date ranges appear below.';
    } catch (error) {
      heading = 'Refresh unavailable'; message = error.message || 'The refresh could not start. Saved reports remain available.';
    } finally {
      if (attempted && reloadReport) {
        try { await reloadReport(); }
        catch { pageError = 'The page could not reload its saved reports. Refresh the page when convenient; the dates below still describe the data currently shown.'; }
      }
      busy = false;
      render();
    }
  }
  async function resume() {
    if (resumed) return;
    resumed = true;
    const intent = savedIntent();
    if (!intent) { clearIntent(); return; }
    try {
      if (!await authenticated()) return;
      if (intent.path !== location.pathname + location.search + location.hash) {
        location.replace(intent.path); return;
      }
      await start({ verified: true });
    } catch { /* Leave the requested continuation available for a manual retry. */ }
  }
  return {
    mount(element) {
      if (!element) return;
      host = element;
      trigger = document.createElement('button');
      trigger.type = 'button'; trigger.className = 'report-refresh-trigger';
      trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', String(dialog.open));
      trigger.setAttribute('aria-controls', dialog.id);
      trigger.addEventListener('click', () => busy ? show() : start());
      host.replaceChildren(trigger);
      render();
      void resume();
    },
    update() { render(); },
  };
}
