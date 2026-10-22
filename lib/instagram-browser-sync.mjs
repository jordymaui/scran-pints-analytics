// Server-only orchestration. Login credentials remain inside the hosted browser.
import { randomUUID } from 'node:crypto';
import { createInstagramCloudBrowser, CloudBrowserError } from './instagram-browser-provider.mjs';
import { collectInstagramBrowserCapture, verifyInstagramBrowserAccount } from './instagram-browser-capture.mjs';
import { validateInstagramStudioCapture } from './instagram-studio.mjs';
import { validateSocialImport } from './social-schema.mjs';

const states = new Set(['configured', 'connecting', 'ready', 'login-required', 'failed']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
export function instagramBrowserStatus(connection, now = Date.now()) {
  const credentials = connection?.credentials, browser = credentials?.browser;
  const configured = credentials?.reportingMode === 'browser-sweep' && browser?.provider === 'browserbase' && typeof browser.apiKey === 'string' && !!browser.apiKey;
  let state = configured && states.has(browser.state) ? browser.state : 'not-configured';
  if (state === 'connecting' && Date.parse(browser.setupExpiresAt || '') <= now) state = 'login-required';
  return { configured, connected: state === 'ready', state,
    verifiedAt: iso(browser?.verifiedAt), lastScanAt: iso(browser?.lastScanAt),
    ...(state === 'connecting' ? { sessionExpiresAt: iso(browser.setupExpiresAt) } : {}) };
}
async function saveBrowser(store, connection, browser) {
  await store.setConnection('instagram', { ...connection?.credentials, reportingMode: 'browser-sweep', browser },
    { accountId: connection?.accountId || null, scopes: connection?.scopes || [] });
}
export async function configureInstagramBrowser({ store, apiKey, projectId }) {
  if (typeof apiKey !== 'string' || !/^[!-~]{1,4096}$/.test(apiKey) ||
      projectId != null && (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId))) throw new CloudBrowserError('not-configured');
  const owner = randomUUID();
  if (!await store.acquireSyncLock('instagram', { owner, expiresAt: new Date(Date.now() + 60000).toISOString() })) return { state: 'busy' };
  try {
    const previous = await store.getConnection('instagram');
    await saveBrowser(store, previous, { provider: 'browserbase', apiKey, ...(projectId ? { projectId } : {}), state: 'configured' });
    return { configured: true, connected: false, state: 'configured' };
  } finally { await store.releaseSyncLock('instagram', owner); }
}

export async function startInstagramBrowserLogin({ store, background, createBrowser = createInstagramCloudBrowser,
  verifyAccount = verifyInstagramBrowserAccount, now = () => Date.now(), pause = sleep, fetchImpl = fetch } = {}) {
  let connection = await store.getConnection('instagram'), settings = connection?.credentials?.browser;
  if (!instagramBrowserStatus(connection, now()).configured) throw new CloudBrowserError('not-configured');
  if (settings.state === 'connecting' && Date.parse(settings.setupExpiresAt) > now() && settings.liveViewUrl) {
    return { state: 'connecting', liveViewUrl: settings.liveViewUrl, expiresAt: settings.setupExpiresAt };
  }
  const owner = randomUUID();
  if (!await store.acquireSyncLock('instagram', { owner, expiresAt: new Date(now() + 300000).toISOString() })) return { state: 'busy' };
  let browser;
  try {
    connection = await store.getConnection('instagram');
    settings = connection?.credentials?.browser;
    if (!instagramBrowserStatus(connection, now()).configured) throw new CloudBrowserError('not-configured');
    browser = await createBrowser({ ...settings, timeoutSeconds: 240, fetchImpl });
    await browser.page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const expiresAt = new Date(Math.min(Date.parse(browser.expiresAt), now() + 220000)).toISOString();
    const pending = { ...settings, contextId: browser.contextId, state: 'connecting', setupRunId: owner,
      setupExpiresAt: expiresAt, liveViewUrl: browser.liveViewUrl };
    await saveBrowser(store, connection, pending);
    const task = (async () => {
      let verified = false;
      try {
        for (let attempts = 0; attempts < 110 && now() < Date.parse(expiresAt); attempts++) {
          // Wait while the owner signs in normally. Never type passwords, solve
          // challenges or inspect cookies. Navigation begins only after login.
          let loggedIn = false;
          try { loggedIn = await browser.page.evaluate(() => {
            const login = /\/(?:accounts\/(?:login|onetap)|challenge|checkpoint)(?:\/|$)/.test(location.pathname);
            return !login && !!document.querySelector('a[href="/scranpints/"],a[href="/accounts/edit/"]');
          }); } catch { /* Login redirects can replace the document mid-check. */ }
          if (loggedIn) {
            await verifyAccount(browser.page, { now, deadline: Date.parse(expiresAt) });
            verified = true; break;
          }
          await pause(2000);
        }
      } catch { /* A failed identity check never creates a ready connection. */ }
      finally {
        try { await browser.close(); } catch { verified = false; }
        // Browserbase commits Context storage asynchronously after release.
        await pause(3000);
        try {
          const latest = await store.getConnection('instagram');
          if (latest?.credentials?.browser?.setupRunId === owner) {
            const { liveViewUrl, setupRunId, setupExpiresAt, ...saved } = latest.credentials.browser;
            await saveBrowser(store, latest, { ...saved, state: verified ? 'ready' : 'login-required',
              ...(verified ? { verifiedAt: new Date(now()).toISOString() } : {}) });
          }
        } finally { try { await store.releaseSyncLock('instagram', owner); } catch { /* Lease expires. */ } }
      }
    })();
    background(task.catch(() => {}));
    return { state: 'connecting', liveViewUrl: browser.liveViewUrl, expiresAt };
  } catch (error) {
    try { await browser?.close(); } catch { /* Keep sanitized original error. */ }
    try { await store.releaseSyncLock('instagram', owner); } catch { /* Lease expires. */ }
    throw error instanceof CloudBrowserError ? error : new CloudBrowserError();
  }
}

/** Called only while syncCloudSource owns the Instagram account lease. */
export async function syncInstagramBrowser({ connection, store, startedAt, now = () => new Date().toISOString(),
  fetchImpl = fetch, createBrowser = createInstagramCloudBrowser, collect = collectInstagramBrowserCapture } = {}) {
  const settings = connection?.credentials?.browser;
  if (instagramBrowserStatus(connection).state !== 'ready' || !settings.contextId) throw new CloudBrowserError('login-required');
  const previous = await store.loadSnapshot('instagram');
  let prior;
  try {
    prior = validateInstagramStudioCapture(previous?.payload?.manualCapture);
    if (previous.payload.kind === 'instagram-native-capture') {
      if (Object.keys(previous.payload).some(key => !['schemaVersion', 'id', 'kind', 'capturedAt', 'manualCapture'].includes(key)) ||
          previous.payload.schemaVersion !== 1 || previous.payload.id !== 'instagram' ||
          Date.parse(previous.payload.capturedAt) !== Date.parse(prior.capturedAt) ||
          Date.parse(previous.capturedAt) !== Date.parse(prior.capturedAt)) throw Error();
    } else validateSocialImport({ schemaVersion: 1, sources: [previous.payload] });
  } catch { throw new CloudBrowserError('not-configured'); }
  let browser;
  try {
    browser = await createBrowser({ ...settings, timeoutSeconds: 240, fetchImpl });
    const result = await collect({ page: browser.page, previous: prior, capturedAt: startedAt, now,
      // Leave time within Vercel's function budget for validation, private saves,
      // provider release and the final audit, even if session creation was slow.
      deadline: Math.min(Date.parse(browser.expiresAt) - 45000, Date.parse(startedAt) + 205000) });
    if (result.accountStatus !== 'collected' && !result.posts.collected) throw new CloudBrowserError();
    const capture = validateInstagramStudioCapture(result.capture);
    const payload = previous.payload.kind === 'instagram-native-capture'
      ? { schemaVersion: 1, id: 'instagram', kind: 'instagram-native-capture', capturedAt: capture.capturedAt, manualCapture: capture }
      : { ...previous.payload, manualCapture: capture };
    const warningCount = result.errors.length + (result.accountStatus === 'retained' ? 1 : 0) + result.posts.retained + (result.posts.unavailable || 0);
    const saved = await store.saveSnapshot('instagram', payload, { capturedAt: previous.payload.kind === 'instagram-native-capture' ? capture.capturedAt : previous.capturedAt,
      status: warningCount ? 'partial' : 'ready' });
    if (saved?.saved === false) throw new CloudBrowserError();
    await saveBrowser(store, connection, { ...settings, lastScanAt: now() });
    return { capturedAt: capture.capturedAt, warningCount, components: {
      account: { status: result.accountStatus, capturedAt: capture.capturedAt },
      collabs: { collected: result.posts.collected, retained: result.posts.retained, total: result.posts.total, unavailable: result.posts.unavailable || 0 }
    } };
  } catch (error) {
    if (['instagram-login-required', 'instagram-challenge-required', 'instagram-account-mismatch', 'login-required'].includes(error?.code)) {
      await saveBrowser(store, connection, { ...settings, state: 'login-required' });
      throw new CloudBrowserError('login-required');
    }
    throw error instanceof CloudBrowserError ? error : new CloudBrowserError();
  } finally { try { await browser?.close(); } catch { /* Reports already validated; Context will be rechecked next scan. */ } }
}
