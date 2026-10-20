import { CollectionError, requestPlatformJson } from './collectors.mjs';
import { validateSocialImport } from './social-schema.mjs';

// Instagram Login: only owned professional-account data. Account insights expire
// after 90 days; media insight retention is two years. Never synthesize history.
const ORIGIN = 'https://graph.instagram.com';
const fail = (code, message) => { throw new CollectionError(code, message); };
function count(value, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid-response', 'Instagram returned an invalid reporting count.');
  return value;
}
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('configuration', 'A valid Instagram reporting date is required.');
  return value;
}
const offset = (date, amount) => new Date(Date.parse(date) + amount * 86400000).toISOString().slice(0, 10);
const clean = (value, fallback, maximum = 1000) => (typeof value === 'string' ? value.replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '')?.slice(0, maximum) || fallback;
function single(payload) {
  return Array.isArray(payload?.data) ? payload.data.length === 1 ? payload.data[0] : null : payload;
}
function mediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid-response', 'Instagram returned an invalid media permalink.'); }
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname) ||
      url.username || url.password || url.port || !/^\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    fail('invalid-response', 'Instagram returned an unsupported media permalink.');
  }
  url.search = ''; url.hash = '';
  return url.href;
}
async function mapBounded(items, work) {
  const result = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; result[index] = await work(items[index], index); }
  }));
  return result;
}
function insightValues(payload) {
  if (payload.error || !Array.isArray(payload.data)) fail('invalid-response', 'Instagram returned an invalid insights report.');
  const values = new Map();
  for (const row of payload.data) {
    if (typeof row?.name !== 'string' || values.has(row.name)) fail('invalid-response', 'Instagram returned duplicate or missing metric names.');
    let value = null;
    if (row.total_value && Object.hasOwn(row.total_value, 'value')) value = count(row.total_value.value, true);
    else if (Array.isArray(row.values) && row.values.length === 1) value = count(row.values[0]?.value, true);
    values.set(row.name, value);
  }
  return values;
}
function audienceBuckets(payload, family) {
  if (payload.error || !Array.isArray(payload.data)) fail('invalid-response', 'Instagram returned invalid audience insights.');
  if (!payload.data.length) return [];
  if (payload.data.length !== 1 || payload.data[0]?.name !== 'follower_demographics') fail('invalid-response', 'Instagram returned an unexpected audience metric.');
  const breakdowns = payload.data[0]?.total_value?.breakdowns;
  if (!Array.isArray(breakdowns) || breakdowns.length !== 1 ||
      JSON.stringify(breakdowns[0]?.dimension_keys) !== JSON.stringify([family]) ||
      !Array.isArray(breakdowns[0].results) || breakdowns[0].results.length > 45) fail('invalid-response', 'Instagram returned invalid demographic buckets.');
  const seen = new Set();
  return breakdowns[0].results.map(row => {
    const label = row?.dimension_values?.[0];
    if (!Array.isArray(row?.dimension_values) || row.dimension_values.length !== 1 ||
        typeof label !== 'string' || !label.trim() || label.length > 100 || /[<>\u0000-\u001f\u007f]/.test(label) || seen.has(label)) fail('invalid-response', 'Instagram returned an invalid demographic label.');
    seen.add(label); return { label, count: count(row.value) };
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export async function collectInstagram({ env = process.env, fetchImpl = fetch, capturedAt = new Date().toISOString(), end,
  previous = null } = {}) {
  const accessToken = env.INSTAGRAM_ACCESS_TOKEN;
  const accountId = env.INSTAGRAM_ACCOUNT_ID;
  const version = env.INSTAGRAM_API_VERSION || 'v24.0';
  const expectedUsername = (env.INSTAGRAM_EXPECTED_USERNAME || 'scranpints').toLowerCase();
  if (typeof accessToken !== 'string' || !accessToken.trim() || /[\s\u0000-\u001f\u007f]/.test(accessToken)) fail('not-configured', 'Connect the Instagram professional account before collecting reports.');
  if (!/^\d{1,40}$/.test(accountId || '') || !/^v(?:2[2-9]|[3-9]\d)\.\d$/.test(version) || !/^[a-z0-9_.]{1,30}$/.test(expectedUsername)) fail('configuration', 'Instagram account and supported API version are required.');
  if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) fail('configuration', 'A valid collection timestamp is required.');
  const observedDay = day(capturedAt.slice(0, 10));
  const lastDay = end ? day(end) : observedDay;
  if (lastDay > observedDay) fail('configuration', 'Instagram reporting cannot request future dates.');
  const headers = { Authorization: `Bearer ${accessToken}` };
  async function query(path, params = {}) {
    const url = new URL(`${ORIGIN}/${version}/${path}`);
    url.search = new URLSearchParams(params).toString();
    const payload = await requestPlatformJson(fetchImpl, url.href, { headers });
    if (payload.error) fail('api-error', 'Instagram rejected the reporting request.');
    return payload;
  }
  const profile = single(await query(accountId, { fields: 'id,username,followers_count,media_count' }));
  if (!profile || typeof profile.username !== 'string' || profile.username.toLowerCase() !== expectedUsername) fail('account-mismatch', 'The connected Instagram account does not match Scran & Pints.');
  const followers = count(profile.followers_count, true);
  count(profile.media_count, true);
  let prior = null;
  if (previous) {
    try { prior = validateSocialImport({ schemaVersion: 1, sources: [previous] }).sources[0]; }
    catch { fail('configuration', 'The saved Instagram snapshot is invalid.'); }
    if (prior.id !== 'instagram' || prior.provenance.kind !== 'official-api' || Date.parse(prior.capturedAt) > Date.parse(capturedAt)) fail('configuration', 'The saved Instagram snapshot does not match the reporting source.');
  }
  const media = [], seenIds = new Set(), cursors = new Set();
  let after = null, exhausted = false;
  for (let page = 0; page < 500; page++) {
    const payload = await query(`${accountId}/media`, { fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count',
      limit: '100', ...(after ? { after } : {}) });
    if (!Array.isArray(payload.data) || payload.data.length > 100 || payload.data.some(row => !/^\d{1,40}$/.test(String(row?.id || '')))) fail('invalid-response', 'Instagram returned an invalid media page.');
    for (const row of payload.data) {
      const id = String(row.id);
      if (seenIds.has(id)) fail('pagination', 'Instagram repeated media; the previous snapshot was retained.');
      seenIds.add(id);
      if (typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))) fail('invalid-response', 'Instagram returned an invalid media publication date.');
      media.push({ id, title: clean(row.caption, `Instagram ${row.media_type || 'post'}`), url: mediaUrl(row.permalink),
        publishedAt: new Date(row.timestamp).toISOString(), thumbnail: null, views: null,
        likes: count(row.like_count, true), comments: count(row.comments_count, true), shares: null });
    }
    if (!payload.paging?.next) { exhausted = true; break; }
    const cursor = payload.paging?.cursors?.after;
    if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || /[\u0000-\u001f\u007f]/.test(cursor) || cursors.has(cursor)) fail('pagination', 'Instagram pagination did not advance; no partial inventory was published.');
    cursors.add(cursor); after = cursor;
  }
  if (!exhausted) fail('pagination', 'Instagram exceeded the complete media inventory limit; no partial inventory was published.');
  await mapBounded(media, async item => {
    try {
      const values = insightValues(await query(`${item.id}/insights`, { metric: 'views,shares', period: 'lifetime' }));
      item.views = values.get('views') ?? null; item.shares = values.get('shares') ?? null;
    } catch {
      // One unsupported media metric must not suppress otherwise available views.
      try { item.views = insightValues(await query(`${item.id}/insights`, { metric: 'views', period: 'lifetime' })).get('views') ?? null; }
      catch { /* Missing/expired insights remain null. */ }
    }
  });
  const cutoff = offset(lastDay, -89);
  const priorDays = prior?.daily || [];
  const latestSaved = priorDays.at(-1)?.day;
  const firstDay = latestSaved ? [cutoff, offset(latestSaved, -6)].sort().at(-1) : cutoff;
  const dates = [];
  for (let value = firstDay; value <= lastDay; value = offset(value, 1)) dates.push(value);
  const daily = new Map(priorDays.map(row => [row.day, { ...row }]));
  let missingDays = 0;
  await mapBounded(dates, async date => {
    try {
      const values = insightValues(await query(`${accountId}/insights`, { metric: 'views', period: 'day', metric_type: 'total_value',
        since: String(Date.parse(date) / 1000), until: String(Date.parse(offset(date, 1)) / 1000 - 1) }));
      const views = values.get('views');
      if (views === null || views === undefined) { missingDays++; return; }
      daily.set(date, { day: date, views });
    } catch { missingDays++; }
  });
  const buckets = await mapBounded(['age', 'gender', 'country'], async family => {
    try { return audienceBuckets(await query(`${accountId}/insights`, { metric: 'follower_demographics', period: 'lifetime',
      metric_type: 'total_value', timeframe: 'this_month', breakdown: family }), family); }
    catch { return []; }
  });
  const nativeAudience = buckets.some(rows => rows.length) ? { capturedAt, timeframe: 'this_month',
    scope: 'Native follower demographics for the last 30 days. Only followers with reported demographics are included; Meta returns top 45 buckets and suppresses small audiences. Empty categories are unavailable.',
    age: buckets[0], gender: buckets[1], country: buckets[2] } : undefined;
  const rows = [...daily.values()].sort((a, b) => a.day.localeCompare(b.day));
  const sum = key => media.some(item => item[key] === null) ? null : media.reduce((total, item) => total + item[key], 0);
  const missingMedia = media.filter(item => item.views === null || item.shares === null).length;
  const source = { id: 'instagram', label: 'Instagram', accountLabel: `@${profile.username}`, status: 'snapshot', capturedAt,
    dateRange: { start: rows[0]?.day || observedDay, end: observedDay, timezone: 'UTC' },
    counterScope: 'public-content-lifetime',
    scope: `Lifetime counters observed ${observedDay} for all ${media.length} media returned by Instagram Login; followers are current. These totals are not reporting-period totals or unique people. Daily rows separately report native account views in UTC; first backfill is limited to Meta's retained 90 days, then saved history is preserved. ${missingMedia} media have unavailable view/share insights; ${missingDays} requested daily reports were unavailable. Previously saved daily rows are retained where newer rows are unavailable. Deleted/private media, expired Stories and unavailable older insights are excluded. Insights can lag 48 hours.`,
    provenance: { kind: 'official-api', label: 'Instagram API with Instagram Login — media lifetime counters and daily account views' },
    metrics: { views: sum('views'), engagedViews: null, watchHours: null, likes: sum('likes'), comments: sum('comments'), shares: sum('shares'), followers, subscribersNet: null },
    daily: rows, content: media, ...(nativeAudience ? { nativeAudience } : {}) };
  try { return validateSocialImport({ schemaVersion: 1, sources: [source] }).sources[0]; }
  catch { fail('invalid-response', 'Instagram reporting did not pass public snapshot checks; the previous snapshot was retained.'); }
}
