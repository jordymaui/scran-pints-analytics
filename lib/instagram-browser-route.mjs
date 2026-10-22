import { waitUntil } from '@vercel/functions';
import { authConfig, authorizeRequest, sameOriginPost, json, privateHeaders } from './auth.mjs';
import { createCloudStore } from './cloud-store.mjs';
import { instagramBrowserStatus, configureInstagramBrowser, startInstagramBrowserLogin } from './instagram-browser-sync.mjs';

async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers?.['content-type'] || '') || Number(req.headers?.['content-length']) > 8192) throw Error();
  let raw = req.body;
  if (raw === undefined) {
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += Buffer.byteLength(chunk); if (length > 8192) throw Error(); chunks.push(Buffer.from(chunk)); }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string') { if (raw.length > 8192) throw Error(); raw = JSON.parse(raw); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['action', 'apiKey', 'projectId'].includes(key))) throw Error();
  if (!['configure', 'start'].includes(raw.action) || raw.action === 'start' && Object.keys(raw).length !== 1) throw Error();
  return raw;
}
export function createInstagramBrowserHandler({ env = process.env, authorize = authorizeRequest,
  storeFactory = createCloudStore, background = waitUntil, configure = configureInstagramBrowser,
  start = startInstagramBrowserLogin } = {}) {
  return async (req, res) => {
    privateHeaders(res);
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method_not_allowed' }); }
    try {
      const query = new URL(req.url, 'https://internal.invalid').searchParams;
      if ([...query].some(([key, value]) => key !== 'browser' || value !== '1') || query.getAll('browser').length > 1) return json(res, 400, { error: 'unexpected_parameters' });
      const config = authConfig(env);
      if (req.method === 'POST') sameOriginPost(req, config);
      if (!await authorize(req, res, { config })) return;
      const store = storeFactory({ env });
      if (req.method === 'GET') return json(res, 200, instagramBrowserStatus(await store.getConnection('instagram')));
      let input; try { input = await body(req); } catch { return json(res, 400, { error: 'invalid_browser_request' }); }
      const result = input.action === 'configure' ? await configure({ store, apiKey: input.apiKey, projectId: input.projectId })
        : await start({ store, background });
      return json(res, result.state === 'busy' ? 409 : 200, result);
    } catch (error) {
      const code = ['quota', 'not-configured', 'provider-unavailable', 'login-required', 'origin_not_allowed'].includes(error?.code) ? error.code : 'browser_unavailable';
      return json(res, error?.status === 403 ? 403 : 503, { error: code });
    }
  };
}
export default createInstagramBrowserHandler();
