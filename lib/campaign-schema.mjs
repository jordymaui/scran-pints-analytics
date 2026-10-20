const secretPattern = /\b(?:Bearer\s+\S+|(?:access|refresh|id)[ _-]?token\s*[:=]|client[ _-]?secret\s*[:=]|sb_(?:secret|publishable)_[A-Za-z0-9_-]+|ya29\.[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i;

function text(value, field, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      /[\u0000-\u001f\u007f<>]/.test(value) || secretPattern.test(value) ||
      /(?:(?:^|[\s("'])[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp)\/|\\\\)/.test(value)) {
    throw new Error(`Campaign ${field} must be plain public text without credentials or local paths.`);
  }
  return value.trim();
}
function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => ![...required, ...optional].includes(key))) {
    throw new Error('Campaign data has missing or unsupported fields.');
  }
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid campaign identifier.');
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error('Campaign confirmedAt must be a real timestamp with timezone.');
  }
  return value;
}
function evidence(value, platform, contentId, knownUrl) {
  let url;
  try { url = new URL(text(value, 'evidence URL', 1000)); } catch { throw new Error('Campaign evidence must be an official HTTPS content URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('Unsafe campaign evidence URL.');
  let valid = false;
  if (platform.startsWith('youtube-')) {
    if (url.hostname === 'youtu.be') valid = url.pathname === `/${contentId}` && !url.search;
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
      valid = (url.pathname === '/watch' && url.searchParams.get('v') === contentId && [...url.searchParams.keys()].length === 1) ||
        (url.pathname.replace(/\/$/, '') === `/shorts/${contentId}` && !url.search);
    }
  } else {
    const hosts = platform === 'instagram' ? ['instagram.com', 'www.instagram.com'] : ['tiktok.com', 'www.tiktok.com'];
    const expected = new URL(knownUrl);
    valid = hosts.includes(url.hostname) && url.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '') && !url.search;
  }
  if (!valid) throw new Error('Campaign evidence must link to the recorded content on its official platform.');
  return url.href;
}

export function validateCampaigns(input, snapshot, social) {
  exactKeys(input, ['schemaVersion', 'campaigns']);
  if (input.schemaVersion !== 1 || !Array.isArray(input.campaigns) || input.campaigns.length > 30) throw new Error('Invalid campaign schema.');
  const content = new Map(snapshot.videos.map(video => [`youtube-longform:${video.id}`, `https://www.youtube.com/watch?v=${video.id}`]));
  for (const source of social.sources) for (const row of source.content) content.set(`${source.id}:${row.id}`, row.url);
  const ids = new Set();
  return { schemaVersion: 1, campaigns: input.campaigns.map(campaign => {
    exactKeys(campaign, ['id', 'name', 'description', 'placements'], ['status']);
    const id = identifier(campaign.id);
    if (ids.has(id)) throw new Error('Duplicate campaign identifier.');
    ids.add(id);
    if (campaign.status !== undefined && !['awaiting-attribution', 'recorded-placements'].includes(campaign.status)) throw new Error('Invalid campaign status.');
    if (!Array.isArray(campaign.placements) || campaign.placements.length > 1000) throw new Error('Invalid campaign placements.');
    const seen = new Set();
    return { id, name: text(campaign.name, 'name', 100), description: text(campaign.description, 'description'),
      placements: campaign.placements.map(placement => {
        exactKeys(placement, ['platform', 'contentId', 'placement', 'confirmedAt', 'evidenceUrl']);
        const key = `${placement.platform}:${placement.contentId}`;
        if (!content.has(key)) throw new Error('Campaign placement references unknown platform content.');
        if (seen.has(key)) throw new Error('Duplicate campaign content would double-count sponsor reporting.');
        seen.add(key);
        return { platform: placement.platform, contentId: identifier(placement.contentId),
          placement: text(placement.placement, 'placement', 300), confirmedAt: timestamp(placement.confirmedAt),
          evidenceUrl: evidence(placement.evidenceUrl, placement.platform, placement.contentId, content.get(key)) };
      }) };
  }) };
}
