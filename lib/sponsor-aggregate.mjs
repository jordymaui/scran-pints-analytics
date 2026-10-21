// Public reporting only. Platforms keep separate observations and populations.
export const ALL_SOCIAL_PLATFORMS = Object.freeze([
  { id: 'youtube-longform', label: 'YouTube', color: '#e30613' },
  { id: 'instagram', label: 'Instagram', color: '#8e5b8e' },
  { id: 'tiktok', label: 'TikTok', color: '#25211f' },
]);
const DAY = 86_400_000;
const finite = Number.isFinite;
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  finite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const move = (day, amount) => new Date(Date.parse(day) + amount * DAY).toISOString().slice(0, 10);
const sumKnown = values => values.some(finite) ? values.filter(finite).reduce((sum, value) => sum + value, 0) : null;
const engagementOf = row => row && ['likes', 'comments', 'shares'].every(key => finite(row[key]))
  ? row.likes + row.comments + row.shares : null;

function nativePerformance(source) {
  const studio = source?.id === 'tiktok' ? source.studioSupplement?.performance : null;
  const performance = studio || source?.performance ||
    (source?.daily?.length ? { daily: source.daily, dateRange: source.dateRange } : null);
  const window = studio?.seriesRanges?.overview || performance?.dateRange;
  if (!validDay(window?.start) || !validDay(window?.end) || window.start > window.end ||
      !Array.isArray(performance?.daily)) return null;
  const seen = new Set();
  const daily = [];
  for (const original of performance.daily) {
    const date = original.date || original.day;
    if (!validDay(date) || date < window.start || date > window.end || seen.has(date)) continue;
    seen.add(date);
    const row = { date, ...Object.fromEntries(['views', 'likes', 'comments', 'shares'].map(key =>
      [key, finite(original[key]) ? original[key] : null])) };
    row.engagement = engagementOf(row);
    daily.push(row);
  }
  if (!daily.some(row => finite(row.views))) return null;
  return { capturedAt: performance.capturedAt || source.capturedAt,
    dateRange: { start: window.start, end: window.end, timezone: window.timezone ?? window.timeZone ?? null },
    daily: daily.sort((a, b) => a.date.localeCompare(b.date)) };
}

function observedCounter(source, key) {
  if (finite(source?.metrics?.[key])) return source.metrics[key];
  // Public YouTube channel statistics omit likes/comments/shares. Its returned
  // public-video counters can supply only the fields actually present.
  if (!['likes', 'comments', 'shares'].includes(key)) return null;
  return sumKnown((source?.content || []).map(row => row[key]));
}

function uploadCount(source) {
  if (source?.provenance?.kind === 'manual-browser') return null;
  return finite(source?.metrics?.videoCount) ? source.metrics.videoCount
    : Array.isArray(source?.content) ? source.content.length : null;
}

function capturedPeriod(source, periodDays) {
  const capture = source?.manualCapture;
  const windows = capture?.windows;
  if (!Array.isArray(windows) || !windows.length) return null;
  const window = periodDays === null
    ? [...windows].sort((a, b) => b.periodDays - a.periodDays)[0]
    : windows.find(row => row.periodDays === periodDays);
  if (!window) return null;
  const platform = ALL_SOCIAL_PLATFORMS.find(row => row.id === source.id);
  if (!platform) return null;
  return { id: platform.id, label: platform.label, capturedAt: capture.capturedAt,
    periodDays: window.periodDays, periodLabel: window.label,
    // The native total can disagree with its Instagram-only breakdown. Keep
    // both observations, and use only the named platform in cross-platform sums.
    views: window.instagramViews, nativeTotalViews: window.views,
    interactions: window.interactions, viewers: window.viewers, accountsEngaged: window.accountsEngaged,
    followers: capture.followers, profileActivity: window.profileActivity,
    profileVisits: window.profileVisits, externalLinkTaps: window.externalLinkTaps,
    dateRange: { ...window.dateRange },
    distributions: { viewAudience: window.viewAudience, interactionAudience: window.interactionAudience,
      viewContentTypes: window.viewContentTypes, interactionContentTypes: window.interactionContentTypes },
    scopeNote: `${window.label} at capture. Exact reporting dates and timezone were not shown; no daily history was supplied. Not included in the aligned daily graph or growth comparison.` };
}

function reportedHistoryFor(platforms) {
  const rows = platforms.flatMap(platform => {
    if (platform.performance) return [{ id: platform.id, label: platform.label,
      views: sumKnown(platform.performance.daily.map(row => row.views)),
      engagement: sumKnown(platform.performance.daily.map(row => row.engagement)),
      scopeLabel: 'Available daily reporting history', dateRange: { ...platform.performance.dateRange },
      capturedAt: platform.performance.capturedAt, hasDaily: true }];
    const captured = capturedPeriod(platform.source, null);
    return captured ? [{ id: platform.id, label: platform.label, views: captured.views,
      engagement: captured.interactions, scopeLabel: `${captured.periodLabel} at capture · exact boundaries not shown`,
      dateRange: captured.dateRange, capturedAt: captured.capturedAt, hasDaily: false }] : [];
  });
  return { views: sumKnown(rows.map(row => row.views)), engagement: sumKnown(rows.map(row => row.engagement)),
    platforms: rows, includesMixedWindows: rows.some(row => !row.hasDaily) ||
      new Set(rows.map(row => JSON.stringify(row.dateRange))).size > 1,
    coverageNote: 'Adds each platform’s available native history once. Reporting windows differ; Instagram contributes its widest captured window, not a lifetime total. Actions use each platform’s definition; Instagram interactions can include saves and other actions. Views and follows are not deduplicated people.' };
}

function selectedSummaryFor(platforms, period, start, end) {
  const periodDays = period === '7d' ? 7 : 30;
  let partialDaily = false;
  const rows = platforms.flatMap(platform => {
    if (!platform.available) return [];
    if (platform.performance) {
      const daily = platform.performance.daily.filter(row => row.date >= start && row.date <= end);
      const complete = daily.length === periodDays && daily.every(row => finite(row.views) && finite(row.engagement));
      if (!complete) partialDaily = true;
      return [{ id: platform.id, label: platform.label,
        views: sumKnown(daily.map(row => row.views)),
        engagement: sumKnown(daily.map(row => row.engagement)),
        scopeLabel: `Selected ${periodDays}-day daily reporting window${complete ? '' : ' · partial metric coverage'}`,
        capturedAt: platform.performance.capturedAt ?? null,
        dateRange: { start, end, timezone: platform.performance.dateRange.timezone }, hasDaily: true }];
    }
    const captured = capturedPeriod(platform.source, periodDays);
    return captured ? [{ id: platform.id, label: platform.label,
      views: captured.views, engagement: captured.interactions,
      scopeLabel: `${captured.periodLabel} at capture · exact boundaries not shown`,
      capturedAt: captured.capturedAt, dateRange: captured.dateRange, hasDaily: false }] : [];
  });
  const partialMetrics = rows.some(row => !finite(row.views) || !finite(row.engagement));
  return { views: sumKnown(rows.map(row => row.views)), engagement: sumKnown(rows.map(row => row.engagement)),
    platforms: rows, includesMixedWindows: rows.some(row => !row.hasDaily) ||
      new Set(rows.map(row => JSON.stringify(row.dateRange))).size > 1,
    coverageNote: `Adds each platform’s available native report once for the nominal ${periodDays}-day selection. Reporting cutoffs and timezones can differ. Instagram’s captured interactions can include saves and other actions; daily engagement uses likes, comments and shares. The dated chart and its comparisons use only platforms with daily reports.${partialDaily || partialMetrics ? ' Some metrics or reporting days are unavailable; totals include reported contributions only.' : ''}` };
}

function compareWindow(series, start, end, key, sourceIds) {
  const size = Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
  const lookup = new Map(series.map(row => [row.date, row]));
  const total = first => {
    const rows = Array.from({ length: size }, (_, index) => lookup.get(move(first, index)));
    const values = rows.map(row => row?.[key] ?? null);
    const reported = rows.map(row => key === 'views' ? row?.reportedViews : row?.reportedEngagement);
    return { value: sumKnown(reported), days: values.filter(finite).length,
      complete: values.every(finite) && sourceIds.length > 0 };
  };
  const previousStart = move(start, -size), previousEnd = move(start, -1);
  const current = total(start), previous = total(previousStart);
  const complete = current.complete && previous.complete;
  const change = complete ? current.value - previous.value : null;
  return { current, previous, complete, change, percent: complete && previous.value !== 0
    ? change / Math.abs(previous.value) * 100 : null, start, end, previousStart, previousEnd };
}

function normalizedAge(label) {
  const age = String(label).replace(/^age/i, '').replace(/[–—]/g, '-').trim();
  if (/^(?:55-64|65(?:-|\+)?|65-?\+|55\+)$/.test(age)) return '55+';
  return ['13-17', '18-24', '25-34', '35-44', '45-54'].includes(age) ? age.replace('-', '–') : null;
}
function normalizedGender(label) {
  const value = String(label).toLowerCase();
  if (value === 'male' || value === 'm') return 'Male';
  if (value === 'female' || value === 'f') return 'Female';
  if (['other', 'unspecified', 'genderuserspecified', 'userspecified', 'u'].includes(value)) return 'Other / unspecified';
  return null;
}
function countryLabel(label) {
  if (/^[A-Za-z]{2}$/.test(label)) {
    try { return new Intl.DisplayNames(['en-GB'], { type: 'region' }).of(label.toUpperCase()); } catch { return label; }
  }
  return /^(?:others?|other countries)$/i.test(label) ? 'Other countries' : label;
}
function groupedPercentages(rows, labelOf) {
  const groups = new Map();
  for (const row of rows) {
    const label = labelOf(row.label);
    if (!label) continue;
    const previous = groups.get(label);
    if (finite(row.percentage)) {
      if (previous && previous.percentage === null) continue;
      groups.set(label, { label, percentage: (previous?.percentage || 0) + row.percentage, lessThan: null });
    } else if (finite(row.lessThan)) {
      // A threshold is not an exact observation. Never invent its midpoint.
      groups.set(label, { label, percentage: null, lessThan: previous ? null : row.lessThan });
    }
  }
  return [...groups.values()];
}

function nativeAudience(source) {
  if (source.id === 'youtube-longform') {
    const demo = source.audience?.demographics?.report;
    const country = source.audience?.country?.report;
    const age = groupedPercentages((demo?.rows || []).map(row =>
      ({ label: row.ageGroup, percentage: row.viewerPercentage })), normalizedAge);
    const gender = groupedPercentages((demo?.rows || []).map(row =>
      ({ label: row.gender, percentage: row.viewerPercentage })), normalizedGender);
    const denominator = sumKnown((country?.rows || []).map(row => row.views));
    const countries = denominator > 0 ? country.rows.filter(row => finite(row.views)).map(row =>
      ({ label: countryLabel(row.country), percentage: row.views / denominator * 100, lessThan: null })) : [];
    return { age, gender, country: countries, dateRange: demo?.dateRange || null,
      countryDateRange: country?.dateRange || null,
      countryUnit: 'Share of reported geographic views', demographicUnit: 'Reported logged-in viewers' };
  }
  const viewers = source.id === 'tiktok'
    ? source.studioSupplement?.audience?.find(entry => entry.population === 'viewers') : null;
  if (!viewers) return null; // Follower reports are not viewer reports.
  return { age: groupedPercentages(viewers.age || [], normalizedAge),
    gender: groupedPercentages(viewers.gender || [], normalizedGender),
    country: groupedPercentages(viewers.country || [], countryLabel),
    dateRange: viewers.dateRange, countryDateRange: viewers.dateRange,
    countryUnit: 'Reported viewers', demographicUnit: 'Reported viewers' };
}

function profileAverage(profiles, family, labels, adultsOnly = false) {
  const eligible = profiles.map(profile => {
    const rows = profile[family] || [];
    if (labels.some(label => !rows.some(row => row.label === label && finite(row.percentage)))) return null;
    const selected = labels.map(label => ({ ...rows.find(row => row.label === label) }));
    const denominator = selected.reduce((sum, row) => sum + row.percentage, 0);
    if (adultsOnly && denominator <= 0) return null;
    return { ...profile, rows: selected.map(row => ({ ...row,
      percentage: adultsOnly ? row.percentage / denominator * 100 : row.percentage })) };
  }).filter(Boolean);
  return { rows: labels.map(label => ({ label, percentage: eligible.length
    ? eligible.reduce((sum, profile) => sum + profile.rows.find(row => row.label === label).percentage, 0) / eligible.length : null,
    lessThan: null })), contributors: eligible.map(profile => profile.label),
    byPlatform: eligible.map(profile => ({ id: profile.id, label: profile.label,
      dateRange: profile.dateRange, rows: profile.rows })) };
}

export function combinedAudience(sources) {
  const profiles = sources.flatMap(source => {
    const audience = nativeAudience(source);
    const platform = ALL_SOCIAL_PLATFORMS.find(row => row.id === source.id);
    return audience && platform ? [{ ...platform, ...audience }] : [];
  });
  const age = profileAverage(profiles, 'age', ['18–24', '25–34', '35–44', '45–54', '55+'], true);
  const gender = profileAverage(profiles, 'gender', ['Male', 'Female', 'Other / unspecified']);
  const countries = new Map();
  for (const profile of profiles) for (const row of profile.country) {
    const values = countries.get(row.label) || [];
    values.push({ id: profile.id, label: profile.label, color: profile.color,
      percentage: row.percentage, lessThan: row.lessThan, unit: profile.countryUnit });
    countries.set(row.label, values);
  }
  const countryRows = [...countries].map(([label, values]) => ({ label, values }))
    .sort((a, b) => Math.max(...b.values.map(row => row.percentage ?? row.lessThan ?? 0)) -
      Math.max(...a.values.map(row => row.percentage ?? row.lessThan ?? 0)) || a.label.localeCompare(b.label));
  return { method: 'equal-platform-profile', label: 'Audience across channels',
    contributors: profiles.filter(profile => profile.age.length || profile.gender.length).map(profile => profile.label),
    note: 'Channel profiles use equal platform weights and each platform’s latest viewer report. Reporting periods differ. These are descriptive averages, not a combined count of unique people.',
    age: { ...age, method: 'equal-platform-adult-profile', label: 'Age · reported adults (18+)',
      note: 'Each platform’s reported adult age groups are normalised within ages 18+ before averaging equally. Under-18s are excluded; missing groups are not zeroes.' },
    gender: { ...gender, method: 'equal-platform-profile', label: 'Gender · channel average',
      note: 'Equal average of available native viewer profiles. Native rounding is retained. Other and unspecified categories are grouped.' },
    country: { method: 'platform-comparison', label: 'Top countries across channels', rows: countryRows,
      contributors: profiles.filter(profile => profile.country.length).map(profile => profile.label),
      byPlatform: profiles.filter(profile => profile.country.length).map(profile => ({ id: profile.id,
        label: profile.label, dateRange: profile.countryDateRange, unit: profile.countryUnit, rows: profile.country })),
      note: 'YouTube shows shares of reported geographic views; TikTok reports viewer percentages. These different measures are compared, not added.' } };
}

export function buildAllSocialAnalytics(report, period = '7d') {
  if (!['7d', '30d', 'all'].includes(period)) throw Error('Unsupported combined reporting period.');
  const platforms = ALL_SOCIAL_PLATFORMS.map(platform => {
    const source = report?.sources?.find(row => row.id === platform.id);
    const available = source?.status === 'snapshot' && Boolean(source.metrics || source.performance);
    const counters = available ? Object.fromEntries(['views', 'followers', 'likes', 'comments', 'shares']
      .map(key => [key, observedCounter(source, key)])) : {};
    const performance = available ? nativePerformance(source) : null;
    return { ...platform, available, source, performance, capturedAt: source?.capturedAt || null,
      views: counters.views ?? null, followers: counters.followers ?? null,
      uploads: available ? uploadCount(source) : null, engagement: available
        ? sumKnown(['likes', 'comments', 'shares'].map(key => counters[key])) : null,
      counters, periodViews: null, periodEngagement: null };
  });
  const reportedHistory = reportedHistoryFor(platforms);
  const manualPeriods = platforms.flatMap(platform => {
    const captured = capturedPeriod(platform.source, period === '7d' ? 7 : period === '30d' ? 30 : null);
    return captured ? [captured] : [];
  });
  const contributing = platforms.filter(platform => platform.performance);
  const sharedEnd = contributing.map(platform => platform.performance.dateRange.end).sort()[0] || null;
  const lastEnd = contributing.map(platform => platform.performance.dateRange.end).sort().at(-1) || null;
  const firstStart = contributing.map(platform => platform.performance.dateRange.start).sort()[0] || null;
  const size = period === '7d' ? 7 : period === '30d' ? 30 : null;
  const end = size ? sharedEnd : lastEnd;
  const start = end ? size ? move(end, 1 - size) : firstStart : null;
  const summary = period === 'all' ? reportedHistory : selectedSummaryFor(platforms, period, start, end);
  const sourceIds = contributing.map(platform => platform.id);
  const maps = new Map(contributing.map(platform => [platform.id,
    new Map(platform.performance.daily.map(row => [row.date, row]))]));
  const rangeStart = start && size ? move(start, -size) : start;
  const allRows = [];
  // Public reports are bounded. Never create an unbounded calendar from bad dates.
  if (rangeStart && end && (Date.parse(end) - Date.parse(rangeStart)) / DAY < 20000) {
    for (let date = rangeStart; date <= end; date = move(date, 1)) {
      const byPlatform = Object.fromEntries(contributing.map(platform => {
        const row = maps.get(platform.id).get(date);
        return [platform.id, { views: row?.views ?? null, engagement: row?.engagement ?? null }];
      }));
      const rows = Object.values(byPlatform), views = rows.map(row => row.views), engagements = rows.map(row => row.engagement);
      const completeViews = rows.length > 0 && views.every(finite);
      const completeEngagement = rows.length > 0 && engagements.every(finite);
      allRows.push({ date, byPlatform, views: completeViews ? sumKnown(views) : null,
        engagement: completeEngagement ? sumKnown(engagements) : null,
        reportedViews: sumKnown(views), reportedEngagement: sumKnown(engagements),
        completeViews, completeEngagement });
    }
  }
  const daily = allRows.filter(row => row.date >= start);
  const totals = { views: sumKnown(daily.map(row => row.reportedViews)),
    engagement: sumKnown(daily.map(row => row.reportedEngagement)) };
  const engagement = Object.fromEntries(['likes', 'comments', 'shares'].map(key => [key,
    sumKnown(contributing.flatMap(platform => platform.performance.daily
      .filter(row => row.date >= start && row.date <= end && finite(row.engagement)).map(row => row[key])))]));
  engagement.total = sumKnown(Object.values(engagement));
  for (const platform of platforms) {
    const rows = platform.performance?.daily.filter(row => row.date >= start && row.date <= end) || [];
    platform.periodViews = sumKnown(rows.map(row => row.views));
    platform.periodEngagement = sumKnown(rows.map(row => row.engagement));
    platform.periodComplete = rows.length > 0 && rows.length === daily.length && rows.every(row => finite(row.views));
    delete platform.source; delete platform.performance; delete platform.counters;
  }
  const availableSources = ALL_SOCIAL_PLATFORMS.map(platform => report?.sources?.find(source => source.id === platform.id))
    .filter(source => source?.status === 'snapshot');
  const missing = platforms.filter(platform => !platform.available).map(platform => platform.label);
  const noDaily = platforms.filter(platform => platform.available && !sourceIds.includes(platform.id)).map(platform => platform.label);
  const partialDays = daily.filter(row => !row.completeViews).length;
  return { period, headlines: {
    views: sumKnown(platforms.map(platform => platform.views)),
    followers: sumKnown(platforms.map(platform => platform.followers)),
    engagement: sumKnown(platforms.map(platform => platform.engagement)),
    uploads: sumKnown(platforms.map(platform => platform.uploads)) },
    platforms, manualPeriods, reportedHistory, summary, performance: { dateRange: { start, end }, daily, totals,
      partialDays, comparison: size && start && end ? {
        views: compareWindow(allRows, start, end, 'views', sourceIds),
        engagement: compareWindow(allRows, start, end, 'engagement', sourceIds),
      } : { views: null, engagement: null } }, engagement,
    audience: combinedAudience(availableSources), coverage: {
      included: platforms.filter(platform => platform.available).map(platform => platform.label),
      missing, noDaily, chartSources: contributing.map(platform => platform.label),
      counterSources: platforms.filter(platform => finite(platform.views)).map(platform => platform.label),
      uploadSources: platforms.filter(platform => finite(platform.uploads)).map(platform => platform.label),
      note: `${platforms.filter(platform => platform.available).map(platform => platform.label).join(' + ') || 'No accounts reported'}${missing.length ? ` · ${missing.join(', ')} awaiting data` : ''}. YouTube includes Shorts.`,
      counterNote: 'Public lifetime counters have their own capture dates. Account follows and views are not deduplicated people. Recorded engagement includes available likes, comments and shares; YouTube lifetime shares are unavailable.',
      engagementNote: 'Likes, comments and shares on days with complete interaction reports in the selected window. Missing fields remain unavailable.',
      chartNote: size ? `Daily reports are aligned through ${end || 'the latest common date'}. Native date labels are used; reporting timezones can differ.${partialDays ? ` ${partialDays} dates have partial coverage.` : ''}`
        : `All available reported history. Source histories and end dates differ.${partialDays ? ` ${partialDays} of ${daily.length} dates have partial platform coverage.` : ''} The dashed combined line adds reported values only. These activity totals are separate from current public lifetime counters.`,
    } };
}
