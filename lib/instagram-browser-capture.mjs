import { validateInstagramStudioCapture, validateInstagramPostInsights, mergeInstagramStudioCaptures } from './instagram-studio.mjs';

const ORIGIN = 'https://www.instagram.com';
const PROFILE = `${ORIGIN}/scranpints/`;
export class InstagramBrowserCaptureError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new InstagramBrowserCaptureError(code); };
const fatal = error => ['instagram-login-required', 'instagram-challenge-required', 'instagram-account-mismatch'].includes(error?.code);
const epoch = value => typeof value === 'number' ? value : Date.parse(value instanceof Date ? value.toISOString() : value);
const normalize = value => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').replace(/(\d)\s*\.\s*(\d)/g, '$1.$2').replace(/\s+%/g, '%').trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Only rendered DOM text/links are inspected. No framework state, cookies,
// network interception or undocumented reporting endpoints are consulted.
async function readDom(page) {
  return page.evaluate(() => {
    const visible = element => element && element.getClientRects().length &&
      getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
    const sections = {}, headings = new Set(['Views', 'Interactions', 'Profile', 'Followers', 'Facebook', 'Ad']);
    const root = document.body;
    let section = null;
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches('h1,h2,h3,h4,h5,h6,[role="heading"]') && visible(node)) {
            const label = node.innerText?.trim();
            if (headings.has(label)) { section = label; (sections[section] ||= []); }
          }
        } else if (section && visible(node.parentElement) && !node.parentElement.closest('script,style,noscript,[hidden],[aria-hidden="true"]')) {
          const text = node.textContent.trim();
          if (text) sections[section].push(text);
        }
      }
    }
    return {
      url: location.href, body: root?.innerText || '',
      sections: Object.fromEntries(Object.entries(sections).map(([key, values]) => [key, values.join(' ')])),
      links: [...document.querySelectorAll('a[href]')].filter(visible).map(a => ({ text: a.innerText?.trim() || a.getAttribute('aria-label') || '', href: a.href })),
      selectedWeekdays: [...document.querySelectorAll('button[aria-pressed="true"],button[aria-selected="true"],[role="button"][aria-pressed="true"]')]
        .filter(visible).map(button => button.innerText?.trim()),
      dialogs: [...document.querySelectorAll('[role="dialog"],dialog')].filter(visible).map(dialog => ({
        headings: [...dialog.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map(h => h.innerText?.trim()),
        links: [...dialog.querySelectorAll('a[href]')].filter(visible).map(a => a.href),
      })),
    };
  });
}

function checkSession(view) {
  let url;
  try { url = new URL(view.url); } catch { fail('instagram-unexpected-page'); }
  if (url.origin !== ORIGIN) fail('instagram-unexpected-page');
  if (/\/(?:challenge|checkpoint)(?:\/|$)/.test(url.pathname) ||
      /(?:confirm (?:that )?it.s you|enter (?:the |your )?(?:security|confirmation) code|suspicious login attempt)/i.test(view.body)) fail('instagram-challenge-required');
  if (/\/accounts\/(?:login|onetap)(?:\/|$)/.test(url.pathname) ||
      /(?:log in to instagram|log into instagram)/i.test(view.body) ||
      /\bLog in\b/i.test(view.body) && /\bSign up\b/i.test(view.body)) fail('instagram-login-required');
  return url;
}

function clock(now, deadline) {
  const current = epoch(now());
  if (!Number.isFinite(current)) fail('instagram-invalid-input');
  if (current >= deadline) fail('instagram-deadline');
  return current;
}

async function navigate(page, url, { now, deadline }, ready) {
  const remaining = deadline - clock(now, deadline);
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(20_000, remaining) }); }
  catch { fail(epoch(now()) >= deadline ? 'instagram-deadline' : 'instagram-navigation-failed'); }
  const stop = Math.min(deadline, epoch(now()) + 12_000);
  // Bound by both time and attempts so injected/test clocks cannot loop forever.
  for (let attempt = 0; attempt < 25; attempt++) {
    clock(now, deadline);
    let view;
    try { view = await readDom(page); } catch { fail('instagram-page-unavailable'); }
    checkSession(view);
    if (ready(view)) return view;
    if (epoch(now()) >= stop) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(400, Math.max(0, stop - epoch(now())))));
  }
  fail('instagram-page-unavailable');
}

function ownProfile(view) {
  const url = checkSession(view);
  const link = (label, path) => view.links?.some(item => {
    try { const target = new URL(item.href); return target.origin === ORIGIN && target.pathname === path && label.test(normalize(item.text)); }
    catch { return false; }
  });
  return url.pathname === '/scranpints/' &&
    link(/^edit profile$/i, '/accounts/edit/') && link(/^view archive$/i, '/archive/stories/') &&
    link(/^(?:scranpints|scranpints.s profile picture)$/i, '/scranpints/');
}

export async function verifyInstagramBrowserAccount(page, { now = () => Date.now(), deadline = epoch(now()) + 30_000 } = {}) {
  const context = { now, deadline: epoch(deadline) };
  const view = await navigate(page, PROFILE, context, value => ownProfile(value) || /\bFollow(?:ing)?\b/.test(value.body));
  if (!ownProfile(view)) fail('instagram-account-mismatch');
  return { accountUsername: 'scranpints' };
}

/** Observed candidates only; scrolling never establishes a complete inventory. */
export async function discoverInstagramCollaborationCandidates(page, {
  now = () => Date.now(), deadline = epoch(now()) + 15_000,
} = {}) {
  const stop = epoch(deadline);
  if (!Number.isFinite(stop)) fail('instagram-invalid-input');
  clock(now, stop);
  const candidates = new Map();
  let previousLinks = null, stable = 0;
  for (let scrolls = 0; scrolls <= 8; scrolls++) {
    let view;
    try { view = await readDom(page); } catch { fail('instagram-page-unavailable'); }
    if (!ownProfile(view)) fail('instagram-account-mismatch');
    const postLinks = new Set();
    for (const item of view.links || []) {
      let url; try { url = new URL(item.href); } catch { continue; }
      if (url.origin !== ORIGIN || url.search || url.hash) continue;
      // Compare every rendered profile post link, so newly loaded own-account
      // posts do not falsely make the FootyScran subset look stable.
      if (/^\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel)\/[A-Za-z0-9_-]{1,64}\/?$/.test(url.pathname)) postLinks.add(url.pathname.replace(/\/$/, ''));
      const match = /^\/footyscran\/reel\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
      if (match) candidates.set(match[1], {
        shortcode: match[1], url: `${ORIGIN}/footyscran/reel/${match[1]}/`, status: 'unverified',
      });
    }
    const signature = JSON.stringify([...postLinks].sort());
    stable = signature === previousLinks ? stable + 1 : 0;
    previousLinks = signature;
    const remaining = stop - epoch(now());
    if (stable >= 2 || scrolls === 8 || remaining <= 0 || candidates.size >= 500) break;
    try {
      await page.evaluate(async waitMs => {
        // Normal scrolling of the already verified profile only. No links,
        // recommendations, hidden data or provider endpoints are followed here.
        if (location.origin !== 'https://www.instagram.com' || location.pathname !== '/scranpints/') return;
        window.scrollTo(0, Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight));
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }, Math.min(500, remaining));
    } catch { fail('instagram-page-unavailable'); }
    if (epoch(now()) >= stop) break;
  }
  return [...candidates.values()].slice(0, 500);
}

function mediaIdFromShortcode(shortcode) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let value = 0n;
  for (const character of shortcode) value = value * 64n + BigInt(alphabet.indexOf(character));
  const result = value.toString();
  if (!/^[1-9]\d{0,29}$/.test(result)) fail('instagram-invalid-candidate');
  return result;
}

async function verifyCandidate(page, candidate, context, capturedAt) {
  const view = await navigate(page, candidate.url, context, value =>
    value.links?.some(link => /^\d+ others$/i.test(normalize(link.text))));
  const url = checkSession(view);
  if (!new RegExp(`/(?:p|reel)/${escape(candidate.shortcode)}/?$`).test(url.pathname)) fail('instagram-media-mismatch');
  const trigger = page.getByRole('link', { name: /^\d+ others$/i });
  if (await trigger.count() !== 1) fail('instagram-collaboration-unverified');
  await trigger.click({ timeout: Math.min(5000, context.deadline - clock(context.now, context.deadline)) });
  let verified = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    clock(context.now, context.deadline);
    const opened = await readDom(page); checkSession(opened);
    const dialogs = (opened.dialogs || []).filter(dialog => dialog.headings?.includes('Collaborators'));
    verified = dialogs.length === 1 && ['/footyscran/', '/scranpints/'].every(path =>
      dialogs[0].links.some(href => { try { const link = new URL(href); return link.origin === ORIGIN && link.pathname === path; } catch { return false; } }));
    if (verified) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!verified) fail('instagram-collaboration-unverified');
  return { shortcode: candidate.shortcode, url: `${ORIGIN}/reel/${candidate.shortcode}/`,
    // A shortcode determines the route ID, but never proves co-authorship.
    // Only a verified Collaborators dialog permits trying this native UI route.
    mediaId: mediaIdFromShortcode(candidate.shortcode), title: null, publishedAt: null, capturedAt: capturedAt(),
    views: null, likes: null, comments: null, shares: null, saves: null,
    metricScope: 'post-lifetime', viewsPrecision: 'unavailable', relationship: 'collaboration' };
}

function numberAfter(text, label, required = false) {
  const matches = [...normalize(text).matchAll(new RegExp(`(?:^|\\s)${escape(label)}\\s+(--|[0-9][0-9,]*)(?=\\s|$)`, 'gi'))];
  if (matches.length > 1) fail('instagram-ambiguous-metric');
  const raw = matches[0]?.[1];
  if (!raw || raw === '--') { if (required) fail('instagram-metric-unavailable'); return null; }
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(raw)) fail('instagram-invalid-metric');
  const value = Number(raw.replaceAll(',', ''));
  if (!Number.isSafeInteger(value)) fail('instagram-invalid-metric');
  return value;
}

function audience(text) {
  const content = normalize(text).split(/By content (?:type|interactions)/i)[0];
  return ['Followers', 'Non-followers'].flatMap(label => {
    const matches = [...content.matchAll(new RegExp(`(?:^|\\s)${escape(label)}\\s+([0-9]+(?:\\.[0-9]+)?)%`, 'gi'))];
    if (matches.length > 1) fail('instagram-ambiguous-metric');
    if (!matches.length) return [];
    const percentage = Number(matches[0][1]);
    if (percentage > 100) fail('instagram-invalid-metric');
    return [{ label, percentage }];
  });
}

function contentTypes(text, heading) {
  const section = normalize(text).split(heading)[1]?.split('Top content')[0];
  if (!section) return [];
  const labels = [...section.matchAll(/\b(Reels|Stories|Posts)\b/g)].map(match => match[1]);
  const values = [...section.matchAll(/\b([0-9]+(?:\.[0-9]+)?)%/g)].map(match => Number(match[1]));
  if (!labels.length && !values.length) return [];
  if (labels.length !== values.length || new Set(labels).size !== labels.length || values.some(value => value > 100)) fail('instagram-invalid-breakdown');
  return labels.map((label, index) => ({ label, percentage: values[index] }));
}

function followerActivity(view) {
  const text = normalize(view.sections.Followers);
  const match = /12a\s+3a\s+6a\s+9a\s+12p\s+3p\s+6p\s+9p\s+([0-9,\s]+)\s+Followers\b/.exec(text);
  const values = match?.[1].trim().split(/\s+/) || [];
  const weekdays = { M: 'Monday', Tu: 'Tuesday', W: 'Wednesday', Th: 'Thursday', F: 'Friday', Sa: 'Saturday', Su: 'Sunday' };
  const selected = (view.selectedWeekdays || []).filter(value => Object.hasOwn(weekdays, value));
  return { weekday: selected.length === 1 ? weekdays[selected[0]] : null, timezone: null,
    hours: values.length === 8 ? values.map((value, index) => ({ hour: index * 3, followers: numberAfter(`Value ${value}`, 'Value', true) })) : [] };
}

function accountWindow(view, periodDays) {
  const url = checkSession(view), sections = view.sections || {};
  if (url.pathname !== '/accounts/insights/' || url.searchParams.get('timeframe') !== String(periodDays) ||
      !new RegExp(`\\bLast ${periodDays} days\\b`).test(view.body) || !/\bAccount insights\b/.test(view.body)) fail('instagram-window-mismatch');
  const views = sections.Views, interactions = sections.Interactions, profile = sections.Profile;
  return { window: { periodDays, label: `Last ${periodDays} days`, dateRange: { start: null, end: null, timezone: null },
    views: numberAfter(views, 'Views', true), instagramViews: numberAfter(views, 'Instagram', true),
    facebookViews: numberAfter(views, 'Facebook'), viewers: numberAfter(views, 'Viewers'),
    interactions: numberAfter(interactions, 'Interactions', true), accountsEngaged: numberAfter(interactions, 'Accounts engaged'),
    profileActivity: numberAfter(profile, 'Profile'), profileVisits: numberAfter(profile, 'Profile visits'),
    externalLinkTaps: numberAfter(profile, 'External link taps'),
    viewAudience: audience(views), interactionAudience: audience(interactions),
    viewContentTypes: contentTypes(views, 'By content type'), interactionContentTypes: contentTypes(interactions, 'By content interactions') },
    followers: numberAfter(sections.Followers, 'Followers', true), followerActivity: followerActivity(view) };
}

function postInsights(view, mediaId, capturedAt) {
  const url = checkSession(view);
  if (url.pathname !== `/insights/media/${mediaId}/`) fail('instagram-media-mismatch');
  const views = view.sections?.Views, interactions = view.sections?.Interactions;
  return validateInstagramPostInsights({ capturedAt, reportingWindow: 'not-shown', platformScope: 'unspecified', method: 'browser-sweep',
    views: numberAfter(views, 'Views', true), viewers: numberAfter(views, 'Viewers'),
    interactions: numberAfter(normalize(interactions).split(/\bReels interactions\b/i)[0], 'Interactions', true),
    ...Object.fromEntries(['likes', 'comments', 'saves', 'shares'].map(key => [key, numberAfter(interactions, key, false)])),
    accountsEngaged: numberAfter(interactions, 'Accounts engaged'), viewAudience: audience(views), interactionAudience: audience(interactions) });
}

export async function collectInstagramBrowserCapture({ page, previous, capturedAt, now = () => Date.now(), deadline } = {}) {
  let prior;
  try { prior = validateInstagramStudioCapture(previous); } catch { fail('instagram-invalid-input'); }
  const started = epoch(capturedAt ?? now()), current = epoch(now());
  const stop = deadline === undefined ? current + 240_000 : epoch(deadline);
  if (!page?.goto || !page?.evaluate || !Number.isFinite(started) || !Number.isFinite(stop) || started > current + 300_000 ||
      Date.parse(prior.capturedAt) > current + 300_000 || stop <= current || stop - current > 15 * 60_000) fail('instagram-invalid-input');
  const context = { now, deadline: stop }, observedAt = () => new Date(clock(now, stop)).toISOString();
  await verifyInstagramBrowserAccount(page, context);
  const errors = new Set();
  let candidates = [];
  try {
    candidates = (await discoverInstagramCollaborationCandidates(page, context)).filter(candidate =>
      !prior.collaborations?.posts.some(post => post.shortcode === candidate.shortcode));
  } catch (error) {
    if (fatal(error)) throw error;
    errors.add(error instanceof InstagramBrowserCaptureError ? error.code : 'instagram-page-unavailable');
  }
  let account = prior, accountStatus = 'retained';
  try {
    const windows = []; let latest;
    for (const period of [7, 30, 90]) {
      const view = await navigate(page, `${ORIGIN}/accounts/insights/?timeframe=${period}`, context,
        value => Boolean(value.sections?.Views && value.sections?.Interactions && value.sections?.Followers &&
          /Total followers/.test(value.body) && new RegExp(`\\bLast ${period} days\\b`).test(value.body)));
      latest = accountWindow(view, period); windows.push(latest.window);
    }
    account = validateInstagramStudioCapture({ ...prior, capturedAt: observedAt(), method: 'browser-sweep', windows,
      followers: latest.followers, followerActivity: latest.followerActivity });
    accountStatus = 'collected';
  } catch (error) {
    if (fatal(error)) throw error;
    errors.add(error instanceof InstagramBrowserCaptureError ? error.code : 'instagram-account-parse-failed');
  }
  const explicitIds = new Set((previous.collaborations?.posts || [])
    .filter(post => post.relationship === 'collaboration' && post.mediaId).map(post => post.mediaId));
  const existingTargets = (prior.collaborations?.posts || []).filter(post => explicitIds.has(post.mediaId));
  const added = [], discovered = [];
  for (const candidate of candidates) {
    try {
      added.push(await verifyCandidate(page, candidate, context, observedAt));
      discovered.push({ ...candidate, status: 'accepted' });
    } catch (error) {
      if (fatal(error)) throw error;
      errors.add(error instanceof InstagramBrowserCaptureError ? error.code : 'instagram-collaboration-unverified');
      discovered.push(candidate);
      if (error?.code === 'instagram-deadline') break;
    }
  }
  const targets = [...existingTargets, ...added];
  let collected = 0;
  const refreshed = new Map();
  for (const post of targets) {
    try {
      const view = await navigate(page, `${ORIGIN}/insights/media/${post.mediaId}/`, context,
        value => Boolean(value.sections?.Views && value.sections?.Interactions && /Accounts engaged/.test(value.body)));
      const insights = postInsights(view, post.mediaId, observedAt());
      if (post.insights && Date.parse(insights.capturedAt) < Date.parse(post.insights.capturedAt)) fail('instagram-stale-observation');
      refreshed.set(post.shortcode, { ...post, insights }); collected++;
    } catch (error) {
      if (fatal(error)) throw error;
      errors.add(error instanceof InstagramBrowserCaptureError ? error.code : 'instagram-post-parse-failed');
      if (error?.code === 'instagram-deadline') break;
    }
  }
  let capture = account;
  if (collected || added.length) {
    const posts = [...(prior.collaborations?.posts || []), ...added].map(post => refreshed.get(post.shortcode) || post);
    const latest = posts.flatMap(post => [post.capturedAt, post.insights?.capturedAt]).filter(Boolean)
      .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    capture = mergeInstagramStudioCaptures(prior, { ...account,
      collaborations: { accountUsername: 'footyscran', coverage: 'observed-profile-collabs', ...prior.collaborations, capturedAt: latest, posts } });
  }
  const unavailable = added.filter(post => !refreshed.has(post.shortcode)).length;
  return { capture: validateInstagramStudioCapture(capture), accountStatus,
    posts: { collected, retained: existingTargets.filter(post => !refreshed.has(post.shortcode)).length,
      unavailable, total: targets.length }, errors: [...errors], discovered };
}
