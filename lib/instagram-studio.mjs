const WINDOW_COUNTS = ['views', 'instagramViews', 'facebookViews', 'viewers', 'interactions',
  'accountsEngaged', 'profileActivity', 'profileVisits', 'externalLinkTaps'];
const CONTENT_COUNTS = ['views', 'viewers', 'interactions', 'reelsInteractions', 'likes', 'comments',
  'saves', 'shares', 'accountsEngaged', 'profileActivity', 'follows'];
const METRICS = ['views', 'engagedViews', 'watchHours', 'subscribersNet', 'likes', 'comments', 'shares', 'followers'];
const fail = message => { throw new Error(`Invalid Instagram native capture: ${message}`); };
function object(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) {
    fail(`${name} has missing or unsupported fields`);
  }
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    fail('capture timestamp must be a real ISO instant');
  }
  return value;
}
function count(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) fail('counts must be non-negative integers or null');
  return value;
}
function unknownRange(value) {
  object(value, ['start', 'end', 'timezone'], 'relative reporting window');
  if (Object.values(value).some(item => item !== null)) fail('relative window boundaries and timezone were not observed');
  return { start: null, end: null, timezone: null };
}
function percentages(value, labels) {
  if (!Array.isArray(value) || value.length > labels.length) fail('invalid percentage breakdown');
  const seen = new Set();
  return value.map(row => {
    object(row, ['label', 'percentage'], 'percentage bucket');
    if (!labels.includes(row.label) || seen.has(row.label) ||
        row.percentage !== null && (!Number.isFinite(row.percentage) || row.percentage < 0 || row.percentage > 100)) {
      fail('invalid or repeated percentage bucket');
    }
    seen.add(row.label);
    return { label: row.label, percentage: row.percentage };
  });
}

/** Individually verified collaboration posts; never an extra platform total. */
export function validateInstagramCollaborations(value) {
  object(value, ['accountUsername', 'capturedAt', 'coverage', 'posts'], 'collaborations');
  if (value.accountUsername !== 'footyscran' || value.coverage !== 'observed-profile-collabs' ||
      !Array.isArray(value.posts) || value.posts.length > 500) fail('invalid collaboration account or coverage');
  const capturedAt = instant(value.capturedAt);
  const shortcodes = new Set(), mediaIds = new Set();
  const posts = value.posts.map(post => {
    const optional = Object.hasOwn(post || {}, 'relationship') ? ['relationship'] : [];
    object(post, ['shortcode', 'url', 'mediaId', 'title', 'publishedAt', 'capturedAt',
      'views', 'likes', 'comments', 'shares', 'saves', 'metricScope', 'viewsPrecision', ...optional], 'collaboration post');
    const relationship = optional.length ? post.relationship : 'collaboration';
    if (!['collaboration', 'campaign-post'].includes(relationship)) fail('invalid post relationship');
    if (typeof post.shortcode !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(post.shortcode) || shortcodes.has(post.shortcode)) {
      fail('invalid or repeated collaboration shortcode');
    }
    shortcodes.add(post.shortcode);
    let url;
    try { url = new URL(post.url); } catch { fail('invalid collaboration URL'); }
    if (typeof post.url !== 'string' || url.protocol !== 'https:' ||
        !['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.username || url.password ||
        url.port || url.search || url.hash || !['p', 'reel'].some(type =>
          [`/${type}/${post.shortcode}`, `/${type}/${post.shortcode}/`].includes(url.pathname))) {
      fail('collaboration URL must match its shortcode on Instagram');
    }
    if (post.mediaId !== null && (typeof post.mediaId !== 'string' || !/^\d{1,30}$/.test(post.mediaId) || mediaIds.has(post.mediaId))) {
      fail('invalid or repeated collaboration media ID');
    }
    if (post.mediaId !== null) mediaIds.add(post.mediaId);
    if (post.title !== null && (typeof post.title !== 'string' || !post.title.trim() || post.title.length > 1000 ||
        /[\u0000-\u001f\u007f<>]|(?:\bBearer\s+|\b(?:access|refresh|id)[ _-]?token\s*[:=]|\bclient[ _-]?secret\s*[:=])|(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|private)\/)/i.test(post.title))) {
      fail('invalid collaboration title');
    }
    const observedAt = instant(post.capturedAt);
    if (Date.parse(observedAt) > Date.parse(capturedAt)) fail('post capture is later than collaboration capture');
    let publishedAt = post.publishedAt;
    if (publishedAt !== null) {
      if (typeof publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) {
        instant(`${publishedAt}T00:00:00Z`);
        if (publishedAt > observedAt.slice(0, 10)) fail('post publication is later than capture');
      } else if (Date.parse(instant(publishedAt)) > Date.parse(observedAt)) fail('post publication is later than capture');
    }
    if (post.metricScope !== 'post-lifetime' || !['exact', 'rounded', 'unavailable'].includes(post.viewsPrecision) ||
        (post.viewsPrecision === 'unavailable') !== (post.views === null)) fail('invalid collaboration metric scope or view precision');
    return { shortcode: post.shortcode, url: url.href, mediaId: post.mediaId,
      title: post.title === null ? null : post.title.trim(), publishedAt, capturedAt: observedAt,
      ...Object.fromEntries(['views', 'likes', 'comments', 'shares', 'saves'].map(key => [key, count(post[key])])),
      metricScope: 'post-lifetime', viewsPrecision: post.viewsPrecision, relationship };
  });
  return { accountUsername: 'footyscran', capturedAt, coverage: 'observed-profile-collabs', posts };
}

/** Pure, strict public projection of reviewed native UI observations. */
export function validateInstagramStudioCapture(value) {
  const optional = Object.hasOwn(value || {}, 'collaborations') ? ['collaborations'] : [];
  object(value, ['schemaVersion', 'accountUsername', 'capturedAt', 'method', 'followers', 'contentCount',
    'windows', 'followerActivity', 'audience', 'contentCoverage', 'content', ...optional], 'capture');
  if (value.schemaVersion !== 1 || value.accountUsername !== 'scranpints' ||
      value.method !== 'manual-browser-inspection' || value.audience !== null || value.contentCoverage !== 'sample') {
    fail('unsupported account, provenance or coverage');
  }
  const capturedAt = instant(value.capturedAt);
  if (!Array.isArray(value.windows) || !value.windows.length || value.windows.length > 3) fail('invalid native windows');
  const periods = new Set();
  const windows = value.windows.map(window => {
    object(window, ['periodDays', 'label', 'dateRange', ...WINDOW_COUNTS,
      'viewAudience', 'interactionAudience', 'viewContentTypes', 'interactionContentTypes'], 'native window');
    if (![7, 30, 90].includes(window.periodDays) || periods.has(window.periodDays) || window.label !== `Last ${window.periodDays} days`) {
      fail('invalid or repeated relative window');
    }
    periods.add(window.periodDays);
    return { periodDays: window.periodDays, label: window.label, dateRange: unknownRange(window.dateRange),
      ...Object.fromEntries(WINDOW_COUNTS.map(key => [key, count(window[key])])),
      viewAudience: percentages(window.viewAudience, ['Followers', 'Non-followers']),
      interactionAudience: percentages(window.interactionAudience, ['Followers', 'Non-followers']),
      viewContentTypes: percentages(window.viewContentTypes, ['Reels', 'Stories', 'Posts']),
      interactionContentTypes: percentages(window.interactionContentTypes, ['Reels', 'Stories', 'Posts']) };
  }).sort((a, b) => a.periodDays - b.periodDays);
  object(value.followerActivity, ['weekday', 'timezone', 'hours'], 'follower activity');
  if (![null, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(value.followerActivity.weekday) ||
      value.followerActivity.timezone !== null || !Array.isArray(value.followerActivity.hours) || value.followerActivity.hours.length > 24) {
    fail('invalid follower activity context');
  }
  const hours = new Set();
  const activity = value.followerActivity.hours.map(row => {
    object(row, ['hour', 'followers'], 'follower activity hour');
    if (!Number.isInteger(row.hour) || row.hour < 0 || row.hour > 23 || hours.has(row.hour)) fail('invalid or repeated activity hour');
    hours.add(row.hour);
    return { hour: row.hour, followers: count(row.followers) };
  }).sort((a, b) => a.hour - b.hour);
  if (!Array.isArray(value.content) || value.content.length > 100) fail('invalid inspected content sample');
  const ids = new Set();
  const content = value.content.map(item => {
    object(item, ['id', 'url', 'capturedAt', 'reportingWindow', ...CONTENT_COUNTS, 'viewAudience', 'interactionAudience'], 'content observation');
    if (typeof item.id !== 'string' || !/^\d{1,30}$/.test(item.id) || ids.has(item.id) ||
        item.url !== null || item.reportingWindow !== 'not-shown') fail('invalid sample identifier or unverified content context');
    ids.add(item.id);
    const observedAt = instant(item.capturedAt);
    if (Date.parse(observedAt) > Date.parse(capturedAt)) fail('content capture is later than the enclosing capture');
    return { id: item.id, url: null, capturedAt: observedAt, reportingWindow: 'not-shown',
      ...Object.fromEntries(CONTENT_COUNTS.map(key => [key, count(item[key])])),
      viewAudience: percentages(item.viewAudience, ['Followers', 'Non-followers']),
      interactionAudience: percentages(item.interactionAudience, ['Followers', 'Non-followers']) };
  });
  return { schemaVersion: 1, accountUsername: 'scranpints', capturedAt, method: 'manual-browser-inspection',
    followers: count(value.followers), contentCount: count(value.contentCount), windows,
    followerActivity: { weekday: value.followerActivity.weekday, timezone: null, hours: activity },
    audience: null, contentCoverage: 'sample', content,
    ...(optional.length ? { collaborations: validateInstagramCollaborations(value.collaborations) } : {}) };
}

/** Account windows and collaboration observations have independent capture dates. */
export function mergeInstagramStudioCaptures(previous, incoming) {
  const next = validateInstagramStudioCapture(incoming);
  if (!previous) return next;
  const prior = validateInstagramStudioCapture(previous);
  const capture = Date.parse(prior.capturedAt) > Date.parse(next.capturedAt) ? prior : next;
  const observations = [prior.collaborations, next.collaborations].filter(Boolean);
  if (!observations.length) return capture;
  const newest = observations.reduce((a, b) => Date.parse(a.capturedAt) > Date.parse(b.capturedAt) ? a : b);
  // Partial profile inspections do not establish that an omitted post vanished.
  // Keep each last observation with its own date instead of relabeling old counts.
  const posts = new Map();
  for (const observation of observations) for (const post of observation.posts) {
    const current = posts.get(post.shortcode);
    if (!current || Date.parse(post.capturedAt) >= Date.parse(current.capturedAt)) posts.set(post.shortcode, post);
  }
  return validateInstagramStudioCapture({ ...capture,
    collaborations: { ...newest, posts: [...posts.values()] } });
}

/** Attach the capture without overwriting an independently collected API source. */
export function applyInstagramStudioCapture(report, rawCapture) {
  const incoming = validateInstagramStudioCapture(rawCapture);
  const sources = report.sources.map(source => {
    if (source.id !== 'instagram') return source;
    const capture = mergeInstagramStudioCaptures(source.manualCapture, incoming);
    if (source.status === 'snapshot' && source.metrics && source.provenance?.kind !== 'manual-browser') {
      return { ...source, manualCapture: capture };
    }
    return { ...source, status: 'snapshot', accountLabel: 'Scran & Pints', capturedAt: capture.capturedAt,
      dateRange: { start: null, end: null, timezone: null },
      scope: 'Manually captured Instagram native insights. Last 7, 30 and 90 days are native relative labels; exact boundaries and reporting timezone were not shown. Current followers are observed at capture; lifetime views and daily history are unavailable.',
      provenance: { kind: 'manual-browser', label: 'Instagram native insights · manually captured' },
      snapshotOrigin: 'manual-capture', counterScope: 'manual-current-followers', contentCount: capture.contentCount,
      metrics: { ...Object.fromEntries(METRICS.map(key => [key, null])), followers: capture.followers },
      daily: [], content: [], manualCapture: capture };
  });
  return { ...report, sources };
}
