import { CollectionError, requestPlatformJson } from './collectors.mjs';
import { publicYouTubeThumbnail, validatePublicYouTubeReport } from './report-model.mjs';

export const PUBLIC_YOUTUBE_CHANNEL_ID = 'UCAX4l1JUAymaMHVKiRFzK-A';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const fail = code => { throw new CollectionError(code, 'The public YouTube report could not be collected completely. The previous report was kept.'); };

function counter(value, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail('invalid-response');
  return Number(value);
}

/** Collect public Data API resources using an API key, never an OAuth grant. */
export async function collectPublicYouTube({ env = process.env, fetchImpl = fetch, capturedAt = new Date().toISOString() } = {}) {
  const key = env.YOUTUBE_PUBLIC_API_KEY;
  if (typeof key !== 'string' || !key.trim() || /[\s\r\n]/.test(key)) fail('not-configured');
  const request = async (resource, params) => {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    url.search = new URLSearchParams({ ...params, key }).toString();
    const response = await requestPlatformJson(fetchImpl, url.href);
    if (response.error || !Array.isArray(response.items)) fail('invalid-response');
    return response;
  };
  const channelResponse = await request('channels', {
    part: 'snippet,contentDetails,statistics', id: PUBLIC_YOUTUBE_CHANNEL_ID,
  });
  const channel = channelResponse.items[0];
  if (channelResponse.items.length !== 1 || channel?.id !== PUBLIC_YOUTUBE_CHANNEL_ID ||
      typeof channel.snippet?.title !== 'string' || !channel.statistics ||
      typeof channel.statistics.hiddenSubscriberCount !== 'boolean') fail('invalid-response');
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  if (typeof uploads !== 'string' || !/^[A-Za-z0-9_-]{10,100}$/.test(uploads)) fail('invalid-response');
  const ids = new Set();
  const cursors = new Set();
  let pageToken;
  let pages = 0;
  do {
    if (++pages > 100) fail('pagination');
    const page = await request('playlistItems', {
      part: 'contentDetails', playlistId: uploads, maxResults: '50', ...(pageToken ? { pageToken } : {}),
    });
    for (const item of page.items) {
      const id = item?.contentDetails?.videoId;
      if (!VIDEO_ID.test(id || '') || ids.has(id)) fail('pagination');
      ids.add(id);
      if (ids.size > 5000) fail('pagination');
    }
    pageToken = page.nextPageToken;
    if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken ||
        pageToken.length > 1000 || /[\u0000-\u0020\u007f]/.test(pageToken) || cursors.has(pageToken))) fail('pagination');
    if (pageToken) cursors.add(pageToken);
  } while (pageToken);

  const content = [];
  const list = [...ids];
  let unresolved = 0;
  for (let offset = 0; offset < list.length; offset += 50) {
    const batch = list.slice(offset, offset + 50);
    const page = await request('videos', { part: 'snippet,statistics,status', id: batch.join(',') });
    const returned = new Set();
    for (const video of page.items) {
      if (!video || !batch.includes(video.id) || returned.has(video.id) ||
          video.snippet?.channelId !== PUBLIC_YOUTUBE_CHANNEL_ID) fail('invalid-response');
      returned.add(video.id);
      if (video.status?.privacyStatus !== 'public') { unresolved++; continue; }
      const thumbs = video.snippet.thumbnails || {};
      const thumbnail = ['high', 'medium', 'default'].map(size => thumbs[size]?.url).find(url => publicYouTubeThumbnail(url)) || null;
      content.push({
        id: video.id, title: video.snippet.title,
        url: `https://www.youtube.com/watch?v=${video.id}`,
        publishedAt: video.snippet.publishedAt, thumbnail,
        views: counter(video.statistics?.viewCount, true),
        likes: counter(video.statistics?.likeCount, true),
        comments: counter(video.statistics?.commentCount, true),
      });
    }
    unresolved += batch.length - returned.size;
  }
  const videoCount = counter(channel.statistics.videoCount);
  try {
    return validatePublicYouTubeReport({
      schemaVersion: 1, capturedAt,
      channel: {
        id: channel.id, title: channel.snippet.title,
        views: counter(channel.statistics.viewCount),
        subscribers: channel.statistics.hiddenSubscriberCount ? null : counter(channel.statistics.subscriberCount),
        videoCount,
      },
      inventory: { complete: unresolved === 0 && content.length === videoCount, publicUploadsCount: content.length },
      content,
    });
  } catch { fail('invalid-response'); }
}
