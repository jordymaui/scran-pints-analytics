import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPublicOutput, PUBLIC_OUTPUT } from './build.mjs';
import privateHandler from '../api/private.mjs';
import workshopData from '../api/workshop-data.mjs';
import login from '../api/auth/login.mjs';
import callback from '../api/auth/callback.mjs';
import logout from '../api/auth/logout.mjs';
import session from '../api/auth/session.mjs';
import report from '../api/report.mjs';
import connectionStatus from '../api/connection-status.mjs';
import workshopNotebook from '../api/workshop-notebook.mjs';
import youtubeConnection from '../api/connections/youtube.mjs';
import sync from '../api/sync.mjs';
import { json } from '../lib/auth.mjs';
import { PRIVATE_PAGES } from '../lib/private-files.mjs';

const apiRoutes = new Map([
  ['/api/private', privateHandler], ['/api/workshop-data', workshopData],
  ['/api/auth/login', login], ['/api/auth/callback', callback],
  ['/api/auth/logout', logout], ['/api/auth/session', session],
  ['/api/report', report], ['/api/connection-status', connectionStatus],
  ['/api/workshop-notebook', workshopNotebook], ['/api/connections/youtube', youtubeConnection],
  ['/api/sync', sync],
]);
export const PRIVATE_ROOT_FILES = new Set([
  ...PRIVATE_PAGES, 'data.json', 'image-index.json', 'image-assets.js',
  'app.js', 'labs.js', 'winners.js', 'leaderboard.js', 'menu.js',
  'style.css', 'mobile.css', 'labs.css', 'winners.css', 'leaderboard.css',
]);
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};

function pathnameFromRequest(raw) {
  const path = String(raw || '').split('?')[0];
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || /[%\\\u0000-\u001f?#:]/.test(decoded) ||
      decoded.split('/').some(part => part === '.' || part === '..')) return null;
  return decoded === '/' ? '/index.html' : decoded;
}
function queryFrom(url) {
  const query = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (!Object.hasOwn(query, key)) query[key] = value;
    else query[key] = [...(Array.isArray(query[key]) ? query[key] : [query[key]]), value];
  }
  return query;
}
async function publicFile(pathname) {
  const root = await realpath(PUBLIC_OUTPUT);
  const candidate = resolve(root, `.${pathname}`);
  const rel = relative(root, candidate);
  if (isAbsolute(rel) || rel.startsWith('..')) return null;
  try {
    const canonical = await realpath(candidate);
    const finalRelative = relative(root, canonical);
    if (isAbsolute(finalRelative) || finalRelative.startsWith('..') || !(await stat(canonical)).isFile()) return null;
    return canonical;
  } catch { return null; }
}

export function createAppServer() {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    try {
      const path = pathnameFromRequest(req.url);
      if (!path) return json(res, 404, { error: 'not_found' });
      const url = new URL(req.url, 'http://localhost');
      req.query = queryFrom(url);
      const handler = apiRoutes.get(path);
      if (handler) return await handler(req, res);
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        return json(res, 405, { error: 'method_not_allowed' });
      }
      // Mirror Vercel: only the public build is eligible for static serving.
      const file = await publicFile(path);
      if (file) {
        const contents = await readFile(file);
        res.statusCode = 200;
        res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
        res.setHeader('Content-Length', String(contents.byteLength));
        res.setHeader('Cache-Control', path === '/public-report.json' ? 'no-store' : 'public, max-age=0, must-revalidate');
        return res.end(req.method === 'HEAD' ? undefined : contents);
      }
      if (PRIVATE_ROOT_FILES.has(path.slice(1)) || path.startsWith('/assets/')) {
        req.query = { path: path.slice(1) };
        return await privateHandler(req, res);
      }
      return json(res, 404, { error: 'not_found' });
    } catch {
      if (!res.headersSent) return json(res, 500, { error: 'request_failed' });
      res.end();
    }
  });
}

export async function startServer({ port = Number(process.env.PORT || 5186), build = true } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  if (build) await buildPublicOutput();
  const server = createAppServer();
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const server = await startServer();
    console.log(`Scran & Pints: http://localhost:${server.address().port} (public output only; workshop requires Google sign-in)`);
  } catch (error) {
    console.error(`Server failed: ${error.message}`);
    process.exitCode = 1;
  }
}
