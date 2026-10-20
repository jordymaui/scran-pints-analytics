// Preview selection never rewrites stored metadata or archived test assets.
function officialImage(value, videoId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['i.ytimg.com', 'i9.ytimg.com'].includes(url.hostname) ||
        url.port || url.username || url.password || url.search || url.hash ||
        !new RegExp(`^/vi(?:_webp)?/${videoId}/[A-Za-z0-9_-]+\\.(jpg|webp|png)$`).test(url.pathname)) return null;
    return url;
  } catch { return null; }
}

export function youtubeThumbnailPreview(value, videoId, apiPreview = null) {
  const original = officialImage(value, videoId);
  // Local captures and other platforms must retain their own image.
  if (!original) return value;
  const preferred = officialImage(apiPreview, videoId);
  if (preferred) return preferred.href;
  // New high-resolution names can serve a gray 200 response. Use the stable
  // standard preview only for a verified official URL for this same video.
  return /\/(?:uhd|qhd|fhd|maxres|sd)default\./.test(original.pathname)
    ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : original.href;
}

const installed = new WeakSet();
export function installThumbnailFallbacks(root) {
  if (!root?.addEventListener || installed.has(root)) return;
  installed.add(root);
  const retried = new WeakSet();
  root.addEventListener('error', event => {
    const image = event.target;
    if (image?.tagName !== 'IMG') return;
    if (image.dataset?.archivedThumbnail !== undefined) {
      if (image.hidden) return;
      image.hidden = true;
      const note = image.ownerDocument.createElement('span');
      note.className = 'missing-image';
      note.textContent = 'Saved image unavailable';
      image.after(note);
      return;
    }
    const id = image.dataset?.youtubeVideo;
    if (!officialImage(image.getAttribute('src'), id)) return;
    const high = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    if (!retried.has(image) && image.getAttribute('src') !== high) {
      retried.add(image);
      image.src = high;
    } else {
      image.hidden = true;
      image.setAttribute('aria-hidden', 'true');
    }
  }, true);
}

if (typeof document !== 'undefined') installThumbnailFallbacks(document);
