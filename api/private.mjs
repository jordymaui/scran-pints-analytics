import { readFile } from 'node:fs/promises';
import { authorizeRequest, json } from '../lib/auth.mjs';
import { resolvePrivateFile, privateContentType, PRIVATE_PAGES } from '../lib/private-files.mjs';

export default async function handler(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    return json(res, 405, { error: 'method_not_allowed' });
  }
  let requested;
  try {
    requested = req.query?.path ?? new URL(req.url, 'https://local.invalid').searchParams.get('path');
  } catch { return json(res, 404, { error: 'not_found' }); }
  if (typeof requested !== 'string') return json(res, 404, { error: 'not_found' });
  const html = PRIVATE_PAGES.has(requested.replace(/^\//, ''));
  if (!await authorizeRequest(req, res, { redirect: html })) return;
  try {
    const path = await resolvePrivateFile(requested);
    if (!path) return json(res, 404, { error: 'not_found' });
    const file = await readFile(path);
    res.statusCode = 200;
    res.setHeader('Content-Type', privateContentType(path));
    res.setHeader('Content-Length', String(file.byteLength));
    res.setHeader('X-Frame-Options', 'DENY');
    res.end(req.method === 'HEAD' ? undefined : file);
  } catch { json(res, 503, { error: 'private_file_unavailable' }); }
}
