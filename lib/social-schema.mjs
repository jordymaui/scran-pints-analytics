export const SOCIAL_SOURCE_IDS = Object.freeze(['youtube-shorts', 'instagram', 'tiktok']);
export const SOCIAL_METRICS = Object.freeze([
  'views', 'engagedViews', 'watchHours', 'likes', 'comments', 'shares', 'followers', 'subscribersNet',
]);
export const YOUTUBE_ANALYTICS_PROVENANCE = 'YouTube Analytics API v2 — daily creatorContentType report';
export const YOUTUBE_SHORTS_DAILY_METRICS = Object.freeze([
  'views', 'engagedViews', 'watchHours', 'likes', 'comments', 'shares',
  'subscribersGained', 'subscribersLost', 'subscribersNet',
]);

const SOURCE_FIELDS = [
  'id', 'label', 'accountLabel', 'status', 'capturedAt', 'dateRange', 'scope', 'provenance',
  'metrics', 'daily', 'content',
];
const CONTENT_FIELDS = [
  'id', 'title', 'url', 'publishedAt', 'thumbnail', 'views', 'likes', 'comments', 'shares',
];
const SECRET_PATTERN = /(?:\bBearer\s+\S+|\b(?:access|refresh|id)[ _-]?token\s*[:=]|\bclient[ _-]?secret\s*[:=]|\bya29\.[A-Za-z0-9_-]+|\b(?:act|rft)\.[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i;
const LOCAL_PATH_PATTERN = /(?:(?:^|[\s("'])[A-Za-z]:[\\/]|\\\\[^\\]+\\|(?:^|\s)\/(?:Users|home|tmp|var|private)\b)/;

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function object(value, fields, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) fail(path, 'contains an unsupported field; only the documented public schema is accepted');
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  }
}

function text(value, path, maxLength = 300) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    fail(path, `must be non-empty text of at most ${maxLength} characters`);
  }
  if (/[\u0000-\u001f\u007f<>]/.test(value)) fail(path, 'contains control characters or markup');
  if (SECRET_PATTERN.test(value)) fail(path, 'appears to contain a credential');
  if (LOCAL_PATH_PATTERN.test(value)) fail(path, 'must not expose a local file path');
  return value.trim();
}

function identifier(value, path) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    fail(path, 'must contain 1–128 letters, digits, underscores or hyphens');
  }
  return value;
}

function day(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    fail(path, 'must be a real date in YYYY-MM-DD format');
  }
  return value;
}

function instant(value, path) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    fail(path, 'must be an ISO timestamp with an explicit timezone');
  }
  day(value.slice(0, 10), path);
  return value;
}

function metric(value, key, path, signedLikes = false) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number or null');
  if (key !== 'subscribersNet' && !(key === 'likes' && signedLikes) && value < 0) fail(path, 'must be non-negative or null');
  if (key !== 'watchHours' && !Number.isSafeInteger(value)) fail(path, 'must be a safe integer or null');
  return value;
}

function publicContentUrl(value, sourceId, path) {
  const raw = text(value, path, 1000);
  let url;
  try { url = new URL(raw); } catch { fail(path, 'must be an HTTPS platform content URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    fail(path, 'must be an HTTPS platform content URL without credentials, port or fragment');
  }
  let valid = false;
  if (sourceId === 'youtube-shorts') {
    const youtubeHost = ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname);
    if (url.hostname === 'youtu.be') valid = /^\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname) && !url.search;
    if (youtubeHost && /^\/shorts\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) valid = !url.search;
    if (youtubeHost && url.pathname === '/watch') {
      valid = /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get('v') || '') &&
        [...url.searchParams.keys()].length === 1 && url.searchParams.getAll('v').length === 1;
    }
  } else if (sourceId === 'instagram') {
    valid = ['instagram.com', 'www.instagram.com'].includes(url.hostname) &&
      /^\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && !url.search;
  } else if (sourceId === 'tiktok') {
    valid = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(url.hostname) &&
      /^\/@[A-Za-z0-9_.]+\/video\/\d+\/?$/.test(url.pathname) && !url.search;
  }
  if (!valid) fail(path, 'must be a canonical content link on the matching official platform; remove tracking parameters');
  return url.href;
}

function array(value, path, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail(path, `must be an array with at most ${maximum} entries`);
}

/**
 * Validate and return a fresh, allowlisted public snapshot. Unknown values are null,
 * never inferred as zero. No auth config, raw exports, paths or arbitrary keys pass through.
 */
export function validateSocialImport(input) {
  object(input, ['schemaVersion', 'sources'], 'import');
  if (input.schemaVersion !== 1) fail('import.schemaVersion', 'must be 1');
  array(input.sources, 'import.sources', SOCIAL_SOURCE_IDS.length);
  const sourceIds = new Set();
  const sources = input.sources.map((source, index) => {
    const path = `import.sources[${index}]`;
    const optional = ['nativeAudience', 'counterScope'].filter(key => Object.hasOwn(source || {}, key));
    object(source, [...SOURCE_FIELDS, ...optional], path);
    if (!SOCIAL_SOURCE_IDS.includes(source.id)) fail(`${path}.id`, 'is not a supported source');
    if (sourceIds.has(source.id)) fail(`${path}.id`, 'duplicates another source');
    sourceIds.add(source.id);
    if (source.status !== 'snapshot') fail(`${path}.status`, 'must be snapshot; imports never claim to be live');
    if (optional.length && (source.id !== 'instagram' || source.provenance?.kind !== 'official-api')) {
      fail(path, 'native Instagram reporting fields require the official Instagram API');
    }
    if (source.counterScope !== undefined && source.counterScope !== 'public-content-lifetime') {
      fail(`${path}.counterScope`, 'must describe returned media lifetime counters');
    }
    object(source.dateRange, ['start', 'end', 'timezone'], `${path}.dateRange`);
    const start = day(source.dateRange.start, `${path}.dateRange.start`);
    const end = day(source.dateRange.end, `${path}.dateRange.end`);
    if (start > end) fail(`${path}.dateRange`, 'start must be on or before end');
    const timezone = text(source.dateRange.timezone, `${path}.dateRange.timezone`, 100);
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch {
      fail(`${path}.dateRange.timezone`, 'must be a recognized IANA timezone, such as Europe/London');
    }
    object(source.provenance, ['kind', 'label'], `${path}.provenance`);
    if (!['platform-export', 'official-api'].includes(source.provenance.kind)) {
      fail(`${path}.provenance.kind`, 'must be platform-export or official-api');
    }
    // Native Analytics period likes can contain signed adjustments. This does
    // not relax public content counters, other platforms or other metrics.
    const signedLikes = source.id === 'youtube-shorts' && source.provenance.kind === 'official-api' &&
      source.provenance.label === YOUTUBE_ANALYTICS_PROVENANCE;
    const subscriberFields = signedLikes && (Object.hasOwn(source.metrics || {}, 'subscribersGained') ||
      Object.hasOwn(source.metrics || {}, 'subscribersLost')) ? ['subscribersGained', 'subscribersLost'] : [];
    object(source.metrics, [...SOCIAL_METRICS, ...subscriberFields], `${path}.metrics`);
    const metrics = Object.fromEntries(SOCIAL_METRICS.map(key => [key, metric(source.metrics[key], key, `${path}.metrics.${key}`, signedLikes)]));
    for (const key of subscriberFields) metrics[key] = metric(source.metrics[key], key, `${path}.metrics.${key}`);
    if (subscriberFields.length && metrics.subscribersGained !== null && metrics.subscribersLost !== null &&
        metrics.subscribersNet !== metrics.subscribersGained - metrics.subscribersLost) {
      fail(`${path}.metrics.subscribersNet`, 'must equal the returned gains minus losses');
    }
    array(source.daily, `${path}.daily`, signedLikes ? 20000 : 5000);
    const days = new Set();
    const daily = source.daily.map((row, rowIndex) => {
      const rowPath = `${path}.daily[${rowIndex}]`;
      const expanded = signedLikes && row && Object.keys(row).some(key => key !== 'day' && key !== 'views');
      const rowMetrics = expanded ? YOUTUBE_SHORTS_DAILY_METRICS : ['views'];
      object(row, ['day', ...rowMetrics], rowPath);
      const date = day(row.day, `${rowPath}.day`);
      if (date < start || date > end) fail(`${rowPath}.day`, 'must be inside the declared reporting window');
      if (days.has(date)) fail(`${rowPath}.day`, 'duplicates another day');
      days.add(date);
      const values = Object.fromEntries(rowMetrics.map(key => [key, metric(row[key], key, `${rowPath}.${key}`, signedLikes)]));
      if (expanded && values.subscribersGained !== null && values.subscribersLost !== null &&
          values.subscribersNet !== values.subscribersGained - values.subscribersLost) {
        fail(`${rowPath}.subscribersNet`, 'must equal the returned gains minus losses');
      }
      return { day: date, ...values };
    }).sort((a, b) => a.day.localeCompare(b.day));
    array(source.content, `${path}.content`, 50000);
    const contentIds = new Set();
    const content = source.content.map((item, itemIndex) => {
      const itemPath = `${path}.content[${itemIndex}]`;
      object(item, CONTENT_FIELDS, itemPath);
      const id = identifier(item.id, `${itemPath}.id`);
      if (contentIds.has(id)) fail(`${itemPath}.id`, 'duplicates another content item');
      contentIds.add(id);
      if (item.thumbnail !== null) fail(`${itemPath}.thumbnail`, 'must be null in schema version 1');
      return {
        id,
        title: text(item.title, `${itemPath}.title`, 1000),
        url: publicContentUrl(item.url, source.id, `${itemPath}.url`),
        publishedAt: instant(item.publishedAt, `${itemPath}.publishedAt`),
        thumbnail: null,
        ...Object.fromEntries(['views', 'likes', 'comments', 'shares'].map(key => [key, metric(item[key], key, `${itemPath}.${key}`)])),
      };
    });
    let nativeAudience;
    if (source.nativeAudience !== undefined) {
      const entry = source.nativeAudience;
      const audiencePath = `${path}.nativeAudience`;
      object(entry, ['capturedAt', 'timeframe', 'scope', 'age', 'gender', 'country'], audiencePath);
      const capturedAt = instant(entry.capturedAt, `${audiencePath}.capturedAt`);
      if (Date.parse(capturedAt) > Date.parse(source.capturedAt) || entry.timeframe !== 'this_month') {
        fail(audiencePath, 'must be a collected current-month audience report');
      }
      nativeAudience = { capturedAt, timeframe: 'this_month', scope: text(entry.scope, `${audiencePath}.scope`, 1000) };
      for (const family of ['age', 'gender', 'country']) {
        array(entry[family], `${audiencePath}.${family}`, 100);
        const labels = new Set();
        nativeAudience[family] = entry[family].map((row, index) => {
          const rowPath = `${audiencePath}.${family}[${index}]`;
          object(row, ['label', 'count'], rowPath);
          const label = text(row.label, `${rowPath}.label`, 100);
          const amount = metric(row.count, 'views', `${rowPath}.count`);
          if (amount === null || labels.has(label)) fail(rowPath, 'requires a unique bucket and a reported count');
          labels.add(label);
          return { label, count: amount };
        });
      }
    }
    return {
      id: source.id,
      label: text(source.label, `${path}.label`, 100),
      accountLabel: text(source.accountLabel, `${path}.accountLabel`, 150),
      status: 'snapshot',
      capturedAt: instant(source.capturedAt, `${path}.capturedAt`),
      dateRange: { start, end, timezone },
      scope: text(source.scope, `${path}.scope`, 1000),
      provenance: {
        kind: source.provenance.kind,
        label: text(source.provenance.label, `${path}.provenance.label`, 300),
      },
      metrics, daily, content,
      ...(source.counterScope ? { counterScope: source.counterScope } : {}),
      ...(nativeAudience ? { nativeAudience } : {}),
    };
  });
  return { schemaVersion: 1, sources };
}
