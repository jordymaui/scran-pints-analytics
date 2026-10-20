import { authorizeRequest, json } from '../lib/auth.mjs';
import { loadReportingInputs } from '../lib/cloud-report.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: 'method_not_allowed' });
  }
  if (!await authorizeRequest(req, res)) return;
  try {
    const { snapshot, storageStatus, origins } = await loadReportingInputs();
    return json(res, 200, { ...snapshot, storageStatus, snapshotOrigin: origins.youtube });
  } catch { json(res, 503, { error: 'workshop_snapshot_unavailable' }); }
}
