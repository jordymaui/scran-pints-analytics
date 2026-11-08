// Native X exports. Only selected reporting fields cross the public boundary.
const FIELDS = ['views', 'watchHours', 'impressions', 'engagements', 'likes', 'comments', 'reposts', 'shares', 'bookmarks', 'profileVisits', 'netFollowers', 'posts'];
const fail = () => { throw Error('Invalid X Analytics report.'); };
const keys = (v, list) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === list.length && list.every(k => Object.hasOwn(v, k));
const day = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const instant = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
const safe = v => typeof v === 'string' && v.length > 0 && v.length < 250 && !/[<>\u0000-\u001f]/.test(v) && !/(?:token|secret)\s*[:=]|https?:|[A-Z]:[\\/]/i.test(v);
const amount = (v, key) => v === null || Number.isFinite(v) && (key === 'netFollowers' || v >= 0) && (key === 'watchHours' || Number.isSafeInteger(v));
function range(v) { if (!keys(v, ['start', 'end', 'timezone']) || !day(v.start) || !day(v.end) || v.start > v.end || v.timezone !== null) fail(); return { ...v }; }
function buckets(v) {
  if (!Array.isArray(v) || v.length > 100) fail(); const seen = new Set();
  return v.map(r => { if (!keys(r, ['label', 'percentage']) || !safe(r.label) || seen.has(r.label) || !Number.isFinite(r.percentage) || r.percentage < 0 || r.percentage > 100) fail(); seen.add(r.label); return { ...r }; });
}
export function validateXAnalytics(input) {
  if (!keys(input, ['schemaVersion', 'accountUsername', 'capturedAt', 'accountDateRange', 'videoDateRange', 'daily', 'totals', 'videos', 'audience']) || input.schemaVersion !== 1 || input.accountUsername !== 'ScranPints' || !instant(input.capturedAt)) fail();
  const accountDateRange = range(input.accountDateRange), videoDateRange = range(input.videoDateRange);
  if (accountDateRange.end > input.capturedAt.slice(0, 10) || videoDateRange.start < accountDateRange.start || videoDateRange.end > accountDateRange.end || !Array.isArray(input.daily) || !input.daily.length || input.daily.length > 20000) fail();
  const seen = new Set();
  const daily = input.daily.map(r => {
    if (!keys(r, ['date', ...FIELDS]) || !day(r.date) || seen.has(r.date) || r.date < accountDateRange.start || r.date > accountDateRange.end || FIELDS.some(k => !amount(r[k], k))) fail();
    if ((r.date < videoDateRange.start || r.date > videoDateRange.end) && (r.views !== null || r.watchHours !== null)) fail();
    seen.add(r.date); return { ...r };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (!keys(input.totals, FIELDS) || FIELDS.some(k => !amount(input.totals[k], k))) fail();
  for (const key of FIELDS) {
    const window = ['views', 'watchHours'].includes(key) ? videoDateRange : accountDateRange;
    const selected = daily.filter(r => r.date >= window.start && r.date <= window.end);
    const complete = selected.length === (Date.parse(window.end) - Date.parse(window.start)) / 86400000 + 1 && selected.every(r => r[key] !== null);
    const total = complete ? selected.reduce((s, r) => s + r[key], 0) : null;
    if (total === null ? input.totals[key] !== null : Math.abs(total - input.totals[key]) > 0.000001) fail();
  }
  if (!Array.isArray(input.videos) || input.videos.length > 5000) fail(); const media = new Set();
  const videos = input.videos.map(v => {
    if (!keys(v, ['id', 'publishedOn', 'title', 'views', 'durationSeconds']) || !/^\d+_\d+$/.test(v.id) || media.has(v.id) || !day(v.publishedOn) || !safe(v.title) || !Number.isSafeInteger(v.views) || v.views < 0 || !Number.isSafeInteger(v.durationSeconds) || v.durationSeconds <= 0) fail();
    media.add(v.id); return { ...v };
  });
  let audience = null;
  if (input.audience !== null) {
    const a = input.audience;
    if (!keys(a, ['capturedAt', 'metric', 'periodLabel', 'age', 'gender', 'country']) || !instant(a.capturedAt) || a.metric !== 'impressions' || a.periodLabel !== '3M at capture') fail();
    audience = { capturedAt: a.capturedAt, metric: a.metric, periodLabel: a.periodLabel, age: buckets(a.age), gender: buckets(a.gender), country: buckets(a.country) };
  }
  return { schemaVersion: 1, accountUsername: 'ScranPints', capturedAt: input.capturedAt, accountDateRange, videoDateRange, daily, totals: { ...input.totals }, videos, audience };
}

// RFC4180-style parsing also handles quoted dates containing commas.
function csv(text) {
  if (typeof text !== 'string' || text.length > 10000000) fail();
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
    else if (c === '"') { if (cell) fail(); quoted = true; }
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (quoted) fail(); row.push(cell); if (row.some(Boolean)) rows.push(row); return rows;
}
function dateLabel(value) {
  const match = /^(?:[A-Za-z]{3}, )?([A-Za-z]{3}) (\d{1,2}), (\d{4})$/.exec(value);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match?.[1]);
  if (!match || month < 0) fail(); const d = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`; if (!day(d)) fail(); return d;
}
const cellNumber = v => { if (!/^\d+(?:\.\d+)?$/.test(v || '')) fail(); return Number(v); };
export function normalizeXExports({ overviewCsv, videoCsv, capturedAt, followers, audience = null }) {
  if (!instant(capturedAt) || !Number.isSafeInteger(followers) || followers < 0) fail();
  const overview = csv(overviewCsv), video = csv(videoCsv);
  const headers = ['Date', 'Impressions', 'Likes', 'Engagements', 'Bookmarks', 'Shares', 'New follows', 'Unfollows', 'Replies', 'Reposts', 'Profile visits', 'Create Post', 'Video views', 'Media views'];
  if (JSON.stringify(overview.shift()) !== JSON.stringify(headers)) fail();
  if (video[0]?.[0] !== 'Video overview' || JSON.stringify(video[1]) !== JSON.stringify(['Date', 'Views', 'Watch Time (ms)', 'Completion Rate', 'Average Watch Time (ms)', 'Estimated Revenue'])) fail();
  const videoRows = [], videos = []; let index = 2;
  for (; index < video.length && video[index][0] !== 'Your videos'; index++) {
    const r = video[index]; if (r.length !== 6) fail();
    videoRows.push({ date: dateLabel(r[0]), views: cellNumber(r[1]), watchHours: cellNumber(r[2]) / 3600000 });
  }
  if (!videoRows.length || video[index + 1]?.[1] !== 'Video ID') fail();
  for (const r of video.slice(index + 2)) {
    const duration = /^(?:(\d+):)?(\d+):(\d+)$/.exec(r[4]); if (!duration) fail();
    videos.push({ id: r[1], publishedOn: dateLabel(r[0]), title: r[2] || 'Untitled', views: cellNumber(r[3]), durationSeconds: Number(duration[1] || 0) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) });
  }
  const dates = videoRows.map(r => r.date).sort(), videoDateRange = { start: dates[0], end: dates.at(-1), timezone: null };
  const viewMap = new Map(videoRows.map(r => [r.date, r])); if (viewMap.size !== videoRows.length) fail();
  const daily = overview.map(r => {
    if (r.length !== headers.length) fail(); const date = dateLabel(r[0]), n = r.slice(1).map(cellNumber), v = viewMap.get(date);
    return { date, views: v?.views ?? null, watchHours: v?.watchHours ?? null, impressions: n[0], likes: n[1], engagements: n[2], bookmarks: n[3], shares: n[4], netFollowers: n[5] - n[6], comments: n[7], reposts: n[8], profileVisits: n[9], posts: n[10] };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const accountDateRange = { start: daily[0]?.date, end: daily.at(-1)?.date, timezone: null };
  const totals = Object.fromEntries(FIELDS.map(k => [k, daily.filter(r => !['views', 'watchHours'].includes(k) || r.date >= videoDateRange.start && r.date <= videoDateRange.end).reduce((s, r) => s + (r[k] ?? 0), 0)]));
  const xAnalytics = validateXAnalytics({ schemaVersion: 1, accountUsername: 'ScranPints', capturedAt, accountDateRange, videoDateRange, daily, totals, videos, audience });
  return { id: 'x', label: 'X', accountLabel: 'Scran & Pints · @ScranPints', status: 'snapshot', capturedAt, dateRange: videoDateRange,
    scope: 'Native X video views. Post impressions are reported separately. Daily account engagement can include non-video posts. Captured export; Refresh retains this report until a newer native capture is saved.',
    provenance: { kind: 'platform-export', label: 'X Analytics · native account and video CSV exports' },
    metrics: { views: totals.views, engagedViews: null, watchHours: totals.watchHours, likes: totals.likes, comments: totals.comments, shares: totals.shares + totals.reposts, followers, subscribersNet: totals.netFollowers },
    daily: daily.filter(r => r.date >= videoDateRange.start && r.date <= videoDateRange.end).map(r => ({ day: r.date, views: r.views })), content: [], xAnalytics };
}

export function xPerformance(input) {
  const x = validateXAnalytics(input), r = x.videoDateRange;
  const daily = x.daily.filter(d => d.date >= r.start && d.date <= r.end).map(d => ({ date: d.date, views: d.views, watchHours: d.watchHours,
    likes: d.likes, comments: d.comments, shares: d.shares !== null && d.reposts !== null ? d.shares + d.reposts : null, subscribersNet: d.netFollowers, engagements: d.engagements }));
  const total = key => daily.every(d => Number.isFinite(d[key])) ? daily.reduce((s, d) => s + d[key], 0) : null;
  return { capturedAt: x.capturedAt, dateRange: { ...r, timeZone: null }, daily,
    totals: { views: x.totals.views, watchHours: x.totals.watchHours, likes: total('likes'), comments: total('comments'), shares: total('shares'), subscribersNet: total('subscribersNet') } };
}
