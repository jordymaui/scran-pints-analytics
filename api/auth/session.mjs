import { authorizeRequest, json } from '../../lib/auth.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: 'method_not_allowed' });
  }
  const user = await authorizeRequest(req, res);
  if (user) json(res, 200, { authenticated: true, user: { email: user.email } });
}
