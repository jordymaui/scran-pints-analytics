const DAY = 86400000;
const finite = value => typeof value === 'number' && Number.isFinite(value);

// Calendar dates in the saved API export, never a rolling 72/168-hour window.
export function windowMetrics(video, count) {
  if (![3, 7].includes(count)) throw new RangeError('Use 3 or 7 calendar dates.');
  const start = video.reportingPublishedDate || String(video.publishedAt || '').slice(0, 10);
  const time = Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(time)) return { complete: false, reason: 'Publication date unavailable', days: count };
  const dates = Array.from({ length: count }, (_, i) => new Date(time + i * DAY).toISOString().slice(0, 10));
  const records = Array.isArray(video.daily) ? video.daily : [];
  const matches = dates.map(day => records.filter(row => row.day === day));
  const present = matches.filter(rows => rows.length === 1).length;
  const base = { start, end: dates.at(-1), days: count, present };
  if (matches.some(rows => rows.length !== 1)) {
    return { ...base, complete: false, reason: matches.some(rows => rows.length > 1) ? 'Duplicate source dates' : `${present}/${count} dates collected` };
  }
  const rows = matches.map(items => items[0]);
  const total = key => rows.every(row => finite(row[key])) ? rows.reduce((sum, row) => sum + row[key], 0) : null;
  const minutes = total('estimatedMinutesWatched');
  const gained = total('subscribersGained');
  const lost = total('subscribersLost');
  return {
    ...base,
    complete: true,
    views: total('views'),
    watchHours: minutes === null ? null : minutes / 60,
    subscribersNet: gained === null || lost === null ? null : gained - lost
  };
}

export function groupTests(history) {
  return (history?.videos || []).flatMap(video => {
    const groups = new Map();
    for (const test of video.tests || []) {
      const id = test.testId || test.id;
      if (id) groups.set(id, { ...test, testId: id, videoId: video.videoId, episode: video.episode, variants: [] });
    }
    for (const variant of video.variants || []) {
      if (!variant.testId || variant.status === 'draft') continue;
      if (!groups.has(variant.testId)) groups.set(variant.testId, { testId: variant.testId, videoId: video.videoId, episode: video.episode, variants: [] });
      groups.get(variant.testId).variants.push(variant);
    }
    return [...groups.values()].map(group => {
      const shares = group.variants.map(v => v.metrics?.watchTimeSharePct).filter(finite);
      return {
        ...group,
        highestShare: shares.length ? Math.max(...shares) : null,
        observedAt: group.observedAt || group.variants.map(v => v.observedAt).filter(Boolean).sort().at(-1) || null,
        window: group.window || group.variants.find(v => v.window)?.window || null
      };
    });
  });
}

export function metadataAudit(video, historyVideo) {
  const title = video.metadata?.title || video.title || '';
  const used = (historyVideo?.variants || []).filter(v => v.status !== 'draft');
  const description = typeof video.metadata?.description === 'string' ? video.metadata.description : null;
  const tags = Array.isArray(video.metadata?.tags) ? video.metadata.tags : null;
  return {
    title,
    capturedAt: video.metadata?.capturedAt || null,
    characters: Array.from(title).length,
    words: title.trim() ? title.trim().split(/\s+/u).length : 0,
    recoveredTitles: new Set(used.map(v => v.title).filter(Boolean)).size,
    thumbnailCaptures: used.filter(v => v.webThumbnail || v.webEvidence).length,
    description: description === null ? 'Not collected' : description ? `${Array.from(description).length} characters` : 'Empty at capture',
    tags: tags === null ? 'Not collected' : `${tags.length} returned`,
    descriptionText: description,
    tagList: tags
  };
}

const fields = ['id', 'videoId', 'hypothesis', 'change', 'control', 'candidate', 'thumbnail', 'metric', 'decision', 'result', 'status', 'updatedAt'];
export function validateNotebook(payload) {
  if (payload?.schema !== 'scran-workshop-notebook-v1' || !Array.isArray(payload.entries) || payload.entries.length > 200) {
    throw new Error('Choose a Workshop notebook export with at most 200 experiments.');
  }
  const ids = new Set();
  return payload.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) throw new Error('Every experiment needs a unique ID.');
    if (!['draft', 'planned', 'running', 'reviewed'].includes(entry.status)) throw new Error('An experiment has an unknown status.');
    const clean = {};
    for (const field of fields) {
      if (typeof entry[field] !== 'string' || entry[field].length > 10000) throw new Error('An experiment has an invalid or oversized field.');
      clean[field] = entry[field];
    }
    ids.add(entry.id);
    return clean;
  });
}

// Rebase local edits onto the latest team version. Two edits to one experiment
// are retained as separate drafts; untouched stale rows never undo team edits.
export function mergeNotebookChanges(base, local, remote, makeId) {
  const same = (a, b) => a === b || !!a && !!b && fields.every(field => a[field] === b[field]);
  const original = new Map(base.map(entry => [entry.id, entry]));
  const current = new Map(local.map(entry => [entry.id, entry]));
  const merged = new Map(remote.map(entry => [entry.id, entry]));
  let conflicts = 0;
  const remappedIds = Object.create(null);
  for (const entry of local) {
    const before = original.get(entry.id);
    if (same(entry, before)) continue;
    const team = merged.get(entry.id);
    if (same(entry, team)) continue;
    if (same(team, before)) merged.set(entry.id, entry);
    else {
      const id = makeId();
      if (!id || merged.has(id)) throw new Error('Could not create a unique conflict draft.');
      merged.set(id, { ...entry, id });
      remappedIds[entry.id] = id;
      conflicts++;
    }
  }
  for (const entry of base) {
    if (!current.has(entry.id)) {
      if (same(merged.get(entry.id), entry)) merged.delete(entry.id);
      else if (merged.has(entry.id)) conflicts++;
    }
  }
  if (merged.size > 200) throw new Error('The merged notebook would exceed 200 experiments. Export your page copy before reloading.');
  return { entries: [...merged.values()], conflicts, remappedIds };
}
