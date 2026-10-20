import { windowMetrics, groupTests, metadataAudit, validateNotebook, mergeNotebookChanges, workshopThumbnail, workshopPackage } from '/lib/workshop-model.mjs';

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
  const grid = Array.from({ length: 5 }, (_, i) => i * top / 4).map(value => `<line x1="54" x2="894" y1="${y(value)}" y2="${y(value)}" stroke="#d8cbb8"/><text x="43" y="${y(value) + 4}" text-anchor="end">${number(value * 100)}%</text>`).join('');
  const labels = [0, .25, .5, .75, 1].map(value => `<text x="${x(value)}" y="258" text-anchor="middle">${value * 100}%</text>`).join('');
  const paths = series.map((item, i) => `<polyline fill="none" stroke="${i ? '#171310' : '#db0b19'}" stroke-width="3" ${i ? 'stroke-dasharray="8 5"' : ''} points="${item.points.map(point => `${x(point.elapsedVideoTimeRatio).toFixed(2)},${y(point.audienceWatchRatio).toFixed(2)}`).join(' ')}"/>`).join('');
  const samples = series.map(({ video, points }) => `${escapeHTML(video.name)}: ${points.length && video.retentionNear30Seconds?.audienceWatchRatio != null ? `${percent(video.retentionNear30Seconds.audienceWatchRatio * 100)} at ${number(video.retentionNear30Seconds.sampledSeconds, 1)}s` : 'no near-30-second sample collected'}`).join(' · ');
  const sources = series.map(({ video, points }) => points.length ? `${escapeHTML(video.name)}: curve captured ${escapeHTML(date(video.retentionSource?.capturedAt || data.capturedAt))}; queried through ${escapeHTML(date(video.retentionSource?.end || data.apiThrough))}${video.refreshReports?.retention === 'no-rows-retained-previous' ? ' · older curve retained because refresh returned no rows' : ''}` : `${escapeHTML(video.name)}: retention curve unavailable`).join(' · ');
  $('#retention-chart').innerHTML = `<svg viewBox="0 0 930 285" role="img" aria-labelledby="retention-title retention-description"><title id="retention-title">Audience retention: ${escapeHTML(videos.map(video => video.name).join(' compared with '))}</title><desc id="retention-description">Audience watch ratio over percentage through each video. Source: saved YouTube API retention export. These curves are not first ${windowDays} date results.</desc>${grid}${labels}${paths}<text x="474" y="280" text-anchor="middle">PROGRESS THROUGH VIDEO</text></svg><div class="chart-legend">${series.map(item => `<span><i aria-hidden="true"></i>${escapeHTML(item.video.name)}${!item.points.length ? ' · no curve collected' : ''}</span>`).join('')}</div><p class="note">API sample near 30 seconds: ${samples}. Studio’s 30-second card uses its own capture and may differ.</p><p class="note">${sources}. Retention reports do not return a daily completeness marker.</p>`;
}

function renderHeadToHead() {
  const videos = [videoFor($('#video-a').value), videoFor($('#video-b').value)];
  $('#video-cards').innerHTML = videos.map(studioCard).join('');
  renderRetention(videos);
  $('#comparison-prompt').innerHTML = `<p><strong>QUESTION TO TAKE INTO THE NEXT EDIT</strong>${videos[0].id === videos[1].id ? 'Choose two different episodes to explore the differences.' : `Compare the promise in ${escapeHTML(videos[0].name)} with ${escapeHTML(videos[1].name)}: does each opening deliver what its title and thumbnail suggest? Note the exact moment and draft one change. Audience, video age and distribution can also explain differences.`}</p><button id="start-pair-experiment" class="button" type="button">Draft a test ↗</button>`;
  $('#start-pair-experiment').addEventListener('click', () => {
    newExperiment(videos[0].id);
    $('#experiment-control').value = `${videos.map(video => { const pair = workshopPackage(video, data.capturedAt); return `${video.name}: ${pair.title}\nTitle captured ${date(pair.capturedAt)}${pair.hostedImage ? '; hosted thumbnail may change' : '; saved local thumbnail'}`; }).join('\nCompared with\n')}\nAPI through ${date(data.apiThrough)}; whole-video observations, not a controlled experiment.`;
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
  return `<article class="pair-card">${imageHTML(variant.webThumbnail || variant.webEvidence, title, !variant.webThumbnail && !!variant.webEvidence)}<span class="record-status">${escapeHTML(variant.status === 'current' ? 'LATEST SAVED OBSERVATION' : variant.testId ? 'RECOVERED TEST PAIR' : 'HISTORICAL CAPTURE')}</span><h4>${escapeHTML(title)}</h4>${group ? `<div class="share ${highest ? 'highest' : ''}">${hasShare ? percent(share) : '—'}<small>${hasShare ? 'test watch-time share' : 'share not collected'}</small></div>${highest ? '<p>Highest recorded share in this group · not proof of a winner</p>' : ''}` : ''}<p>Observed: ${escapeHTML(variant.observedAt ? date(variant.observedAt) : 'Date not recorded')}</p>${variant.thumbnailDescription ? `<p>${escapeHTML(variant.thumbnailDescription)}</p>` : ''}<details><summary>Capture details &amp; evidence</summary><p>Record: ${escapeHTML(variant.variantId)}<br>Original capture date: ${escapeHTML(variant.observedAt || 'Not recorded')}</p>${variant.window ? `<p>${escapeHTML(variant.window)}</p>` : ''}${asset(variant.webEvidence) ? `<p><a href="${escapeHTML(asset(variant.webEvidence))}" target="_blank" rel="noopener noreferrer">Open saved screenshot ↗</a></p>` : ''}${caveats.length ? `<ul>${caveats.map(note => `<li>${escapeHTML(note)}</li>`).join('')}</ul>` : ''}${sources.length ? `<p>Original source references</p><ul>${sources.map(source => `<li>${escapeHTML(source)}</li>`).join('')}</ul>` : ''}</details></article>`;
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
  $('#packaging-results').innerHTML = visible.length ? visible.map(group => `<article class="test-round"><div class="round-header"><div><span class="eyebrow">${escapeHTML(group.episode)} / ${escapeHTML(group.testId)}</span><h3>${escapeHTML(group.result || (group.status?.includes('without a clear winner') ? 'No clear winner' : 'Saved test evidence'))}</h3><p>${escapeHTML(group.status || 'Final status not recorded')}<br>${escapeHTML(group.window || 'Exact run dates not recorded')}<br>Captured ${escapeHTML(date(group.observedAt))}</p></div><span class="pill">PAIRING RESULTS ONLY</span></div><div class="pair-grid">${group.variants.map(variant => pairCard(variant, group)).join('')}</div><div class="round-footer"><button class="text-button" type="button" data-draft-test="${escapeHTML(group.testId)}">Use this evidence in a draft ↗</button></div></article>`).join('') : '<p class="empty">No recovered native test matches these filters. Current API metadata is not a native test result. Choose capture history to inspect any saved evidence for this upload.</p>';
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

function initialize() {
  tests = groupTests(data.history);
  const options = data.videos.map(video => `<option value="${escapeHTML(video.id)}">${escapeHTML(video.name)}</option>`).join('');
  for (const selector of ['#video-a', '#video-b', '#experiment-video']) $(selector).innerHTML = options;
  $('#packaging-video').insertAdjacentHTML('beforeend', options);
  $('#video-b').value = data.videos[Math.min(2, data.videos.length - 1)].id;
  const sourceText = `Saved reporting evidence · API through ${date(data.apiThrough)} · collected ${date(data.capturedAt)} · historical Studio cards ${date(data.studioCapturedAt)}`;
  $('#source-stamp').textContent = sourceText;
  $('#method-dates').textContent = sourceText;
  renderSummary();
  renderComparison();
  renderHeadToHead();
  renderPackaging();
  renderMetadata();
  bindNotebook();
  loadNotebook();
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
      $('#experiment-change').value = 'Title + thumbnail pairing';
      $('#experiment-control').value = `${group.episode} / ${group.testId}\n${group.window || 'Exact run dates not recorded'}\nCaptured ${group.observedAt || 'date not recorded'}\n${group.status || group.result || 'No result recorded'}\n${group.variants.map(variant => `${variant.title || 'Title unknown'}: ${percent(variant.metrics?.watchTimeSharePct)} watch-time share`).join('\n')}`;
      $('#experiment-metric').value = 'Native test watch-time share for the whole title/image pairing. Keep the full test dates and final status. Do not infer variant CTR or attribute the result to one element.';
      $('#notebook').scrollIntoView({ behavior: 'smooth' });
      $('#experiment-hypothesis').focus({ preventScroll: true });
    }
  });
  $('#close-image').addEventListener('click', () => $('#image-dialog').close());
  $('#image-dialog').addEventListener('click', event => { if (event.target === $('#image-dialog')) $('#image-dialog').close(); });
  $('#load-state').hidden = true;
  $('#workshop-content').hidden = false;
}

async function load() {
  try {
    const response = await fetch('/api/workshop-data', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 || response.status === 403) {
      $('#source-stamp').textContent = 'Private team workshop · sign in to view the saved evidence';
      $('#load-state').innerHTML = '<strong>This is the team workshop.</strong><br>Sign in with an authorised team account to open analytics, packaging history and the experiment notebook.<p><a class="button" href="/login.html?next=%2Fworkshop.html">Sign in to the workshop ↗</a></p>';
      return;
    }
    if (!response.ok) throw new Error(`The data service returned ${response.status}.`);
    data = await response.json();
    if (!Array.isArray(data.videos) || !data.videos.length) throw new Error('No video records were returned.');
    initialize();
  } catch (error) {
    $('#source-stamp').textContent = 'Saved evidence is currently unavailable';
    $('#load-state').setAttribute('role', 'alert');
    $('#load-state').innerHTML = `<strong>The workshop could not load its evidence.</strong><br>${escapeHTML(error.message)}<p>The saved report remains unchanged. Try again when the reporting service is available.</p><button type="button" class="button" id="retry-load">Try again</button>`;
    $('#retry-load').addEventListener('click', load);
  }
}
load();
