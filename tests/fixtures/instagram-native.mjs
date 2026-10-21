// Entirely synthetic test observations. Never populate this fixture from an account export.
export function instagramNativeFixture() {
  const capturedAt = '2026-01-15T12:00:00Z';
  const audience = (followers, others) => [
    { label: 'Followers', percentage: followers },
    { label: 'Non-followers', percentage: others },
  ];
  const contentTypes = () => [{ label: 'Reels', percentage: 95 }, { label: 'Stories', percentage: 5 }];
  return {
    schemaVersion: 1, accountUsername: 'scranpints', capturedAt,
    method: 'manual-browser-inspection', followers: 42, contentCount: null,
    windows: [7, 30, 90].map((periodDays, index) => ({
      periodDays, label: `Last ${periodDays} days`,
      dateRange: { start: null, end: null, timezone: null },
      views: periodDays * 100 + 10, instagramViews: periodDays * 100, facebookViews: 0,
      viewers: periodDays * 10, interactions: periodDays * 3, accountsEngaged: periodDays * 2,
      profileActivity: periodDays + 2, profileVisits: periodDays,
      externalLinkTaps: index === 0 ? null : 2,
      viewAudience: audience(20, 80), interactionAudience: audience(30, 70),
      viewContentTypes: contentTypes(), interactionContentTypes: contentTypes(),
    })),
    followerActivity: { weekday: 'Monday', timezone: null,
      hours: [2, 4, 6, 8, 7, 5, 3, 1].map((followers, index) => ({ hour: index * 3, followers })) },
    audience: null, contentCoverage: 'sample',
    content: [{ id: '1000000000000000001', url: null, capturedAt, reportingWindow: 'not-shown',
      views: 100, viewers: 80, interactions: 12, reelsInteractions: 0,
      likes: 5, comments: 1, saves: 2, shares: 1, accountsEngaged: 10, profileActivity: 2, follows: 1,
      viewAudience: audience(10, 90), interactionAudience: audience(40, 60) }],
  };
}

export function instagramCollaborationFixture() {
  return { accountUsername: 'footyscran', capturedAt: '2026-01-16T10:00:00Z',
    coverage: 'observed-profile-collabs', posts: [
      { shortcode: 'Synthetic_A', url: 'https://www.instagram.com/reel/Synthetic_A/',
        mediaId: '1000000000000000101', title: 'Synthetic collaboration example',
        publishedAt: '2026-01-10', capturedAt: '2026-01-16T09:00:00Z',
        views: 1200, likes: 15, comments: 2, shares: null, saves: null,
        metricScope: 'post-lifetime', viewsPrecision: 'rounded', relationship: 'collaboration' },
      { shortcode: 'Synthetic_B', url: 'https://www.instagram.com/p/Synthetic_B/',
        mediaId: null, title: null, publishedAt: null, capturedAt: '2026-01-16T09:30:00Z',
        views: null, likes: null, comments: null, shares: null, saves: null,
        metricScope: 'post-lifetime', viewsPrecision: 'unavailable', relationship: 'campaign-post' },
    ] };
}
