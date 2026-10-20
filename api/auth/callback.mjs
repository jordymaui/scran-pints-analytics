import { finishGoogleLogin, authFailure } from '../../lib/auth.mjs';

export default async function handler(req, res) {
  try { await finishGoogleLogin(req, res); }
  catch (error) { authFailure(res, error, { toLogin: true }); }
}
