import test from 'node:test';
import assert from 'node:assert/strict';
import { collectInstagramBrowserCapture, verifyInstagramBrowserAccount, discoverInstagramCollaborationCandidates } from '../lib/instagram-browser-capture.mjs';
import { validateInstagramStudioCapture } from '../lib/instagram-studio.mjs';
import { instagramNativeFixture, instagramCollaborationFixture, instagramPostInsightsFixture } from './fixtures/instagram-native.mjs';

const ORIGIN = 'https://www.instagram.com';
const START = Date.parse('2026-01-17T12:00:00Z');
const ACCOUNT = `${ORIGIN}/scranpints/`;
const existingId = '1000000000000000101';
// Entirely synthetic rendered DOM snapshots. These retain native label order,
// including duplicated labels and a separate Facebook section, not real values.
function previous() {
  const capture = instagramNativeFixture();
  capture.collaborations = instagramCollaborationFixture();
  capture.collaborations.posts[0].insights = instagramPostInsightsFixture();
  return capture;
}
function profile(extra = []) {
  return { url: ACCOUNT, body: 'scranpints Edit Profile View archive', sections: {}, dialogs: [],
    links: [{ text: 'scranpints', href: ACCOUNT },
      { text: 'Edit Profile', href: `${ORIGIN}/accounts/edit/` },
      { text: 'View archive', href: `${ORIGIN}/archive/stories/` }, ...extra] };
}
function account(period, { zero = false, bad = false } = {}) {
  const amount = zero ? 0 : period * 100;
  const sections = {
    Views: `Views ${bad ? '1.2K' : amount + (zero ? 0 : 5)} Views Followers 20% Non-followers 80% Instagram ${amount} Facebook 0 Viewers ${zero ? 0 : 40} By content type All Followers Non-followers Reels Stories 90% 10% Followers Non-followers Top content based on views`,
    Interactions: `Interactions ${zero ? 0 : 30} Interactions Followers 10% Non-followers 90% Accounts engaged ${zero ? 0 : 20} By content interactions Reels Stories 80% 20% Followers and non-followers Top content based on interactions`,
    Profile: `Profile ${zero ? 0 : 12} Profile activity Profile visits ${zero ? 0 : 10} External link taps ${period === 7 ? '--' : zero ? 0 : 2}`,
    Followers: `Followers ${zero ? 0 : 50} Total followers Most active times M Tu W Th F Sa Su 12a 3a 6a 9a 12p 3p 6p 9p 1 2 3 4 5 6 7 8 Followers`,
  };
  return { url: `${ORIGIN}/accounts/insights/?timeframe=${period}`, body: `Account insights Last ${period} days ${Object.values(sections).join(' ')}`,
    sections, links: [], selectedWeekdays: ['Tu'] };
}
function post(id = existingId, { zero = false, bad = false, splitPercentage = false } = {}) {
  const sections = {
    Views: `Views Views ${bad ? 'unknown' : zero ? '0' : '1,500'} Followers ${splitPercentage ? '0 . 9 %' : '10%'} Non-followers ${splitPercentage ? '99 . 1 %' : '90%'} Viewers ${zero ? 0 : 1000}`,
    Interactions: `Interactions Interactions ${zero ? 0 : 45} Followers 20% Non-followers 80% Reels interactions 0 Likes ${zero ? 0 : 21} Comments ${zero ? 0 : 4} Saves ${zero ? 0 : 5} Shares 0 Accounts engaged ${zero ? 0 : 35}`,
    Profile: 'Profile Profile activity -- Follows', Facebook: 'Facebook Views 999,999 Reactions 9 Comments 9',
  };
  return { url: `${ORIGIN}/insights/media/${id}/`, body: `888 777 Like Comment ${Object.values(sections).join(' ')}`, sections, links: [] };
}
function setup({ badPeriod, badPost = false, zero = false, wrongAccount = false, challenge = false,
  candidate = false, accepted = true, candidateMissing = false, splitPercentage = false } = {}) {
  let url, modal = false, milliseconds = START;
  const calls = [];
  const candidateUrl = `${ORIGIN}/footyscran/reel/SyntheticNew/`;
  const candidateId = [...'SyntheticNew'].reduce((value, char) => value * 64n + BigInt('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(char)), 0n).toString();
  const page = {
    async goto(value, options) { calls.push(value); url = value; modal = false; assert.equal(options.waitUntil, 'domcontentloaded'); },
    async evaluate() {
      if (challenge) return { url: `${ORIGIN}/challenge/`, body: 'Enter security code', links: [], sections: {} };
      if (url === ACCOUNT) return wrongAccount ? { ...profile(), body: 'scranpints Follow Message', links: [{ text: 'scranpints', href: ACCOUNT }] }
        : profile(candidate ? [{ text: 'New synthetic Reel', href: candidateUrl }] : []);
      if (url === candidateUrl) return { url, body: 'footyscran 2 others scranpints in caption', sections: {},
        links: [{ text: '2 others', href: `${url}#` }, { text: 'scranpints', href: ACCOUNT }],
        dialogs: modal ? [{ headings: ['Collaborators'], links: [`${ORIGIN}/footyscran/`, accepted ? ACCOUNT : `${ORIGIN}/unrelated/`] }] : [] };
      const period = new URL(url).searchParams.get('timeframe');
      if (period) return account(Number(period), { zero, bad: Number(period) === badPeriod });
      const id = /\/insights\/media\/(\d+)\//.exec(url)?.[1];
      return post(id, { zero, bad: id === candidateId ? candidateMissing : badPost, splitPercentage });
    },
    getByRole(role, options) {
      assert.equal(role, 'link'); assert.ok(options.name.test('2 others'));
      return { async count() { return 1; }, async click() { modal = true; } };
    },
  };
  return { page, calls, candidateId, now: () => { milliseconds += 20; return milliseconds; }, deadline: START + 120_000 };
}

test('browser sweep parses labelled sections and retains distinct scopes, dates and zero values', async () => {
  const initial = previous(), mock = setup({ splitPercentage: true });
  const result = await collectInstagramBrowserCapture({ ...mock, previous: initial, capturedAt: new Date(START).toISOString() });
  assert.equal(result.accountStatus, 'collected');
  assert.deepEqual(result.posts, { collected: 1, retained: 0, unavailable: 0, total: 1 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.capture.method, 'browser-sweep');
  assert.equal(result.capture.windows[0].views, 705);
  assert.equal(result.capture.windows[0].instagramViews, 700);
  assert.equal(result.capture.windows[0].facebookViews, 0);
  assert.equal(result.capture.windows[0].externalLinkTaps, null);
  assert.deepEqual(result.capture.windows[0].dateRange, { start: null, end: null, timezone: null });
  assert.equal(result.capture.followerActivity.weekday, 'Tuesday');
  assert.equal(result.capture.followerActivity.hours.length, 8);
  const updated = result.capture.collaborations.posts[0];
  assert.equal(updated.insights.method, 'browser-sweep');
  assert.equal(updated.insights.views, 1500); // Not reel action buttons or Facebook views.
  assert.equal(updated.insights.shares, 0);
  assert.equal(updated.insights.viewAudience[0].percentage, 0.9);
  assert.equal(updated.insights.platformScope, 'unspecified');
  assert.equal(updated.insights.reportingWindow, 'not-shown');
  assert.equal(updated.capturedAt, initial.collaborations.posts[0].capturedAt);
  assert.equal(updated.views, initial.collaborations.posts[0].views);
  assert.ok(Date.parse(updated.insights.capturedAt) > Date.parse(result.capture.capturedAt));
  assert.deepEqual(result.capture.collaborations.posts[1], initial.collaborations.posts[1]);
  assert.ok(mock.calls.every(value => !value.includes('Synthetic_B')));
  assert.doesNotMatch(JSON.stringify(result.capture), /999999|888|777/);
});

test('explicit zero metrics remain successful observations', async () => {
  const result = await collectInstagramBrowserCapture({ ...setup({ zero: true }), previous: previous() });
  assert.equal(result.accountStatus, 'collected');
  assert.equal(result.capture.followers, 0);
  assert.equal(result.capture.windows[0].views, 0);
  assert.equal(result.capture.collaborations.posts[0].insights.views, 0);
  assert.equal(result.posts.collected, 1);
});

test('one malformed account period retains the entire prior account block while collab insights can advance', async () => {
  const initial = previous();
  const result = await collectInstagramBrowserCapture({ ...setup({ badPeriod: 30 }), previous: initial });
  assert.equal(result.accountStatus, 'retained');
  for (const key of ['capturedAt', 'method', 'windows', 'followers', 'followerActivity', 'content']) assert.deepEqual(result.capture[key], initial[key]);
  assert.equal(result.posts.collected, 1);
  assert.ok(result.errors.includes('instagram-metric-unavailable'));
});

test('unreadable post metrics retain prior native insights without falsely updating their timestamps', async () => {
  const initial = previous();
  const result = await collectInstagramBrowserCapture({ ...setup({ badPost: true }), previous: initial });
  assert.equal(result.accountStatus, 'collected');
  assert.equal(result.posts.retained, 1);
  assert.deepEqual(result.capture.collaborations, initial.collaborations);
  assert.ok(result.errors.includes('instagram-metric-unavailable'));
});

test('wrong logged-in account and a challenge fail before any reporting pages are visited', async () => {
  for (const [options, code] of [[{ wrongAccount: true }, 'instagram-account-mismatch'], [{ challenge: true }, 'instagram-challenge-required']]) {
    const mock = setup(options);
    await assert.rejects(collectInstagramBrowserCapture({ ...mock, previous: previous() }), { code });
    assert.deepEqual(mock.calls, [ACCOUNT]);
  }
});

test('only a scoped Collaborators dialog accepts a discovered post, then its native route is collected', async () => {
  const mock = setup({ candidate: true });
  const result = await collectInstagramBrowserCapture({ ...mock, previous: previous() });
  const discovered = result.capture.collaborations.posts.find(row => row.shortcode === 'SyntheticNew');
  assert.equal(result.discovered[0].status, 'accepted');
  assert.equal(discovered.mediaId, mock.candidateId);
  assert.equal(discovered.relationship, 'collaboration');
  assert.equal(discovered.views, null);
  assert.equal(discovered.viewsPrecision, 'unavailable');
  assert.equal(discovered.insights.views, 1500);
  assert.equal(result.posts.collected, 2);
});

test('new verified collab with no readable native metrics remains explicitly unavailable', async () => {
  const result = await collectInstagramBrowserCapture({ ...setup({ candidate: true, candidateMissing: true }), previous: previous() });
  const discovered = result.capture.collaborations.posts.find(row => row.shortcode === 'SyntheticNew');
  assert.equal(discovered.views, null);
  assert.equal(discovered.insights, undefined);
  assert.equal(result.posts.unavailable, 1);
  assert.equal(result.posts.total, 2);
  assert.ok(result.errors.length);
});

test('a caption mention cannot substitute for verified popup membership', async () => {
  const result = await collectInstagramBrowserCapture({ ...setup({ candidate: true, accepted: false }), previous: previous() });
  assert.equal(result.discovered[0].status, 'unverified');
  assert.equal(result.capture.collaborations.posts.length, previous().collaborations.posts.length);
  assert.ok(result.errors.includes('instagram-collaboration-unverified'));
});

test('deadline stops collection with original dated observations retained', async () => {
  const mock = setup(); let reads = 0;
  const result = await collectInstagramBrowserCapture({ ...mock, previous: previous(),
    now: () => ++reads > 5 ? START + 120_000 : START });
  assert.equal(result.accountStatus, 'retained');
  assert.equal(result.posts.retained, 1);
  assert.deepEqual(result.capture, validateInstagramStudioCapture(previous()));
  assert.ok(result.errors.includes('instagram-deadline'));
});

test('browser provenance is strictly allowed without opening arbitrary methods or scopes', async () => {
  const capture = previous(); capture.method = 'browser-sweep'; capture.collaborations.posts[0].insights.method = 'browser-sweep';
  assert.equal(validateInstagramStudioCapture(capture).method, 'browser-sweep');
  capture.method = 'api'; assert.throws(() => validateInstagramStudioCapture(capture));
  const mock = setup({ wrongAccount: true });
  await assert.rejects(verifyInstagramBrowserAccount(mock.page, mock), { code: 'instagram-account-mismatch' });
});

test('legacy implicit relationships never become automatic native-insight targets', async () => {
  const capture = previous(); delete capture.collaborations.posts[0].relationship;
  const mock = setup();
  const result = await collectInstagramBrowserCapture({ ...mock, previous: capture });
  assert.equal(result.posts.total, 0);
  assert.ok(mock.calls.every(url => !url.includes('/insights/media/')));
  assert.deepEqual(result.capture.collaborations.posts[0].insights, capture.collaborations.posts[0].insights);
});

test('profile discovery gathers lazy-loaded candidates until two stable full post-link sets', async () => {
  let scrolls = 0;
  const link = (owner, shortcode) => ({ text: 'Synthetic post', href: `${ORIGIN}/${owner}/reel/${shortcode}/` });
  const stages = [
    [link('footyscran', 'SyntheticA')],
    [link('footyscran', 'SyntheticA'), link('scranpints', 'OwnB')],
    [link('footyscran', 'SyntheticA'), link('scranpints', 'OwnB'), link('scranpints', 'OwnC')],
    [link('footyscran', 'SyntheticA'), link('scranpints', 'OwnB'), link('scranpints', 'OwnC'), link('footyscran', 'SyntheticD')],
  ];
  const page = { async evaluate(_operation, waitMs) {
    if (typeof waitMs === 'number') { scrolls++; assert.ok(waitMs <= 500); return; }
    return profile(stages[Math.min(scrolls, stages.length - 1)]);
  } };
  const candidates = await discoverInstagramCollaborationCandidates(page, { now: () => START, deadline: START + 15_000 });
  assert.deepEqual(candidates.map(row => row.shortcode), ['SyntheticA', 'SyntheticD']);
  assert.ok(candidates.every(row => row.status === 'unverified'));
  assert.equal(scrolls, 5);
});

test('profile discovery caps scrolling at eight and preserves candidates from virtualized earlier renders', async () => {
  let scrolls = 0;
  const page = { async evaluate(_operation, waitMs) {
    if (typeof waitMs === 'number') { scrolls++; return; }
    return profile([{ text: 'Synthetic post', href: `${ORIGIN}/footyscran/reel/Synthetic_${scrolls}/` }]);
  } };
  const candidates = await discoverInstagramCollaborationCandidates(page, { now: () => START, deadline: START + 15_000 });
  assert.equal(scrolls, 8);
  assert.equal(candidates.length, 9);
  assert.equal(candidates[0].shortcode, 'Synthetic_0');
  assert.equal(candidates.at(-1).shortcode, 'Synthetic_8');
});

test('profile scrolling stops for login/challenge and never navigates away to discover posts', async () => {
  for (const [path, body, code] of [['/challenge/', 'Enter security code', 'instagram-challenge-required'],
    ['/accounts/login/', 'Log in to Instagram', 'instagram-login-required']]) {
    let scrolls = 0;
    const page = { async evaluate(_operation, waitMs) {
      if (typeof waitMs === 'number') { scrolls++; return; }
      return scrolls ? { url: `${ORIGIN}${path}`, body, sections: {}, links: [] } : profile();
    } };
    await assert.rejects(discoverInstagramCollaborationCandidates(page, { now: () => START, deadline: START + 15_000 }), { code });
    assert.equal(scrolls, 1);
  }
});

test('profile discovery respects remaining deadline without an unbounded pagination wait', async () => {
  let current = START, scrolls = 0;
  const page = { async evaluate(_operation, waitMs) {
    if (typeof waitMs === 'number') { scrolls++; current += waitMs; return; }
    return profile([{ text: 'Synthetic post', href: `${ORIGIN}/footyscran/reel/Synthetic_${scrolls}/` }]);
  } };
  const candidates = await discoverInstagramCollaborationCandidates(page, { now: () => current, deadline: START + 1100 });
  assert.equal(current, START + 1100);
  assert.equal(scrolls, 3);
  assert.equal(candidates.length, 3);
});
