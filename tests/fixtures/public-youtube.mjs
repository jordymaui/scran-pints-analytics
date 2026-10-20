export function publicYouTubeFixture(capturedAt = '2026-10-20T12:00:00.000Z') {
  return {
    schemaVersion: 1, capturedAt,
    channel: { id: 'UCAX4l1JUAymaMHVKiRFzK-A', title: 'Scran & Pints', views: 987654, subscribers: 12300, videoCount: 1 },
    inventory: { complete: true, publicUploadsCount: 1 },
    content: [{ id: 'PublicVid12', title: 'A public upload', url: 'https://www.youtube.com/watch?v=PublicVid12',
      publishedAt: '2026-10-18T12:00:00Z', thumbnail: 'https://i.ytimg.com/vi/PublicVid12/hqdefault.jpg',
      views: 12345, likes: 123, comments: null }],
  };
}
