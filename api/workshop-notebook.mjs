import { authorizeRequest, authConfig, sameOriginPost, json } from '../lib/auth.mjs';
import { createCloudStore } from '../lib/cloud-store.mjs';
import { validateNotebook } from '../lib/workshop-model.mjs';

const MAX_BODY = 2_000_000;
async function readBody(req) {
  if (Number(req.headers?.['content-length']) > MAX_BODY) throw Object.assign(Error(), { status: 413 });
  if (!/^application\/json(?:;|$)/i.test(req.headers?.['content-type'] || '')) throw Object.assign(Error(), { status: 415 });
  let raw = req.body;
  if (raw === undefined) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += Buffer.byteLength(chunk);
      if (length > MAX_BODY) throw Object.assign(Error(), { status: 413 });
      chunks.push(Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw !== 'string') raw = JSON.stringify(raw);
  if (Buffer.byteLength(raw) > MAX_BODY) throw Object.assign(Error(), { status: 413 });
  return JSON.parse(raw);
}

export function createNotebookHandler({
  authorize = authorizeRequest, storeFactory = createCloudStore, getAuthConfig = authConfig,
} = {}) {
  return async function handler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return json(res, 405, { error: 'method_not_allowed' });
    }
    const user = await authorize(req, res);
    if (!user) return;
    try {
      if (req.method === 'GET') return json(res, 200, await storeFactory().getNotebook());
      sameOriginPost(req, getAuthConfig());
      let input;
      try {
        input = await readBody(req);
        if (!input || Object.keys(input).some(key => !['drafts', 'expectedVersion'].includes(key)) ||
            !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw Error();
        input.drafts = validateNotebook({ schema: 'scran-workshop-notebook-v1', entries: input.drafts });
      } catch (error) { return json(res, [413, 415].includes(error.status) ? error.status : 400, { error: 'invalid_notebook' }); }
      const saved = await storeFactory().saveNotebook({ ...input, updatedBy: user.id });
      return json(res, 200, saved);
    } catch (error) {
      if (error.code === 'version-conflict') return json(res, 409, { error: 'notebook_version_conflict' });
      if (error.status === 403) return json(res, 403, { error: 'origin_not_allowed' });
      return json(res, 503, { error: error.code === 'not-configured' ? 'storage_not_configured' : 'notebook_unavailable' });
    }
  };
}

export default createNotebookHandler();
