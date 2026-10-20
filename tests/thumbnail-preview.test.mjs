import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeThumbnailPreview, installThumbnailFallbacks } from '../thumbnail-preview.js';

const id = 'CWBBRExPJ0I';
const high = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const broken = `https://i.ytimg.com/vi/${id}/fhddefault.jpg`;

test('current previews prefer same-video API high and replace unsupported large sizes without changing saved images', () => {
  assert.equal(youtubeThumbnailPreview(broken, id, high), high);
  assert.equal(youtubeThumbnailPreview(broken, id), high);
  assert.equal(youtubeThumbnailPreview(broken.replace('fhd', 'uhd'), id), high);
  assert.equal(youtubeThumbnailPreview(high, id), high);
  assert.equal(youtubeThumbnailPreview('/assets/history-hull-test.jpg', id, high), '/assets/history-hull-test.jpg');
  assert.equal(youtubeThumbnailPreview('https://example.com/image.jpg', id, high), 'https://example.com/image.jpg');
  assert.equal(youtubeThumbnailPreview(high, 'differentID'), high);
  assert.equal(youtubeThumbnailPreview(high, id, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'), high);
});

test('failed current images retry official high once for the same video, then stop', () => {
  const listeners = [];
  const root = { addEventListener(name, fn, capture) { listeners.push({ name, fn, capture }); } };
  installThumbnailFallbacks(root); installThumbnailFallbacks(root);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].capture, true);
  const error = listeners[0].fn;
  const image = {
    tagName: 'IMG', dataset: { youtubeVideo: id }, src: broken, hidden: false,
    getAttribute(name) { return this[name]; }, setAttribute(name, value) { this[name] = value; },
  };
  error({ target: image });
  assert.equal(image.src, high);
  assert.equal(image.hidden, false);
  error({ target: image });
  assert.equal(image.hidden, true);
  assert.equal(image['aria-hidden'], 'true');
  const wrongVideo = { ...image, hidden: false, src: 'https://i.ytimg.com/vi/abcdefghijk/fhddefault.jpg' };
  error({ target: wrongVideo });
  assert.equal(wrongVideo.hidden, false);
  assert.match(wrongVideo.src, /abcdefghijk\/fhddefault/);
});

test('failed archived evidence gets an explicit notice and is never replaced by current YouTube art', () => {
  let error;
  installThumbnailFallbacks({ addEventListener(_name, fn) { error = fn; } });
  const notices = [];
  const image = {
    tagName: 'IMG', dataset: { archivedThumbnail: '', youtubeVideo: id }, src: '/assets/history-test.jpg',
    ownerDocument: { createElement: () => ({}) }, after(note) { notices.push(note); },
  };
  error({ target: image }); error({ target: image });
  assert.equal(image.src, '/assets/history-test.jpg');
  assert.equal(image.hidden, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].textContent, 'Saved image unavailable');
});
