// Server-only Browserbase adapter. Returned identifiers and live URLs are private.
// API contract: https://docs.browserbase.com/reference/api/create-a-session
const API = 'https://api.browserbase.com/v1';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MESSAGES = {
  'not-configured': 'The cloud browser is not configured.',
  'provider-unavailable': 'The cloud browser is temporarily unavailable.',
  quota: 'The cloud browser allowance or concurrency limit has been reached.',
  'login-required': 'The Instagram owner needs to reconnect the cloud browser.'
};

export class CloudBrowserError extends Error {
  constructor(code = 'provider-unavailable') {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'provider-unavailable';
    super(MESSAGES[safeCode]);
    this.name = 'CloudBrowserError';
    this.code = safeCode;
  }
}

function unavailable() { return new CloudBrowserError('provider-unavailable'); }
function providerURL(value, live = false) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw unavailable();
  let url;
  try { url = new URL(value); } catch { throw unavailable(); }
  // Only provider-owned hosts; reject suffix tricks, userinfo and alternate ports.
  const host = url.hostname;
  const owned = host === 'browserbase.com' || /^(?:[a-z0-9-]+\.)+browserbase\.com$/.test(host);
  if (!owned || url.username || url.password || url.port || url.hash ||
      !(live ? url.protocol === 'https:' : ['wss:', 'https:'].includes(url.protocol))) throw unavailable();
  return url.href;
}

async function bounded(operation, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), milliseconds); })
    ]);
  } finally { clearTimeout(timer); }
}

async function defaultConnect(url, options) {
  const { chromium } = await import('playwright-core');
  return chromium.connectOverCDP(url, options);
}

/** Caller must hold its account lease until close() and never expose this object publicly. */
export async function createInstagramCloudBrowser({
  apiKey, projectId, contextId, timeoutSeconds = 240,
  fetchImpl = fetch, connectImpl = defaultConnect
} = {}) {
  if (typeof apiKey !== 'string' || !/^[!-~]{1,4096}$/.test(apiKey) ||
      (projectId != null && (typeof projectId !== 'string' || !ID.test(projectId))) ||
      (contextId != null && (typeof contextId !== 'string' || !ID.test(contextId))) ||
      !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 240 ||
      typeof fetchImpl !== 'function' || typeof connectImpl !== 'function') {
    throw new CloudBrowserError('not-configured');
  }
  const request = async (path, body, release = false) => {
    try {
      return await bounded(async () => {
        const response = await fetchImpl(`${API}${path}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15000)
        });
        if (release && [404, 410].includes(response.status)) return null;
        if (!response.ok) {
          throw new CloudBrowserError([402, 429].includes(response.status) ? 'quota' :
            [401, 403].includes(response.status) ? 'not-configured' : 'provider-unavailable');
        }
        if (release) return null;
        const raw = await response.text();
        if (raw.length > 65536) throw unavailable();
        const result = JSON.parse(raw);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw unavailable();
        return result;
      });
    } catch (error) {
      throw error instanceof CloudBrowserError ? error : unavailable();
    }
  };
  let browser, sessionId, closePromise;
  // Release and disconnect are both attempted. Persistence is finalized by Browserbase
  // asynchronously after session closure; callers must not immediately reuse the Context.
  const close = () => closePromise ||= (async () => {
    let failed = false;
    if (sessionId) {
      try { await request(`/sessions/${sessionId}`, { status: 'REQUEST_RELEASE' }, true); }
      catch { failed = true; }
    }
    if (browser) {
      try { await bounded(() => browser.close(), 10000); }
      catch { failed = true; }
    }
    if (failed) throw unavailable();
  })();
  try {
    const project = projectId == null ? {} : { projectId };
    if (contextId == null) {
      const created = await request('/contexts', project);
      if (typeof created.id !== 'string' || !ID.test(created.id)) throw unavailable();
      contextId = created.id;
    }
    const startedAt = Date.now();
    const session = await request('/sessions', {
      ...project, timeout: timeoutSeconds, keepAlive: false, proxies: false,
      browserSettings: {
        context: { id: contextId, persist: true },
        solveCaptchas: false, recordSession: false, logSession: false,
        advancedStealth: false, ignoreCertificateErrors: false
      }
    });
    if (typeof session.id !== 'string' || !ID.test(session.id)) throw unavailable();
    sessionId = session.id;
    const expiry = typeof session.expiresAt === 'string' ? Date.parse(session.expiresAt) : NaN;
    if (!['RUNNING', 'PENDING'].includes(session.status) || !Number.isFinite(expiry) ||
        expiry <= Date.now() || expiry > startedAt + (timeoutSeconds + 60) * 1000 ||
        (session.contextId != null && session.contextId !== contextId)) throw unavailable();
    const connectUrl = providerURL(session.connectUrl);
    browser = await connectImpl(connectUrl, { timeout: 15000 });
    const context = browser.contexts()[0];
    if (!context) throw unavailable();
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    if (page.url() !== 'about:blank') await page.goto('about:blank', { timeout: 10000 });
    const debug = await request(`/sessions/${sessionId}/debug`);
    const liveViewUrl = providerURL(debug.debuggerFullscreenUrl, true);
    return { page, contextId, sessionId, liveViewUrl, expiresAt: new Date(expiry).toISOString(), close };
  } catch (error) {
    try { await close(); } catch { /* Preserve the original sanitized failure. */ }
    throw error instanceof CloudBrowserError ? error : unavailable();
  }
}
