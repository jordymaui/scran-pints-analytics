import { logout, authFailure } from '../../lib/auth.mjs';

export default async function handler(req, res) {
  try { await logout(req, res); }
  catch (error) { authFailure(res, error); }
}
