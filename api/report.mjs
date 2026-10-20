import { loadPublicReport } from '../lib/cloud-report.mjs';
import { json } from '../lib/auth.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: 'method_not_allowed' });
  }
  try { return json(res, 200, await loadPublicReport()); }
  catch { return json(res, 503, { error: 'report_unavailable' }); }
}
