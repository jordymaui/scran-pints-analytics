const DAY = 86_400_000;
const MAX_DAYS = 20_000;
const METRICS = ['views', 'watchHours', 'likes', 'comments', 'shares', 'subscribersNet'];
const RANGES = { '7d': 7, '28d': 28, '90d': 90 };
const finite = value => typeof value === 'number' && Number.isFinite(value);

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
const shift = (date, days) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
const daysBetween = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
const emptyPeriod = () => ({
  start: null, end: null, rows: [], previousRows: [], complete: false, previousComplete: false,
});

function indexRows(rows, start = null, end = null) {
  const indexed = new Map();
  for (const row of rows) {
    if (!validDate(row?.date) || (start && row.date < start) || (end && row.date > end)) continue;
    // Two rows for the same date are ambiguous, even if their values match.
    indexed.set(row.date, indexed.has(row.date) ? null : row);
  }
  return indexed;
}

function calendarRows(indexed, start, end) {
  const count = daysBetween(start, end);
  if (!Number.isInteger(count) || count < 1 || count > MAX_DAYS) return [];
  return Array.from({ length: count }, (_, index) => {
    const date = shift(start, index);
    const source = indexed.get(date);
    const available = Boolean(source && source.available !== false);
    return { date, available, ...Object.fromEntries(METRICS.map(key => [
      key, available && finite(source[key]) ? source[key] : null,
    ])) };
  });
}

/**
 * Inclusive source-calendar windows; no local timezone conversion is applied.
 * Missing or duplicate dates become available:false rows with null metrics.
 * Custom {start,end} is capped at the latest source date. Earlier missing dates
 * remain gaps so short histories cannot masquerade as complete 7/28/90-day runs.
 */
export function selectPeriod(performance, range = '28d', custom) {
  const declared = performance?.dateRange;
  if (!validDate(declared?.start) || !validDate(declared?.end) || declared.start > declared.end ||
      !Array.isArray(performance.daily) || performance.daily.length > MAX_DAYS * 2) return emptyPeriod();
  const indexed = indexRows(performance.daily, declared.start, declared.end);
  const dates = [...indexed.keys()].sort();
  if (!dates.length) return emptyPeriod();
  let end = dates.at(-1), start;
  if (Object.hasOwn(RANGES, range)) start = shift(end, 1 - RANGES[range]);
  else if (range === 'all') start = declared.start;
  else if (range === 'custom') {
    if (!validDate(custom?.start) || !validDate(custom?.end) || custom.start > custom.end) return emptyPeriod();
    start = custom.start;
    end = custom.end < end ? custom.end : end;
  } else return emptyPeriod();
  const count = daysBetween(start, end);
  if (!Number.isInteger(count) || count < 1 || count > MAX_DAYS) return emptyPeriod();
  const rows = calendarRows(indexed, start, end);
  const previousEnd = shift(start, -1);
  const previousRows = calendarRows(indexed, shift(start, -count), previousEnd);
  return {
    start, end, rows, previousRows,
    complete: rows.length === count && rows.every(row => row.available),
    previousComplete: previousRows.length === count && previousRows.every(row => row.available),
  };
}

function metricValue(row, key) {
  if (!row || row.available === false) return null;
  if (key === 'engagement') {
    const values = ['likes', 'comments', 'shares'].map(field => row[field]);
    if (!values.every(finite)) return null;
    const total = values.reduce((sum, value) => sum + value, 0);
    return finite(total) ? total : null;
  }
  return METRICS.includes(key) && finite(row[key]) ? row[key] : null;
}

function completeSum(rows, key, complete) {
  if (complete !== true || !Array.isArray(rows) || !rows.length) return null;
  const values = rows.map(row => metricValue(row, key));
  if (values.some(value => value === null)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return finite(total) ? total : null;
}

/** Sum daily native values only; never substitute a differently scoped total. */
export function summarizeMetric(period, key) {
  const value = completeSum(period?.rows, key, period?.complete);
  const previous = completeSum(period?.previousRows, key, period?.previousComplete);
  // Percentage growth from zero or a negative baseline is not reported.
  const change = value !== null && previous !== null && previous > 0
    ? ((value - previous) / previous) * 100 : null;
  return { value, previous, deltaPercent: finite(change) ? change : null, complete: value !== null };
}

/**
 * Chart points are {date,value}; null is a gap, including absent calendar dates.
 * Once a cumulative prefix has a gap its true running total remains unknown.
 */
export function chartSeries(rows, key, cumulative = false) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_DAYS * 2) return [];
  const indexed = indexRows(rows);
  const dates = [...indexed.keys()].sort();
  if (!dates.length) return [];
  let total = 0, complete = true;
  return calendarRows(indexed, dates[0], dates.at(-1)).map(row => {
    const value = metricValue(row, key);
    if (!cumulative) return { date: row.date, value };
    if (value === null) complete = false;
    if (complete) {
      total += value;
      if (!finite(total)) complete = false;
    }
    return { date: row.date, value: complete ? total : null };
  });
}
