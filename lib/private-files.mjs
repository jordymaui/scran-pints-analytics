import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute, extname } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export const PRIVATE_PAGES = new Set([
  'review-room.html', 'title-table.html', 'thumbnail-lab.html',
  'winners-losers.html', 'leaderboard.html',
]);
const fixedFiles = [
  ...PRIVATE_PAGES, 'data.json', 'image-index.json', 'image-assets.js',
  'app.js', 'labs.js', 'winners.js', 'leaderboard.js', 'menu.js',
  'style.css', 'mobile.css', 'labs.css', 'winners.css', 'leaderboard.css',
];
let manifest;

async function privateManifest() {
  if (!manifest) {
    manifest = (async () => {
      const allowed = new Set(fixedFiles);
      const [data, images] = await Promise.all([
        readFile(resolve(root, 'data.json'), 'utf8').then(JSON.parse),
        readFile(resolve(root, 'image-index.json'), 'utf8').then(JSON.parse),
      ]);
      for (const [path, hash] of Object.entries(images)) {
        allowed.add(path);
        if (/^[a-f0-9]{64}$/.test(hash)) {
          allowed.add(`assets/optimized/${hash.slice(0, 12)}-480.webp`);
          allowed.add(`assets/optimized/${hash.slice(0, 12)}-960.webp`);
        }
      }
      for (const video of data.videos || []) if (video.thumb) allowed.add(video.thumb);
      for (const video of data.history?.videos || []) {
        for (const variant of video.variants || []) {
          if (variant.webThumbnail) allowed.add(variant.webThumbnail);
          if (variant.webEvidence) allowed.add(variant.webEvidence);
        }
      }
      return allowed;
    })().catch(error => { manifest = undefined; throw error; });
  }
  return manifest;
}

export async function resolvePrivateFile(pathname) {
  if (typeof pathname !== 'string' || pathname.length > 1024) return null;
  let name;
  try { name = decodeURIComponent(pathname).replace(/^\//, ''); } catch { return null; }
  if (!name || /[%\\\u0000-\u001f?#:]/.test(name) || name.split('/').some(x => !x || x === '.' || x === '..')) return null;
  if (!(await privateManifest()).has(name)) return null;
  const candidate = resolve(root, name);
  const pathFromRoot = relative(root, candidate);
  if (isAbsolute(pathFromRoot) || pathFromRoot.startsWith('..')) return null;
  try {
    // A matching filename may still be a symlink: validate its final target too.
    const canonical = await realpath(candidate);
    const canonicalRelative = relative(await realpath(root), canonical);
    if (isAbsolute(canonicalRelative) || canonicalRelative.startsWith('..')) return null;
    return canonical;
  } catch { return null; }
}

export function privateContentType(path) {
  return ({
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  })[extname(path).toLowerCase()] || 'application/octet-stream';
}
